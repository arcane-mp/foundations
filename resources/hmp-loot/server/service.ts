import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootPlayer, HmpLootPolicy, HmpLootRecord, HmpLootSpotFamily, HmpLootSpotTake, HmpLootState, HmpLootStatus, HmpLootTake } from "../types";
import type { LootDependencies, LootService } from "./internal";

const NONE: HmpLootFamilies = Object.freeze({ chests: false, moonstones: false, foragables: false, pouches: false });
const SPOT_FAMILIES: readonly HmpLootSpotFamily[] = ["moonstones", "foragables"];

const recordId = (key: string, characterId: number | null): string => `${key}\u0000${characterId ?? 0}`;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function createLootService<P extends HmpLootPlayer>(dependencies: LootDependencies<P>): LootService<P> {
    const { config, lootables, world, repository, migrations, core } = dependencies;
    const spots = dependencies.spots ?? null;
    const now = dependencies.now || Date.now;
    const schedule = dependencies.schedule || ((fn: () => void, ms: number) => {
        const timer = setInterval(fn, ms);
        return () => clearInterval(timer);
    });
    const logger = dependencies.logger;
    const startedAt = now();
    const definitions = new Map(config.lootables.map((definition) => [definition.key, definition]));
    const ids = new Map<string, number>();
    const keysById = new Map<number, string>();
    const records = new Map<string, HmpLootRecord>();
    const subscribers = new Set<(take: HmpLootTake<P>) => void>();
    let state: HmpLootStatus["state"] = "starting";
    let lastError = "";
    let readyPromise: Promise<void> | null = null;
    let stopSweep: (() => void) | null = null;
    // What this resource changed, so stop puts back what it found and leaves other owners' settings alone.
    let switchedOff: Partial<HmpLootFamilies> = {};
    let policyFound: Partial<Record<HmpLootSpotFamily, HmpLootPolicy>> = {};
    let policySet: Record<HmpLootSpotFamily, HmpLootPolicy | null> = { moonstones: null, foragables: null };

    // Only for rows read at startup: a loaded take stays in effect until the sweep releases it.
    const live = (record: HmpLootRecord | undefined): boolean => !!record && (record.respawnAt === null || record.respawnAt > now());

    function characterOf(player: P): number | null {
        try { return core.characters.active(player)?.id ?? null; }
        catch (_) { return null; }
    }

    function accountOf(player: P): number | null {
        try { return core.accounts.getByPlayer(player)?.id ?? null; }
        catch (_) { return null; }
    }

    // Without a character there is nobody to record a take against, so nothing is offered.
    function viewFor(definition: HmpLootDefinition, characterId: number | null): { items?: HmpLootItem[]; locked?: boolean } | null {
        if (characterId === null) return { locked: true };
        return records.has(recordId(definition.key, characterId)) ? { items: [] } : null;
    }

    function sync(player: P): void {
        if (state !== "ready") return;
        const characterId = characterOf(player);
        for (const definition of definitions.values()) {
            const id = ids.get(definition.key);
            if (definition.scope === "character" && id) lootables.setView(id, player, viewFor(definition, characterId));
        }
    }

    function playerWith(characterId: number): P | null {
        return dependencies.players().find((player) => characterOf(player) === characterId) ?? null;
    }

    // The take is over: the loot is back for whoever it was taken from.
    function release(record: HmpLootRecord): void {
        records.delete(recordId(record.key, record.characterId));
        const definition = definitions.get(record.key);
        const id = ids.get(record.key);
        if (!definition || !id || state !== "ready") return;
        if (record.characterId === null) {
            lootables.setItems(id, definition.items);
            return;
        }
        const player = playerWith(record.characterId);
        if (player) lootables.setView(id, player, null);
    }

    async function forget(record: HmpLootRecord): Promise<void> {
        release(record);
        try { await repository.remove(record.key, record.characterId); }
        catch (error) { logger?.warn(`Could not delete the take of '${record.key}' by character ${record.characterId ?? "shared"}: ${messageOf(error)}`); }
    }

    async function sweep(): Promise<void> {
        const due = [...records.values()].filter((record) => record.respawnAt !== null && record.respawnAt <= now());
        for (const record of due) await forget(record);
    }

    function place(definition: HmpLootDefinition): void {
        const sharedTaken = definition.scope === "shared" && records.has(recordId(definition.key, null));
        try {
            const id = lootables.place(definition.kind, definition.position.x, definition.position.y, definition.position.z, definition.yaw, {
                items: sharedTaken ? [] : definition.items,
                mode: definition.scope === "character" ? "perPlayer" : "shared",
                ...(definition.model ? { model: definition.model } : {}),
            });
            if (!id) throw new Error("Lootables.place returned 0");
            ids.set(definition.key, id);
            keysById.set(id, definition.key);
        }
        catch (error) {
            logger?.warn(`Could not place lootable '${definition.key}': ${messageOf(error)}`);
        }
    }

    function applySpotSettings(): void {
        const settings = config.lootSpots;
        const kinds = Object.entries(settings.kinds);
        if (settings.mode === null && settings.respawnSeconds === null && settings.yield === null && !kinds.length) return;
        if (!spots) {
            logger?.warn("lootSpots needs HogwartsMP 1.11 or newer for LootSpots; this host ignores it");
            return;
        }
        const refused = (what: string) => logger?.warn(`LootSpots refused ${what}`);
        if (settings.mode !== null && spots.mode !== settings.mode && !spots.setMode(settings.mode)) refused(`mode "${settings.mode}"`);
        if (settings.respawnSeconds !== null && !spots.setRespawnSeconds(settings.respawnSeconds)) refused(`respawnSeconds ${settings.respawnSeconds}`);
        if (settings.yield !== null && !spots.setYield(settings.yield)) refused(`yield ${JSON.stringify(settings.yield)}`);
        const known = new Set<string>([...SPOT_FAMILIES, ...spots.getKinds().map((entry) => entry.kind)]);
        const isFamily = (kind: string) => (SPOT_FAMILIES as readonly string[]).includes(kind);
        kinds.sort(([a], [b]) => Number(!isFamily(a)) - Number(!isFamily(b)));
        for (const [kind, value] of kinds) {
            if (!known.has(kind)) {
                logger?.warn(`lootSpots.kinds.${kind} is not a LootSpots kind or family (${[...known].join(", ")}); it is skipped`);
                continue;
            }
            if (value.respawnSeconds !== undefined && !spots.setRespawnSeconds(value.respawnSeconds, kind)) refused(`respawnSeconds ${value.respawnSeconds} for ${kind}`);
            if (value.yield !== undefined && !spots.setYield(value.yield, kind)) refused(`yield ${JSON.stringify(value.yield)} for ${kind}`);
        }
    }

    // gameLoot wins for its families; one it leaves out follows suppressGameLoot. Only what differs from what
    // the host holds now is changed, and "native" never is, so another owner's policy stands.
    function applyGameLoot(): void {
        const policyHost = typeof world.setLootPolicy === "function" && !!world.lootPolicy;
        const found = world.lootSuppressed;
        const off: Partial<HmpLootFamilies> = {};
        for (const family of ["chests", "pouches"] as const) {
            if (config.suppressGameLoot[family] && !found?.[family]) off[family] = true;
        }
        const wanted: Partial<Record<HmpLootSpotFamily, HmpLootPolicy>> = {};
        for (const family of SPOT_FAMILIES) {
            const fallback: HmpLootPolicy = config.suppressGameLoot[family] ? "suppressed" : "native";
            let policy = config.gameLoot[family] ?? fallback;
            if (policy === "server" && !policyHost) {
                logger?.warn(`gameLoot.${family} "server" needs HogwartsMP 1.11 or newer for World.setLootPolicy; this host keeps ${family} ${fallback}`);
                policy = fallback;
            }
            if (policy === "native") continue;
            if (policyHost) {
                if (world.lootPolicy![family] !== policy) wanted[family] = policy;
            }
            else if (!found?.[family]) off[family] = true;
        }
        if (Object.keys(off).length) {
            if (!world.suppressLoot(off)) throw new Error("World.suppressLoot refused the configured families");
            switchedOff = off;
            for (const family of SPOT_FAMILIES) if (off[family]) policySet[family] = "suppressed";
        }
        if (Object.keys(wanted).length) {
            const before = { ...world.lootPolicy! };
            if (!world.setLootPolicy!(wanted)) throw new Error("World.setLootPolicy refused the configured policy");
            for (const family of Object.keys(wanted) as HmpLootSpotFamily[]) {
                policyFound[family] = before[family];
                policySet[family] = wanted[family]!;
            }
        }
    }

    async function ready(): Promise<void> {
        if (!readyPromise) {
            readyPromise = (async () => {
                try {
                    await repository.start(migrations);
                    for (const record of await repository.loadAll()) {
                        // A take of a lootable no longer configured stays in the table, so re-adding it remembers.
                        if (!definitions.has(record.key)) continue;
                        if (live(record)) records.set(recordId(record.key, record.characterId), record);
                        else await repository.remove(record.key, record.characterId);
                    }
                    applySpotSettings();
                    applyGameLoot();
                    for (const definition of definitions.values()) place(definition);
                    state = "ready";
                    stopSweep = schedule(() => { void sweep(); }, config.sweepMs);
                    for (const player of dependencies.players()) sync(player);
                }
                catch (error) {
                    state = "degraded";
                    lastError = messageOf(error);
                    throw error;
                }
            })();
        }
        return readyPromise;
    }

    // The builtin has already emptied the contents (shared) or the taker's view (character); the record
    // keeps a character's view empty across character switches, reconnects and restarts.
    async function taken(player: P, lootableId: number, items: HmpLootItem[]): Promise<void> {
        const key = keysById.get(lootableId);
        const definition = key ? definitions.get(key) : undefined;
        if (!key || !definition || state !== "ready") return;
        const characterId = definition.scope === "character" ? characterOf(player) : null;
        if (definition.scope === "character" && characterId === null) {
            logger?.warn(`#${player.id} took from '${key}' without a character; nothing was recorded`);
            return;
        }
        const takenAt = now();
        const record: HmpLootRecord = { key, characterId, accountId: accountOf(player), takenAt, respawnAt: definition.respawnSeconds === null ? null : takenAt + definition.respawnSeconds * 1000 };
        records.set(recordId(key, characterId), record);
        for (const handler of subscribers) {
            try { handler({ ...record, player, items }); }
            catch (error) { logger?.warn(`An hmp-loot take subscriber failed: ${messageOf(error)}`); }
        }
        await repository.put(record);
    }

    // The host runs the spot and adopts the items; this only names the taker's character for listeners.
    function spotTaken(player: P, spotId: string, items: HmpLootItem[]): void {
        let spot: { kind: string; family: HmpLootSpotFamily } | null = null;
        try { spot = spots?.get(spotId) ?? null; }
        catch (_) { /* reported without its kind */ }
        const take: HmpLootSpotTake<P> = {
            player, characterId: characterOf(player), accountId: accountOf(player), spotId,
            kind: spot?.kind ?? null, family: spot?.family ?? null, items: items.map((item) => ({ ...item })),
        };
        dependencies.emit?.("hmp:loot:spotTaken", take);
    }

    function suppressedGameLoot(): HmpLootFamilies {
        const out = { ...NONE, ...switchedOff };
        for (const family of SPOT_FAMILIES) if (policySet[family]) out[family] = true;
        return out;
    }

    function stateOf(definition: HmpLootDefinition): HmpLootState {
        const shared = definition.scope === "shared" ? records.get(recordId(definition.key, null)) : undefined;
        return { ...definition, items: definition.items.map((item) => ({ ...item })), lootableId: ids.get(definition.key) ?? 0, taken: !!shared, respawnAt: shared ? shared.respawnAt : null };
    }

    function stop(): void {
        stopSweep?.();
        stopSweep = null;
        for (const id of ids.values()) {
            try { lootables.remove(id); }
            catch (_) { /* the server is going down with it */ }
        }
        ids.clear();
        keysById.clear();
        const lifted = Object.fromEntries(Object.keys(switchedOff).map((family) => [family, false]));
        if (Object.keys(lifted).length) world.suppressLoot(lifted);
        if (Object.keys(policyFound).length) world.setLootPolicy?.(policyFound);
        switchedOff = {};
        policyFound = {};
        policySet = { moonstones: null, foragables: null };
        state = "stopped";
    }

    const api = Object.freeze({
        list: () => [...definitions.values()].map(stateOf),
        get: (key: string) => {
            const definition = definitions.get(key);
            return definition ? stateOf(definition) : null;
        },
        record: (key: string, characterId: number | null) => {
            const record = records.get(recordId(key, characterId));
            return record ? { ...record } : null;
        },
        async reset(key: string, characterId?: number | null) {
            if (!definitions.has(key)) throw new Error(`unknown lootable '${key}'`);
            const matches = [...records.values()].filter((record) => record.key === key && (characterId === undefined || record.characterId === (characterId ?? null)));
            for (const record of matches) await forget(record);
            return matches.length;
        },
        onTaken(handler: (take: HmpLootTake<P>) => void) {
            subscribers.add(handler);
            return () => subscribers.delete(handler);
        },
    });

    return Object.freeze({
        lootables: api,
        status: (): HmpLootStatus => ({ state, lastError, lootables: ids.size, records: records.size, suppressedGameLoot: suppressedGameLoot(), gameLoot: { ...policySet }, uptimeMs: now() - startedAt }),
        ready,
        taken,
        spotTaken,
        sync,
        stop,
    });
}

export = { createLootService };

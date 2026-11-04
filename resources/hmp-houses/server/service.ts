import normalizeModule = require("../shared/normalize");
import type { HmpCoreGroup } from "../../hmp-core/types";
import type { HmpHouseId, HmpHouseMutationOptions, HmpHousePointOptions, HmpHousePointTransaction, HmpHouseStanding } from "../types";
import type { HousesDependencies, HousesService, Player, PointDraft } from "./internal";

const { HOUSES, house: normalizeHouse, nativeHouse, clean, positiveId, limit, signedAmount, metadata } = normalizeModule;
const COMMON_ROOMS_KEY = "hmp-houses:commonRooms";

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The one house with the most points; null on a tie at the top, which includes no house having any. */
function leader(standings: ReadonlyArray<HmpHouseStanding>): HmpHouseId | null {
    const top = Math.max(...standings.map((row) => row.points));
    const leaders = standings.filter((row) => row.points === top);
    return leaders.length === 1 ? leaders[0].house : null;
}

function grantedRooms(value: unknown): HmpHouseId[] {
    return Array.isArray(value) ? HOUSES.filter((entry) => value.includes(entry)) : [];
}

function createHousesService(dependencies: HousesDependencies): HousesService {
    const { repository, core, events, logger, config, migrations } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const syncedPlayers = new Set<number>();
    const commonRoomPlayers = new Map<number, Player>();
    let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
    let lastError = "";
    let pendingTransactions = 0;
    let startPromise: Promise<void> | null = null;
    let warnedCommonRooms = false;
    let warnedBanners = false;
    let hungBanners: HmpHouseId | "none" | null = null;
    let bannerQueue = Promise.resolve();

    function start(): Promise<void> {
        if (state === "stopped") return Promise.reject(new Error("hmp-houses is stopped"));
        if (startPromise) return startPromise;
        state = "starting";
        startPromise = repository.migrate(migrations).then(async () => {
            pendingTransactions = (await repository.pendingPoints(200)).length;
            state = "ready";
            lastError = "";
            await queueBanners();
        }).catch((error) => {
            state = "degraded";
            lastError = messageOf(error).slice(0, 191);
            throw error;
        });
        return startPromise;
    }

    function playerId(player: Player): number {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0) throw new TypeError("a connected player is required");
        return id;
    }

    function activeCharacter(player: Player) {
        playerId(player);
        const character = core.characters.active(player);
        if (!character) throw new Error("Select a character before using houses");
        return character;
    }

    function characterId(target: Player | number): number {
        return typeof target === "number" ? positiveId(target, "character id") : activeCharacter(target).id;
    }

    function actorCharacterId(actor: Player | number | null | undefined): number | null {
        if (actor === undefined || actor === null) return null;
        return characterId(actor);
    }

    function onlinePlayer(characterId: number): Player | null {
        return core.sessions.all().find((session) => session.character?.id === characterId)?.player || null;
    }

    function optionalText(value: unknown, maximum: number): string {
        return String(value || "").trim().slice(0, maximum);
    }

    function resource(value: unknown): string {
        return clean(value, "source resource", 64);
    }

    async function project(characterId: number, house: HmpHouseId | null): Promise<void> {
        const groups = await core.groups.listCharacter(characterId);
        const ownedKeys = new Set(HOUSES.map((entry) => `${config.groupPrefix}${entry}`));
        for (const group of groups) if (ownedKeys.has(group.key.toLowerCase()) && group.key.toLowerCase() !== (house ? `${config.groupPrefix}${house}` : "")) await core.groups.removeCharacter(characterId, group.key);
        if (house) await core.groups.setCharacter(characterId, `${config.groupPrefix}${house}`, 0, { source: "hmp-houses", house });
    }

    function applyNative(player: Player, house: HmpHouseId | null): void {
        player.house = nativeHouse(house);
        syncedPlayers.add(playerId(player));
    }

    async function sync(player: Player) {
        await start();
        const character = activeCharacter(player);
        const membership = await repository.membership(character.id);
        await project(character.id, membership?.house || null);
        applyNative(player, membership?.house || null);
        return membership;
    }

    async function getMembership(target: Player | number) {
        await start();
        return repository.membership(characterId(target));
    }

    async function setMembership(target: Player | number, rawHouse: HmpHouseId, options: HmpHouseMutationOptions<Player>) {
        await start();
        if (!options) throw new TypeError("house mutation options are required");
        const targetCharacterId = characterId(target);
        const house = normalizeHouse(rawHouse);
        const result = await repository.setMembership({
            characterId: targetCharacterId,
            house,
            actorCharacterId: actorCharacterId(options.actor),
            resource: resource(options.resource),
            reason: optionalText(options.reason, 191),
        });
        await project(targetCharacterId, house);
        const player = typeof target === "number" ? onlinePlayer(targetCharacterId) : target;
        if (player) applyNative(player, house);
        if (result.previousHouse !== house) events.emit("hmp:houses:changed", { player, character: player ? core.characters.active(player) : null, membership: result.membership, previousHouse: result.previousHouse });
        return result.membership;
    }

    async function clearMembership(target: Player | number, options: HmpHouseMutationOptions<Player>): Promise<boolean> {
        await start();
        if (!options) throw new TypeError("house mutation options are required");
        const targetCharacterId = characterId(target);
        const previousHouse = await repository.clearMembership(targetCharacterId, actorCharacterId(options.actor), resource(options.resource), optionalText(options.reason, 191));
        await project(targetCharacterId, null);
        const player = typeof target === "number" ? onlinePlayer(targetCharacterId) : target;
        if (player) applyNative(player, null);
        if (previousHouse) events.emit("hmp:houses:changed", { player, character: player ? core.characters.active(player) : null, membership: null, previousHouse });
        return previousHouse !== null;
    }

    function pointReference(value: unknown): string {
        const reference = clean(value, "house point reference", 96);
        if (!/^[A-Za-z0-9_.:-]+$/.test(reference)) throw new TypeError("house point reference may contain only letters, numbers, dot, underscore, colon, and dash");
        return reference;
    }

    function pointDraft(rawHouse: HmpHouseId, rawAmount: number, options: HmpHousePointOptions<Player>): PointDraft {
        if (!options) throw new TypeError("house point options are required");
        return {
            reference: pointReference(options.reference),
            house: normalizeHouse(rawHouse),
            amount: signedAmount(rawAmount),
            actorCharacterId: actorCharacterId(options.actor),
            resource: resource(options.resource),
            reason: optionalText(options.reason, 191),
            metadata: metadata(options.metadata),
        };
    }

    function assertReplay(transaction: HmpHousePointTransaction, draft: PointDraft): void {
        if (transaction.house !== draft.house || transaction.amount !== draft.amount || transaction.actorCharacterId !== draft.actorCharacterId || transaction.resource !== draft.resource) {
            throw Object.assign(new Error(`House point reference '${draft.reference}' was reused for a different operation`), { code: "HMP_HOUSES_REFERENCE" });
        }
    }

    async function adjust(rawHouse: HmpHouseId, rawAmount: number, options: HmpHousePointOptions<Player>): Promise<HmpHousePointTransaction> {
        await start();
        const draft = pointDraft(rawHouse, rawAmount, options);
        const begun = await repository.beginPoint(draft);
        assertReplay(begun.transaction, draft);
        if (begun.transaction.status === "failed") throw new Error(`House point transaction '${draft.reference}' failed: ${begun.transaction.error}`);
        const shouldEmit = begun.transaction.status !== "completed";
        let transaction: HmpHousePointTransaction;
        try { transaction = begun.transaction.status === "completed" ? begun.transaction : await repository.applyPoint(draft.reference, config.allowNegativePoints); }
        catch (error) {
            if (begun.transaction.status === "pending") await repository.failPoint(draft.reference, messageOf(error));
            pendingTransactions = (await repository.pendingPoints(200)).length;
            throw error;
        }
        pendingTransactions = (await repository.pendingPoints(200)).length;
        if (shouldEmit) {
            events.emit("hmp:houses:points", { transaction, standing: await repository.standing(transaction.house) });
            await followLeader();
        }
        return transaction;
    }

    async function recover(rawReference: string): Promise<HmpHousePointTransaction> {
        await start();
        const reference = pointReference(rawReference);
        const existing = await repository.pointTransaction(reference);
        if (!existing) throw new Error(`House point transaction '${reference}' does not exist`);
        if (existing.status === "failed") throw new Error(`House point transaction '${reference}' failed: ${existing.error}`);
        const shouldEmit = existing.status !== "completed";
        const transaction = shouldEmit ? await repository.applyPoint(reference, config.allowNegativePoints) : existing;
        pendingTransactions = (await repository.pendingPoints(200)).length;
        if (shouldEmit) {
            events.emit("hmp:houses:points", { transaction, standing: await repository.standing(transaction.house), recovered: true });
            await followLeader();
        }
        return transaction;
    }

    // Banners are server-wide, so hanging them queues behind any earlier hang and reads the latest standings.
    function queueBanners(): Promise<void> {
        bannerQueue = bannerQueue.then(hangBanners).catch((error) => { logger.warn(`[hmp-houses] could not hang the Great Hall banners: ${messageOf(error)}`); });
        return bannerQueue;
    }

    function followLeader(): Promise<void> {
        return config.greatHallBanners === "leader" ? queueBanners() : Promise.resolve();
    }

    async function hangBanners(): Promise<void> {
        if (config.greatHallBanners === "game") return;
        const world = dependencies.world;
        if (typeof world?.setGreatHallBanners !== "function") {
            if (!warnedBanners) {
                warnedBanners = true;
                logger.warn("[hmp-houses] greatHallBanners needs a HogwartsMP host with World.setGreatHallBanners; the Great Hall keeps the game's banners");
            }
            return;
        }
        const banners = config.greatHallBanners === "leader" ? leader(await repository.standings()) : config.greatHallBanners;
        if (!banners || banners === hungBanners || state === "stopped") return;
        if (world.setGreatHallBanners(banners === "none" ? "none" : nativeHouse(banners))) hungBanners = banners;
    }

    function releaseBanners(): void {
        if (hungBanners === null) return;
        hungBanners = null;
        try { dependencies.world?.setGreatHallBanners?.("game"); }
        catch (error) { logger.warn(`[hmp-houses] could not release the Great Hall banners: ${messageOf(error)}`); }
    }

    async function listCommonRooms(target: Player | number): Promise<HmpHouseId[]> {
        await start();
        return grantedRooms(await core.metadata.getCharacter(characterId(target), COMMON_ROOMS_KEY));
    }

    function inCommonRoomGroups(groups: HmpCoreGroup[]): boolean {
        const grades = new Map(groups.map((group) => [group.key.toLowerCase(), Number(group.grade) || 0]));
        return config.commonRoomGroups.some((required) => (grades.get(required.key) ?? Number.NEGATIVE_INFINITY) >= required.minimumGrade);
    }

    async function syncCommonRooms(player: Player): Promise<HmpHouseId[] | null> {
        await start();
        const character = activeCharacter(player);
        const granted = grantedRooms(await core.metadata.getCharacter(character.id, COMMON_ROOMS_KEY));
        const access = config.commonRoomGroups.length && granted.length < HOUSES.length && inCommonRoomGroups(await core.groups.effective(player)) ? [...HOUSES] : granted;
        if (!Array.isArray(player.commonRooms)) {
            if (access.length && !warnedCommonRooms) {
                warnedCommonRooms = true;
                logger.warn("[hmp-houses] common-room access needs a HogwartsMP host with player.commonRooms; players enter only their own house's");
            }
            return null;
        }
        player.commonRooms = access.map((house) => nativeHouse(house));
        if (access.length) commonRoomPlayers.set(playerId(player), player);
        else commonRoomPlayers.delete(playerId(player));
        return access;
    }

    async function writeCommonRooms(target: Player | number, rooms: HmpHouseId[]): Promise<void> {
        const id = characterId(target);
        await core.metadata.setCharacter(id, COMMON_ROOMS_KEY, rooms);
        const player = typeof target === "number" ? onlinePlayer(id) : target;
        if (player) await syncCommonRooms(player);
    }

    async function grantCommonRoom(target: Player | number, rawHouse: HmpHouseId): Promise<boolean> {
        const house = normalizeHouse(rawHouse);
        const rooms = await listCommonRooms(target);
        if (rooms.includes(house)) return false;
        await writeCommonRooms(target, HOUSES.filter((entry) => entry === house || rooms.includes(entry)));
        return true;
    }

    async function revokeCommonRoom(target: Player | number, rawHouse: HmpHouseId): Promise<boolean> {
        const house = normalizeHouse(rawHouse);
        const rooms = await listCommonRooms(target);
        if (!rooms.includes(house)) return false;
        await writeCommonRooms(target, rooms.filter((entry) => entry !== house));
        return true;
    }

    async function clearCommonRooms(target: Player | number): Promise<number> {
        const rooms = await listCommonRooms(target);
        if (rooms.length) await writeCommonRooms(target, []);
        return rooms.length;
    }

    async function groupsChanged(change: unknown): Promise<void> {
        if (!config.commonRoomGroups.length || state === "stopped") return;
        const value = change && typeof change === "object" ? change as { key?: unknown; group?: { key?: unknown } } : {};
        const key = String(value.group?.key ?? value.key ?? "").toLowerCase();
        if (key && !config.commonRoomGroups.some((group) => group.key === key)) return;
        await Promise.all(core.sessions.all().filter((session) => session.character && session.player).map(async (session) => {
            try { await syncCommonRooms(session.player); }
            catch (error) { logger.warn(`[hmp-houses] could not refresh common rooms for #${session.player.id}: ${messageOf(error)}`); }
        }));
    }

    async function characterLoaded(player: Player): Promise<void> {
        try { await sync(player); }
        catch (error) { logger.warn(`[hmp-houses] could not synchronize #${player.id}: ${messageOf(error)}`); }
        try { await syncCommonRooms(player); }
        catch (error) { logger.warn(`[hmp-houses] could not apply common rooms for #${player.id}: ${messageOf(error)}`); }
    }

    function disconnect(player: Player): boolean {
        syncedPlayers.delete(Number(player.id));
        commonRoomPlayers.delete(Number(player.id));
        return true;
    }

    async function stop(): Promise<void> {
        state = "stopped";
        syncedPlayers.clear();
        for (const player of commonRoomPlayers.values()) {
            try { player.commonRooms = []; }
            catch (error) { logger.warn(`[hmp-houses] could not take common rooms back from #${player.id}: ${messageOf(error)}`); }
        }
        commonRoomPlayers.clear();
        releaseBanners();
    }

    return Object.freeze({
        membership: Object.freeze({
            get: getMembership, set: setMembership, clear: clearMembership,
            members: async (rawHouse: HmpHouseId, rawLimit = 50) => { await start(); return repository.members(normalizeHouse(rawHouse), limit(rawLimit)); },
            history: async (rawCharacterId: number, rawLimit = 50) => { await start(); return repository.membershipHistory(positiveId(rawCharacterId, "character id"), limit(rawLimit)); },
            sync,
        }),
        points: Object.freeze({
            get: async (rawHouse: HmpHouseId) => { await start(); return repository.standing(normalizeHouse(rawHouse)); },
            standings: async () => { await start(); return repository.standings(); },
            adjust,
            award: (house: HmpHouseId, amount: number, options: HmpHousePointOptions<Player>) => {
                const value = signedAmount(amount);
                if (value < 0) throw new TypeError("award amount must be positive");
                return adjust(house, value, options);
            },
            deduct: (house: HmpHouseId, amount: number, options: HmpHousePointOptions<Player>) => {
                const value = signedAmount(amount);
                if (value < 0) throw new TypeError("deduct amount must be positive");
                return adjust(house, -value, options);
            },
            transaction: async (reference: string) => { await start(); return repository.pointTransaction(pointReference(reference)); },
            history: async (rawHouse?: HmpHouseId, rawLimit = 50) => { await start(); return repository.pointHistory(rawHouse ? normalizeHouse(rawHouse) : undefined, limit(rawLimit)); },
            pending: async (rawLimit = 50) => { await start(); const rows = await repository.pendingPoints(limit(rawLimit)); pendingTransactions = rows.length; return rows; },
            recover,
        }),
        commonRooms: Object.freeze({
            list: listCommonRooms, grant: grantCommonRoom, revoke: revokeCommonRoom, clear: clearCommonRooms, sync: syncCommonRooms,
        }),
        status: () => ({ state, lastError, syncedPlayers: syncedPlayers.size, pendingTransactions, uptimeMs: Math.max(0, now() - startedAt) }),
        start, characterLoaded, groupsChanged, disconnect, stop,
    });
}

export = { createHousesService, leader, COMMON_ROOMS_KEY };

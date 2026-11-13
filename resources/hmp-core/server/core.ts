import type {
    HmpCore,
    HmpCoreAccount,
    HmpCoreCharacter,
    HmpCoreGroup,
    HmpCoreIdentityProvider,
    HmpCorePrincipal,
    HmpCoreSession,
    HmpCoreStatus,
} from "../types";
import type { CoreConfig, CoreOptions, Player, ProviderEntry, Scope } from "./internal";

const IDENTITY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
    steamId: "client-steam",
    discordId: "client-discord",
    hardwareId: "client-hardware",
});
const CLIENT_PROVIDER = "hmp-client-identity";
// A load whose player disconnected keeps the character claimed until its loading handlers return, so a new
// session cannot load it alongside them. This bounds a handler that never returns.
const ABANDONED_LOAD_RELEASE_MS = 30_000;

interface PendingSelect {
    readonly characterId: number;
    readonly result: Promise<HmpCoreCharacter>;
    abandoned?: ReturnType<typeof setTimeout>;
}

function fail(code: string, message: string): Error & { code: string } {
    const error = new Error(message);
    return Object.assign(error, { code });
}

function playerId(player: Player | number): number {
    const id = Number(player && typeof player === "object" ? player.id : player);
    if (!Number.isSafeInteger(id) || id < 0) throw fail("HMP_CORE_INVALID_PLAYER", "A connected player is required");
    return id;
}

function positiveId(value: unknown, label: string): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw fail("HMP_CORE_INVALID_ID", `${label} must be a positive integer`);
    return id;
}

function normalizeKey(value: unknown, label = "key"): string {
    const key = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(key)) {
        throw fail("HMP_CORE_INVALID_KEY", `${label} must be 1-64 lowercase letters, numbers, dots, colons, underscores or hyphens`);
    }
    return key;
}

function normalizePrincipal(value: unknown, fallbackTrust = "asserted"): HmpCorePrincipal {
    if (!value || typeof value !== "object") throw fail("HMP_CORE_INVALID_IDENTITY", "Identity provider returned an invalid principal");
    const record = value as Record<string, unknown>;
    const provider = normalizeKey(record.provider, "identity provider");
    const subject = String(record.subject ?? "").trim();
    if (!subject || subject.length > 191) throw fail("HMP_CORE_INVALID_IDENTITY", "Identity subject must be 1-191 characters");
    const trust = String(record.trust || fallbackTrust).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(trust)) throw fail("HMP_CORE_INVALID_IDENTITY", "Identity trust must be a short token");
    return Object.freeze({ provider, subject, trust });
}

function createCore(options: CoreOptions) {
    const repository = options.repository;
    const database = options.database;
    const migrations = options.migrations || [];
    const events = options.events || null;
    const listPlayers = options.listPlayers || (() => []);
    const logger = options.logger || console;
    const config = options.config || {};
    if (!repository || !database) throw new TypeError("repository and database are required");

    let state: HmpCoreStatus["state"] = "starting";
    let lastError = "";
    let startedAt = Date.now();
    let startPromise: Promise<boolean> | null = null;
    const sessionsByPlayer = new Map<number, HmpCoreSession<Player>>();
    const characterClaims = new Map<number, HmpCoreSession<Player>>();
    // The select each session is running; a session runs one at a time.
    const selecting = new WeakMap<HmpCoreSession<Player>, PendingSelect>();
    // Sessions whose unloadCharacter is still waiting on its hmp:character:unloading handlers.
    const unloading = new WeakSet<HmpCoreSession<Player>>();
    const attempts = new Map<number, symbol>();
    const providers = new Map<string, ProviderEntry>();

    function logError(message: string, error: unknown): void {
        if (logger && typeof logger.error === "function") logger.error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    }

    function logWarn(message: string): void {
        if (logger && typeof logger.warn === "function") logger.warn(message);
    }

    async function emit(name: string, payload: unknown): Promise<void> {
        if (!events || typeof events.emit !== "function") return;
        try { await events.emit(name, payload); }
        catch (error) { logError(`[hmp-core] ${name} handler failed`, error); }
    }

    function releaseClaim(characterId: number, session: HmpCoreSession<Player>): void {
        if (characterClaims.get(characterId) === session) characterClaims.delete(characterId);
    }

    function claimedElsewhere(characterId: number, session: HmpCoreSession<Player>): boolean {
        const claimed = characterClaims.get(characterId);
        return Boolean(claimed && claimed !== session);
    }

    // A player can disconnect during any await of a select or an unload, and their disconnect has then run.
    function sessionEnded(session: HmpCoreSession<Player>): boolean {
        return sessionsByPlayer.get(session.playerId) !== session;
    }

    function registerProvider(definition: HmpCoreIdentityProvider<Player>): () => boolean {
        if (!definition || typeof definition.resolve !== "function") throw new TypeError("identity provider resolve must be a function");
        const name = normalizeKey(definition.name, "identity provider name");
        if (providers.has(name)) throw fail("HMP_CORE_PROVIDER_EXISTS", `Identity provider ${name} is already registered`);
        const entry: ProviderEntry = Object.freeze({
            name,
            resource: String(definition.resource || "unknown"),
            priority: Number.isFinite(Number(definition.priority)) ? Number(definition.priority) : 0,
            trust: String(definition.trust || "asserted"),
            resolve: definition.resolve,
        });
        providers.set(name, entry);
        return () => providers.delete(name);
    }

    function unregisterProvider(name: string): boolean {
        return providers.delete(normalizeKey(name, "identity provider name"));
    }

    function removeIdentityProvidersForResource(resource: string): number {
        let removed = 0;
        for (const [name, provider] of providers) {
            if (provider.resource === resource && name !== CLIENT_PROVIDER) {
                providers.delete(name);
                removed += 1;
            }
        }
        return removed;
    }

    async function resolveIdentity(player: Player): Promise<{ principal: HmpCorePrincipal; provider: string }> {
        const ordered = [...providers.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
        for (const provider of ordered) {
            const result = await provider.resolve(player);
            if (result) return { principal: normalizePrincipal(result, provider.trust), provider: provider.name };
        }
        throw fail("HMP_CORE_IDENTITY_MISSING", "No usable identity was supplied for this player");
    }

    function clientIdentities(player: Player): HmpCorePrincipal[] {
        const identities: HmpCorePrincipal[] = [];
        for (const field of config.identityOrder || Object.keys(IDENTITY_FIELDS)) {
            const provider = IDENTITY_FIELDS[field];
            const subject = String((player as unknown as Record<string, unknown>)[field] ?? "").trim();
            if (provider && /^\d+$/.test(subject)) identities.push({ provider, subject, trust: "asserted" });
        }
        return identities;
    }

    registerProvider({
        name: CLIENT_PROVIDER,
        resource: "hmp-core",
        priority: -1000,
        trust: "asserted",
        resolve: (player: Player) => clientIdentities(player)[0] || null,
    });

    // A client announces only the IDs it detected on that launch, so Steam or Discord can be missing
    // from one session to the next. The account is found through any announced ID and remembers them all.
    async function accountForClientIdentities(identities: HmpCorePrincipal[], displayName: string): Promise<HmpCoreAccount> {
        const owners = await Promise.all(identities.map((identity) => repository.findIdentity(identity.provider, identity.subject)));
        let match = owners.findIndex(Boolean);
        if (match > 0) {
            // The IDs ranked above the match are new. An account that already holds a different ID of one
            // of those kinds belongs to someone else on a shared machine, not to this player.
            const held = new Set((await repository.listIdentities(owners[match]!.account.id)).map((identity) => identity.provider));
            if (identities.slice(0, match).some((identity) => held.has(identity.provider))) match = -1;
        }
        const primary = Math.max(match, 0);
        const account = await repository.findOrCreateAccount(identities[primary], displayName);
        for (const [index, identity] of identities.entries()) {
            const owner = owners[index];
            if (owner && owner.account.id !== account.id) {
                logWarn(`[hmp-core] Account ${account.id} shares a ${identity.provider} ID with account ${owner.account.id}; the accounts were not merged`);
            } else if (!owner && index !== primary) {
                try { await repository.linkIdentity(account.id, identity); }
                catch (error) { logError(`[hmp-core] could not link ${identity.provider} to account ${account.id}`, error); }
            }
        }
        return account;
    }

    function getSession(player: Player | number): HmpCoreSession<Player> | null {
        try { return sessionsByPlayer.get(playerId(player)) || null; }
        catch (_) { return null; }
    }

    function requireSession(player: Player | number): HmpCoreSession<Player> {
        const session = getSession(player);
        if (!session) throw fail("HMP_CORE_SESSION_MISSING", "Player does not have a ready hmp-core session");
        return session;
    }

    async function accountAllowsDuplicateSessions(accountId: number): Promise<boolean> {
        if (config.duplicateSession !== "allow-group") return false;
        const key = String(config.duplicateSessionGroup || "admin").trim().toLowerCase();
        const minimumGrade = Number(config.duplicateSessionMinimumGrade ?? 1);
        return (await repository.listAccountGroups(accountId)).some((group) => group.key === key && group.grade >= minimumGrade);
    }

    async function connect(player: Player): Promise<HmpCoreSession<Player> | null> {
        const id = playerId(player);
        if (startPromise) await startPromise;
        if (state !== "ready") throw fail("HMP_CORE_NOT_READY", `hmp-core is ${state}`);
        if (sessionsByPlayer.has(id)) return sessionsByPlayer.get(id) ?? null;

        const token = Symbol(`connect:${id}`);
        attempts.set(id, token);
        try {
            const { principal, provider } = await resolveIdentity(player);
            const displayName = String(player.nickname || `Player ${id}`).trim().slice(0, 80) || `Player ${id}`;
            const account = provider === CLIENT_PROVIDER
                ? await accountForClientIdentities(clientIdentities(player), displayName)
                : await repository.findOrCreateAccount(principal, displayName);
            if (attempts.get(id) !== token) return null;

            const existing = [...sessionsByPlayer.values()].filter((session) => session.account.id === account.id && session.playerId !== id);
            if (existing.length) {
                if (config.duplicateSession === "replace-old") {
                    for (const session of existing) {
                        await disconnect(session.player);
                        if (config.kickDuplicateSession && typeof session.player?.kick === "function") session.player.kick("Your account connected from another session.");
                    }
                } else if (!await accountAllowsDuplicateSessions(account.id)) {
                    if (config.kickDuplicateSession && typeof player.kick === "function") player.kick("This account is already connected.");
                    throw fail("HMP_CORE_DUPLICATE_SESSION", "This account already has an active session");
                }
            }

            const session = {
                player,
                playerId: id,
                account,
                principal,
                character: null,
                connectedAt: new Date().toISOString(),
            };
            sessionsByPlayer.set(id, session);
            await emit("hmp:session:ready", session);

            if (config.autoSelectSingleCharacter) {
                const available = await repository.listCharacters(account.id);
                if (available.length === 1) {
                    try { await selectCharacter(player, available[0].id); }
                    catch (error) {
                        // A player who left during the load gets null, as one who left before the session did.
                        if (sessionEnded(session)) return null;
                        // Another session holds the character, such as one whose load is still finishing after its
                        // player left. This session stays open and the player picks a character themselves.
                        if ((error as { code?: unknown })?.code !== "HMP_CORE_CHARACTER_IN_USE") throw error;
                        logWarn(`[hmp-core] Did not auto-select character ${available[0].id} for account ${account.id}: it is active in another session`);
                    }
                }
            }
            return session;
        } finally {
            if (attempts.get(id) === token) attempts.delete(id);
        }
    }

    async function unloadCharacter(player: Player | number): Promise<HmpCoreCharacter | null> {
        const session = requireSession(player);
        if (!session.character) return null;
        const character = session.character;
        unloading.add(session);
        // emit() reports a handler's error itself and never rejects.
        await emit("hmp:character:unloading", { session, character });
        unloading.delete(session);
        // A disconnect while the handlers ran has raised hmp:character:unloaded and released the claim.
        if (sessionEnded(session)) return character;
        session.character = null;
        releaseClaim(character.id, session);
        await emit("hmp:character:unloaded", { session, character });
        return character;
    }

    // The select of a session that just ended, if it is still loading, keeps its claim until its loading
    // handlers return. If they have not returned by the deadline, the claim is released anyway.
    function abandonSelect(session: HmpCoreSession<Player>): void {
        const pending = selecting.get(session);
        if (!pending || characterClaims.get(pending.characterId) !== session) return;
        pending.abandoned = setTimeout(() => {
            if (characterClaims.get(pending.characterId) !== session) return;
            characterClaims.delete(pending.characterId);
            logWarn(`[hmp-core] Released character ${pending.characterId}: its load was still running ${ABANDONED_LOAD_RELEASE_MS / 1000} s after its player disconnected`);
        }, ABANDONED_LOAD_RELEASE_MS);
    }

    async function disconnect(player: Player): Promise<boolean> {
        const id = playerId(player);
        attempts.delete(id);
        const session = sessionsByPlayer.get(id);
        if (!session) return false;
        // The player entity is gone once this handler yields, and a payload naming it can no longer be
        // copied to other resources (their handlers never ran). So every teardown event is raised up front.
        const teardown: Promise<void>[] = [];
        const character = session.character;
        if (character) {
            // An unload in progress raised hmp:character:unloading already and leaves the rest to this teardown.
            if (!unloading.has(session)) teardown.push(emit("hmp:character:unloading", { session, character }));
            session.character = null;
            releaseClaim(character.id, session);
            teardown.push(emit("hmp:character:unloaded", { session, character }));
        } else {
            abandonSelect(session);
        }
        sessionsByPlayer.delete(id);
        teardown.push(emit("hmp:session:ended", session));
        const displayName = String(player.nickname || session.account.displayName).slice(0, 80);
        await Promise.all(teardown);
        try { await repository.touchAccount(session.account.id, displayName); }
        catch (error) { logError("[hmp-core] could not update account activity", error); }
        return true;
    }

    async function listCharacters(player: Player | number): Promise<HmpCoreCharacter[]> {
        return repository.listCharacters(requireSession(player).account.id);
    }

    async function createCharacter(player: Player | number, input: { name: string; slot?: number }): Promise<HmpCoreCharacter> {
        const session = requireSession(player);
        const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
        if (name.length < 2 || name.length > 80) throw fail("HMP_CORE_INVALID_CHARACTER", "Character name must be 2-80 characters");
        const existing = await repository.listCharacters(session.account.id);
        if (existing.length >= Number(config.maxCharacters || 4)) throw fail("HMP_CORE_CHARACTER_LIMIT", "Character limit reached");
        const requested = input?.slot === undefined ? null : Number(input.slot);
        const occupied = new Set(existing.map((character) => character.slot));
        const slot = requested === null ? Array.from({ length: Number(config.maxCharacters || 4) }, (_, index) => index + 1).find((value) => !occupied.has(value)) : requested;
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > Number(config.maxCharacters || 4) || occupied.has(slot)) {
            throw fail("HMP_CORE_INVALID_CHARACTER_SLOT", "Character slot is unavailable");
        }
        const character = await repository.createCharacter(session.account.id, { name, slot });
        await emit("hmp:character:created", { session, character });
        return character;
    }

    async function selectCharacter(player: Player | number, characterId: number): Promise<HmpCoreCharacter> {
        const session = requireSession(player);
        const id = positiveId(characterId, "characterId");
        // One select at a time per session. A second pick of the same character shares the first one's result;
        // a pick of another is refused, so one player never has two loads running and none is left claimed.
        const running = selecting.get(session);
        if (running) {
            if (running.characterId === id) return running.result;
            throw fail("HMP_CORE_CHARACTER_LOADING", "Another character is still loading for this player");
        }
        const pending: PendingSelect = { characterId: id, result: loadCharacter(player, session, id) };
        selecting.set(session, pending);
        try { return await pending.result; }
        finally {
            if (pending.abandoned) clearTimeout(pending.abandoned);
            if (selecting.get(session) === pending) selecting.delete(session);
        }
    }

    async function loadCharacter(player: Player | number, session: HmpCoreSession<Player>, characterId: number): Promise<HmpCoreCharacter> {
        // The session is checked again after every await: a claim taken for a session that has ended would never
        // be released, and no event is raised for it once hmp:session:ended has been.
        const endedError = () => fail("HMP_CORE_SESSION_MISSING", "The player's session ended before the character was selected");
        const inUseError = () => fail("HMP_CORE_CHARACTER_IN_USE", "Character is active in another session");
        const character = await repository.findCharacterById(characterId);
        if (sessionEnded(session)) throw endedError();
        if (!character || character.accountId !== session.account.id || character.status !== "active") {
            throw fail("HMP_CORE_CHARACTER_NOT_FOUND", "Character does not belong to this account");
        }
        if (session.character?.id === character.id) return character;
        if (claimedElsewhere(character.id, session)) throw inUseError();
        if (session.character) {
            await unloadCharacter(player);
            if (sessionEnded(session)) throw endedError();
            // Another session of the account may have taken the character while this one unloaded its last.
            if (claimedElsewhere(character.id, session)) throw inUseError();
        }
        characterClaims.set(character.id, session);
        // emit() reports a handler's error itself and never rejects, so the load always reaches this check.
        await emit("hmp:character:loading", { session, character });
        if (sessionEnded(session)) {
            releaseClaim(character.id, session);
            throw endedError();
        }
        session.character = character;
        await emit("hmp:character:loaded", { session, character });
        // A disconnect during hmp:character:loaded unloaded the character and released its claim.
        if (sessionEnded(session)) throw endedError();
        await emit("hmp:character:selected", { session, character });
        return character;
    }

    async function deleteCharacter(player: Player | number, characterId: number): Promise<boolean> {
        const session = requireSession(player);
        const character = await repository.findCharacterById(positiveId(characterId, "characterId"));
        if (!character || character.accountId !== session.account.id || character.status !== "active") {
            throw fail("HMP_CORE_CHARACTER_NOT_FOUND", "Character does not belong to this account");
        }
        if (claimedElsewhere(character.id, session)) throw fail("HMP_CORE_CHARACTER_IN_USE", "Character is active in another session");
        if (session.character?.id === character.id) await unloadCharacter(player);
        const deleted = await repository.deleteCharacter(character.id);
        if (deleted) await emit("hmp:character:deleted", { session, character });
        return deleted;
    }

    function normalizeGroup(grade: number, metadata?: Record<string, unknown>): { grade: number; metadata: Record<string, unknown> } {
        const value = Number(grade);
        if (!Number.isSafeInteger(value)) throw fail("HMP_CORE_INVALID_GRADE", "Group grade must be an integer");
        const details = metadata && typeof metadata === "object" ? metadata : {};
        try { JSON.stringify(details); }
        catch (_) { throw fail("HMP_CORE_INVALID_METADATA", "Group metadata must be JSON serializable"); }
        return { grade: value, metadata: details };
    }

    async function effectiveGroups(player: Player | number): Promise<HmpCoreGroup[]> {
        const session = requireSession(player);
        const accountGroups = await repository.listAccountGroups(session.account.id);
        const characterGroups = session.character ? await repository.listCharacterGroups(session.character.id) : [];
        const merged = new Map(accountGroups.map((group) => [group.key, group]));
        for (const group of characterGroups) {
            const current = merged.get(group.key);
            if (!current || group.grade >= current.grade) merged.set(group.key, group);
        }
        return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    }

    async function setGroup(scope: Scope, ownerId: number, key: string, grade: number, metadata?: Record<string, unknown>): Promise<HmpCoreGroup> {
        const normalized = normalizeGroup(grade, metadata);
        const group = await repository.setGroup(scope, positiveId(ownerId, `${scope}Id`), normalizeKey(key, "group key"), normalized.grade, normalized.metadata);
        await emit("hmp:groups:changed", { action: "set", ownerId: Number(ownerId), group });
        return group;
    }

    async function removeGroup(scope: Scope, ownerId: number, key: string): Promise<boolean> {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "group key");
        const removed = await repository.removeGroup(scope, id, normalized);
        if (removed) await emit("hmp:groups:changed", { action: "remove", scope, ownerId: id, key: normalized });
        return removed;
    }

    function serializable<T>(value: T): T {
        if (value === undefined) throw fail("HMP_CORE_INVALID_METADATA", "Metadata value cannot be undefined");
        try {
            const json = JSON.stringify(value);
            if (json === undefined) throw new Error("not serializable");
        } catch (_) { throw fail("HMP_CORE_INVALID_METADATA", "Metadata value must be JSON serializable"); }
        return value;
    }

    async function setMetadata<T>(scope: Scope, ownerId: number, key: string, value: T): Promise<T> {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "metadata key");
        const result = await repository.setMetadata(scope, id, normalized, serializable(value));
        await emit("hmp:metadata:changed", { action: "set", scope, ownerId: id, key: normalized, value: result });
        return result;
    }

    async function deleteMetadata(scope: Scope, ownerId: number, key: string): Promise<boolean> {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "metadata key");
        const removed = await repository.deleteMetadata(scope, id, normalized);
        if (removed) await emit("hmp:metadata:changed", { action: "delete", scope, ownerId: id, key: normalized });
        return removed;
    }

    async function start(): Promise<boolean> {
        if (state === "ready") return true;
        if (startPromise) return startPromise;
        state = "starting";
        lastError = "";
        startedAt = Date.now();
        startPromise = (async () => {
            try {
                if (!await database.ready()) throw fail("HMP_CORE_DATABASE_UNAVAILABLE", "hmp-mysql is not ready");
                await database.migrate("hmp-core", migrations);
                state = "ready";
                const players = listPlayers();
                for (const player of Array.isArray(players) ? players : []) connect(player).catch((error) => logError("[hmp-core] existing player setup failed", error));
                return true;
            } catch (error) {
                state = "degraded";
                lastError = error instanceof Error ? error.message : String(error);
                throw error;
            } finally {
                startPromise = null;
            }
        })();
        return startPromise;
    }

    async function stop(): Promise<void> {
        state = "stopped";
        attempts.clear();
        for (const session of [...sessionsByPlayer.values()]) await disconnect(session.player);
    }

    const status = (): HmpCoreStatus => Object.freeze({ state, lastError, sessions: sessionsByPlayer.size, identityProviders: providers.size, uptimeMs: Date.now() - startedAt });
    const identity = Object.freeze({ register: registerProvider, unregister: unregisterProvider, list: () => [...providers.values()].map(({ resolve, ...entry }) => entry), resolve: async (player: Player) => (await resolveIdentity(player)).principal });
    const accounts = Object.freeze({
        getByPlayer: (player: Player | number) => getSession(player)?.account || null,
        getById: (id: number) => repository.findAccountById(positiveId(id, "accountId")),
        linkIdentity: (id: number, principal: HmpCorePrincipal) => repository.linkIdentity(positiveId(id, "accountId"), normalizePrincipal(principal)),
    });
    const sessions = Object.freeze({ get: getSession, all: () => [...sessionsByPlayer.values()], isReady: (player: Player | number) => Boolean(getSession(player)) });
    const characters = Object.freeze({
        list: listCharacters,
        create: createCharacter,
        select: selectCharacter,
        active: (player: Player | number) => getSession(player)?.character || null,
        unload: unloadCharacter,
        delete: deleteCharacter,
        limit: () => Number(config.maxCharacters || 4),
    });
    const groups = Object.freeze({
        listAccount: (id: number) => repository.listAccountGroups(positiveId(id, "accountId")),
        listCharacter: (id: number) => repository.listCharacterGroups(positiveId(id, "characterId")),
        effective: effectiveGroups,
        async has(player: Player | number, key: string, minimumGrade = 0) {
            const grade = Number(minimumGrade);
            if (!Number.isSafeInteger(grade)) throw fail("HMP_CORE_INVALID_GRADE", "Minimum group grade must be an integer");
            return (await effectiveGroups(player)).some((group) => group.key === normalizeKey(key, "group key") && group.grade >= grade);
        },
        setAccount: (id: number, key: string, grade: number, metadata?: Record<string, unknown>) => setGroup("account", id, key, grade, metadata),
        setCharacter: (id: number, key: string, grade: number, metadata?: Record<string, unknown>) => setGroup("character", id, key, grade, metadata),
        removeAccount: (id: number, key: string) => removeGroup("account", id, key),
        removeCharacter: (id: number, key: string) => removeGroup("character", id, key),
    });
    const metadata = Object.freeze({
        getAccount: (id: number, key: string) => repository.getMetadata("account", positiveId(id, "accountId"), normalizeKey(key, "metadata key")),
        getCharacter: (id: number, key: string) => repository.getMetadata("character", positiveId(id, "characterId"), normalizeKey(key, "metadata key")),
        setAccount: <T>(id: number, key: string, value: T) => setMetadata("account", id, key, value),
        setCharacter: <T>(id: number, key: string, value: T) => setMetadata("character", id, key, value),
        deleteAccount: (id: number, key: string) => deleteMetadata("account", id, key),
        deleteCharacter: (id: number, key: string) => deleteMetadata("character", id, key),
    });

    return Object.freeze({ status, identity, accounts, sessions, characters, groups, metadata, start, stop, connect, disconnect, removeIdentityProvidersForResource });
}

export = { createCore, normalizePrincipal };
// TypeScript source.

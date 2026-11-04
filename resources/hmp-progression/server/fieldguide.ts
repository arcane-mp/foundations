import fieldGuideModule = require("../shared/fieldguide");
import serviceModule = require("./service");
import type { FieldGuideDependencies, FieldGuideSync, Player } from "./internal";

const { maximumSnapshotBytes, utf8Length, normalizeSnapshot } = fieldGuideModule;
const { payloadObject } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One character load's restore: the client must acknowledge it before any save is taken. */
interface Load {
    characterId: number;
    token: number;
    phase: "loading" | "restoring" | "watching" | "failed";
    message: string;
}

interface Connection {
    loads: number;
    unsupported: boolean;
    current: Load | null;
}

function createFieldGuideSync(dependencies: FieldGuideDependencies): FieldGuideSync {
    const { repository, core, logger, enabled, ready } = dependencies;
    const connections = new Map<number, Connection>();
    // Latest accepted snapshot per character, written one at a time so an older save never lands last.
    const pending = new Map<number, string>();
    let writing: Promise<void> | null = null;
    let sequence = 0;
    let warned = false;

    function connectionFor(player: Player): Connection {
        const id = Number(player.id);
        let connection = connections.get(id);
        if (!connection) connections.set(id, connection = { loads: 0, unsupported: false, current: null });
        return connection;
    }
    function selected(player: Player, load: Load | null | undefined): load is Load {
        return !!load && core.characters.active(player)?.id === load.characterId;
    }

    async function characterLoaded(player: Player): Promise<void> {
        if (!enabled) return;
        const character = core.characters.active(player);
        if (!character) return;
        const connection = connectionFor(player);
        if (connection.unsupported) return;
        const first = connection.loads++ === 0;
        const load: Load = { characterId: character.id, token: ++sequence, phase: "loading", message: "" };
        connection.current = load;
        try {
            await ready();
            const stored = await repository.fieldGuide(character.id);
            if (connection.current !== load || connections.get(Number(player.id)) !== connection || !selected(player, load)) return;
            const snapshot = stored === null ? null : normalizeSnapshot(JSON.parse(stored));
            // With nothing saved, the first character adopts what the game holds; a later one would inherit the previous character's.
            const restore = stored !== null || !first;
            load.message = JSON.stringify({ characterId: character.id, token: load.token, restore, snapshot });
            load.phase = "restoring";
            player.emit!("hmp-progression:field-guide", load.message);
        } catch (error) {
            if (connection.current === load) load.phase = "failed";
            logger.warn(`Could not load #${player.id}'s Field Guide: ${messageOf(error)}`);
        }
    }

    function characterUnloaded(player: Player): void {
        const connection = connections.get(Number(player.id));
        if (connection) connection.current = null;
    }

    // The client script may not have been listening when the character loaded.
    function worldReady(player: Player): void {
        const load = connections.get(Number(player.id))?.current;
        if (load?.phase === "restoring" && selected(player, load)) player.emit!("hmp-progression:field-guide", load.message);
    }

    function result(player: Player, payload: unknown): void {
        const value = payloadObject(payload);
        const connection = connections.get(Number(player.id));
        const load = connection?.current;
        if (!value || !connection || !load || load.phase !== "restoring" || !selected(player, load)) return;
        if (Number(value.token) !== load.token || Number(value.characterId) !== load.characterId) return;
        if (value.unsupported === true) {
            connection.unsupported = true;
            load.phase = "failed";
            if (!warned) {
                warned = true;
                logger.warn("fieldGuide needs HogwartsMP 1.11 or newer for FieldGuide on the client; this host keeps no Field Guide progress");
            }
            return;
        }
        const reason = typeof value.reason === "string" ? value.reason.slice(0, 191) : "";
        if (reason || typeof value.ok !== "boolean") {
            load.phase = "failed";
            logger.warn(`Could not restore #${player.id}'s Field Guide for character ${load.characterId}: ${reason || "no result"}; its saved Field Guide is kept`);
            return;
        }
        load.phase = "watching";
        const mismatches = Array.isArray(value.mismatches) ? value.mismatches.filter((entry): entry is string => typeof entry === "string") : [];
        if (!value.ok && mismatches.length) {
            logger.warn(`#${player.id}'s Field Guide for character ${load.characterId} was restored with ${mismatches.length} difference(s): ${mismatches.slice(0, 5).map((entry) => entry.slice(0, 120)).join("; ")}`);
        }
        if (value.needsTravel === true) {
            logger.info(`#${player.id}'s Field Guide was restored into a loaded world; Revelio pages and map icons catch up on the next map load`);
        }
    }

    function save(player: Player, payload: unknown): void {
        if (typeof payload === "string" && utf8Length(payload) > maximumSnapshotBytes + 1024) {
            logger.warn(`Refused #${player.id}'s Field Guide: larger than ${maximumSnapshotBytes} bytes`);
            return;
        }
        const value = payloadObject(payload);
        const load = connections.get(Number(player.id))?.current;
        if (!value || !load || load.phase !== "watching" || !selected(player, load)) return;
        if (Number(value.token) !== load.token || Number(value.characterId) !== load.characterId) return;
        let json: string;
        try { json = JSON.stringify(normalizeSnapshot(value.snapshot)); }
        catch (error) {
            logger.warn(`Refused #${player.id}'s Field Guide: ${messageOf(error)}`);
            return;
        }
        if (utf8Length(json) > maximumSnapshotBytes) {
            logger.warn(`Refused #${player.id}'s Field Guide: larger than ${maximumSnapshotBytes} bytes`);
            return;
        }
        pending.set(load.characterId, json);
        flush();
    }

    function flush(): void {
        const next = pending.entries().next();
        if (writing || next.done) return;
        const [characterId, json] = next.value;
        pending.delete(characterId);
        // No ready() wait: a save follows a load that already had the schema, and must still land while stopping.
        writing = (async () => {
            try {
                await repository.saveFieldGuide(characterId, json);
            } catch (error) {
                logger.warn(`Could not save character ${characterId}'s Field Guide: ${messageOf(error)}`);
            }
        })().finally(() => { writing = null; flush(); });
    }

    function disconnect(player: Player): void {
        connections.delete(Number(player.id));
    }

    return {
        characterLoaded, characterUnloaded, worldReady, result, save, disconnect,
        idle: async () => { while (writing) await writing; },
    };
}

export = { createFieldGuideSync };

import normalizeModule = require("../shared/normalize");
import type { FlooFlameDependencies, FlooFlames, Player } from "./internal";

const { positiveId, flameId } = normalizeModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const key = (id: string): string => id.toLowerCase();

/** A flame lit in a player's game this connection, and the character it was lit for (null: none selected). */
interface ShownFlame { id: string; characterId: number | null }

function createFlooFlames(dependencies: FlooFlameDependencies): FlooFlames {
    const { repository, core, logger, enabled, ready } = dependencies;
    // The game keeps every flame lit for the whole connection, so a later character must have the earlier one's dimmed.
    const shown = new Map<number, Map<string, ShownFlame>>();
    let warned = false;

    function supported(player: Player): boolean {
        if (typeof player.setFastTravelUnlocked === "function") return true;
        if (!warned) {
            warned = true;
            logger.warn("flooFlames needs HogwartsMP 1.11 or newer for player.setFastTravelUnlocked; this host keeps no Floo flames");
        }
        return false;
    }
    function shownFor(player: Player): Map<string, ShownFlame> {
        const id = Number(player.id);
        let flames = shown.get(id);
        if (!flames) shown.set(id, flames = new Map());
        return flames;
    }
    function apply(player: Player, ids: string[], lit: boolean): void {
        if (!ids.length) return;
        try { player.setFastTravelUnlocked!(ids, lit); }
        catch (error) { logger.warn(`Could not ${lit ? "light" : "dim"} #${player.id}'s Floo flames: ${messageOf(error)}`); }
    }

    async function characterLoaded(player: Player): Promise<void> {
        if (!enabled || !supported(player)) return;
        const character = core.characters.active(player);
        if (!character) return;
        try {
            await ready();
            const stored = await repository.flooFlames(character.id);
            if (core.characters.active(player)?.id !== character.id) return;
            const flames = shownFor(player);
            const keep = new Set(stored.map(key));
            const dim: string[] = [];
            for (const [name, flame] of flames) {
                if (keep.has(name) || flame.characterId === character.id) continue;
                dim.push(flame.id);
                flames.delete(name);
            }
            for (const id of stored) flames.set(key(id), { id, characterId: character.id });
            apply(player, dim, false);
            apply(player, stored, true);
        } catch (error) {
            logger.warn(`Could not restore #${player.id}'s Floo flames: ${messageOf(error)}`);
        }
    }

    async function unlocked(player: Player, unlock: unknown): Promise<void> {
        if (!enabled) return;
        let id: string;
        try { id = flameId(unlock && typeof unlock === "object" ? (unlock as { destinationId?: unknown }).destinationId : undefined); }
        catch { return; }
        const character = core.characters.active(player);
        shownFor(player).set(key(id), { id, characterId: character?.id ?? null });
        if (!character) return;
        await ready();
        await repository.lightFlooFlames(character.id, [id]);
    }

    function disconnect(player: Player): void {
        shown.delete(Number(player.id));
    }

    function assertEnabled(): void {
        if (!enabled) throw new Error("hmp-progression flooFlames is off");
    }
    function characterOf(target: Player | number): number {
        if (typeof target === "number") return positiveId(target, "character id");
        const character = target ? core.characters.active(target) : null;
        if (!character) throw new Error("Select a character before using Floo flames");
        return character.id;
    }
    function flameIds(value: unknown): string[] {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || list.length > 128) throw new TypeError("Floo flame ids must name 1 to 128 flames");
        const unique = new Map<string, string>();
        for (const entry of list) {
            const id = flameId(entry);
            if (!unique.has(key(id))) unique.set(key(id), id);
        }
        return [...unique.values()];
    }

    async function list(target: Player | number): Promise<string[]> {
        assertEnabled();
        const characterId = characterOf(target);
        await ready();
        return repository.flooFlames(characterId);
    }

    async function set(target: Player | number, rawIds: string | string[], lit = true): Promise<string[]> {
        assertEnabled();
        if (typeof lit !== "boolean") throw new TypeError("lit must be a boolean");
        const characterId = characterOf(target);
        const ids = flameIds(rawIds);
        await ready();
        if (lit) await repository.lightFlooFlames(characterId, ids);
        else await repository.dimFlooFlames(characterId, ids);
        const player = core.sessions.all().find((session) => session.character?.id === characterId)?.player || null;
        if (player && typeof player.setFastTravelUnlocked === "function") {
            const flames = shownFor(player);
            for (const id of ids) {
                if (lit) flames.set(key(id), { id, characterId });
                else flames.delete(key(id));
            }
            apply(player, ids, lit);
        }
        return repository.flooFlames(characterId);
    }

    return { api: Object.freeze({ list, set }), characterLoaded, unlocked, disconnect };
}

export = { createFlooFlames };

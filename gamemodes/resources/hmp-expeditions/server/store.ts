import type { HmpExpedition, HmpExpeditionEnemy, HmpExpeditionStage, HmpExpeditionVector3 } from "../types";
import { EXPEDITION_ID, LIMITS, normalizeExpedition, normalizeStage } from "./config";

/** The part of hmp-worldstate the expeditions need; values are at most 256 characters. */
export interface KeyValueStore {
    get(system: string, key: string): string | null;
    list(system: string): Array<{ key: string; value: string }>;
    set(system: string, key: string, value: string): Promise<boolean>;
    delete(system: string, key: string): Promise<boolean>;
}

export const EXPEDITIONS_SYSTEM = "expeditions";
export const RECORDS_SYSTEM = "expedition-records";
const VALUE_LIMIT = 256;

function parseJson(value: string | null): unknown {
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
}

/** `<id>:meta` holds the label, map, entrance and reward; `<id>:<n>` stage n, so each value fits 256 characters. */
export function serializeExpedition(expedition: HmpExpedition): Array<[string, string]> {
    const { entrance } = expedition;
    const entries: Array<[string, string]> = [[`${expedition.id}:meta`, JSON.stringify({
        l: expedition.label, a: expedition.areaId, x: expedition.experience, c: expedition.stages.length,
        e: [entrance.x, entrance.y, entrance.z, Math.round(entrance.yaw)],
    })]];
    expedition.stages.forEach((stage, index) => entries.push([`${expedition.id}:${index}`, JSON.stringify({
        p: [stage.x, stage.y, stage.z], e: stage.enemies.map((enemy) => [enemy.id, enemy.count]), b: stage.boss ? [stage.boss.id, stage.boss.health] : null,
    })]));
    for (const [key, value] of entries) {
        if (value.length > VALUE_LIMIT) throw new RangeError(`${key} is too long to store; split the stage into two`);
    }
    return entries;
}

export function parseWorldExpedition(id: string, read: (key: string) => string | null): HmpExpedition {
    const meta = parseJson(read(`${id}:meta`)) as { l?: unknown; a?: unknown; x?: unknown; c?: unknown; e?: unknown } | null;
    if (!meta) throw new RangeError(`expedition ${id} has no metadata`);
    const count = Number(meta.c);
    if (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.stages) throw new RangeError(`expedition ${id} has a bad stage count`);
    const entrance = Array.isArray(meta.e) ? meta.e : [];
    const stages = Array.from({ length: count }, (_, index) => {
        const stage = parseJson(read(`${id}:${index}`)) as { p?: unknown; e?: unknown; b?: unknown } | null;
        if (!stage || !Array.isArray(stage.p)) throw new RangeError(`expedition ${id} is missing stage ${index}`);
        const enemies = (Array.isArray(stage.e) ? stage.e : []).map((entry) => Array.isArray(entry) ? { id: entry[0], count: entry[1] } : {});
        const boss = Array.isArray(stage.b) ? { id: stage.b[0], health: stage.b[1] } : null;
        return { x: stage.p[0], y: stage.p[1], z: stage.p[2], enemies, boss };
    });
    return normalizeExpedition(id, { label: meta.l, areaId: meta.a, experience: meta.x, entrance: { x: entrance[0], y: entrance[1], z: entrance[2], yaw: entrance[3] }, stages }, "world");
}

export function createExpeditionStore(options: { store: KeyValueStore; configured: HmpExpedition[]; warn?(message: string): void }) {
    const { store } = options;
    const configured = new Map(options.configured.map((expedition) => [expedition.id, expedition]));

    function get(id: string): HmpExpedition | null {
        const key = String(id || "").trim().toLowerCase();
        const fromConfig = configured.get(key);
        if (fromConfig) return fromConfig;
        if (!EXPEDITION_ID.test(key) || !store.get(EXPEDITIONS_SYSTEM, `${key}:meta`)) return null;
        try { return parseWorldExpedition(key, (entry) => store.get(EXPEDITIONS_SYSTEM, entry)); }
        catch (error) { options.warn?.(`Expedition ${key} is unreadable: ${error instanceof Error ? error.message : String(error)}`); return null; }
    }

    function list(): HmpExpedition[] {
        const world = store.list(EXPEDITIONS_SYSTEM).map((entry) => entry.key).filter((key) => key.endsWith(":meta")).map((key) => key.slice(0, -5));
        return [...new Set([...configured.keys(), ...world])].sort().flatMap((id) => { const expedition = get(id); return expedition ? [expedition] : []; });
    }

    async function save(value: Omit<HmpExpedition, "source">): Promise<HmpExpedition> {
        if (configured.has(value.id)) throw new Error(`Expedition ${value.id} comes from data/hmp-expeditions.json; edit it there`);
        const expedition = normalizeExpedition(value.id, value, "world");
        const entries = serializeExpedition(expedition);
        const previous = Number((parseJson(store.get(EXPEDITIONS_SYSTEM, `${value.id}:meta`)) as { c?: unknown } | null)?.c) || 0;
        // Stages first and the metadata last, so a reader never sees a count with stages not yet written.
        for (const [key, entry] of entries.slice(1)) await store.set(EXPEDITIONS_SYSTEM, key, entry);
        await store.set(EXPEDITIONS_SYSTEM, entries[0][0], entries[0][1]);
        for (let index = expedition.stages.length; index < previous; index++) await store.delete(EXPEDITIONS_SYSTEM, `${value.id}:${index}`);
        return expedition;
    }

    async function remove(id: string): Promise<boolean> {
        if (configured.has(id)) throw new Error(`Expedition ${id} comes from data/hmp-expeditions.json; remove it there`);
        const keys = store.list(EXPEDITIONS_SYSTEM).map((entry) => entry.key).filter((key) => key.startsWith(`${id}:`));
        keys.sort((a, b) => Number(b.endsWith(":meta")) - Number(a.endsWith(":meta")));
        for (const key of keys) await store.delete(EXPEDITIONS_SYSTEM, key);
        await store.delete(RECORDS_SYSTEM, id);
        return keys.length > 0;
    }

    function record(id: string): { timeMs: number; party: string; at: string } | null {
        const value = parseJson(store.get(RECORDS_SYSTEM, id)) as { t?: unknown; n?: unknown; at?: unknown } | null;
        const timeMs = Number(value?.t);
        return value && Number.isSafeInteger(timeMs) && timeMs > 0 ? { timeMs, party: String(value.n || "?"), at: String(value.at || "") } : null;
    }

    async function submit(id: string, timeMs: number, party: string[], at: string): Promise<boolean> {
        const current = record(id);
        if (current && current.timeMs <= timeMs) return false;
        let names = party.join(", ");
        if (names.length > 160) names = `${names.slice(0, 157)}...`;
        await store.set(RECORDS_SYSTEM, id, JSON.stringify({ t: Math.round(timeMs), n: names, at }));
        return true;
    }

    return { get, list, save, remove, record, submit };
}

export type ExpeditionStore = ReturnType<typeof createExpeditionStore>;

export interface EditorPlayer {
    id: number;
    position: HmpExpeditionVector3;
    location?(): { areaId: string; regionId: string } | null;
}

/** In-game authoring: the editor stands where the party gathers, then at each fight, and names its enemies. */
export function createEditor(options: { store: ExpeditionStore; isEnemy(id: string): boolean }) {
    const drafts = new Map<number, Omit<HmpExpedition, "source">>();

    function here(player: EditorPlayer): HmpExpeditionVector3 {
        const { x, y, z } = player.position || { x: NaN, y: NaN, z: NaN };
        if (![x, y, z].every(Number.isFinite)) throw new Error("Your position is unknown; try again in a moment");
        return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    }

    function draft(player: EditorPlayer) {
        const value = drafts.get(player.id);
        if (!value) throw new Error("You are not editing an expedition; start with: edit new <id> [label]");
        return value;
    }

    /** Reads "Goblin_Melee x3 Spider_Small" into enemies, every id checked against the hmp-npcs catalog. */
    function enemies(words: string[]): HmpExpeditionEnemy[] {
        const list: HmpExpeditionEnemy[] = [];
        for (let index = 0; index < words.length; index++) {
            const id = words[index];
            if (!options.isEnemy(id)) throw new Error(`'${id}' is not in the hmp-npcs catalog`);
            const next = /^x(\d{1,2})$/i.exec(words[index + 1] || "");
            const count = next ? Number(next[1]) : 1;
            if (next) index += 1;
            if (count < 1 || count > LIMITS.countPerEnemy) throw new Error(`A count is 1-${LIMITS.countPerEnemy}`);
            list.push({ id, count });
        }
        return list;
    }

    function begin(player: EditorPlayer, id: string, label?: string) {
        const key = String(id || "").trim().toLowerCase();
        if (!EXPEDITION_ID.test(key)) throw new Error("An expedition id is 1-32 lowercase letters, numbers, hyphens or underscores");
        const existing = options.store.get(key);
        if (existing?.source === "config") throw new Error(`Expedition ${key} comes from data/hmp-expeditions.json; edit it there`);
        const name = (label || existing?.label || key).replace(/\s+/g, " ").trim().slice(0, LIMITS.label);
        const value = existing
            ? { ...existing, label: name, stages: existing.stages.map((stage) => ({ ...stage, enemies: stage.enemies.map((enemy) => ({ ...enemy })) })) }
            : { id: key, label: name, areaId: player.location?.()?.areaId || "Overland", entrance: { ...here(player), yaw: 0 }, stages: [], experience: 500 };
        drafts.set(player.id, value);
        return value;
    }

    /** A fight where the editor stands: `[enemy [xN]]...` and optionally `boss <id> [health]`. */
    function stage(player: EditorPlayer, words: string[]) {
        const value = draft(player);
        if (value.stages.length >= LIMITS.stages) throw new Error(`An expedition holds at most ${LIMITS.stages} stages`);
        const bossAt = words.findIndex((word) => word.toLowerCase() === "boss");
        const pack = enemies(bossAt < 0 ? words : words.slice(0, bossAt));
        let boss: HmpExpeditionStage["boss"] = null;
        if (bossAt >= 0) {
            const id = words[bossAt + 1];
            if (!id || !options.isEnemy(id)) throw new Error(`'${id || ""}' is not in the hmp-npcs catalog`);
            boss = { id, health: words[bossAt + 2] === undefined ? 2000 : Number(words[bossAt + 2]) };
        }
        const built = normalizeStage({ ...here(player), enemies: pack, boss }, `stage ${value.stages.length + 1}`);
        serializeExpedition({ ...value, stages: [built], source: "world" });
        value.stages.push(built);
        return value;
    }

    function undo(player: EditorPlayer) {
        const value = draft(player);
        if (!value.stages.pop()) throw new Error("The draft has no stages");
        return value;
    }

    function entrance(player: EditorPlayer, yaw?: number) {
        const value = draft(player);
        const facing = yaw ?? value.entrance.yaw;
        if (!Number.isFinite(facing)) throw new Error("The heading must be a number of degrees");
        value.entrance = { ...here(player), yaw: ((facing % 360) + 360) % 360 };
        return value;
    }

    function reward(player: EditorPlayer, experience: number) {
        const value = draft(player);
        if (!Number.isSafeInteger(experience) || experience < 0 || experience > 1_000_000) throw new Error("Experience is 0-1000000");
        value.experience = experience;
        return value;
    }

    async function save(player: EditorPlayer): Promise<HmpExpedition> {
        const value = draft(player);
        if (!value.stages.length) throw new Error("An expedition needs at least one stage");
        const saved = await options.store.save(value);
        drafts.delete(player.id);
        return saved;
    }

    return {
        begin, stage, undo, entrance, reward, save,
        discard: (player: EditorPlayer) => drafts.delete(player.id),
        get: (player: EditorPlayer) => drafts.get(player.id) || null,
        forget: (playerId: number) => drafts.delete(playerId),
    };
}

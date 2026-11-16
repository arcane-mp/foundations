import type { HmpRacingCheckpoint, HmpRacingRecord, HmpRacingTrack } from "../types";
import { LIMITS, TRACK_ID, checkpoint, normalizeTrack } from "./config";

/** The part of hmp-worldstate the tracks and records need; values are at most 256 characters. */
export interface KeyValueStore {
    get(system: string, key: string): string | null;
    list(system: string): Array<{ key: string; value: string }>;
    set(system: string, key: string, value: string): Promise<boolean>;
    delete(system: string, key: string): Promise<boolean>;
}

export const TRACKS_SYSTEM = "racing-tracks";
export const RECORDS_SYSTEM = "racing-records";

/**
 * A track authored in game lives in hmp-worldstate, one key per checkpoint, since a value holds at most 256
 * characters: `<id>:meta` holds the label, laps, map and start, and `<id>:<n>` checkpoint n.
 */
function parseJson(value: string | null): unknown {
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
}

export function serializeTrack(track: HmpRacingTrack): Array<[string, string]> {
    const entries: Array<[string, string]> = [[`${track.id}:meta`, JSON.stringify({
        l: track.label, n: track.laps, a: track.areaId, c: track.checkpoints.length,
        s: [track.start.x, track.start.y, track.start.z, Math.round(track.start.yaw)],
    })]];
    track.checkpoints.forEach((gate, index) => entries.push([`${track.id}:${index}`, JSON.stringify([gate.x, gate.y, gate.z, gate.radius])]));
    return entries;
}

export function parseWorldTrack(id: string, read: (key: string) => string | null): HmpRacingTrack {
    const meta = parseJson(read(`${id}:meta`)) as { l?: unknown; n?: unknown; a?: unknown; c?: unknown; s?: unknown } | null;
    if (!meta) throw new RangeError(`track ${id} has no metadata`);
    const count = Number(meta.c);
    if (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.checkpoints[1]) throw new RangeError(`track ${id} has a bad checkpoint count`);
    const start = Array.isArray(meta.s) ? meta.s : [];
    const checkpoints = Array.from({ length: count }, (_, index) => {
        const gate = parseJson(read(`${id}:${index}`));
        if (!Array.isArray(gate)) throw new RangeError(`track ${id} is missing checkpoint ${index}`);
        return { x: gate[0], y: gate[1], z: gate[2], radius: gate[3] };
    });
    return normalizeTrack(id, { label: meta.l, laps: meta.n, areaId: meta.a, start: { x: start[0], y: start[1], z: start[2], yaw: start[3] }, checkpoints }, "world");
}

/** A track being authored: the editor's own until saved. */
export interface TrackDraft {
    id: string;
    label: string;
    laps: number;
    areaId: string;
    start: HmpRacingTrack["start"];
    checkpoints: HmpRacingCheckpoint[];
}

export function createTrackStore(options: {
    store: KeyValueStore;
    configTracks: HmpRacingTrack[];
    warn?(message: string): void;
}) {
    const { store } = options;
    const configured = new Map(options.configTracks.map((track) => [track.id, track]));

    function worldIds(): string[] {
        return [...new Set(store.list(TRACKS_SYSTEM).map((entry) => entry.key).filter((key) => key.endsWith(":meta")).map((key) => key.slice(0, -5)))]
            .filter((id) => TRACK_ID.test(id));
    }

    function get(id: string): HmpRacingTrack | null {
        const key = String(id || "").trim().toLowerCase();
        const fromConfig = configured.get(key);
        if (fromConfig) return fromConfig;
        if (!TRACK_ID.test(key) || !store.get(TRACKS_SYSTEM, `${key}:meta`)) return null;
        try { return parseWorldTrack(key, (entry) => store.get(TRACKS_SYSTEM, entry)); }
        catch (error) { options.warn?.(`Track ${key} is unreadable: ${error instanceof Error ? error.message : String(error)}`); return null; }
    }

    function list(): HmpRacingTrack[] {
        const ids = new Set([...configured.keys(), ...worldIds()]);
        return [...ids].sort().flatMap((id) => { const track = get(id); return track ? [track] : []; });
    }

    async function save(draft: TrackDraft): Promise<HmpRacingTrack> {
        if (configured.has(draft.id)) throw new Error(`Track ${draft.id} comes from data/hmp-racing.json; edit it there`);
        const track = normalizeTrack(draft.id, draft, "world");
        const previous = Number((parseJson(store.get(TRACKS_SYSTEM, `${draft.id}:meta`)) as { c?: unknown } | null)?.c) || 0;
        // Checkpoints first and the metadata last, so a reader never sees a count with gates not yet written.
        const entries = serializeTrack(track);
        for (const [key, value] of entries.slice(1)) await store.set(TRACKS_SYSTEM, key, value);
        await store.set(TRACKS_SYSTEM, entries[0][0], entries[0][1]);
        for (let index = track.checkpoints.length; index < previous; index++) await store.delete(TRACKS_SYSTEM, `${draft.id}:${index}`);
        return track;
    }

    async function remove(id: string): Promise<boolean> {
        if (configured.has(id)) throw new Error(`Track ${id} comes from data/hmp-racing.json; remove it there`);
        const keys = store.list(TRACKS_SYSTEM).map((entry) => entry.key).filter((key) => key.startsWith(`${id}:`));
        // The metadata first, so a half-removed track is never listed.
        keys.sort((a, b) => Number(b.endsWith(":meta")) - Number(a.endsWith(":meta")));
        for (const key of keys) await store.delete(TRACKS_SYSTEM, key);
        await store.delete(RECORDS_SYSTEM, id);
        return keys.length > 0;
    }

    function record(id: string): HmpRacingRecord | null {
        const value = parseJson(store.get(RECORDS_SYSTEM, id)) as { t?: unknown; c?: unknown; n?: unknown; at?: unknown } | null;
        const timeMs = Number(value?.t);
        if (!value || !Number.isSafeInteger(timeMs) || timeMs <= 0) return null;
        const characterId = Number(value.c);
        return { track: id, timeMs, characterId: Number.isSafeInteger(characterId) && characterId > 0 ? characterId : null, name: String(value.n || "?"), at: String(value.at || "") };
    }

    /** Stores a time when it beats the track's record; true when it did. */
    async function submit(id: string, timeMs: number, characterId: number | null, name: string, at: string): Promise<boolean> {
        const current = record(id);
        if (current && current.timeMs <= timeMs) return false;
        await store.set(RECORDS_SYSTEM, id, JSON.stringify({ t: Math.round(timeMs), c: characterId, n: name.slice(0, 64), at }));
        return true;
    }

    return { get, list, save, remove, record, submit, checkpoint };
}

export type TrackStore = ReturnType<typeof createTrackStore>;

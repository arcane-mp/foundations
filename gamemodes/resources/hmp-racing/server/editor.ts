import type { HmpRacingTrack, HmpRacingVector3 } from "../types";
import { LIMITS, TRACK_ID } from "./config";
import type { TrackDraft, TrackStore } from "./tracks";

export interface EditorPlayer {
    id: number;
    position: HmpRacingVector3;
    location?(): { areaId: string; regionId: string } | null;
}

/**
 * In-game track authoring: an editor flies the course and drops a checkpoint where they hover. A draft is the
 * editor's own until they save it into hmp-worldstate.
 */
export function createEditor(options: { tracks: TrackStore; defaultRadiusCm: number; yaw?(player: EditorPlayer): number | null }) {
    const { tracks } = options;
    const drafts = new Map<number, TrackDraft>();

    function here(player: EditorPlayer): HmpRacingVector3 {
        const { x, y, z } = player.position || { x: NaN, y: NaN, z: NaN };
        if (![x, y, z].every(Number.isFinite)) throw new Error("Your position is unknown; try again in a moment");
        return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
    }

    function draft(player: EditorPlayer): TrackDraft {
        const value = drafts.get(player.id);
        if (!value) throw new Error("You are not editing a track; start with: edit new <id> [laps] [label]");
        return value;
    }

    /** Starts a draft at the editor's position, or opens an existing in-game track to change it. */
    function begin(player: EditorPlayer, id: string, laps?: number, label?: string): TrackDraft {
        const key = String(id || "").trim().toLowerCase();
        if (!TRACK_ID.test(key)) throw new Error("A track id is 1-32 lowercase letters, numbers, hyphens or underscores");
        const existing = tracks.get(key);
        if (existing?.source === "config") throw new Error(`Track ${key} comes from data/hmp-racing.json; edit it there`);
        const lapCount = laps === undefined ? existing?.laps ?? 1 : laps;
        if (!Number.isSafeInteger(lapCount) || lapCount < LIMITS.laps[0] || lapCount > LIMITS.laps[1]) throw new Error(`Laps must be ${LIMITS.laps[0]}-${LIMITS.laps[1]}`);
        const name = (label || existing?.label || key).replace(/\s+/g, " ").trim().slice(0, LIMITS.label);
        const value: TrackDraft = existing
            ? { id: key, label: name, laps: lapCount, areaId: existing.areaId, start: { ...existing.start }, checkpoints: existing.checkpoints.map((gate) => ({ ...gate })) }
            : { id: key, label: name, laps: lapCount, areaId: player.location?.()?.areaId || "Overland", start: { ...here(player), yaw: options.yaw?.(player) ?? 0 }, checkpoints: [] };
        drafts.set(player.id, value);
        return value;
    }

    /** Moves the grid to where the editor is, facing `yaw` degrees (or the way they face, when the host says). */
    function setStart(player: EditorPlayer, yaw?: number): TrackDraft {
        const value = draft(player);
        const facing = yaw ?? options.yaw?.(player) ?? value.start.yaw;
        if (!Number.isFinite(facing)) throw new Error("The heading must be a number of degrees");
        value.start = { ...here(player), yaw: ((facing % 360) + 360) % 360 };
        return value;
    }

    function point(player: EditorPlayer, radiusMetres?: number): TrackDraft {
        const value = draft(player);
        if (value.checkpoints.length >= LIMITS.checkpoints[1]) throw new Error(`A track holds at most ${LIMITS.checkpoints[1]} checkpoints`);
        const radius = radiusMetres === undefined ? options.defaultRadiusCm : Math.round(radiusMetres * 100);
        if (!Number.isSafeInteger(radius) || radius < LIMITS.radius[0] || radius > LIMITS.radius[1]) {
            throw new Error(`A checkpoint radius is ${LIMITS.radius[0] / 100}-${LIMITS.radius[1] / 100} metres`);
        }
        value.checkpoints.push({ ...here(player), radius });
        return value;
    }

    function undo(player: EditorPlayer): TrackDraft {
        const value = draft(player);
        if (!value.checkpoints.pop()) throw new Error("The draft has no checkpoints");
        return value;
    }

    function setLaps(player: EditorPlayer, laps: number): TrackDraft {
        const value = draft(player);
        if (!Number.isSafeInteger(laps) || laps < LIMITS.laps[0] || laps > LIMITS.laps[1]) throw new Error(`Laps must be ${LIMITS.laps[0]}-${LIMITS.laps[1]}`);
        value.laps = laps;
        return value;
    }

    async function save(player: EditorPlayer): Promise<HmpRacingTrack> {
        const value = draft(player);
        if (value.checkpoints.length < LIMITS.checkpoints[0]) throw new Error(`A track needs at least ${LIMITS.checkpoints[0]} checkpoints`);
        const track = await tracks.save(value);
        drafts.delete(player.id);
        return track;
    }

    function discard(player: EditorPlayer): boolean {
        return drafts.delete(player.id);
    }

    return { begin, setStart, point, undo, setLaps, save, discard, get: (player: EditorPlayer) => drafts.get(player.id) || null, forget: (playerId: number) => drafts.delete(playerId) };
}

export type TrackEditor = ReturnType<typeof createEditor>;

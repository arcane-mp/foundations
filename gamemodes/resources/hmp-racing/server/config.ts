import type { HmpRacingCheckpoint, HmpRacingTrack } from "../types";

export interface RacingConfig {
    command: string;
    /** hmp-core group, and its minimum grade, that may author tracks with /race edit. */
    editorGroup: string;
    editorGrade: number;
    maxRacers: number;
    lobbyTtlSeconds: number;
    countdownSeconds: number;
    /** After the first finisher, how long the rest have to finish. */
    finishGraceSeconds: number;
    /** A race still running this long after its start ends, and whoever has not finished is out. */
    timeLimitSeconds: number;
    /** How often the server samples racers' positions. */
    tickMs: number;
    /** Faster than this between two samples is a teleport; 0 turns the check off. */
    maxSpeedCmPerSecond: number;
    /** Distance between grid slots. */
    gridSpacingCm: number;
    /** A checkpoint dropped with /race edit point and no radius gets this one. */
    defaultRadiusCm: number;
    /** How many gates ahead the client draws, the next one included. */
    gatesAhead: number;
    tracks: HmpRacingTrack[];
}

export const TRACK_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const LIMITS = Object.freeze({
    laps: [1, 20] as const,
    checkpoints: [2, 64] as const,
    radius: [100, 5000] as const,
    label: 48,
    area: 64,
});

const DEFAULTS: Omit<RacingConfig, "tracks"> = Object.freeze({
    command: "race",
    editorGroup: "admin",
    editorGrade: 1,
    maxRacers: 12,
    lobbyTtlSeconds: 600,
    countdownSeconds: 5,
    finishGraceSeconds: 60,
    timeLimitSeconds: 900,
    tickMs: 100,
    maxSpeedCmPerSecond: 15000,
    gridSpacingCm: 300,
    defaultRadiusCm: 800,
    gatesAhead: 2,
});

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
    if (value === undefined || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RangeError(`hmp-racing ${label} must be an integer between ${min} and ${max}`);
    return parsed;
}

function coordinate(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e8) throw new RangeError(`${label} must be a finite coordinate`);
    return Math.round(parsed);
}

function text(value: unknown, fallback: string, max: number, label: string): string {
    const result = String(value ?? fallback).replace(/\s+/g, " ").trim();
    if (!result || result.length > max) throw new RangeError(`${label} must be 1-${max} characters`);
    return result;
}

export function checkpoint(value: unknown, label: string, defaultRadius = DEFAULTS.defaultRadiusCm): HmpRacingCheckpoint {
    const source = record(value);
    return {
        x: coordinate(source.x, `${label}.x`),
        y: coordinate(source.y, `${label}.y`),
        z: coordinate(source.z, `${label}.z`),
        radius: integer(source.radius, defaultRadius, LIMITS.radius[0], LIMITS.radius[1], `${label}.radius`),
    };
}

/** Validates one track; throws a RangeError naming the bad field. */
export function normalizeTrack(id: string, value: unknown, source: HmpRacingTrack["source"]): HmpRacingTrack {
    if (!TRACK_ID.test(id)) throw new RangeError(`track id '${id}' must be 1-32 lowercase letters, numbers, hyphens or underscores`);
    const raw = record(value);
    const where = `track ${id}`;
    const start = record(raw.start);
    const checkpoints = Array.isArray(raw.checkpoints) ? raw.checkpoints : [];
    if (checkpoints.length < LIMITS.checkpoints[0] || checkpoints.length > LIMITS.checkpoints[1]) {
        throw new RangeError(`${where} needs ${LIMITS.checkpoints[0]}-${LIMITS.checkpoints[1]} checkpoints`);
    }
    const yaw = Number(start.yaw ?? 0);
    if (!Number.isFinite(yaw)) throw new RangeError(`${where}.start.yaw must be a number`);
    return {
        id,
        label: text(raw.label, id, LIMITS.label, `${where}.label`),
        laps: integer(raw.laps, 1, LIMITS.laps[0], LIMITS.laps[1], `${where}.laps`),
        areaId: text(raw.areaId, "Overland", LIMITS.area, `${where}.areaId`),
        start: {
            x: coordinate(start.x, `${where}.start.x`),
            y: coordinate(start.y, `${where}.start.y`),
            z: coordinate(start.z, `${where}.start.z`),
            yaw: ((yaw % 360) + 360) % 360,
        },
        checkpoints: checkpoints.map((entry, index) => checkpoint(entry, `${where}.checkpoints[${index}]`)),
        source,
    };
}

export function normalizeConfig(raw: unknown): RacingConfig {
    const source = record(raw);
    const command = String(source.command ?? DEFAULTS.command).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(command)) throw new RangeError("hmp-racing command must be a simple word");
    const editorGroup = String(source.editorGroup ?? DEFAULTS.editorGroup).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(editorGroup)) throw new RangeError("hmp-racing editorGroup must be a valid group key");
    const tracks = Object.entries(record(source.tracks)).map(([id, track]) => normalizeTrack(id, track, "config"));
    return {
        command,
        editorGroup,
        editorGrade: integer(source.editorGrade, DEFAULTS.editorGrade, 0, 1000, "editorGrade"),
        maxRacers: integer(source.maxRacers, DEFAULTS.maxRacers, 1, 32, "maxRacers"),
        lobbyTtlSeconds: integer(source.lobbyTtlSeconds, DEFAULTS.lobbyTtlSeconds, 60, 3600, "lobbyTtlSeconds"),
        countdownSeconds: integer(source.countdownSeconds, DEFAULTS.countdownSeconds, 1, 30, "countdownSeconds"),
        finishGraceSeconds: integer(source.finishGraceSeconds, DEFAULTS.finishGraceSeconds, 5, 600, "finishGraceSeconds"),
        timeLimitSeconds: integer(source.timeLimitSeconds, DEFAULTS.timeLimitSeconds, 30, 7200, "timeLimitSeconds"),
        tickMs: integer(source.tickMs, DEFAULTS.tickMs, 50, 1000, "tickMs"),
        maxSpeedCmPerSecond: integer(source.maxSpeedCmPerSecond, DEFAULTS.maxSpeedCmPerSecond, 0, 1_000_000, "maxSpeedCmPerSecond"),
        gridSpacingCm: integer(source.gridSpacingCm, DEFAULTS.gridSpacingCm, 100, 2000, "gridSpacingCm"),
        defaultRadiusCm: integer(source.defaultRadiusCm, DEFAULTS.defaultRadiusCm, LIMITS.radius[0], LIMITS.radius[1], "defaultRadiusCm"),
        gatesAhead: integer(source.gatesAhead, DEFAULTS.gatesAhead, 1, 5, "gatesAhead"),
        tracks,
    };
}

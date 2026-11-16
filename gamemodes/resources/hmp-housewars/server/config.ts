import type { HmpHouseWarsArena } from "../types";

export interface HouseWarsConfig {
    command: string;
    /** Rounds in a match, odd: the first house to win most of them takes it. */
    rounds: number;
    roundSeconds: number;
    countdownSeconds: number;
    intermissionSeconds: number;
    maxPerHouse: number;
    /** At the start, the largest house may outnumber the smallest by at most this; 0 never checks. */
    maxImbalance: number;
    lobbyTtlSeconds: number;
    /** The radius of an arena a host opens where they stand, without naming one. */
    defaultArenaRadiusCm: number;
    /** Health a knocked-out fighter is held at; they kneel instead of dying. */
    koHp: number;
    /** House Cup points through hmp-houses: to the winning house, and to every house that fought. 0 gives none. */
    housePoints: { win: number; participation: number };
    arenas: HmpHouseWarsArena[];
}

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
    if (value === undefined || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RangeError(`hmp-housewars ${label} must be an integer between ${min} and ${max}`);
    return parsed;
}

function coordinate(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e8) throw new RangeError(`hmp-housewars ${label} must be a finite coordinate`);
    return Math.round(parsed);
}

export function normalizeArena(id: string, value: unknown): HmpHouseWarsArena {
    if (!ID.test(id)) throw new RangeError(`hmp-housewars arena id '${id}' must be 1-32 lowercase letters, numbers, hyphens or underscores`);
    const raw = record(value);
    const center = record(raw.center);
    const label = String(raw.label ?? id).replace(/\s+/g, " ").trim().slice(0, 48) || id;
    const areaId = String(raw.areaId ?? "Overland").trim();
    if (!areaId || areaId.length > 64) throw new RangeError(`hmp-housewars arena ${id}.areaId must be 1-64 characters`);
    return {
        id, label, areaId,
        center: { x: coordinate(center.x, `arena ${id}.center.x`), y: coordinate(center.y, `arena ${id}.center.y`), z: coordinate(center.z, `arena ${id}.center.z`) },
        radius: integer(raw.radius, 2500, 1000, 20_000, `arena ${id}.radius`),
    };
}

export function normalizeConfig(raw: unknown): HouseWarsConfig {
    const source = record(raw);
    const command = String(source.command ?? "housewars").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(command)) throw new RangeError("hmp-housewars command must be a simple word");
    const rounds = integer(source.rounds, 3, 1, 9, "rounds");
    if (rounds % 2 === 0) throw new RangeError("hmp-housewars rounds must be odd, so a match always has a winner on rounds");
    const points = record(source.housePoints);
    return {
        command,
        rounds,
        roundSeconds: integer(source.roundSeconds, 180, 30, 1800, "roundSeconds"),
        countdownSeconds: integer(source.countdownSeconds, 5, 1, 30, "countdownSeconds"),
        intermissionSeconds: integer(source.intermissionSeconds, 8, 3, 120, "intermissionSeconds"),
        maxPerHouse: integer(source.maxPerHouse, 4, 1, 16, "maxPerHouse"),
        maxImbalance: integer(source.maxImbalance, 1, 0, 16, "maxImbalance"),
        lobbyTtlSeconds: integer(source.lobbyTtlSeconds, 600, 60, 3600, "lobbyTtlSeconds"),
        defaultArenaRadiusCm: integer(source.defaultArenaRadiusCm, 2500, 1000, 20_000, "defaultArenaRadiusCm"),
        koHp: integer(source.koHp, 1, 1, 100, "koHp"),
        housePoints: {
            win: integer(points.win, 50, 0, 10_000, "housePoints.win"),
            participation: integer(points.participation, 10, 0, 10_000, "housePoints.participation"),
        },
        arenas: Object.entries(record(source.arenas)).map(([id, arena]) => normalizeArena(id, arena)),
    };
}

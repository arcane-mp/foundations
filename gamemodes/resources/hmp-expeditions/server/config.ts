import type { HmpExpedition, HmpExpeditionStage } from "../types";

export interface ExpeditionsConfig {
    command: string;
    editorGroup: string;
    editorGrade: number;
    maxParty: number;
    lobbyTtlSeconds: number;
    countdownSeconds: number;
    /** A run still going this long after its start fails. */
    timeLimitSeconds: number;
    /** Pause between a cleared stage and the next one's spawn, for the party to travel and catch breath. */
    stageDelaySeconds: number;
    enemiesPerExtraFighter: number;
    bossHealthPerExtraFighter: number;
    /** Most enemies one stage may spawn after scaling, boss included; capped by free hmp-npcs capacity. */
    maxEnemiesPerStage: number;
    /** Minimum seconds between two experience payments to the same character, read from hmp-progression reward history. */
    rewardCooldownSeconds: number;
    /** Put each run's party, and its enemies, in a virtual world of their own (needs a host that moves players). */
    instanced: boolean;
    /** The first virtual world instanced runs take; each run takes the next free one. */
    firstVirtualWorld: number;
    expeditions: HmpExpedition[];
}

export const EXPEDITION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CATALOG_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
export const LIMITS = Object.freeze({ stages: 12, enemiesPerStage: 6, countPerEnemy: 20, label: 48 });

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
    if (value === undefined || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RangeError(`hmp-expeditions ${label} must be an integer between ${min} and ${max}`);
    return parsed;
}

function share(value: unknown, fallback: number, label: string): number {
    if (value === undefined || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 4) throw new RangeError(`hmp-expeditions ${label} must be between 0 and 4`);
    return parsed;
}

function coordinate(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e8) throw new RangeError(`${label} must be a finite coordinate`);
    return Math.round(parsed);
}

export function normalizeStage(value: unknown, label: string): HmpExpeditionStage {
    const raw = record(value);
    const enemies = (Array.isArray(raw.enemies) ? raw.enemies : []).map((entry, index) => {
        const enemy = record(entry);
        const id = String(enemy.id ?? "").trim();
        if (!CATALOG_ID.test(id)) throw new RangeError(`${label}.enemies[${index}].id must be an hmp-npcs catalog id`);
        return { id, count: integer(enemy.count, 1, 1, LIMITS.countPerEnemy, `${label}.enemies[${index}].count`) };
    });
    if (enemies.length > LIMITS.enemiesPerStage) throw new RangeError(`${label} holds at most ${LIMITS.enemiesPerStage} kinds of enemy`);
    const bossSource = raw.boss === undefined || raw.boss === null ? null : record(raw.boss);
    const boss = bossSource ? (() => {
        const id = String(bossSource.id ?? "").trim();
        if (!CATALOG_ID.test(id)) throw new RangeError(`${label}.boss.id must be an hmp-npcs catalog id`);
        return { id, health: integer(bossSource.health, 2000, 100, 1_000_000, `${label}.boss.health`) };
    })() : null;
    if (!enemies.length && !boss) throw new RangeError(`${label} needs enemies or a boss`);
    return { x: coordinate(raw.x, `${label}.x`), y: coordinate(raw.y, `${label}.y`), z: coordinate(raw.z, `${label}.z`), enemies, boss };
}

export function normalizeExpedition(id: string, value: unknown, source: HmpExpedition["source"]): HmpExpedition {
    if (!EXPEDITION_ID.test(id)) throw new RangeError(`expedition id '${id}' must be 1-32 lowercase letters, numbers, hyphens or underscores`);
    const raw = record(value);
    const where = `expedition ${id}`;
    const entrance = record(raw.entrance);
    const stages = Array.isArray(raw.stages) ? raw.stages : [];
    if (!stages.length || stages.length > LIMITS.stages) throw new RangeError(`${where} needs 1-${LIMITS.stages} stages`);
    const label = String(raw.label ?? id).replace(/\s+/g, " ").trim();
    if (!label || label.length > LIMITS.label) throw new RangeError(`${where}.label must be 1-${LIMITS.label} characters`);
    const areaId = String(raw.areaId ?? "Overland").trim();
    if (!areaId || areaId.length > 64) throw new RangeError(`${where}.areaId must be 1-64 characters`);
    const yaw = Number(entrance.yaw ?? 0);
    if (!Number.isFinite(yaw)) throw new RangeError(`${where}.entrance.yaw must be a number`);
    return {
        id, label, areaId,
        entrance: { x: coordinate(entrance.x, `${where}.entrance.x`), y: coordinate(entrance.y, `${where}.entrance.y`), z: coordinate(entrance.z, `${where}.entrance.z`), yaw: ((yaw % 360) + 360) % 360 },
        stages: stages.map((stage, index) => normalizeStage(stage, `${where}.stages[${index}]`)),
        experience: integer(raw.experience, 500, 0, 1_000_000, `${where}.experience`),
        source,
    };
}

export function normalizeConfig(raw: unknown): ExpeditionsConfig {
    const source = record(raw);
    const command = String(source.command ?? "expedition").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(command)) throw new RangeError("hmp-expeditions command must be a simple word");
    const editorGroup = String(source.editorGroup ?? "admin").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(editorGroup)) throw new RangeError("hmp-expeditions editorGroup must be a valid group key");
    return {
        command,
        editorGroup,
        editorGrade: integer(source.editorGrade, 1, 0, 1000, "editorGrade"),
        maxParty: integer(source.maxParty, 4, 1, 12, "maxParty"),
        lobbyTtlSeconds: integer(source.lobbyTtlSeconds, 600, 60, 3600, "lobbyTtlSeconds"),
        countdownSeconds: integer(source.countdownSeconds, 5, 1, 30, "countdownSeconds"),
        timeLimitSeconds: integer(source.timeLimitSeconds, 1800, 60, 7200, "timeLimitSeconds"),
        stageDelaySeconds: integer(source.stageDelaySeconds, 4, 0, 120, "stageDelaySeconds"),
        enemiesPerExtraFighter: share(source.enemiesPerExtraFighter, 0.5, "enemiesPerExtraFighter"),
        bossHealthPerExtraFighter: share(source.bossHealthPerExtraFighter, 0.75, "bossHealthPerExtraFighter"),
        // hmp-npcs allows 256 per resource (512 in total) across every run and gamemode.
        maxEnemiesPerStage: integer(source.maxEnemiesPerStage, 24, 1, 256, "maxEnemiesPerStage"),
        rewardCooldownSeconds: integer(source.rewardCooldownSeconds, 3600, 0, 86_400, "rewardCooldownSeconds"),
        instanced: source.instanced === true,
        firstVirtualWorld: integer(source.firstVirtualWorld, 7000, 1, 1_000_000, "firstVirtualWorld"),
        expeditions: Object.entries(record(source.expeditions)).map(([id, expedition]) => normalizeExpedition(id, expedition, "config")),
    };
}

import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootPlayer, HmpLootPolicy, HmpLootSpotFamily, HmpLootSpotYield } from "../types";
import type { LootConfig, LootSpotConfig, LootSpotSettings } from "./internal";

const KINDS = new Set(["chest", "moonstone", "foragable"]);
const SCOPES = new Set(["character", "shared"]);
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const POLICIES = new Set(["native", "suppressed", "server"]);
const SPOT_MODES = new Set(["shared", "perPlayer"]);
const SPOT_KIND_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
// The host's LootSpots limits: a week of respawn, 1-1000 of an item per restock.
const MAX_SPOT_RESPAWN_SECONDS = 7 * 86400;
const MAX_SPOT_YIELD = 1000;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function cleanId(value: unknown, label: string): string {
    const result = String(value || "").trim();
    if (!result || result.length > 64) throw new TypeError(`${label} must be a non-empty string up to 64 characters`);
    return result;
}

function finite(value: unknown, label: string): number {
    const n = Number(value);
    if (typeof value !== "number" || !Number.isFinite(n)) throw new TypeError(`${label} must be a number`);
    return n;
}

function positiveInt(value: unknown, label: string): number {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${label} must be a positive integer`);
    return n;
}

function families(value: unknown, label: string): HmpLootFamilies {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const out = { chests: false, moonstones: false, foragables: false, pouches: false };
    for (const family of Object.keys(out) as Array<keyof HmpLootFamilies>) {
        if (raw[family] === undefined) continue;
        if (typeof raw[family] !== "boolean") throw new TypeError(`${label}.${family} must be a boolean`);
        out[family] = raw[family] as boolean;
    }
    return out;
}

function policies(value: unknown, label: string): Record<HmpLootSpotFamily, HmpLootPolicy | null> {
    if (value !== undefined && value !== null && !isObject(value)) throw new TypeError(`${label} must be an object`);
    const raw = value ?? {};
    const out: Record<HmpLootSpotFamily, HmpLootPolicy | null> = { moonstones: null, foragables: null };
    for (const family of Object.keys(out) as HmpLootSpotFamily[]) {
        if (raw[family] === undefined || raw[family] === null) continue;
        if (!POLICIES.has(raw[family] as string)) throw new TypeError(`${label}.${family} must be "native", "suppressed" or "server"`);
        out[family] = raw[family] as HmpLootPolicy;
    }
    return out;
}

function spotRespawn(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SPOT_RESPAWN_SECONDS) {
        throw new TypeError(`${label} must be from 0 to ${MAX_SPOT_RESPAWN_SECONDS} seconds`);
    }
    return value;
}

function spotYield(value: unknown, label: string): HmpLootSpotYield {
    const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_SPOT_YIELD;
    if (whole(value)) return value;
    if (Array.isArray(value) && value.length === 2 && whole(value[0]) && whole(value[1]) && value[0] <= value[1]) return [value[0], value[1]];
    throw new TypeError(`${label} must be a whole number from 1 to ${MAX_SPOT_YIELD}, or [min, max] within it`);
}

function spotSettings(value: unknown, label: string): LootSpotConfig {
    if (value !== undefined && value !== null && !isObject(value)) throw new TypeError(`${label} must be an object`);
    const raw = value ?? {};
    if (raw.mode !== undefined && raw.mode !== null && !SPOT_MODES.has(raw.mode as string)) throw new TypeError(`${label}.mode must be "shared" or "perPlayer"`);
    if (raw.kinds !== undefined && raw.kinds !== null && !isObject(raw.kinds)) throw new TypeError(`${label}.kinds must be an object keyed by kind`);
    const kinds: Record<string, LootSpotSettings> = {};
    for (const [kind, entry] of Object.entries(raw.kinds ?? {})) {
        if (!SPOT_KIND_PATTERN.test(kind)) throw new TypeError(`${label}.kinds key '${kind}' must be a kind name, "moonstones" or "foragables"`);
        if (!isObject(entry)) throw new TypeError(`${label}.kinds.${kind} must be { respawnSeconds?, yield? }`);
        const settings: LootSpotSettings = {};
        if (entry.respawnSeconds !== undefined && entry.respawnSeconds !== null) settings.respawnSeconds = spotRespawn(entry.respawnSeconds, `${label}.kinds.${kind}.respawnSeconds`);
        if (entry.yield !== undefined && entry.yield !== null) settings.yield = spotYield(entry.yield, `${label}.kinds.${kind}.yield`);
        kinds[kind] = settings;
    }
    return {
        mode: (raw.mode ?? null) as LootSpotConfig["mode"],
        respawnSeconds: raw.respawnSeconds === undefined || raw.respawnSeconds === null ? null : spotRespawn(raw.respawnSeconds, `${label}.respawnSeconds`),
        yield: raw.yield === undefined || raw.yield === null ? null : spotYield(raw.yield, `${label}.yield`),
        kinds,
    };
}

function items(value: unknown, label: string): HmpLootItem[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of { itemId, count? }`);
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object") throw new TypeError(`${label}[${index}] must be an object`);
        const item = entry as Record<string, unknown>;
        return { itemId: cleanId(item.itemId, `${label}[${index}].itemId`), count: item.count === undefined ? 1 : positiveInt(item.count, `${label}[${index}].count`) };
    });
}

function definition(value: unknown, index: number): HmpLootDefinition {
    const label = `hmp-loot lootables[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    const raw = value as Record<string, unknown>;
    const key = String(raw.key ?? "");
    if (!KEY_PATTERN.test(key)) throw new TypeError(`${label}.key must be 1-64 letters, digits, '_', '.' or '-'`);
    const kind = String(raw.kind ?? "chest");
    if (!KINDS.has(kind)) throw new TypeError(`${label}.kind must be "chest", "moonstone" or "foragable"`);
    const scope = String(raw.scope ?? "character");
    if (!SCOPES.has(scope)) throw new TypeError(`${label}.scope must be "character" or "shared"`);
    const position = raw.position && typeof raw.position === "object" ? raw.position as Record<string, unknown> : null;
    if (!position) throw new TypeError(`${label}.position must be { x, y, z }`);
    const out: HmpLootDefinition = {
        key,
        kind: kind as HmpLootDefinition["kind"],
        position: { x: finite(position.x, `${label}.position.x`), y: finite(position.y, `${label}.position.y`), z: finite(position.z, `${label}.position.z`) },
        yaw: raw.yaw === undefined ? 0 : finite(raw.yaw, `${label}.yaw`),
        items: items(raw.items ?? [], `${label}.items`),
        scope: scope as HmpLootDefinition["scope"],
        respawnSeconds: raw.respawnSeconds === undefined || raw.respawnSeconds === null ? null : positiveInt(raw.respawnSeconds, `${label}.respawnSeconds`),
    };
    if (raw.model !== undefined) out.model = cleanId(raw.model, `${label}.model`).slice(0, 256);
    return out;
}

function loadConfig(Hmp: HmpLibServer<HmpLootPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): LootConfig {
    const env = options.env || process.env;
    const defaults: LootConfig = {
        command: "loot",
        enableCommands: true,
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        suppressGameLoot: { chests: false, moonstones: false, foragables: false, pouches: false },
        gameLoot: { moonstones: null, foragables: null },
        lootSpots: { mode: null, respawnSeconds: null, yield: null, kinds: {} },
        lootables: [],
        sweepMs: 1000,
    };
    const loaded = Hmp.config.load<LootConfig & Record<string, unknown>>(env.HMP_LOOT_CONFIG || "data/hmp-loot.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as LootConfig & Record<string, unknown>,
    });
    const command = cleanId(env.HMP_LOOT_COMMAND || loaded.command || "loot", "hmp-loot command").toLowerCase();
    const enableCommands = env.HMP_LOOT_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_LOOT_COMMANDS, true);
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-loot adminGroups must be an array");
    const adminGroups = loaded.adminGroups.map((entry, index) => ({
        key: cleanId(entry?.key, `admin group ${index} key`).toLowerCase(),
        minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
    }));
    if (!Array.isArray(loaded.lootables)) throw new TypeError("hmp-loot lootables must be an array");
    const lootables = loaded.lootables.map(definition);
    const seen = new Set<string>();
    for (const entry of lootables) {
        if (seen.has(entry.key)) throw new TypeError(`hmp-loot lootable key '${entry.key}' is used twice`);
        seen.add(entry.key);
    }
    const sweepMs = loaded.sweepMs === undefined ? defaults.sweepMs : positiveInt(loaded.sweepMs, "hmp-loot sweepMs");
    return {
        command, enableCommands, adminGroups,
        suppressGameLoot: families(loaded.suppressGameLoot, "hmp-loot suppressGameLoot"),
        gameLoot: policies(loaded.gameLoot, "hmp-loot gameLoot"),
        lootSpots: spotSettings(loaded.lootSpots, "hmp-loot lootSpots"),
        lootables, sweepMs,
    };
}

export = { loadConfig };

import normalizeModule = require("../shared/normalize");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpBlipNativeIconLabel, HmpBlipNativeIcons, HmpBlipPlayer } from "../types";
import type { BlipsConfig } from "./internal";

const { text } = normalizeModule;

function plainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nativeIcons(raw: unknown): HmpBlipNativeIcons {
    if (raw === undefined || raw === null) return { hide: [], labels: {} };
    if (!plainObject(raw)) throw new TypeError("hmp-blips nativeIcons must be an object");
    if (raw.hide !== undefined && !Array.isArray(raw.hide)) throw new TypeError("hmp-blips nativeIcons.hide must be an array");
    if (raw.labels !== undefined && !plainObject(raw.labels)) throw new TypeError("hmp-blips nativeIcons.labels must be an object");
    const hide = new Map<string, string>();
    for (const entry of (raw.hide || []) as unknown[]) {
        const target = text(entry, "hmp-blips nativeIcons.hide entry", 160);
        if (!hide.has(target.toLowerCase())) hide.set(target.toLowerCase(), target);
    }
    const labels: Record<string, HmpBlipNativeIconLabel> = {};
    for (const [rawId, rawLabel] of Object.entries((raw.labels || {}) as Record<string, unknown>)) {
        const id = text(rawId, "hmp-blips nativeIcons.labels id", 160);
        if (!plainObject(rawLabel)) throw new TypeError(`hmp-blips nativeIcons.labels.${id} must be an object with a title`);
        const label: HmpBlipNativeIconLabel = { title: text(rawLabel.title, `hmp-blips nativeIcons.labels.${id}.title`, 120) };
        if (rawLabel.description !== undefined) label.description = text(rawLabel.description, `hmp-blips nativeIcons.labels.${id}.description`, 500, true);
        labels[id] = label;
    }
    return { hide: [...hide.values()], labels };
}

function finite(value: unknown, label: string, minimum: number, maximum: number, integer = false): number {
    const result = Number(value);
    if (!Number.isFinite(result) || result < minimum || result > maximum || (integer && !Number.isSafeInteger(result))) {
        throw new RangeError(`${label} must be ${integer ? "an integer " : ""}between ${minimum} and ${maximum}`);
    }
    return result;
}

function loadConfig(Hmp: HmpLibServer<HmpBlipPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): BlipsConfig {
    const env = options.env || process.env;
    const defaults: BlipsConfig = {
        defaultTtl: 600,
        maxTtl: 0,
        maxMarkersPerResource: 256,
        showAllPlayers: true,
        houseTint: true,
        playerBlipScale: 1,
        hideBaseIcon: false,
        nativeIcons: { hide: [], labels: {} },
        enableCommands: true,
        command: "blips",
    };
    const loaded = Hmp.config.load<BlipsConfig & Record<string, unknown>>(env.HMP_BLIPS_CONFIG || "data/hmp-blips.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as BlipsConfig & Record<string, unknown>,
    });
    const command = Hmp.text.clean(env.HMP_BLIPS_COMMAND || loaded.command || "blips", 32).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(command)) throw new TypeError("hmp-blips command contains unsupported characters");
    return {
        defaultTtl: finite(env.HMP_BLIPS_DEFAULT_TTL ?? loaded.defaultTtl, "hmp-blips defaultTtl", 0, 604_800),
        maxTtl: finite(env.HMP_BLIPS_MAX_TTL ?? loaded.maxTtl, "hmp-blips maxTtl", 0, 2_000_000),
        maxMarkersPerResource: finite(env.HMP_BLIPS_MAX_MARKERS ?? loaded.maxMarkersPerResource, "hmp-blips maxMarkersPerResource", 1, 10_000, true),
        showAllPlayers: env.HMP_BLIPS_SHOW_ALL === undefined ? loaded.showAllPlayers !== false : Hmp.config.env.boolean(env.HMP_BLIPS_SHOW_ALL, true),
        houseTint: env.HMP_BLIPS_HOUSE_TINT === undefined ? loaded.houseTint !== false : Hmp.config.env.boolean(env.HMP_BLIPS_HOUSE_TINT, true),
        playerBlipScale: finite(env.HMP_BLIPS_PLAYER_SCALE ?? loaded.playerBlipScale, "hmp-blips playerBlipScale", 0.1, 10),
        hideBaseIcon: env.HMP_BLIPS_HIDE_BASE === undefined ? loaded.hideBaseIcon === true : Hmp.config.env.boolean(env.HMP_BLIPS_HIDE_BASE, false),
        nativeIcons: nativeIcons(loaded.nativeIcons),
        enableCommands: env.HMP_BLIPS_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_BLIPS_COMMANDS, true),
        command,
    };
}

export = { loadConfig, nativeIcons };

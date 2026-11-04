import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpProgressionPlayer } from "../types";
import type { ProgressionConfig } from "./internal";

function clean(value: unknown, label: string, maximum = 64): string {
    const result = String(value || "").trim();
    if (!result || result.length > maximum) throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
    return result;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const result = Number(value);
    return Number.isSafeInteger(result) && result >= minimum && result <= maximum ? result : fallback;
}

function loadConfig(Hmp: HmpLibServer<HmpProgressionPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ProgressionConfig {
    const env = options.env || process.env;
    const defaults: ProgressionConfig = {
        enableCommands: true,
        command: "progression",
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        maximumExperience: 100_000_000,
        maximumTalentPoints: 100,
        nativeRequestTimeoutMs: 8_000,
        flooFlames: true,
    };
    const loaded = Hmp.config.load<ProgressionConfig & Record<string, unknown>>(env.HMP_PROGRESSION_CONFIG || "data/hmp-progression.json", {
        cwd: options.cwd || process.cwd(), defaults: defaults as ProgressionConfig & Record<string, unknown>,
    });
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-progression adminGroups must be an array");
    return {
        enableCommands: env.HMP_PROGRESSION_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_PROGRESSION_COMMANDS, true),
        command: clean(env.HMP_PROGRESSION_COMMAND || loaded.command || "progression", "progression command").toLowerCase(),
        adminGroups: loaded.adminGroups.map((entry, index) => ({
            key: clean(entry?.key, `admin group ${index} key`).toLowerCase(),
            minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
        })),
        maximumExperience: bounded(loaded.maximumExperience, defaults.maximumExperience, 1, Number.MAX_SAFE_INTEGER),
        maximumTalentPoints: bounded(loaded.maximumTalentPoints, defaults.maximumTalentPoints, 1, 10_000),
        nativeRequestTimeoutMs: bounded(loaded.nativeRequestTimeoutMs, defaults.nativeRequestTimeoutMs, 1_000, 60_000),
        flooFlames: loaded.flooFlames !== false,
    };
}

export = { loadConfig };

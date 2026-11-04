import normalizeModule = require("../shared/normalize");
import activitiesModule = require("../shared/activities");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpEmotePlayer } from "../types";
import type { EmoteConfig } from "./internal";

const { normalizeConfigured } = normalizeModule;
const { ACTIVITY_IDS, activityIds } = activitiesModule;

function loadConfig(Hmp: HmpLibServer<HmpEmotePlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): EmoteConfig {
    const env = options.env || process.env;
    const defaults: EmoteConfig = {
        command: "emote",
        enabled: true,
        allowAll: false,
        maxFavorites: 300,
        maxAliases: 200,
        editorGroups: [{ key: "admin", minimumGrade: 1 }],
        ui: { url: "fw://resources/hmp-emotes/dist/menu.html" },
        aliases: {
            popcorn: "/Game/Animation/Human/Stations/Sitting/STUF_STN_SIT_Bench_Eat_Box_v01_anm.STUF_STN_SIT_Bench_Eat_Box_v01_anm",
            apple: "/Game/Animation/Human/Stations/Sitting/HUF_STN_SIT_Bench_Idle_EatingApple_ANM.HUF_STN_SIT_Bench_Idle_EatingApple_ANM",
        },
        activities: [...ACTIVITY_IDS],
    };
    const loaded = Hmp.config.load<EmoteConfig & Record<string, unknown>>(env.HMP_EMOTES_CONFIG || "data/hmp-emotes.json", {
        cwd: options.cwd || process.cwd(), defaults: defaults as EmoteConfig & Record<string, unknown>,
    });
    loaded.command = String(env.HMP_EMOTES_COMMAND || loaded.command || defaults.command).trim().toLowerCase();
    loaded.enabled = env.HMP_EMOTES_ENABLED === undefined ? loaded.enabled !== false : Hmp.config.env.boolean(env.HMP_EMOTES_ENABLED, true);
    const allowAllEnvironment = env.HMP_EMOTES_ALLOW_ALL ?? env.HMP_EMOTES_BROWSE_UNALIASED;
    loaded.allowAll = allowAllEnvironment === undefined
        ? loaded.allowAll === true || loaded.browseUnaliased === true
        : Hmp.config.env.boolean(allowAllEnvironment, false);
    loaded.maxFavorites = Math.max(1, Math.min(300, Math.trunc(Number(loaded.maxFavorites)) || defaults.maxFavorites));
    loaded.maxAliases = Math.max(1, Math.min(1000, Math.trunc(Number(loaded.maxAliases)) || defaults.maxAliases));
    if (!Array.isArray(loaded.editorGroups)) throw new TypeError("hmp-emotes editorGroups must be an array");
    loaded.editorGroups = loaded.editorGroups.map((group, index) => {
        const key = String(group?.key || "").trim().toLowerCase();
        if (!key || key.length > 64) throw new TypeError(`hmp-emotes editor group ${index} is invalid`);
        const minimumGrade = Number(group.minimumGrade || 0);
        if (!Number.isSafeInteger(minimumGrade)) throw new TypeError(`hmp-emotes editor group ${index} grade must be an integer`);
        return { key, minimumGrade };
    });
    if (!loaded.ui || typeof loaded.ui !== "object") loaded.ui = { ...defaults.ui };
    loaded.ui.url = String(env.HMP_EMOTES_UI_URL || loaded.ui.url || defaults.ui.url).trim();
    if (!loaded.ui.url.startsWith("fw://resources/") && !loaded.ui.url.startsWith("https://")) throw new TypeError("hmp-emotes ui.url must be a resource URL or HTTPS URL");
    if (!loaded.aliases || typeof loaded.aliases !== "object" || Array.isArray(loaded.aliases)) throw new TypeError("hmp-emotes aliases must be an object");
    for (const [name, definition] of Object.entries(loaded.aliases)) normalizeConfigured(name, definition);
    loaded.activities = activityIds(loaded.activities);
    return loaded;
}

export = { loadConfig };

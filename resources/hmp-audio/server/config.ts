import defaultsModule = require("../shared/defaults");
import normalizeModule = require("../shared/normalize");
import dialogueModule = require("./dialogue");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpAudioPlayer } from "../types";
import type { AudioConfig } from "./internal";

const { aliases: defaultAliases } = defaultsModule;
const { aliases: normalizeAliases } = normalizeModule;
const { normalizeDialogue } = dialogueModule;

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    const result = Number(value);
    if (!Number.isFinite(result) || result < minimum || result > maximum) throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
    return result;
}

function loadConfig(Hmp: HmpLibServer<HmpAudioPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): AudioConfig {
    const env = options.env || process.env;
    const defaults: AudioConfig = {
        aliases: { ...defaultAliases },
        defaultRange: 10_000,
        maxActivePerOwner: 128,
        oneShotHandleMs: 60_000,
        enableCommands: true,
        command: "audio",
        dialogue: {},
    };
    const loaded = Hmp.config.load<AudioConfig & Record<string, unknown>>(env.HMP_AUDIO_CONFIG || "data/hmp-audio.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as AudioConfig & Record<string, unknown>,
    });
    const command = Hmp.text.clean(env.HMP_AUDIO_COMMAND || loaded.command || "audio", 32).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(command)) throw new TypeError("hmp-audio command contains unsupported characters");
    return {
        aliases: normalizeAliases(loaded.aliases),
        defaultRange: finite(env.HMP_AUDIO_RANGE ?? loaded.defaultRange, "hmp-audio defaultRange", 0, 10_000_000),
        maxActivePerOwner: Math.trunc(finite(env.HMP_AUDIO_MAX_ACTIVE ?? loaded.maxActivePerOwner, "hmp-audio maxActivePerOwner", 1, 10_000)),
        oneShotHandleMs: Math.trunc(finite(env.HMP_AUDIO_HANDLE_MS ?? loaded.oneShotHandleMs, "hmp-audio oneShotHandleMs", 1_000, 3_600_000)),
        enableCommands: env.HMP_AUDIO_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_AUDIO_COMMANDS, true),
        command,
        dialogue: normalizeDialogue(loaded.dialogue ?? {}, "hmp-audio dialogue"),
    };
}

export = { loadConfig };

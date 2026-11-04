import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpAudioPlayer } from "../types";
import type { NativeServerAudio } from "./internal";

declare const Audio: NativeServerAudio<HmpAudioPlayer>;

const { loadConfig } = configModule;
const { createAudioService } = serviceModule;
const Hmp = Imports.get<HmpLibServer<HmpAudioPlayer>>("hmp-lib");
const logger = Hmp.logger.create("hmp-audio");
const config = loadConfig(Hmp);
let audio: ReturnType<typeof createAudioService<HmpAudioPlayer>>;

function catalogPayload(): string {
    return JSON.stringify({ aliases: Object.fromEntries(audio.catalog.list().map((entry) => [entry.alias, entry.event])) });
}

function syncCatalog(player: HmpAudioPlayer): void {
    if (typeof player?.emit === "function") player.emit("hmp-audio:catalog", catalogPayload());
}

function broadcastCatalog(): void {
    for (const player of PlayerManager.getAll()) syncCatalog(player);
}

audio = createAudioService({ native: Audio, config, events: Events, onCatalogChange: broadcastCatalog });
for (const name of ["sounds", "catalog", "banks", "dialogue", "status"] as const) Exports.register(name, audio[name]);
if (Object.keys(config.dialogue).length && !audio.dialogue.current()) logger.warn("dialogue needs a HogwartsMP host with Audio.setDialoguePolicy; this host ignores it");

Events.onClient("hmp-audio:ready", syncCatalog);
Events.on("playerConnect", syncCatalog);
Events.on("playerDisconnect", (player: HmpAudioPlayer) => audio.sounds.release({ resource: "hmp-audio", id: `command-${player.id}` }));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-audio") audio.stop();
    else audio.cleanup(name);
});

if (config.enableCommands) {
    const commands = Hmp.command.createRouter({ prefix: "[audio]", logger });
    commands.register(config.command, {
        aliases: ["sounds"],
        usage: `/${config.command} <list [search]|play <event> [range]|local <event>|stop <handle>|status>`,
        description: "Inspect and test Foundations audio.",
    }, ({ player, args, invokedAs, reply, usage }) => {
        const action = String(args.shift() || (invokedAs === "sounds" ? "list" : "status")).toLowerCase();
        const owner = { resource: "hmp-audio", id: `command-${player.id}` };
        if (action === "status") {
            const status = audio.status();
            reply(`${status.activeSounds} tracked sound(s), ${status.aliases} alias(es), ${status.banks} leased bank(s)`);
            return;
        }
        if (action === "list") {
            const entries = audio.catalog.list(args.join(" ")).slice(0, 30);
            reply(entries.map((entry) => `${entry.alias}=${entry.event}`).join(", ") || "No matching aliases.");
            return;
        }
        if (action === "play") {
            const event = args[0];
            if (!event || !player.position) return reply(usage);
            const range = args[1] === undefined ? undefined : Number(args[1]);
            const handle = audio.sounds.playAt(owner, event, player.position, { range });
            reply(handle ? `Playing '${audio.catalog.resolve(event)}' at your position as ${handle}.` : `The engine refused '${audio.catalog.resolve(event)}'.`);
            return;
        }
        if (action === "local") {
            const event = args[0];
            if (!event) return reply(usage);
            const handle = audio.sounds.playForPlayer(owner, player, event);
            reply(handle ? `Playing '${audio.catalog.resolve(event)}' privately as ${handle}.` : `The engine refused '${audio.catalog.resolve(event)}'.`);
            return;
        }
        if (action === "stop") {
            reply(audio.sounds.stop(owner, args[0] || "") ? "Stopped." : "That handle is not active or is not yours.");
            return;
        }
        reply(usage);
    });
    Events.on("chatCommand", commands.handle);
}

logger.info(`Audio ready with ${audio.catalogCount()} alias(es)`);

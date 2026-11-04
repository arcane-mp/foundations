import configModule = require("./config");
import fieldGuideModule = require("./fieldguide");
import flamesModule = require("./flames");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { Player } from "./internal";

const { loadConfig } = configModule;
const { createFieldGuideSync } = fieldGuideModule;
const { createFlooFlames } = flamesModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createProgressionService } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const core = Imports.get("hmp-core");
const logger = Hmp.logger.create("hmp-progression");
const config = loadConfig(Hmp);
const repository = createRepository(database);
const service = createProgressionService({ repository, core, events: Events, logger, config, migrations });
const flames = createFlooFlames({ repository, core, logger, enabled: config.flooFlames, ready: service.start });
const fieldGuide = createFieldGuideSync({ repository, core, logger, enabled: config.fieldGuide, ready: service.start });

Exports.register("progression", service.progression);
Exports.register("talents", service.talents);
Exports.register("flooFlames", flames.api);
Exports.register("status", service.status);

function loadedPlayer(payload: unknown): Player | null {
    if (!payload || typeof payload !== "object" || !("session" in payload)) return null;
    const session = payload.session;
    return session && typeof session === "object" && "player" in session ? session.player as Player : null;
}

Events.on("hmp:character:loaded", (payload: unknown) => {
    const player = loadedPlayer(payload);
    if (!player) return;
    void service.characterLoaded(player);
    void flames.characterLoaded(player);
    void fieldGuide.characterLoaded(player);
});
Events.on("hmp:character:unloaded", (payload: unknown) => {
    const player = loadedPlayer(payload);
    if (!player) return;
    service.disconnect(player);
    fieldGuide.characterUnloaded(player);
});
Events.on("worldReady", (player: Player) => {
    if (!core.characters.active(player)) return;
    void service.worldReady(player);
    fieldGuide.worldReady(player);
});
Events.on("playerDisconnect", (player: Player) => { service.disconnect(player); flames.disconnect(player); fieldGuide.disconnect(player); });
Events.onClient("hmp-progression:field-guide-result", (player: Player, payload: unknown) => { fieldGuide.result(player, payload); });
Events.onClient("hmp-progression:field-guide-save", (player: Player, payload: unknown) => { fieldGuide.save(player, payload); });
Events.on("playerFastTravelUnlocked", (player: Player, unlock: unknown) => { void flames.unlocked(player, unlock).catch((error) => logger.warn(`Could not save #${player.id}'s Floo flame: ${messageOf(error)}`)); });
Events.onClient("hmp-progression:native-report", (player: Player, payload: unknown) => { void service.nativeReport(player, payload).catch((error) => logger.warn(`Native report rejected: ${messageOf(error)}`)); });
Events.onClient("hmp-progression:native-result", (player: Player, payload: unknown) => { void service.nativeResult(player, payload); });
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-progression") void service.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`)); });

async function isAdmin(player: Player): Promise<boolean> {
    if (!config.adminGroups.length) return false;
    return (await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade)))).some(Boolean);
}

let commandSequence = 0;
const commandReference = (suffix: string) => `progression:command:${suffix}:${Date.now().toString(36)}:${(++commandSequence).toString(36)}`;

if (config.enableCommands) Events.on("chatCommand", (player: Player, _message: string, rawCommand: string, rawArgs: string[]) => {
    if (String(rawCommand || "").toLowerCase() !== config.command) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[progression] ${message}`);
    void (async () => {
        const subcommand = String(args.shift() || "status").toLowerCase();
        const target = (raw: string | undefined): Player | null => Hmp.player.find(raw || "me", player) as Player | null;
        if (subcommand === "status") {
            const selected = target(args[0]);
            if (!selected) { reply(`Usage: /${config.command} status [me|nick|#id]`); return; }
            const profile = await service.progression.get(selected);
            reply(`${selected.nickname}: level ${profile.level}, ${profile.experiencePoints} XP, ${profile.talentPoints} talent point(s), revision ${profile.appliedRevision}/${profile.revision}`);
            return;
        }
        if (subcommand === "talents") {
            const selected = target(args[0]);
            if (!selected) { reply(`Usage: /${config.command} talents [me|nick|#id]`); return; }
            const [profile, talents] = await Promise.all([service.progression.get(selected), service.talents.list(selected)]);
            reply(`${selected.nickname}: ${profile.talentPoints} point(s); ${talents.length ? talents.map((entry) => `${entry.talentId}${entry.level > 1 ? `(${entry.level})` : ""}`).join(", ") : "no Foundations-managed talents"}`);
            return;
        }
        if (subcommand === "buy") {
            const id = args[0];
            if (!id) { reply(`Usage: /${config.command} buy <talentId>`); return; }
            const talent = await service.talents.purchase(player, id, { resource: "hmp-progression:command", actor: player, reason: "player purchase" });
            reply(`Purchased ${talent.talentId}.`);
            return;
        }
        if (!await isAdmin(player)) { reply("You do not have permission to administer progression."); return; }
        const context = { resource: "hmp-progression:command", actor: player, reason: "closed-testing command" };
        if (subcommand === "reset") {
            const resetTarget = target(args[0]);
            if (!resetTarget) { reply(`Usage: /${config.command} reset <me|nick|#id>`); return; }
            reply(`Revoked ${await service.talents.reset(resetTarget, context)} Foundations-managed talent(s) from ${resetTarget.nickname}.`);
            return;
        }
        const selected = target(args[1]);
        if (!selected) { reply(`Usage: /${config.command} <add|set|level|grant|revoke|points|reset> <value> [me|nick|#id]`); return; }
        if (subcommand === "add") {
            const amount = Number(args[0]);
            const transaction = await service.progression.add(selected, amount, { ...context, reference: commandReference("add") });
            reply(`${selected.nickname}: ${transaction.balanceBefore} -> ${transaction.balanceAfter} XP.`);
        } else if (subcommand === "set") {
            const amount = Number(args[0]);
            const transaction = await service.progression.set(selected, amount, { ...context, reference: commandReference("set") });
            reply(`${selected.nickname}: ${transaction.balanceBefore} -> ${transaction.balanceAfter} XP.`);
        } else if (subcommand === "level") {
            const transaction = await service.progression.setLevel(selected, Number(args[0]), { ...context, reference: commandReference("level") });
            reply(`${selected.nickname}: ${transaction.balanceAfter} XP (level ${args[0]} target).`);
        } else if (subcommand === "grant") {
            const talent = await service.talents.grant(selected, args[0], Number(args[2]) || 1, context);
            reply(`Granted ${talent.talentId} to ${selected.nickname}.`);
        } else if (subcommand === "revoke") {
            const talent = await service.talents.revoke(selected, args[0], context);
            reply(`Revoked ${talent.talentId} from ${selected.nickname}.`);
        } else if (subcommand === "points") {
            const profile = await service.talents.setPoints(selected, Number(args[0]), context);
            reply(`${selected.nickname}: ${profile.talentPoints} talent point(s).`);
        } else {
            reply(`Usage: /${config.command} status|talents|buy|add|set|level|grant|revoke|points|reset`);
        }
    })().catch((error) => { logger.warn(`Command failed: ${messageOf(error)}`); reply(messageOf(error)); });
});

Events.on("resourceStart", async (name?: string) => {
    if (name && name !== "hmp-progression") return;
    await service.start();
    logger.info("Character progression, replay-safe rewards, and managed talents ready");
});

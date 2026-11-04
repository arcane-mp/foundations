import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import normalizeModule = require("../shared/normalize");
import type { NativeWorldBanners, Player } from "./internal";

declare const World: NativeWorldBanners | undefined;

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createHousesService } = serviceModule;
const { HOUSES, house: normalizeHouse, nativeHouse } = normalizeModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const core = Imports.get("hmp-core");
const logger = Hmp.logger.create("hmp-houses");
const config = loadConfig(Hmp);
const repository = createRepository(database);
const houses = createHousesService({ repository, core, events: Events, logger, config, migrations, world: typeof World === "undefined" ? undefined : World });

Exports.register("membership", houses.membership);
Exports.register("points", houses.points);
Exports.register("commonRooms", houses.commonRooms);
Exports.register("status", houses.status);

function loadedPlayer(payload: unknown): Player | null {
    if (!payload || typeof payload !== "object" || !("session" in payload)) return null;
    const session = payload.session;
    return session && typeof session === "object" && "player" in session ? session.player as Player : null;
}

Events.on("hmp:character:loaded", (payload: unknown) => { const player = loadedPlayer(payload); if (player) void houses.characterLoaded(player); });
Events.on("hmp:character:unloaded", (payload: unknown) => {
    const player = loadedPlayer(payload);
    if (!player) return;
    try {
        player.house = "Unaffiliated";
        if (Array.isArray(player.commonRooms)) player.commonRooms = [];
    }
    catch (error) { logger.debug(`Skipped native house reset for #${player.id}: ${messageOf(error)}`); }
    houses.disconnect(player);
});
Events.on("hmp:groups:changed", (change: unknown) => houses.groupsChanged(change).catch((error) => logger.warn(`Could not refresh common rooms: ${messageOf(error)}`)));
Events.on("playerDisconnect", (player: Player) => houses.disconnect(player));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-houses") houses.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`));
});

async function isAdmin(player: Player): Promise<boolean> {
    if (!config.adminGroups.length) return false;
    return (await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade)))).some(Boolean);
}

let commandSequence = 0;
function standingsLine(rows: Awaited<ReturnType<typeof houses.points.standings>>): string {
    return rows.map((row) => `${nativeHouse(row.house)}: ${row.points}`).join(" | ");
}

if (config.enableCommands) Events.on("chatCommand", (player: Player, _message: unknown, rawCommand: unknown, rawArgs: unknown) => {
    const command = String(rawCommand || "").toLowerCase();
    if (command !== config.houseCommand && command !== config.pointsCommand) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[houses] ${message}`);
    void (async () => {
        if (command === config.houseCommand) {
            const target = Hmp.player.find(args[0] || "me", player);
            if (!target) { reply(`Usage: /${config.houseCommand} [me|nick|#id] [${HOUSES.join("|")}|clear]`); return; }
            if (!args[1]) {
                const membership = await houses.membership.get(target);
                reply(`${target.nickname || `#${target.id}`}: ${membership ? nativeHouse(membership.house) : "Unaffiliated"}`);
                return;
            }
            if (!await isAdmin(player)) { reply("You do not have permission to assign houses."); return; }
            const options = { resource: "hmp-houses:command", actor: player, reason: "closed-testing command" };
            if (args[1].toLowerCase() === "clear" || args[1].toLowerCase() === "unaffiliated") {
                const changed = await houses.membership.clear(target, options);
                reply(`${changed ? "cleared" : "already had no"} house assignment for ${target.nickname || `#${target.id}`}`);
                return;
            }
            const membership = await houses.membership.set(target, normalizeHouse(args[1]), options);
            reply(`${membership.characterName} is now ${nativeHouse(membership.house)}`);
            return;
        }

        if (!args.length) { reply(standingsLine(await houses.points.standings())); return; }
        if (args[0].toLowerCase() === "history") {
            const rawHouse = args[1] && args[1].toLowerCase() !== "all" ? normalizeHouse(args[1]) : undefined;
            const rows = await houses.points.history(rawHouse, Number(args[2]) || 10);
            reply(rows.length ? rows.map((row) => `${row.reference}:${nativeHouse(row.house)} ${row.amount >= 0 ? "+" : ""}${row.amount}=${row.balanceAfter ?? "pending"}`).join(" | ") : "No House Cup transactions found.");
            return;
        }
        if (!await isAdmin(player)) { reply("You do not have permission to change House Cup points."); return; }
        if (args[0].toLowerCase() === "recover") {
            if (!args[1]) { reply(`Usage: /${config.pointsCommand} recover <reference>`); return; }
            const transaction = await houses.points.recover(args[1]);
            reply(`${transaction.reference} is ${transaction.status}; ${nativeHouse(transaction.house)}=${transaction.balanceAfter}`);
            return;
        }
        const house = normalizeHouse(args[0]);
        const amount = Number(args[1]);
        if (!Number.isSafeInteger(amount) || amount === 0) { reply(`Usage: /${config.pointsCommand} <house> <signedAmount> [reference]`); return; }
        const reference = args[2] || `houses:command:${Date.now().toString(36)}:${(++commandSequence).toString(36)}`;
        const transaction = await houses.points.adjust(house, amount, { reference, resource: "hmp-houses:command", actor: player, reason: "closed-testing command" });
        reply(`${nativeHouse(house)} ${amount >= 0 ? "+" : ""}${amount} -> ${transaction.balanceAfter} (${transaction.reference})`);
    })().catch((error) => { logger.warn(`House command failed: ${messageOf(error)}`); reply(messageOf(error)); });
});

Events.on("resourceStart", async (name?: string) => {
    if (name && name !== "hmp-houses") return;
    await houses.start();
    logger.info("Character houses, native synchronization and House Cup ledger ready");
});

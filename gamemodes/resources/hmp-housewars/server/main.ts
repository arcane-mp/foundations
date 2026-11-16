import type { HmpActivities } from "../../../../resources/hmp-activities/types";
import type { HmpCore } from "../../../../resources/hmp-core/types";
import type { HmpHouses } from "../../../../resources/hmp-houses/types";
import type { HmpLibServer } from "../../../../resources/hmp-lib/types";
import type { HmpPvp } from "../../../../resources/hmp-pvp/types";
import type { HmpHouseWarsFinished } from "../types";
import { HOUSE_LABELS } from "../shared/types";
import { normalizeConfig } from "./config";
import { RESOURCE, createHouseWarsService, type HouseWarsPlayer } from "./service";

const Hmp = Imports.get<HmpLibServer<HouseWarsPlayer>>("hmp-lib");
const Core = Imports.get<HmpCore<HouseWarsPlayer>>("hmp-core");
const Activities = Imports.get<HmpActivities<HouseWarsPlayer>>("hmp-activities");
const Houses = Imports.get<HmpHouses<HouseWarsPlayer>>("hmp-houses");
const PvpPolicy = Imports.get<HmpPvp>("hmp-pvp");
const logger = Hmp.logger.create(RESOURCE);
const router = Hmp.command.createRouter({ prefix: "[HOUSES]", logger });
const CONFIG = normalizeConfig(Hmp.config.load<Record<string, unknown>>(process.env.HMP_HOUSEWARS_CONFIG || "data/hmp-housewars.json", { defaults: {} }));
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const battles = createHouseWarsService({
    config: CONFIG,
    activities: Activities,
    pvp: PvpPolicy,
    player: (id) => PlayerManager.getById(id) as HouseWarsPlayer | null,
    character: (player) => {
        try { const character = Core.characters.active(player); return character ? { id: character.id, name: character.name } : null; }
        catch (_) { return null; }
    },
    house: async (player) => (await Houses.membership.get(player))?.house ?? null,
    pair: (a, b, options) => Pvp.setPair(a, b, options),
    setRecovery: (id, on) => { try { PlayerManager.getById(id)?.setHealthRecovery?.(on); } catch (_) { /* left */ } },
    endKneel: (id) => { try { PlayerManager.getById(id)?.endKneel?.(); } catch (_) { /* left */ } },
    award: async (house, amount, reference, reason) => { await Houses.points.award(house, amount, { reference, resource: RESOURCE, reason }); },
    emit: (player, event, payload) => player.emit(event, payload),
    say: (player, message) => player.sendChat?.(`[HOUSES] ${message}`),
    finished: (event: HmpHouseWarsFinished) => { Events.emit(`${RESOURCE}:finished`, event); },
    warn: (message) => logger.warn(message),
});

router.register(CONFIG.command, async ({ player, args, reply, findPlayer }) => {
    const verb = (args[0] || "").toLowerCase();
    try {
        if (verb === "arenas") {
            if (!CONFIG.arenas.length) reply(`No arenas configured; /${CONFIG.command} host opens one where you stand`);
            for (const arena of CONFIG.arenas) reply(`${arena.id} — ${arena.label} (${arena.areaId}, ${Math.round(arena.radius / 100)} m)`);
        } else if (verb === "host") {
            const session = await battles.host(player, args[1]);
            reply(`Hosting ${session.title}. Others join with /${CONFIG.command} join ${player.nickname}; start with /${CONFIG.command} start`);
        } else if (verb === "join") {
            const leader = args[1] ? findPlayer(args.slice(1).join(" "), { allowSelf: false }) : null;
            if (args[1] && !leader) { reply("No such player"); return; }
            const session = await battles.join(player, leader);
            reply(`Joined ${session.title} (${session.participants.length} fighters)`);
        } else if (verb === "leave") {
            reply(await battles.leave(player) ? "You left the battle" : "You are not in a house battle");
        } else if (verb === "start") {
            await battles.start(player);
        } else if (verb === "stop" || verb === "cancel") {
            reply(await battles.cancel(player) ? "Battle stopped" : "You are not in a house battle");
        } else if (verb === "status") {
            const status = battles.status();
            if (!status.battles.length) { reply("No house battles"); return; }
            for (const battle of status.battles) {
                const score = Object.entries(battle.score).map(([house, wins]) => `${HOUSE_LABELS[house as keyof typeof HOUSE_LABELS]} ${wins}`).join(" · ");
                reply(`${battle.arena}: ${battle.phase}${battle.round ? `, round ${battle.round}` : ""}${score ? ` (${score})` : ""}`);
            }
        } else if (verb === "cup") {
            const standings = await Houses.points.standings();
            reply(standings.sort((a, b) => b.points - a.points).map((standing) => `${HOUSE_LABELS[standing.house]} ${standing.points}`).join(" · "));
        } else {
            reply(`Usage: /${CONFIG.command} arenas | host [arena] | join [host] | leave | start | stop | status | cup`);
        }
    } catch (error) { reply(messageOf(error)); }
});

Events.on("chatCommand", (player: HogwartsMpPlayer, message: string, command: string, args: string[]) => {
    void router.handle(player as unknown as HouseWarsPlayer, message, command, args);
});
Events.on("pvpDefeat", (victim: HogwartsMpPlayer, killer: HogwartsMpPlayer) => { battles.defeated(victim.id, killer.id); });
Events.on("playerDied", (player: HogwartsMpPlayer) => { battles.died(player.id); });
Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    void battles.stop().catch((error) => logger.warn(`Stop failed: ${messageOf(error)}`));
});

logger.info(`House battles ready with ${CONFIG.arenas.length} configured arena(s)`);

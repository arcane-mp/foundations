import type { HmpActivities } from "../../../../resources/hmp-activities/types";
import type { HmpCore } from "../../../../resources/hmp-core/types";
import type { HmpLibServer } from "../../../../resources/hmp-lib/types";
import type { HmpNpcs } from "../../../../resources/hmp-npcs/types";
import type { HmpProgressionApi } from "../../../../resources/hmp-progression/types";
import type { HmpWorldStateServer } from "../../../../resources/hmp-worldstate/types";
import type { HmpExpedition, HmpExpeditionFinished } from "../types";
import { formatTime } from "../shared/types";
import { normalizeConfig } from "./config";
import { RESOURCE, createExpeditionService, type ExpeditionPlayer } from "./service";
import { EXPEDITIONS_SYSTEM, RECORDS_SYSTEM, createEditor, createExpeditionStore, type EditorPlayer } from "./store";

const Hmp = Imports.get<HmpLibServer<ExpeditionPlayer>>("hmp-lib");
const Core = Imports.get<HmpCore<ExpeditionPlayer>>("hmp-core");
const Activities = Imports.get<HmpActivities<ExpeditionPlayer>>("hmp-activities");
const Npcs = Imports.get<HmpNpcs>("hmp-npcs");
const Progression = Imports.get<{ progression: HmpProgressionApi<ExpeditionPlayer> }>("hmp-progression").progression;
const WorldState = Imports.get<HmpWorldStateServer<ExpeditionPlayer>>("hmp-worldstate");
const logger = Hmp.logger.create(RESOURCE);
const router = Hmp.command.createRouter({ prefix: "[EXPEDITION]", logger });
const CONFIG = normalizeConfig(Hmp.config.load<Record<string, unknown>>(process.env.HMP_EXPEDITIONS_CONFIG || "data/hmp-expeditions.json", { defaults: {} }));
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

// An expedition naming an enemy the runtime catalog lacks still loads; that enemy is skipped with a warning when it spawns.
for (const expedition of CONFIG.expeditions) {
    for (const stage of expedition.stages) {
        for (const id of [...stage.enemies.map((enemy) => enemy.id), ...(stage.boss ? [stage.boss.id] : [])]) {
            if (!Npcs.catalog.has(id)) logger.warn(`Expedition ${expedition.id} names '${id}', which is not in the hmp-npcs catalog`);
        }
    }
}

const releaseExpeditions = WorldState.systems.register(EXPEDITIONS_SYSTEM, { maxEntries: 5_000, broadcast: false });
const releaseRecords = WorldState.systems.register(RECORDS_SYSTEM, { maxEntries: 1_000, broadcast: false });
const store = createExpeditionStore({
    store: {
        get: (system, key) => WorldState.state.get(system, key),
        list: (system) => WorldState.state.list(system),
        set: (system, key, value) => WorldState.state.set(system, key, value),
        delete: (system, key) => WorldState.state.delete(system, key),
    },
    configured: CONFIG.expeditions,
    warn: (message) => logger.warn(message),
});

const expeditions = createExpeditionService({
    config: CONFIG,
    store,
    activities: Activities,
    npcs: Npcs,
    player: (id) => PlayerManager.getById(id) as ExpeditionPlayer | null,
    character: (player) => {
        try { const character = Core.characters.active(player); return character ? { id: character.id, name: character.name } : null; }
        catch (_) { return null; }
    },
    // The host keeps a player's virtual world on the player; a host that cannot move one leaves it as it was.
    setWorld: (player, world) => {
        try { player.virtualWorld = world; return Number(player.virtualWorld) === world; }
        catch (_) { return false; }
    },
    reward: async (characterId, experience, reference, reason) => { await Progression.add(characterId, experience, { reference, resource: RESOURCE, reason }); },
    history: (characterId) => Progression.history(characterId),
    emit: (player, event, payload) => player.emit(event, payload),
    say: (player, message) => player.sendChat?.(`[EXPEDITION] ${message}`),
    finished: (event: HmpExpeditionFinished) => { Events.emit(`${RESOURCE}:finished`, event); },
    warn: (message) => logger.warn(message),
});

const editor = createEditor({ store, isEnemy: (id) => Npcs.catalog.has(id) });

function describe(expedition: HmpExpedition): string {
    const record = store.record(expedition.id);
    const bosses = expedition.stages.filter((stage) => stage.boss).length;
    return `${expedition.id} — ${expedition.label}, ${expedition.stages.length} stage(s)${bosses ? `, ${bosses} boss(es)` : ""}, ${expedition.experience} XP, ${expedition.areaId}${record ? `, record ${formatTime(record.timeMs)} by ${record.party}` : ""}`;
}

async function editCommand(player: ExpeditionPlayer, args: string[], reply: (message: string) => void): Promise<void> {
    let allowed = false;
    try { allowed = await Core.groups.has(player, CONFIG.editorGroup, CONFIG.editorGrade); } catch (_) { allowed = false; }
    if (!allowed) { reply("Only expedition editors may do that"); return; }
    const verb = (args[0] || "").toLowerCase();
    const who = player as EditorPlayer;
    const summary = () => { const draft = editor.get(who); return draft ? `${draft.id}: ${draft.stages.length} stage(s), ${draft.experience} XP` : "no draft"; };
    if (verb === "new") { editor.begin(who, args[1], args.slice(2).join(" ") || undefined); reply(`Editing ${summary()}. The party gathers where you stand; add fights with: edit stage <enemy> [xN]... [boss <enemy> [health]]`); }
    else if (verb === "stage") { editor.stage(who, args.slice(1)); reply(`Stage added (${summary()})`); }
    else if (verb === "undo") { editor.undo(who); reply(`Last stage removed (${summary()})`); }
    else if (verb === "entrance") { editor.entrance(who, args[1] === undefined ? undefined : Number(args[1])); reply(`Entrance moved here (${summary()})`); }
    else if (verb === "reward") { editor.reward(who, Number(args[1])); reply(`Reward set (${summary()})`); }
    else if (verb === "save") { const saved = await editor.save(who); reply(`Saved ${describe(saved)}`); logger.info(`${player.nickname} saved expedition ${saved.id}`); }
    else if (verb === "discard") { reply(editor.discard(who) ? "Draft discarded" : "No draft to discard"); }
    else if (verb === "delete") { const id = String(args[1] || "").toLowerCase(); reply(await store.remove(id) ? `Deleted ${id} and its record` : `No in-game expedition named ${id}`); }
    else if (verb === "enemies") {
        const filter = String(args[1] || "").toLowerCase();
        const list = Npcs.catalog.list().filter((entry) => !filter || entry.id.toLowerCase().includes(filter) || entry.label.toLowerCase().includes(filter));
        reply(list.slice(0, 20).map((entry) => entry.id).join(", ") + (list.length > 20 ? ` … ${list.length - 20} more; narrow it with: edit enemies <text>` : ""));
    } else if (verb === "export") {
        const expedition = store.get(args[1]);
        if (!expedition) { reply("No such expedition"); return; }
        const { id, source: _source, ...body } = expedition;
        logger.info(`Expedition ${id} for data/hmp-expeditions.json: ${JSON.stringify({ [id]: body })}`);
        reply(`Expedition ${id} written to the server log as JSON for data/hmp-expeditions.json`);
    } else {
        reply("edit new <id> [label] | stage <enemy> [xN]... [boss <enemy> [health]] | undo | entrance [yaw] | reward <xp> | save | discard | delete <id> | enemies [text] | export <id>");
    }
}

router.register(CONFIG.command, async ({ player, args, reply, findPlayer }) => {
    const verb = (args[0] || "").toLowerCase();
    try {
        if (verb === "list") {
            const list = store.list();
            if (!list.length) reply("No expeditions yet. An editor builds one with: edit new <id>");
            for (const expedition of list) reply(describe(expedition));
        } else if (verb === "host") {
            if (!args[1]) { reply(`Usage: /${CONFIG.command} host <expedition>`); return; }
            const session = await expeditions.host(player, args[1]);
            reply(`Leading ${session.title}. Others join with /${CONFIG.command} join ${player.nickname}; set off with /${CONFIG.command} start`);
        } else if (verb === "join") {
            const leader = args[1] ? findPlayer(args.slice(1).join(" "), { allowSelf: false }) : null;
            if (args[1] && !leader) { reply("No such player"); return; }
            const session = await expeditions.join(player, leader);
            reply(`Joined ${session.title} (${session.participants.length}/${session.maximumPlayers})`);
        } else if (verb === "leave") {
            reply(await expeditions.leave(player) ? "You left the expedition" : "You are not in an expedition");
        } else if (verb === "start") {
            await expeditions.start(player);
        } else if (verb === "stop" || verb === "cancel") {
            reply(await expeditions.cancel(player) ? "Expedition stopped" : "You are not in an expedition");
        } else if (verb === "status") {
            const status = expeditions.status();
            reply(status.parties.length ? status.parties.map((party) => `${party.expedition} ${party.phase}${party.stage ? ` stage ${party.stage}, ${party.remaining} left` : ""}`).join(" · ") : "No expeditions under way");
        } else if (verb === "edit") {
            await editCommand(player, args.slice(1), reply);
        } else {
            reply(`Usage: /${CONFIG.command} list | host <expedition> | join [leader] | leave | start | stop | status | edit …`);
        }
    } catch (error) { reply(messageOf(error)); }
});

Events.on("chatCommand", (player: HogwartsMpPlayer, message: string, command: string, args: string[]) => {
    void router.handle(player as unknown as ExpeditionPlayer, message, command, args);
});
Events.on("npcDied", (npcId: number) => { expeditions.npcDied(Number(npcId)); });
Events.on("playerDied", (player: HogwartsMpPlayer) => { expeditions.downed(player.id); });
Events.on("playerDowned", (player: HogwartsMpPlayer) => { expeditions.downed(player.id); });
Events.on("playerDownedEnd", (player: HogwartsMpPlayer) => { expeditions.revived(player.id); });
Events.on("playerDisconnect", (player: HogwartsMpPlayer) => { editor.forget(player.id); });
Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    void expeditions.stop().catch((error) => logger.warn(`Stop failed: ${messageOf(error)}`));
    releaseExpeditions();
    releaseRecords();
});

logger.info(`Expeditions ready with ${CONFIG.expeditions.length} configured expedition(s)${CONFIG.instanced ? ", instanced" : ""}`);

import type { HmpActivities } from "../../../../resources/hmp-activities/types";
import type { HmpCore } from "../../../../resources/hmp-core/types";
import type { HmpLibServer } from "../../../../resources/hmp-lib/types";
import type { HmpWorldStateServer } from "../../../../resources/hmp-worldstate/types";
import type { HmpRacingFinished, HmpRacingTrack } from "../types";
import type { GateState } from "../shared/types";
import { formatTime } from "../shared/types";
import { normalizeConfig } from "./config";
import { createEditor, type EditorPlayer } from "./editor";
import { RESOURCE, createRacingService, type RacingPlayer } from "./service";
import { RECORDS_SYSTEM, TRACKS_SYSTEM, createTrackStore } from "./tracks";

const Hmp = Imports.get<HmpLibServer<RacingPlayer>>("hmp-lib");
const Core = Imports.get<HmpCore<RacingPlayer>>("hmp-core");
const Activities = Imports.get<HmpActivities<RacingPlayer>>("hmp-activities");
const WorldState = Imports.get<HmpWorldStateServer<RacingPlayer>>("hmp-worldstate");
const logger = Hmp.logger.create(RESOURCE);
const router = Hmp.command.createRouter({ prefix: "[RACE]", logger });
const CONFIG = normalizeConfig(Hmp.config.load<Record<string, unknown>>(process.env.HMP_RACING_CONFIG || "data/hmp-racing.json", { defaults: {} }));
const BESTS_KEY = `${RESOURCE}:bests`;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Server-only: no client reads tracks or records from hmp-worldstate; racers get their gates from this resource.
const releaseTracks = WorldState.systems.register(TRACKS_SYSTEM, { maxEntries: 10_000, broadcast: false });
const releaseRecords = WorldState.systems.register(RECORDS_SYSTEM, { maxEntries: 1_000, broadcast: false });

const tracks = createTrackStore({
    store: {
        get: (system, key) => WorldState.state.get(system, key),
        list: (system) => WorldState.state.list(system),
        set: (system, key, value) => WorldState.state.set(system, key, value),
        delete: (system, key) => WorldState.state.delete(system, key),
    },
    configTracks: CONFIG.tracks,
    warn: (message) => logger.warn(message),
});

const racing = createRacingService({
    config: CONFIG,
    tracks,
    activities: Activities,
    player: (id) => PlayerManager.getById(id) as RacingPlayer | null,
    character: (player) => {
        try { const character = Core.characters.active(player); return character ? { id: character.id, name: character.name } : null; }
        catch (_) { return null; }
    },
    bests: {
        get: async (characterId) => ({ ...(await Core.metadata.getCharacter<Record<string, number>>(characterId, BESTS_KEY) || {}) }),
        set: async (characterId, bests) => { await Core.metadata.setCharacter(characterId, BESTS_KEY, bests); },
    },
    emit: (player, event, payload) => player.emit(event, payload),
    say: (player, message) => player.sendChat?.(`[RACE] ${message}`),
    finished: (event: HmpRacingFinished) => { Events.emit(`${RESOURCE}:finished`, event); },
    warn: (message) => logger.warn(message),
});

const editor = createEditor({ tracks, defaultRadiusCm: CONFIG.defaultRadiusCm });

function describe(track: HmpRacingTrack): string {
    const record = tracks.record(track.id);
    return `${track.id} — ${track.label}, ${track.laps} lap${track.laps === 1 ? "" : "s"}, ${track.checkpoints.length} gates, ${track.areaId}${record ? `, record ${formatTime(record.timeMs)} by ${record.name}` : ""}`;
}

/** Shows an editor the draft's gates, so they see the course as they build it. */
function showDraft(player: RacingPlayer): void {
    const draft = editor.get(player as EditorPlayer);
    const gates: GateState = { gates: (draft?.checkpoints || []).map((gate, index, all) => ({ ...gate, kind: index === all.length - 1 ? "next" : "later" })) };
    player.emit(`${RESOURCE}:gates`, JSON.stringify(gates));
}

async function canEdit(player: RacingPlayer): Promise<boolean> {
    try { return await Core.groups.has(player, CONFIG.editorGroup, CONFIG.editorGrade); }
    catch (_) { return false; }
}

async function editCommand(player: RacingPlayer, args: string[], reply: (message: string) => void): Promise<void> {
    if (!await canEdit(player)) { reply("Only track editors may do that"); return; }
    const verb = (args[0] || "").toLowerCase();
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
    const summary = () => { const draft = editor.get(player as EditorPlayer); return draft ? `${draft.id}: ${draft.checkpoints.length} gates, ${draft.laps} lap(s)` : "no draft"; };
    if (verb === "new") {
        const draft = editor.begin(player as EditorPlayer, args[1], number(args[2]), args.slice(3).join(" ") || undefined);
        reply(`Editing ${draft.id} (${draft.checkpoints.length} gates). The grid is where you stand; fly the course and drop gates with: edit point [radius m]`);
    } else if (verb === "start") {
        editor.setStart(player as EditorPlayer, number(args[1]));
        reply(`Grid moved here (${summary()})`);
    } else if (verb === "point") {
        editor.point(player as EditorPlayer, number(args[1]));
        reply(`Gate added (${summary()})`);
    } else if (verb === "undo") {
        editor.undo(player as EditorPlayer);
        reply(`Last gate removed (${summary()})`);
    } else if (verb === "laps") {
        editor.setLaps(player as EditorPlayer, Number(args[1]));
        reply(`Laps set (${summary()})`);
    } else if (verb === "save") {
        const track = await editor.save(player as EditorPlayer);
        reply(`Saved ${describe(track)}`);
        logger.info(`${player.nickname} saved track ${track.id}`);
    } else if (verb === "discard") {
        reply(editor.discard(player as EditorPlayer) ? "Draft discarded" : "No draft to discard");
    } else if (verb === "delete") {
        const id = String(args[1] || "").toLowerCase();
        reply(await tracks.remove(id) ? `Deleted ${id} and its record` : `No in-game track named ${id}`);
    } else if (verb === "export") {
        const track = tracks.get(args[1]);
        if (!track) { reply("No such track"); return; }
        const { id, source: _source, ...body } = track;
        logger.info(`Track ${id} for data/hmp-racing.json: ${JSON.stringify({ [id]: body })}`);
        reply(`Track ${id} written to the server log as JSON for data/hmp-racing.json`);
    } else {
        reply("edit new <id> [laps] [label] | start [yaw] | point [radius m] | undo | laps <n> | save | discard | delete <id> | export <id>");
        return;
    }
    showDraft(player);
}

async function topCommand(player: RacingPlayer, trackId: string | undefined, reply: (message: string) => void): Promise<void> {
    const list = trackId ? [tracks.get(trackId)].filter((track): track is HmpRacingTrack => !!track) : tracks.list();
    if (!list.length) { reply(trackId ? `No track named ${trackId}` : "No tracks yet"); return; }
    const character = Core.characters.active(player);
    const bests = character ? await Core.metadata.getCharacter<Record<string, number>>(character.id, BESTS_KEY) || {} : {};
    for (const track of list) {
        const record = tracks.record(track.id);
        const best = Number(bests[track.id]) || 0;
        reply(`${track.label}: ${record ? `${formatTime(record.timeMs)} by ${record.name}` : "no record"}${best ? ` · your best ${formatTime(best)}` : ""}`);
    }
}

router.register(CONFIG.command, async ({ player, args, reply, findPlayer }) => {
    const verb = (args[0] || "").toLowerCase();
    const say = (message: string) => { reply(message); };
    try {
        if (verb === "tracks") {
            const list = tracks.list();
            if (!list.length) say("No tracks yet. An editor builds one with: edit new <id>");
            for (const track of list) say(describe(track));
        } else if (verb === "host") {
            if (!args[1]) { say(`Usage: /${CONFIG.command} host <track>`); return; }
            const session = await racing.host(player, args[1]);
            say(`Hosting ${session.title}. Others join with /${CONFIG.command} join ${player.nickname}; start with /${CONFIG.command} start`);
        } else if (verb === "join") {
            const leader = args[1] ? findPlayer(args.slice(1).join(" "), { allowSelf: false }) : null;
            if (args[1] && !leader) { say("No such player"); return; }
            const session = await racing.join(player, leader);
            say(`Joined ${session.title} (${session.participants.length}/${session.maximumPlayers})`);
        } else if (verb === "leave") {
            say(await racing.leave(player) ? "You left the race" : "You are not in a race");
        } else if (verb === "start") {
            await racing.start(player);
        } else if (verb === "stop" || verb === "cancel") {
            say(await racing.cancel(player) ? "Race stopped" : "You are not in a race");
        } else if (verb === "top") {
            await topCommand(player, args[1], say);
        } else if (verb === "status") {
            const status = racing.status();
            say(status.races.length ? status.races.map((race) => `${race.track} ${race.phase} (${race.racers})`).join(" · ") : "No races");
        } else if (verb === "edit") {
            await editCommand(player, args.slice(1), say);
        } else {
            say(`Usage: /${CONFIG.command} tracks | host <track> | join [host] | leave | start | stop | top [track] | status | edit …`);
        }
    } catch (error) { say(messageOf(error)); }
});

Events.on("chatCommand", (player: HogwartsMpPlayer, message: string, command: string, args: string[]) => {
    void router.handle(player as unknown as RacingPlayer, message, command, args);
});

// A racer's own map pick would skip the course; the host asks before it travels.
Events.on("playerFastTravelRequest", (player: HogwartsMpPlayer) => racing.racing(player.id) ? false : undefined);
Events.on("playerDied", (player: HogwartsMpPlayer) => { racing.died(player.id); });
Events.on("playerDisconnect", (player: HogwartsMpPlayer) => { editor.forget(player.id); });

Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    void racing.stop().catch((error) => logger.warn(`Stop failed: ${messageOf(error)}`));
    releaseTracks();
    releaseRecords();
});

logger.info(`Broom racing ready with ${CONFIG.tracks.length} configured track(s)`);

import type { HmpActivities, HmpActivitySession } from "../../../../resources/hmp-activities/types";
import type { HmpRacingFinished, HmpRacingResult, HmpRacingTrack, HmpRacingVector3 } from "../types";
import type { CountdownState, GateState, HudState } from "../shared/types";
import { formatTime } from "../shared/types";
import type { RacingConfig } from "./config";
import { Race, gridSlot, type RaceEvent, type Racer } from "./race";
import type { TrackStore } from "./tracks";

export const RESOURCE = "hmp-racing";
export const ACTIVITY_ID = "hmp-racing:race";
const HOLD_OWNER = "hmp-racing";

export interface RacingPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    position: HmpRacingVector3;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
    teleport?(x: number, y: number, z: number, options?: { yaw?: number }): number;
    hold?(options: { owner: string; x?: number; y?: number; z?: number; radius?: number; radiusZ?: number; mode?: "clamp" | "reject"; ttlMs?: number }): boolean;
    release?(owner: string): boolean;
    setFastTravelEnabled?(on: boolean): void;
    getFastTravelEnabled?(): boolean;
    location?(): { areaId: string; regionId: string } | null;
}

type Timer = ReturnType<typeof setTimeout>;

export interface RacingDependencies {
    config: RacingConfig;
    tracks: TrackStore;
    activities: HmpActivities<RacingPlayer>;
    player(id: number): RacingPlayer | null;
    character(player: RacingPlayer): { id: number; name: string } | null;
    bests: {
        get(characterId: number): Promise<Record<string, number>>;
        set(characterId: number, bests: Record<string, number>): Promise<void>;
    };
    emit(player: RacingPlayer, event: string, payload: unknown): void;
    say(player: RacingPlayer, message: string): void;
    /** Raises the server event `hmp-racing:finished`. */
    finished(event: HmpRacingFinished): void;
    now?(): number;
    setTimer?(handler: () => void, ms: number): Timer;
    clearTimer?(timer: Timer): void;
    warn?(message: string): void;
}

interface RaceRecord {
    sessionId: string;
    track: HmpRacingTrack;
    phase: "forming" | "countdown" | "racing" | "done";
    race: Race | null;
    racers: Racer[];
    /** Each racer's fast-travel setting from before the race. */
    fastTravel: Map<number, boolean>;
    timers: Set<Timer>;
    /** Racers who retired during the countdown, before the race had them. */
    retired: Set<number>;
    tick: Timer | null;
    graceTimer: Timer | null;
    lastHud: Map<number, string>;
}

export function createRacingService(dependencies: RacingDependencies) {
    const { config, tracks, activities } = dependencies;
    const now = dependencies.now || Date.now;
    const schedule = dependencies.setTimer || setTimeout;
    const unschedule = dependencies.clearTimer || clearTimeout;
    const races = new Map<string, RaceRecord>();
    const byPlayer = new Map<number, string>();
    let stopped = false;

    function fail(message: string): never { throw new Error(message); }

    function later(record: RaceRecord, handler: () => void, ms: number): Timer {
        // Not unref'd: each resource runs its own event loop, and libuv skips the timers of a loop with nothing referenced.
        const timer = schedule(() => { record.timers.delete(timer); handler(); }, ms);
        record.timers.add(timer);
        return timer;
    }

    function clearTimers(record: RaceRecord): void {
        for (const timer of record.timers) unschedule(timer);
        record.timers.clear();
        record.tick = null;
        record.graceTimer = null;
    }

    function recordFor(player: RacingPlayer | number): RaceRecord | null {
        const sessionId = byPlayer.get(typeof player === "number" ? player : player.id);
        return sessionId ? races.get(sessionId) || null : null;
    }

    function send(playerId: number, event: string, payload: unknown): void {
        const player = dependencies.player(playerId);
        if (player) dependencies.emit(player, event, payload);
    }

    function tell(playerId: number, message: string): void {
        const player = dependencies.player(playerId);
        if (player) dependencies.say(player, message);
    }

    function everyone(record: RaceRecord, message: string): void {
        for (const racer of record.racers) tell(racer.playerId, message);
    }

    function gates(record: RaceRecord, playerId: number): GateState {
        const race = record.race;
        const next = race?.nextGate(playerId);
        if (!race || !next) return { gates: [] };
        const count = record.track.checkpoints.length;
        const passed = race.get(playerId)?.passed ?? 0;
        const remaining = race.totalCheckpoints - passed;
        const shown = Math.min(config.gatesAhead, remaining);
        return {
            gates: Array.from({ length: shown }, (_, offset) => {
                const gate = record.track.checkpoints[(next.index + offset) % count];
                const kind = offset === remaining - 1 ? "finish" : offset === 0 ? "next" : "later";
                return { ...gate, kind } as GateState["gates"][number];
            }),
        };
    }

    function hud(record: RaceRecord, playerId: number, phase?: "countdown"): HudState {
        const race = record.race;
        const count = record.track.checkpoints.length;
        const state = race?.get(playerId);
        const lap = race?.lapOf(playerId) ?? { lap: 1, checkpoint: 0 };
        const recordMs = tracks.record(record.track.id)?.timeMs || 0;
        return {
            active: true,
            track: record.track.label,
            phase: phase || (state?.status === "finished" ? "finished" : state && state.status !== "racing" ? "out" : "racing"),
            place: race ? race.placeOf(playerId) : 0,
            racers: record.racers.length,
            lap: lap.lap,
            laps: record.track.laps,
            checkpoint: lap.checkpoint,
            checkpoints: count,
            elapsedMs: race ? Math.max(0, (state?.finishMs ?? now() - race.startedAt)) : 0,
            lastLapMs: state?.lapsMs.at(-1) || 0,
            recordMs,
        };
    }

    /** Sends a racer's HUD when it changed, and their gates when `gatesToo`. */
    function refresh(record: RaceRecord, playerId: number, gatesToo: boolean): void {
        const state = hud(record, playerId);
        // The elapsed time counts on in the client; only a change in place, lap or gate is worth a packet.
        const key = JSON.stringify({ ...state, elapsedMs: 0 });
        if (gatesToo || record.lastHud.get(playerId) !== key) {
            record.lastHud.set(playerId, key);
            send(playerId, `${RESOURCE}:hud`, JSON.stringify(state));
        }
        if (gatesToo) send(playerId, `${RESOURCE}:gates`, JSON.stringify(gates(record, playerId)));
    }

    function restore(record: RaceRecord, playerId: number): void {
        const player = dependencies.player(playerId);
        try { player?.release?.(HOLD_OWNER); } catch (_) { /* left */ }
        const previous = record.fastTravel.get(playerId);
        record.fastTravel.delete(playerId);
        if (previous !== undefined) { try { player?.setFastTravelEnabled?.(previous); } catch (_) { /* left */ } }
        send(playerId, `${RESOURCE}:hud`, JSON.stringify({ active: false } satisfies HudState));
        send(playerId, `${RESOURCE}:gates`, JSON.stringify({ gates: [] } satisfies GateState));
    }

    function release(record: RaceRecord): void {
        clearTimers(record);
        record.phase = "done";
        for (const racer of record.racers) {
            restore(record, racer.playerId);
            if (byPlayer.get(racer.playerId) === record.sessionId) byPlayer.delete(racer.playerId);
        }
        races.delete(record.sessionId);
    }

    const disposeDefinition = activities.definitions.register({
        id: ACTIVITY_ID,
        resource: RESOURCE,
        label: "Broom race",
        description: "A race through a course of checkpoints, on brooms or mounts.",
        minimumPlayers: 1,
        maximumPlayers: config.maxRacers,
        requireReady: false,
        requiresCharacter: true,
        exclusive: true,
        disconnectPolicy: "remove",
        defaultVisibility: "public",
        scope: "area",
        lobbyTtlSeconds: config.lobbyTtlSeconds,
        onJoined: ({ session, player }) => { if (player) byPlayer.set(player.id, session.id); },
        onLeft: ({ session, player }) => { if (player) left(session.id, player.id); },
        onCancelled: ({ session }) => { const record = races.get(session.id); if (record) release(record); },
        onCompleted: ({ session }) => { const record = races.get(session.id); if (record) release(record); },
    });

    function left(sessionId: string, playerId: number): void {
        const record = races.get(sessionId);
        if (byPlayer.get(playerId) === sessionId) byPlayer.delete(playerId);
        if (!record) return;
        if (record.race?.leave(playerId)) everyone(record, `${record.racers.find((entry) => entry.playerId === playerId)?.nickname || "A racer"} left the race`);
        if (record.phase === "forming") record.racers = record.racers.filter((entry) => entry.playerId !== playerId);
        restore(record, playerId);
        if (record.phase === "racing" && record.race && !record.race.running) void finish(record, false);
    }

    async function host(player: RacingPlayer, trackId: string): Promise<HmpActivitySession> {
        if (stopped) fail("Racing is stopped");
        const track = tracks.get(trackId);
        if (!track) fail(`No track named '${trackId}'. /${config.command} tracks lists them`);
        const area = player.location?.()?.areaId;
        if (area && area !== track.areaId) fail(`${track.label} is in ${track.areaId}; go there to host it`);
        const session = await activities.sessions.create(player, ACTIVITY_ID, {
            title: `${track.label} (${track.laps} lap${track.laps === 1 ? "" : "s"})`,
            metadata: { track: track.id },
        });
        races.set(session.id, {
            sessionId: session.id, track, phase: "forming", race: null, racers: [], fastTravel: new Map(),
            timers: new Set(), retired: new Set(), tick: null, graceTimer: null, lastHud: new Map(),
        });
        byPlayer.set(player.id, session.id);
        return session;
    }

    /** Joins the only open race, or the one `leader` hosts. */
    async function join(player: RacingPlayer, leader?: RacingPlayer | null): Promise<HmpActivitySession> {
        if (recordFor(player)) fail("You are already in a race");
        const open = [...races.values()].filter((record) => record.phase === "forming").map((record) => activities.sessions.get(record.sessionId))
            .filter((session): session is HmpActivitySession => !!session && session.state === "forming");
        const chosen = leader ? open.filter((session) => session.leaderPlayerId === leader.id) : open;
        if (!chosen.length) fail(leader ? `${leader.nickname} is not hosting a race` : "No race is open; host one");
        if (chosen.length > 1) fail(`Several races are open; join one by its host: /${config.command} join <host>`);
        const session = await activities.sessions.join(player, chosen[0].id);
        byPlayer.set(player.id, session.id);
        return session;
    }

    /** Takes a racer out once the race has started; they stay in its activity, which keeps them, until it ends. */
    function retire(record: RaceRecord, playerId: number): boolean {
        const out = record.race ? record.race.leave(playerId) : !record.retired.has(playerId) && record.retired.add(playerId).size > 0;
        if (!out) return false;
        everyone(record, `${record.racers.find((entry) => entry.playerId === playerId)?.nickname || "A racer"} retired`);
        restore(record, playerId);
        if (record.phase === "racing" && record.race && !record.race.running) void finish(record, false);
        return true;
    }

    async function leave(player: RacingPlayer): Promise<boolean> {
        const record = recordFor(player);
        if (!record) return false;
        // A lobby lets them go: its onLeft, or onCancelled for the last one, does the rest.
        if (record.phase === "forming") { await activities.sessions.leave(player, record.sessionId, "left the race"); return true; }
        return retire(record, player.id);
    }

    async function start(player: RacingPlayer): Promise<void> {
        const record = recordFor(player);
        if (!record || record.phase !== "forming") fail("You are not in a race lobby");
        const session = activities.sessions.get(record.sessionId);
        if (!session || session.leaderPlayerId !== player.id) fail("Only the race's host can start it");
        const running = await activities.sessions.start(record.sessionId, { resource: RESOURCE, actor: player, reason: "race started" });
        record.racers = running.participants.map((entry) => {
            const racer = dependencies.player(entry.playerId);
            const character = racer ? dependencies.character(racer) : null;
            return { playerId: entry.playerId, nickname: entry.nickname, characterId: character?.id ?? null, characterName: character?.name ?? entry.characterName };
        });
        record.phase = "countdown";
        const holdMs = (config.countdownSeconds + 2) * 1000;
        record.racers.forEach((racer, index) => {
            const target = dependencies.player(racer.playerId);
            if (!target) return;
            const slot = gridSlot(record.track.start, index, config.gridSpacingCm);
            try {
                if (typeof target.getFastTravelEnabled === "function") record.fastTravel.set(racer.playerId, target.getFastTravelEnabled() !== false);
                target.setFastTravelEnabled?.(false);
                target.teleport?.(slot.x, slot.y, slot.z, { yaw: record.track.start.yaw });
                target.hold?.({ owner: HOLD_OWNER, x: slot.x, y: slot.y, z: slot.z, radius: 150, mode: "clamp", ttlMs: holdMs });
            } catch (error) { dependencies.warn?.(`Could not place racer ${racer.playerId}: ${error instanceof Error ? error.message : String(error)}`); }
            const countdown: CountdownState = { seconds: config.countdownSeconds, track: record.track.label };
            send(racer.playerId, `${RESOURCE}:countdown`, JSON.stringify(countdown));
            send(racer.playerId, `${RESOURCE}:hud`, JSON.stringify(hud(record, racer.playerId, "countdown")));
        });
        later(record, () => go(record), config.countdownSeconds * 1000);
    }

    function go(record: RaceRecord): void {
        if (record.phase !== "countdown" || !races.has(record.sessionId)) return;
        const present = record.racers.filter((racer) => byPlayer.get(racer.playerId) === record.sessionId && !record.retired.has(racer.playerId));
        // Everyone who started is in the results; those already gone are out from the first moment.
        record.race = new Race(record.track, record.racers, now(), { maxSpeedCmPerSecond: config.maxSpeedCmPerSecond });
        for (const racer of record.racers) if (!present.includes(racer)) record.race.leave(racer.playerId);
        record.phase = "racing";
        for (const racer of present) {
            try { dependencies.player(racer.playerId)?.release?.(HOLD_OWNER); } catch (_) { /* left */ }
            refresh(record, racer.playerId, true);
        }
        later(record, () => { void finish(record, true); }, config.timeLimitSeconds * 1000);
        if (!record.race.running) { void finish(record, false); return; }
        record.tick = later(record, () => tick(record), config.tickMs);
    }

    function handle(record: RaceRecord, events: RaceEvent[]): void {
        for (const event of events) {
            const name = record.racers.find((racer) => racer.playerId === event.playerId)?.nickname || "A racer";
            if (event.type === "lap" && event.lap < record.track.laps) tell(event.playerId, `Lap ${event.lap} in ${formatTime(event.lapMs)}`);
            if (event.type === "finish") {
                everyone(record, `${name} finishes ${ordinal(event.place)} in ${formatTime(event.timeMs)}`);
                if (event.place === 1 && record.race?.running) {
                    record.graceTimer = later(record, () => { void finish(record, true); }, config.finishGraceSeconds * 1000);
                    everyone(record, `${config.finishGraceSeconds} seconds left to finish`);
                }
            }
            if (event.type === "disqualified") {
                everyone(record, `${name} is disqualified (${event.reason === "teleport" ? "teleported" : event.reason})`);
            }
        }
    }

    function tick(record: RaceRecord): void {
        record.tick = null;
        const race = record.race;
        if (record.phase !== "racing" || !race) return;
        const at = now();
        const moved = new Set<number>();
        for (const state of race.list()) {
            if (state.status !== "racing") continue;
            const player = dependencies.player(state.playerId);
            if (!player || player.connected === false) continue;
            const events = race.update(state.playerId, player.position, at);
            if (events.length) { moved.add(state.playerId); handle(record, events); }
        }
        // A pass changes everyone's places, so every racer's HUD is checked; only changes are sent.
        for (const racer of record.racers) if (byPlayer.get(racer.playerId) === record.sessionId) refresh(record, racer.playerId, moved.has(racer.playerId));
        if (!race.running) { void finish(record, false); return; }
        record.tick = later(record, () => tick(record), config.tickMs);
    }

    /** Ends the race: results to everyone, records and bests stored, the activity completed. */
    async function finish(record: RaceRecord, cut: boolean): Promise<void> {
        if (record.phase === "done" || !record.race) return;
        record.phase = "done";
        clearTimers(record);
        const race = record.race;
        const at = new Date(now()).toISOString();
        const results: HmpRacingResult[] = [];
        for (const state of race.standings()) {
            const result: HmpRacingResult = {
                playerId: state.playerId, nickname: state.nickname, characterId: state.characterId, characterName: state.characterName,
                place: state.place, timeMs: state.finishMs, lapsMs: [...state.lapsMs],
                status: state.status === "racing" ? "dnf" : state.status, reason: state.reason, trackRecord: false, personalBest: false,
            };
            if (result.status === "finished" && result.timeMs !== null) {
                try {
                    result.trackRecord = await tracks.submit(record.track.id, result.timeMs, state.characterId, state.characterName || state.nickname, at);
                    if (state.characterId) {
                        const bests = await dependencies.bests.get(state.characterId);
                        const previous = Number(bests[record.track.id]) || 0;
                        if (!previous || result.timeMs < previous) {
                            bests[record.track.id] = result.timeMs;
                            await dependencies.bests.set(state.characterId, bests);
                            result.personalBest = true;
                        }
                    }
                } catch (error) { dependencies.warn?.(`Could not store ${state.nickname}'s time: ${error instanceof Error ? error.message : String(error)}`); }
            }
            results.push(result);
        }
        const summary = results.map((result) => result.status === "finished"
            ? `${ordinal(result.place || 0)} ${result.characterName || result.nickname} ${formatTime(result.timeMs || 0)}${result.trackRecord ? " (track record!)" : result.personalBest ? " (personal best)" : ""}`
            : `-- ${result.characterName || result.nickname} ${result.status === "dnf" ? "did not finish" : result.status}`);
        everyone(record, `${record.track.label} results:`);
        for (const line of summary) everyone(record, line);
        const event: HmpRacingFinished = {
            activitySessionId: record.sessionId, track: record.track.id, trackLabel: record.track.label, laps: record.track.laps,
            results, cut: cut && results.some((result) => result.status === "dnf"), finishedAt: at,
        };
        try { dependencies.finished(event); } catch (error) { dependencies.warn?.(`A hmp-racing:finished handler failed: ${error instanceof Error ? error.message : String(error)}`); }
        const winner = results.find((result) => result.place === 1);
        try {
            await activities.sessions.complete(record.sessionId, { track: record.track.id, winnerId: winner?.playerId ?? 0, winnerTimeMs: winner?.timeMs ?? 0 }, { resource: RESOURCE, reason: cut ? "time limit" : "race finished" });
        } catch (error) {
            dependencies.warn?.(`Could not complete race '${record.sessionId}': ${error instanceof Error ? error.message : String(error)}`);
            release(record);
        }
        // onCompleted released it already when the activity completed.
        if (races.has(record.sessionId)) release(record);
    }

    async function cancel(player: RacingPlayer): Promise<boolean> {
        const record = recordFor(player);
        if (!record) return false;
        const session = activities.sessions.get(record.sessionId);
        if (!session || session.leaderPlayerId !== player.id) fail("Only the race's host can stop it");
        if (record.phase === "racing") { await finish(record, true); return true; }
        await activities.sessions.cancel(record.sessionId, { resource: RESOURCE, actor: player, reason: "race cancelled" });
        if (races.has(record.sessionId)) release(record);
        return true;
    }

    /** True while the player is held to a race, from its countdown to its end: fast travel is refused. */
    function racing(playerId: number): boolean {
        const record = recordFor(playerId);
        if (!record || record.retired.has(playerId)) return false;
        if (record.phase === "countdown") return true;
        return record.phase === "racing" && record.race?.get(playerId)?.status === "racing";
    }

    /** A racer who went down is out of the race. */
    function died(playerId: number): void {
        const record = recordFor(playerId);
        if (record?.phase !== "racing" || !record.race) return;
        handle(record, record.race.disqualify(playerId, "fell"));
        refresh(record, playerId, true);
        if (!record.race.running) void finish(record, false);
    }

    function status() {
        return {
            state: stopped ? "stopped" as const : "ready" as const,
            races: [...races.values()].map((record) => ({ sessionId: record.sessionId, track: record.track.id, phase: record.phase, racers: record.racers.length })),
        };
    }

    async function stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        for (const record of [...races.values()]) release(record);
        await disposeDefinition();
    }

    return { host, join, leave, start, cancel, racing, died, status, stop, recordFor };
}

export function ordinal(place: number): string {
    const tens = place % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][place % 10] || "th";
    return `${place}${suffix}`;
}

import type { HmpActivities, HmpActivitySession } from "../../../../resources/hmp-activities/types";
import type { HmpNpcSpawnInput } from "../../../../resources/hmp-npcs/types";
import type { HmpExpedition, HmpExpeditionFinished, HmpExpeditionVector3 } from "../types";
import type { HudState, ObjectiveState } from "../shared/types";
import { formatTime } from "../shared/types";
import type { ExpeditionsConfig } from "./config";
import { Run, spawnRing } from "./run";
import type { ExpeditionStore } from "./store";

export const RESOURCE = "hmp-expeditions";
export const ACTIVITY_ID = "hmp-expeditions:run";
const HOLD_OWNER = "hmp-expeditions";

export interface ExpeditionPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    position: HmpExpeditionVector3;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
    teleport?(x: number, y: number, z: number, options?: { yaw?: number }): number;
    hold?(options: { owner: string; x?: number; y?: number; z?: number; radius?: number; mode?: "clamp" | "reject"; ttlMs?: number }): boolean;
    release?(owner: string): boolean;
    location?(): { areaId: string; regionId: string } | null;
}

type Timer = ReturnType<typeof setTimeout>;
type Result = HmpExpeditionFinished["result"];

export interface ExpeditionDependencies {
    config: ExpeditionsConfig;
    store: ExpeditionStore;
    activities: HmpActivities<ExpeditionPlayer>;
    npcs: {
        spawn(input: HmpNpcSpawnInput): { id: number };
        destroy(id: number, resource: string): boolean;
        setVirtualWorld(id: number, resource: string, world: number, map?: string): boolean;
    };
    player(id: number): ExpeditionPlayer | null;
    character(player: ExpeditionPlayer): { id: number; name: string } | null;
    /** Moves a player into a virtual world; false when the host kept them where they were. */
    setWorld(player: ExpeditionPlayer, world: number): boolean;
    /** Experience through hmp-progression; the reference makes a retry harmless. */
    reward(characterId: number, experience: number, reference: string, reason: string): Promise<void>;
    emit(player: ExpeditionPlayer, event: string, payload: unknown): void;
    say(player: ExpeditionPlayer, message: string): void;
    finished(event: HmpExpeditionFinished): void;
    now?(): number;
    setTimer?(handler: () => void, ms: number): Timer;
    clearTimer?(timer: Timer): void;
    warn?(message: string): void;
}

interface Party {
    sessionId: string;
    expedition: HmpExpedition;
    phase: "forming" | "countdown" | "running" | "done";
    run: Run | null;
    members: Array<{ playerId: number; nickname: string; characterId: number | null; characterName: string | null }>;
    timers: Set<Timer>;
    /** The run's virtual world, or 0 in the shared world. */
    world: number;
    /** Each member's world from before the run. */
    previousWorld: Map<number, number>;
    ownerCursor: number;
    endsAt: number;
}

export function createExpeditionService(dependencies: ExpeditionDependencies) {
    const { config, store, activities, npcs } = dependencies;
    const now = dependencies.now || Date.now;
    const schedule = dependencies.setTimer || setTimeout;
    const unschedule = dependencies.clearTimer || clearTimeout;
    const parties = new Map<string, Party>();
    const byPlayer = new Map<number, string>();
    const byNpc = new Map<number, string>();
    let stopped = false;

    function fail(message: string): never { throw new Error(message); }

    function later(party: Party, handler: () => void, ms: number): Timer {
        // Not unref'd: each resource runs its own event loop, and libuv skips the timers of a loop with nothing referenced.
        const timer = schedule(() => { party.timers.delete(timer); handler(); }, ms);
        party.timers.add(timer);
        return timer;
    }

    function partyFor(player: ExpeditionPlayer | number): Party | null {
        const id = byPlayer.get(typeof player === "number" ? player : player.id);
        return id ? parties.get(id) || null : null;
    }

    function send(playerId: number, event: string, payload: unknown): void {
        const player = dependencies.player(playerId);
        if (player) dependencies.emit(player, event, payload);
    }

    function inRun(party: Party): number[] {
        return party.run ? [...party.run.party] : party.members.map((member) => member.playerId);
    }

    function everyone(party: Party, message: string): void {
        for (const id of inRun(party)) { const player = dependencies.player(id); if (player) dependencies.say(player, message); }
    }

    function hud(party: Party): HudState {
        const run = party.run;
        return {
            active: true,
            expedition: party.expedition.label,
            phase: party.phase === "countdown" ? "countdown" : "running",
            stage: run ? Math.max(1, run.stage + 1) : 1,
            stages: party.expedition.stages.length,
            remaining: run?.remaining ?? 0,
            boss: !!run?.current?.boss,
            remainingMs: party.endsAt ? Math.max(0, party.endsAt - now()) : 0,
            recordMs: store.record(party.expedition.id)?.timeMs || 0,
        };
    }

    function refresh(party: Party): void {
        const state = JSON.stringify(hud(party));
        for (const id of inRun(party)) send(id, `${RESOURCE}:hud`, state);
    }

    function objective(party: Party): void {
        const stage = party.run?.current;
        const state: ObjectiveState = stage ? { active: true, x: stage.x, y: stage.y, z: stage.z, boss: !!stage.boss } : { active: false };
        for (const id of inRun(party)) send(id, `${RESOURCE}:objective`, JSON.stringify(state));
    }

    function letGo(party: Party, playerId: number): void {
        const player = dependencies.player(playerId);
        try { player?.release?.(HOLD_OWNER); } catch (_) { /* left */ }
        const previous = party.previousWorld.get(playerId);
        party.previousWorld.delete(playerId);
        if (player && previous !== undefined && party.world) dependencies.setWorld(player, previous);
        send(playerId, `${RESOURCE}:hud`, JSON.stringify({ active: false } satisfies HudState));
        send(playerId, `${RESOURCE}:objective`, JSON.stringify({ active: false } satisfies ObjectiveState));
    }

    function clearNpcs(party: Party): void {
        for (const id of party.run?.takeStanding() || []) {
            byNpc.delete(id);
            try { npcs.destroy(id, RESOURCE); } catch (_) { /* gone */ }
        }
    }

    function release(party: Party): void {
        for (const timer of party.timers) unschedule(timer);
        party.timers.clear();
        clearNpcs(party);
        party.phase = "done";
        for (const id of new Set([...party.members.map((member) => member.playerId), ...party.previousWorld.keys()])) letGo(party, id);
        for (const [playerId, sessionId] of [...byPlayer]) if (sessionId === party.sessionId) byPlayer.delete(playerId);
        parties.delete(party.sessionId);
    }

    const disposeDefinition = activities.definitions.register({
        id: ACTIVITY_ID,
        resource: RESOURCE,
        label: "Expedition",
        description: "A cooperative run through fights in order, to a final foe.",
        minimumPlayers: 1,
        maximumPlayers: config.maxParty,
        requireReady: false,
        requiresCharacter: true,
        exclusive: true,
        disconnectPolicy: "remove",
        defaultVisibility: "public",
        scope: "area",
        lobbyTtlSeconds: config.lobbyTtlSeconds,
        onJoined: ({ session, player }) => { if (player) byPlayer.set(player.id, session.id); },
        onLeft: ({ session, player }) => { if (player) departed(session.id, player.id); },
        // The last member leaving cancels the activity: a running party ends as abandoned.
        onCancelled: ({ session }) => {
            const party = parties.get(session.id);
            if (!party) return;
            if (party.run && party.phase !== "done") void finish(party, "abandoned", false);
            else release(party);
        },
        onCompleted: ({ session }) => { const party = parties.get(session.id); if (party) release(party); },
    });

    async function host(player: ExpeditionPlayer, id: string): Promise<HmpActivitySession> {
        if (stopped) fail("Expeditions are stopped");
        const expedition = store.get(id);
        if (!expedition) fail(`No expedition named '${id}'. /${config.command} list shows them`);
        const area = player.location?.()?.areaId;
        if (area && area !== expedition.areaId) fail(`${expedition.label} is in ${expedition.areaId}; go there to host it`);
        const session = await activities.sessions.create(player, ACTIVITY_ID, { title: expedition.label, metadata: { expedition: expedition.id } });
        parties.set(session.id, {
            sessionId: session.id, expedition, phase: "forming", run: null, members: [], timers: new Set(),
            world: 0, previousWorld: new Map(), ownerCursor: 0, endsAt: 0,
        });
        byPlayer.set(player.id, session.id);
        return session;
    }

    async function join(player: ExpeditionPlayer, leader?: ExpeditionPlayer | null): Promise<HmpActivitySession> {
        if (partyFor(player)) fail("You are already in an expedition");
        const open = [...parties.values()].filter((party) => party.phase === "forming").map((party) => activities.sessions.get(party.sessionId))
            .filter((session): session is HmpActivitySession => !!session && session.state === "forming");
        const chosen = leader ? open.filter((session) => session.leaderPlayerId === leader.id) : open;
        if (!chosen.length) fail(leader ? `${leader.nickname} is not leading an expedition` : "No expedition is open; host one");
        if (chosen.length > 1) fail(`Several expeditions are open; join one by its leader: /${config.command} join <leader>`);
        const session = await activities.sessions.join(player, chosen[0].id);
        byPlayer.set(player.id, session.id);
        return session;
    }

    function freeWorld(): number {
        const taken = new Set([...parties.values()].map((party) => party.world).filter(Boolean));
        let world = config.firstVirtualWorld;
        while (taken.has(world)) world += 1;
        return world;
    }

    async function start(player: ExpeditionPlayer): Promise<void> {
        const party = partyFor(player);
        if (!party || party.phase !== "forming") fail("You are not in an expedition lobby");
        const session = activities.sessions.get(party.sessionId);
        if (!session || session.leaderPlayerId !== player.id) fail("Only the expedition's leader can start it");
        const running = await activities.sessions.start(party.sessionId, { resource: RESOURCE, actor: player, reason: "expedition started" });
        party.members = running.participants.map((entry) => {
            const member = dependencies.player(entry.playerId);
            const character = member ? dependencies.character(member) : null;
            return { playerId: entry.playerId, nickname: entry.nickname, characterId: character?.id ?? entry.characterId, characterName: character?.name ?? entry.characterName };
        });
        party.run = new Run(party.expedition, party.members.map((member) => member.playerId), now(), {
            enemiesPerExtraFighter: config.enemiesPerExtraFighter, bossHealthPerExtraFighter: config.bossHealthPerExtraFighter,
        });
        party.phase = "countdown";
        if (config.instanced) {
            const world = freeWorld();
            party.world = world;
            for (const member of party.members) {
                const target = dependencies.player(member.playerId);
                if (!target) continue;
                party.previousWorld.set(member.playerId, Number(target.virtualWorld || 0));
                if (!dependencies.setWorld(target, world)) {
                    dependencies.warn?.(`The host kept player ${member.playerId} out of virtual world ${world}; this expedition runs in the shared world`);
                    for (const [id, previous] of party.previousWorld) { const back = dependencies.player(id); if (back) dependencies.setWorld(back, previous); }
                    party.previousWorld.clear();
                    party.world = 0;
                    break;
                }
            }
        }
        const { entrance } = party.expedition;
        party.members.forEach((member, index) => {
            const target = dependencies.player(member.playerId);
            if (!target) return;
            const spot = spawnRing(entrance, index, party.members.length, 200);
            try {
                target.teleport?.(spot.x, spot.y, spot.z, { yaw: entrance.yaw });
                target.hold?.({ owner: HOLD_OWNER, x: spot.x, y: spot.y, z: spot.z, radius: 150, mode: "clamp", ttlMs: (config.countdownSeconds + 2) * 1000 });
            } catch (error) { dependencies.warn?.(`Could not place ${member.nickname}: ${error instanceof Error ? error.message : String(error)}`); }
            send(member.playerId, `${RESOURCE}:countdown`, JSON.stringify({ seconds: config.countdownSeconds, expedition: party.expedition.label }));
        });
        refresh(party);
        later(party, () => begin(party), config.countdownSeconds * 1000);
    }

    function begin(party: Party): void {
        if (party.phase !== "countdown" || !party.run) return;
        party.phase = "running";
        party.endsAt = now() + config.timeLimitSeconds * 1000;
        for (const id of party.run.party) { try { dependencies.player(id)?.release?.(HOLD_OWNER); } catch (_) { /* left */ } }
        later(party, () => { void finish(party, "timeout", true); }, config.timeLimitSeconds * 1000);
        nextStage(party);
    }

    function nextOwner(party: Party): number | undefined {
        const ids = [...(party.run?.party || [])].filter((id) => dependencies.player(id));
        if (!ids.length) return undefined;
        const owner = ids[party.ownerCursor % ids.length];
        party.ownerCursor += 1;
        return owner;
    }

    function nextStage(party: Party): void {
        const run = party.run;
        if (!run || party.phase !== "running") return;
        const orders = run.advance();
        const stage = run.current!;
        let spawned = 0;
        orders.forEach((order, index) => {
            const spot = spawnRing(stage, index, orders.length);
            try {
                const npc = npcs.spawn({
                    resource: RESOURCE, enemyId: order.enemyId, position: { x: spot.x, y: spot.y, z: spot.z }, yaw: spot.yaw,
                    disposition: "hostile", ownerId: nextOwner(party), ...(order.maxHealth ? { maxHealth: order.maxHealth, scale: 1.3 } : {}),
                });
                if (party.world) npcs.setVirtualWorld(npc.id, RESOURCE, party.world, party.expedition.areaId);
                run.spawned(npc.id);
                byNpc.set(npc.id, party.sessionId);
                spawned += 1;
            } catch (error) { dependencies.warn?.(`Could not spawn ${order.enemyId}: ${error instanceof Error ? error.message : String(error)}`); }
        });
        const label = `Stage ${run.stage + 1}/${party.expedition.stages.length}`;
        if (!spawned) {
            // Nothing could be spawned: the stage stands empty, and the party moves on rather than wait forever.
            everyone(party, `${label}: its enemies could not be summoned; moving on`);
            stageCleared(party);
            return;
        }
        everyone(party, `${label}: ${stage.boss ? "the final foe awaits" : `${spawned} enemies`} at the marker`);
        objective(party);
        refresh(party);
    }

    function stageCleared(party: Party): void {
        const run = party.run!;
        if (run.onLastStage) { void finish(party, "cleared", true); return; }
        everyone(party, `Stage ${run.stage + 1} cleared`);
        const after = () => nextStage(party);
        if (config.stageDelaySeconds > 0) later(party, after, config.stageDelaySeconds * 1000);
        else after();
        refresh(party);
    }

    function npcDied(npcId: number): void {
        const sessionId = byNpc.get(npcId);
        const party = sessionId ? parties.get(sessionId) : null;
        byNpc.delete(npcId);
        if (!party?.run || party.phase !== "running") return;
        if (party.run.killed(npcId)) stageCleared(party);
        else refresh(party);
    }

    function downed(playerId: number): void {
        const party = partyFor(playerId);
        if (!party?.run || party.phase !== "running") return;
        if (party.run.downed(playerId)) { everyone(party, "The whole party has fallen"); void finish(party, "wiped", true); }
    }

    function revived(playerId: number): void {
        partyFor(playerId)?.run?.revived(playerId);
    }

    /** A member is out for good: disconnected, or retired from a running expedition. */
    function departed(sessionId: string, playerId: number): void {
        const party = parties.get(sessionId);
        if (byPlayer.get(playerId) === sessionId) byPlayer.delete(playerId);
        if (!party) return;
        letGo(party, playerId);
        const run = party.run;
        if (!run || party.phase === "done" || !run.party.has(playerId)) return;
        const empty = run.leave(playerId);
        everyone(party, `${party.members.find((member) => member.playerId === playerId)?.nickname || "A fighter"} left the expedition`);
        if (empty) { void finish(party, "abandoned", true); return; }
        if (run.wiped && party.phase === "running") { everyone(party, "The whole party has fallen"); void finish(party, "wiped", true); }
    }

    async function leave(player: ExpeditionPlayer): Promise<boolean> {
        const party = partyFor(player);
        if (!party) return false;
        if (party.phase === "forming") { await activities.sessions.leave(player, party.sessionId, "left the expedition"); return true; }
        if (!party.run?.party.has(player.id)) return false;
        departed(party.sessionId, player.id);
        // A running activity keeps its members until it ends.
        if (parties.has(party.sessionId)) byPlayer.set(player.id, party.sessionId);
        return true;
    }

    async function finish(party: Party, result: Result, complete: boolean): Promise<void> {
        const run = party.run;
        if (!run || party.phase === "done" || run.result) return;
        run.finish(result);
        party.phase = "done";
        for (const timer of party.timers) unschedule(timer);
        party.timers.clear();
        clearNpcs(party);
        const durationMs = Math.max(0, now() - run.startedAt);
        const at = new Date(now()).toISOString();
        const finishers = new Set(run.party);
        const participants = party.members.map((member) => ({ ...member, rewarded: false }));
        let record = false;
        if (result === "cleared") {
            for (const member of participants) {
                if (!finishers.has(member.playerId) || !member.characterId || party.expedition.experience <= 0) continue;
                try {
                    await dependencies.reward(member.characterId, party.expedition.experience, `${RESOURCE}:${party.sessionId}:${member.characterId}`, `cleared ${party.expedition.label}`);
                    member.rewarded = true;
                } catch (error) { dependencies.warn?.(`Could not reward ${member.nickname}: ${error instanceof Error ? error.message : String(error)}`); }
            }
            try { record = await store.submit(party.expedition.id, durationMs, participants.filter((member) => finishers.has(member.playerId)).map((member) => member.characterName || member.nickname), at); }
            catch (error) { dependencies.warn?.(`Could not store the clear time: ${error instanceof Error ? error.message : String(error)}`); }
        }
        const messages: Record<Result, string> = {
            cleared: `${party.expedition.label} cleared in ${formatTime(durationMs)}${record ? " — a new record!" : ""}${party.expedition.experience ? ` (+${party.expedition.experience} XP)` : ""}`,
            wiped: `${party.expedition.label} failed: the party fell at stage ${run.stage + 1}`,
            timeout: `${party.expedition.label} failed: time ran out at stage ${run.stage + 1}`,
            abandoned: `${party.expedition.label} was abandoned`,
            stopped: `${party.expedition.label} was stopped`,
        };
        everyone(party, messages[result]);
        const event: HmpExpeditionFinished = {
            activitySessionId: party.sessionId, expedition: party.expedition.id, label: party.expedition.label, result,
            cleared: run.cleared, stages: party.expedition.stages.length, defeated: run.defeated, durationMs, record, participants, finishedAt: at,
        };
        try { dependencies.finished(event); } catch (error) { dependencies.warn?.(`A hmp-expeditions:finished handler failed: ${error instanceof Error ? error.message : String(error)}`); }
        if (complete) {
            try { await activities.sessions.complete(party.sessionId, { result, cleared: run.cleared }, { resource: RESOURCE, reason: result }); }
            catch (error) { dependencies.warn?.(`Could not complete expedition '${party.sessionId}': ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (parties.has(party.sessionId)) release(party);
    }

    async function cancel(player: ExpeditionPlayer): Promise<boolean> {
        const party = partyFor(player);
        if (!party) return false;
        const session = activities.sessions.get(party.sessionId);
        if (!session || session.leaderPlayerId !== player.id) fail("Only the expedition's leader can stop it");
        if (party.run) { await finish(party, "stopped", true); return true; }
        await activities.sessions.cancel(party.sessionId, { resource: RESOURCE, actor: player, reason: "expedition cancelled" });
        if (parties.has(party.sessionId)) release(party);
        return true;
    }

    function status() {
        return {
            state: stopped ? "stopped" as const : "ready" as const,
            parties: [...parties.values()].map((party) => ({
                sessionId: party.sessionId, expedition: party.expedition.id, phase: party.phase, stage: (party.run?.stage ?? -1) + 1,
                remaining: party.run?.remaining ?? 0, world: party.world,
            })),
        };
    }

    async function stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        for (const party of [...parties.values()]) release(party);
        await disposeDefinition();
    }

    return { host, join, leave, start, cancel, npcDied, downed, revived, status, stop, partyFor };
}

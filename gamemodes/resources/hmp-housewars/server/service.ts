import type { HmpActivities, HmpActivitySession } from "../../../../resources/hmp-activities/types";
import type { HmpPvp, HmpPvpHit } from "../../../../resources/hmp-pvp/types";
import type { HmpHouseWarsArena, HmpHouseWarsFinished, HmpHouseWarsHouse, HmpHouseWarsRoundResult, HmpHouseWarsVector3 } from "../types";
import type { CountdownState, HudState } from "../shared/types";
import { HOUSE_LABELS } from "../shared/types";
import type { HouseWarsConfig } from "./config";
import { HOUSES, Match, spawnPoint, type FighterInput } from "./match";

export const RESOURCE = "hmp-housewars";
export const ACTIVITY_ID = "hmp-housewars:battle";
const HOLD_OWNER = "hmp-housewars";
// A live round's pairs: lock-on and a kneel finish, whatever the server's own rules say.
const HOSTILE = { hostile: true, aim: "lock", defeat: "kneel" } as const;
const PEACEFUL = { hostile: false } as const;

export interface HouseWarsPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    position: HmpHouseWarsVector3;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
    teleport?(x: number, y: number, z: number, options?: { yaw?: number }): number;
    hold?(options: { owner: string; x?: number; y?: number; z?: number; radius?: number; radiusZ?: number; mode?: "clamp" | "reject"; ttlMs?: number }): boolean;
    release?(owner: string): boolean;
    location?(): { areaId: string; regionId: string } | null;
}

type Timer = ReturnType<typeof setTimeout>;

export interface HouseWarsDependencies {
    config: HouseWarsConfig;
    activities: HmpActivities<HouseWarsPlayer>;
    pvp: HmpPvp;
    player(id: number): HouseWarsPlayer | null;
    character(player: HouseWarsPlayer): { id: number; name: string } | null;
    /** The player's character's house, from hmp-houses. */
    house(player: HouseWarsPlayer): Promise<HmpHouseWarsHouse | null>;
    /** The host's pair override (Pvp.setPair); null clears it. False when the host has no room. */
    pair(a: number, b: number, options: { hostile: boolean; aim?: "lock" | "skillshot"; defeat?: "death" | "kneel" } | null): boolean;
    setRecovery(playerId: number, on: boolean): void;
    endKneel(playerId: number): void;
    /** House Cup points through the hmp-houses ledger; the reference makes a retry harmless. */
    award(house: HmpHouseWarsHouse, amount: number, reference: string, reason: string): Promise<void>;
    emit(player: HouseWarsPlayer, event: string, payload: unknown): void;
    say(player: HouseWarsPlayer, message: string): void;
    finished(event: HmpHouseWarsFinished): void;
    now?(): number;
    setTimer?(handler: () => void, ms: number): Timer;
    clearTimer?(timer: Timer): void;
    warn?(message: string): void;
}

interface Battle {
    sessionId: string;
    arena: HmpHouseWarsArena;
    phase: "forming" | "countdown" | "fighting" | "intermission" | "done";
    match: Match | null;
    timers: Set<Timer>;
    phaseEndsAt: number;
    /** Fighters whose pairs, holds and recovery this battle took, to give back. */
    touched: Set<number>;
}

export function createHouseWarsService(dependencies: HouseWarsDependencies) {
    const { config, activities } = dependencies;
    const now = dependencies.now || Date.now;
    const schedule = dependencies.setTimer || setTimeout;
    const unschedule = dependencies.clearTimer || clearTimeout;
    const battles = new Map<string, Battle>();
    const byPlayer = new Map<number, string>();
    let stopped = false;

    function fail(message: string): never { throw new Error(message); }
    const label = (house: HmpHouseWarsHouse | null) => house ? HOUSE_LABELS[house] : "Nobody";

    function later(battle: Battle, handler: () => void, ms: number): Timer {
        // Not unref'd: each resource runs its own event loop, and libuv skips the timers of a loop with nothing referenced.
        const timer = schedule(() => { battle.timers.delete(timer); handler(); }, ms);
        battle.timers.add(timer);
        return timer;
    }

    function clearTimers(battle: Battle): void {
        for (const timer of battle.timers) unschedule(timer);
        battle.timers.clear();
    }

    function battleFor(player: HouseWarsPlayer | number): Battle | null {
        const id = byPlayer.get(typeof player === "number" ? player : player.id);
        return id ? battles.get(id) || null : null;
    }

    function send(playerId: number, event: string, payload: unknown): void {
        const player = dependencies.player(playerId);
        if (player) dependencies.emit(player, event, payload);
    }

    function tell(playerId: number, message: string): void {
        const player = dependencies.player(playerId);
        if (player) dependencies.say(player, message);
    }

    function members(battle: Battle): number[] {
        if (battle.match) return battle.match.active().map((fighter) => fighter.playerId);
        return [...byPlayer.entries()].filter(([, id]) => id === battle.sessionId).map(([playerId]) => playerId);
    }

    function everyone(battle: Battle, message: string): void {
        for (const id of members(battle)) tell(id, message);
    }

    function hud(battle: Battle, playerId: number): HudState {
        const match = battle.match;
        const house = match?.houseOf(playerId);
        if (!match || !house) return { active: false };
        const phase = battle.phase === "done" ? "over" : battle.phase === "forming" ? "lobby" : battle.phase;
        return {
            active: true,
            arena: battle.arena.label,
            phase,
            round: match.round,
            rounds: config.rounds,
            house,
            standing: match.isStanding(playerId),
            houses: match.houses().map((entry) => ({
                house: entry,
                wins: match.score.get(entry) || 0,
                standing: match.live ? match.standingBy(entry) : match.active().filter((fighter) => fighter.house === entry).length,
                fighters: match.active().filter((fighter) => fighter.house === entry).length,
            })),
            remainingMs: battle.phaseEndsAt ? Math.max(0, battle.phaseEndsAt - now()) : 0,
        };
    }

    function refresh(battle: Battle): void {
        for (const id of members(battle)) send(id, `${RESOURCE}:hud`, JSON.stringify(hud(battle, id)));
    }

    /** Sets every pair of fighters: hostile across houses while both stand in a live round, peaceful otherwise. */
    function pairUp(battle: Battle): boolean {
        const match = battle.match!;
        const ids = match.active().map((fighter) => fighter.playerId);
        let room = true;
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                if (!dependencies.pair(ids[i], ids[j], match.hostile(ids[i], ids[j]) ? HOSTILE : PEACEFUL)) room = false;
            }
        }
        return room;
    }

    function unpair(battle: Battle, playerId: number): void {
        for (const other of battle.touched) if (other !== playerId) dependencies.pair(playerId, other, null);
    }

    function letGo(battle: Battle, playerId: number): void {
        if (!battle.touched.delete(playerId)) return;
        unpair(battle, playerId);
        dependencies.setRecovery(playerId, true);
        const player = dependencies.player(playerId);
        try { player?.release?.(HOLD_OWNER); } catch (_) { /* left */ }
        send(playerId, `${RESOURCE}:hud`, JSON.stringify({ active: false } satisfies HudState));
    }

    function release(battle: Battle): void {
        clearTimers(battle);
        battle.phase = "done";
        for (const id of [...battle.touched]) letGo(battle, id);
        for (const [playerId, sessionId] of [...byPlayer]) if (sessionId === battle.sessionId) byPlayer.delete(playerId);
        battles.delete(battle.sessionId);
    }

    const disposeDefinition = activities.definitions.register({
        id: ACTIVITY_ID,
        resource: RESOURCE,
        label: "House battle",
        description: "Houses fight elimination rounds for the House Cup.",
        minimumPlayers: 2,
        maximumPlayers: config.maxPerHouse * HOUSES.length,
        teams: HOUSES.map((house) => ({ id: house, label: HOUSE_LABELS[house], min: 0, max: config.maxPerHouse })),
        requireReady: false,
        requiresCharacter: true,
        exclusive: true,
        disconnectPolicy: "remove",
        defaultVisibility: "public",
        scope: "area",
        lobbyTtlSeconds: config.lobbyTtlSeconds,
        onJoined: ({ session, player }) => { if (player) byPlayer.set(player.id, session.id); },
        onLeft: ({ session, player }) => { if (player) departed(session.id, player.id); },
        onCancelled: ({ session }) => { const battle = battles.get(session.id); if (battle) release(battle); },
        onCompleted: ({ session }) => { const battle = battles.get(session.id); if (battle) release(battle); },
    });

    // The battle's own rule: hits across houses in a live round floor at koHp, so the loser kneels; anything
    // else between two fighters of one battle is refused. Duels (priority 1000) still win for their own pairs.
    const disposePolicy = dependencies.pvp.policy.register({
        id: "housewars", resource: RESOURCE, priority: 900,
        decide(hit: Readonly<HmpPvpHit>) {
            const battle = battleFor(hit.casterId);
            if (!battle?.match || battleFor(hit.victimId) !== battle || !battle.match.fighters.has(hit.victimId)) return undefined;
            return battle.match.hostile(hit.casterId, hit.victimId) ? { minHp: config.koHp } : false;
        },
    });

    async function houseOf(player: HouseWarsPlayer): Promise<HmpHouseWarsHouse> {
        const house = await dependencies.house(player);
        if (!house) fail("Your character has no house yet");
        return house;
    }

    async function host(player: HouseWarsPlayer, arenaId?: string): Promise<HmpActivitySession> {
        if (stopped) fail("House battles are stopped");
        const house = await houseOf(player);
        let arena: HmpHouseWarsArena;
        if (arenaId) {
            const found = config.arenas.find((entry) => entry.id === arenaId.toLowerCase());
            if (!found) fail(`No arena named '${arenaId}'. /${config.command} arenas lists them`);
            const area = player.location?.()?.areaId;
            if (area && area !== found.areaId) fail(`${found.label} is in ${found.areaId}; go there to host it`);
            arena = found;
        } else {
            const { x, y, z } = player.position;
            if (![x, y, z].every(Number.isFinite)) fail("Your position is unknown; try again in a moment");
            arena = { id: "here", label: "Open ground", areaId: player.location?.()?.areaId || "Overland", center: { x, y, z }, radius: config.defaultArenaRadiusCm };
        }
        const session = await activities.sessions.create(player, ACTIVITY_ID, { title: `House battle at ${arena.label}`, team: house, metadata: { arena: arena.id } });
        battles.set(session.id, { sessionId: session.id, arena, phase: "forming", match: null, timers: new Set(), phaseEndsAt: 0, touched: new Set() });
        byPlayer.set(player.id, session.id);
        return session;
    }

    async function join(player: HouseWarsPlayer, leader?: HouseWarsPlayer | null): Promise<HmpActivitySession> {
        if (battleFor(player)) fail("You are already in a house battle");
        const house = await houseOf(player);
        const open = [...battles.values()].filter((battle) => battle.phase === "forming").map((battle) => activities.sessions.get(battle.sessionId))
            .filter((session): session is HmpActivitySession => !!session && session.state === "forming");
        const chosen = leader ? open.filter((session) => session.leaderPlayerId === leader.id) : open;
        if (!chosen.length) fail(leader ? `${leader.nickname} is not hosting a house battle` : "No house battle is open; host one");
        if (chosen.length > 1) fail(`Several battles are open; join one by its host: /${config.command} join <host>`);
        const session = await activities.sessions.join(player, chosen[0].id, { team: house });
        byPlayer.set(player.id, session.id);
        return session;
    }

    async function start(player: HouseWarsPlayer): Promise<void> {
        const battle = battleFor(player);
        if (!battle || battle.phase !== "forming") fail("You are not in a house battle lobby");
        const session = activities.sessions.get(battle.sessionId);
        if (!session || session.leaderPlayerId !== player.id) fail("Only the battle's host can start it");
        const counts = HOUSES.map((house) => session.participants.filter((entry) => entry.team === house).length).filter(Boolean);
        if (counts.length < 2) fail("A house battle needs fighters from at least two houses");
        if (config.maxImbalance > 0 && Math.max(...counts) - Math.min(...counts) > config.maxImbalance) {
            fail(`The houses are uneven (${counts.join(" v ")}); at most ${config.maxImbalance} apart`);
        }
        const fighters: FighterInput[] = session.participants.map((entry) => {
            const fighter = dependencies.player(entry.playerId);
            const character = fighter ? dependencies.character(fighter) : null;
            return { playerId: entry.playerId, nickname: entry.nickname, characterId: character?.id ?? entry.characterId, characterName: character?.name ?? entry.characterName, house: entry.team as HmpHouseWarsHouse };
        });
        const match = new Match(fighters, config.rounds);
        await activities.sessions.start(battle.sessionId, { resource: RESOURCE, actor: player, reason: "battle started" });
        battle.match = match;
        for (const fighter of fighters) { battle.touched.add(fighter.playerId); dependencies.setRecovery(fighter.playerId, false); }
        if (!pairUp(battle)) {
            everyone(battle, "The server has no room for this battle's PvP pairs right now");
            await activities.sessions.cancel(battle.sessionId, { resource: RESOURCE, reason: "no room for pvp pairs" }).catch(() => undefined);
            if (battles.has(battle.sessionId)) release(battle);
            return;
        }
        everyone(battle, `House battle: ${match.houses().map(label).join(" v ")}, best of ${config.rounds}`);
        countdown(battle);
    }

    /** Puts each house in its corner of the arena and holds them through the countdown. */
    function countdown(battle: Battle): void {
        const match = battle.match!;
        battle.phase = "countdown";
        battle.phaseEndsAt = now() + config.countdownSeconds * 1000;
        const houses = match.contenders();
        for (const [houseIndex, house] of houses.entries()) {
            const team = match.active().filter((fighter) => fighter.house === house);
            team.forEach((fighter, slot) => {
                const player = dependencies.player(fighter.playerId);
                if (!player) return;
                const spot = spawnPoint(battle.arena.center, battle.arena.radius, houseIndex, houses.length, slot);
                try {
                    dependencies.endKneel(fighter.playerId);
                    player.teleport?.(spot.x, spot.y, spot.z, { yaw: spot.yaw });
                    player.hold?.({ owner: HOLD_OWNER, x: spot.x, y: spot.y, z: spot.z, radius: 150, mode: "clamp", ttlMs: (config.countdownSeconds + 2) * 1000 });
                } catch (error) { dependencies.warn?.(`Could not place fighter ${fighter.playerId}: ${error instanceof Error ? error.message : String(error)}`); }
                const state: CountdownState = { seconds: config.countdownSeconds, round: match.round + 1 };
                send(fighter.playerId, `${RESOURCE}:countdown`, JSON.stringify(state));
            });
        }
        refresh(battle);
        later(battle, () => fight(battle), config.countdownSeconds * 1000);
    }

    function fight(battle: Battle): void {
        const match = battle.match;
        if (!match || battle.phase !== "countdown") return;
        match.startRound(now());
        battle.phase = "fighting";
        battle.phaseEndsAt = now() + config.roundSeconds * 1000;
        pairUp(battle);
        // The arena holds every fighter inside its circle until the round ends.
        const { center, radius } = battle.arena;
        for (const fighter of match.active()) {
            try { dependencies.player(fighter.playerId)?.hold?.({ owner: HOLD_OWNER, x: center.x, y: center.y, z: center.z, radius, mode: "clamp", ttlMs: (config.roundSeconds + 5) * 1000 }); }
            catch (_) { /* left */ }
        }
        everyone(battle, `Round ${match.round}: fight!`);
        refresh(battle);
        later(battle, () => settle(battle, match.timeUp(now())), config.roundSeconds * 1000);
    }

    function settle(battle: Battle, result: HmpHouseWarsRoundResult | null): void {
        const match = battle.match;
        if (!match || !result || battle.phase === "done") return;
        clearTimers(battle);
        pairUp(battle);
        const how = result.reason === "time" ? "on time" : result.reason === "forfeit" ? "by forfeit" : "by elimination";
        everyone(battle, result.winner ? `${label(result.winner)} takes round ${result.round} ${how}` : `Round ${result.round} is a draw`);
        everyone(battle, match.houses().map((house) => `${label(house)} ${match.score.get(house) || 0}`).join(" · "));
        if (match.over) { void finish(battle, false); return; }
        battle.phase = "intermission";
        battle.phaseEndsAt = now() + config.intermissionSeconds * 1000;
        for (const fighter of match.active()) dependencies.setRecovery(fighter.playerId, true);
        refresh(battle);
        later(battle, () => {
            for (const fighter of match.active()) dependencies.setRecovery(fighter.playerId, false);
            countdown(battle);
        }, config.intermissionSeconds * 1000);
    }

    async function finish(battle: Battle, stoppedEarly: boolean): Promise<void> {
        const match = battle.match;
        if (!match || battle.phase === "done") return;
        battle.phase = "done";
        clearTimers(battle);
        const winner = stoppedEarly ? null : match.winner;
        const houses = match.houses();
        const housePoints: Partial<Record<HmpHouseWarsHouse, number>> = {};
        if (!stoppedEarly) {
            for (const house of houses) {
                const amount = config.housePoints.participation + (house === winner ? config.housePoints.win : 0);
                if (amount <= 0) continue;
                try {
                    await dependencies.award(house, amount, `${RESOURCE}:${battle.sessionId}:${house}`, house === winner ? "won a house battle" : "fought a house battle");
                    housePoints[house] = amount;
                } catch (error) { dependencies.warn?.(`Could not award ${house} its points: ${error instanceof Error ? error.message : String(error)}`); }
            }
        }
        everyone(battle, stoppedEarly ? "The house battle was stopped" : winner ? `${label(winner)} wins the house battle!` : "The house battle ends level");
        for (const [house, amount] of Object.entries(housePoints)) everyone(battle, `${amount} points to ${label(house as HmpHouseWarsHouse)}`);
        const event: HmpHouseWarsFinished = {
            activitySessionId: battle.sessionId, arena: battle.arena.id, houses, winner, score: match.scoreRecord(), rounds: [...match.rounds],
            fighters: [...match.fighters.values()].map((fighter) => ({ ...fighter })), housePoints, stopped: stoppedEarly, finishedAt: new Date(now()).toISOString(),
        };
        try { dependencies.finished(event); } catch (error) { dependencies.warn?.(`A hmp-housewars:finished handler failed: ${error instanceof Error ? error.message : String(error)}`); }
        try {
            await activities.sessions.complete(battle.sessionId, { winner: winner || "", stopped: stoppedEarly }, { resource: RESOURCE, reason: stoppedEarly ? "battle stopped" : "battle finished" });
        } catch (error) { dependencies.warn?.(`Could not complete battle '${battle.sessionId}': ${error instanceof Error ? error.message : String(error)}`); }
        if (battles.has(battle.sessionId)) release(battle);
    }

    /** A fighter is out of the match for good: their pairs and holds go, and the round is settled if it is over. */
    function departed(sessionId: string, playerId: number): void {
        const battle = battles.get(sessionId);
        if (byPlayer.get(playerId) === sessionId) byPlayer.delete(playerId);
        if (!battle) return;
        letGo(battle, playerId);
        const match = battle.match;
        if (!match || battle.phase === "done") return;
        const name = match.fighters.get(playerId)?.nickname || "A fighter";
        const result = match.leave(playerId, now());
        everyone(battle, `${name} left the battle`);
        if (result) settle(battle, result);
        else if (!match.live && match.over) void finish(battle, false);
        else refresh(battle);
    }

    async function leave(player: HouseWarsPlayer): Promise<boolean> {
        const battle = battleFor(player);
        if (!battle) return false;
        if (battle.phase === "forming") { await activities.sessions.leave(player, battle.sessionId, "left the battle"); return true; }
        // A running activity keeps its members until it ends; the fighter is out of the match from now.
        if (!battle.match || !battle.touched.has(player.id)) return false;
        const sessionId = battle.sessionId;
        departed(sessionId, player.id);
        byPlayer.set(player.id, sessionId);
        return true;
    }

    /** The host reports a kneel or death a hit caused. */
    function defeated(victimId: number, killerId: number): void {
        const battle = battleFor(victimId);
        const match = battle?.match;
        if (!battle || !match || battle.phase !== "fighting" || battleFor(killerId) !== battle) return;
        const victim = match.fighters.get(victimId), killer = match.fighters.get(killerId);
        const result = match.knockout(victimId, killerId, now());
        if (!victim || !killer || match.isStanding(victimId)) return;
        everyone(battle, `${killer.nickname} (${label(killer.house)}) knocks out ${victim.nickname} — ${label(victim.house)} has ${match.standingBy(victim.house)} left`);
        if (result) { settle(battle, result); return; }
        pairUp(battle);
        refresh(battle);
    }

    /** A fighter fell to something other than a rival: down for the round. */
    function died(playerId: number): void {
        const battle = battleFor(playerId);
        const match = battle?.match;
        if (!battle || !match || battle.phase !== "fighting" || !match.isStanding(playerId)) return;
        const result = match.knockout(playerId, null, now());
        everyone(battle, `${match.fighters.get(playerId)?.nickname || "A fighter"} is down`);
        if (result) { settle(battle, result); return; }
        pairUp(battle);
        refresh(battle);
    }

    async function cancel(player: HouseWarsPlayer): Promise<boolean> {
        const battle = battleFor(player);
        if (!battle) return false;
        const session = activities.sessions.get(battle.sessionId);
        if (!session || session.leaderPlayerId !== player.id) fail("Only the battle's host can stop it");
        if (battle.match) { await finish(battle, true); return true; }
        await activities.sessions.cancel(battle.sessionId, { resource: RESOURCE, actor: player, reason: "battle cancelled" });
        if (battles.has(battle.sessionId)) release(battle);
        return true;
    }

    function status() {
        return {
            state: stopped ? "stopped" as const : "ready" as const,
            battles: [...battles.values()].map((battle) => ({
                sessionId: battle.sessionId, arena: battle.arena.id, phase: battle.phase, round: battle.match?.round || 0,
                score: battle.match?.scoreRecord() || {},
            })),
        };
    }

    async function stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        disposePolicy();
        for (const battle of [...battles.values()]) release(battle);
        await disposeDefinition();
    }

    return { host, join, leave, start, cancel, defeated, died, status, stop, battleFor };
}

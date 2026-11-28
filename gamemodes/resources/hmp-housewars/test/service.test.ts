import assert = require("node:assert");
import { test } from "node:test";
import activityModule = require("../../../../resources/hmp-activities/server/service");
import pvpModule = require("../../../../resources/hmp-pvp/server/service");
import type { HmpHousePointTransaction } from "../../../../resources/hmp-houses/types";
import type { HmpHouseWarsFinished, HmpHouseWarsHouse } from "../types";
import { normalizeConfig } from "../server/config";
import { RESOURCE, createHouseWarsService, type HouseWarsPlayer } from "../server/service";

const { createActivityService } = activityModule;
const { createPvpService } = pvpModule;

interface TestPlayer extends HouseWarsPlayer {
    sent: Array<{ event: string; payload: Record<string, unknown> }>;
    said: string[];
    holds: string[];
    holdZ: number[];
    teleports: Array<{ x: number; y: number; z: number; options?: { yaw?: number; snapToGround?: boolean } }>;
}

function clock() {
    let time = 5_000_000;
    let sequence = 0;
    const timers = new Map<number, { at: number; handler: () => void }>();
    return {
        now: () => time,
        setTimer: (handler: () => void, ms: number) => { const id = ++sequence; timers.set(id, { at: time + ms, handler }); return id as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); },
        advance(ms: number) {
            const until = time + ms;
            for (;;) {
                const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!next) break;
                timers.delete(next[0]);
                time = next[1].at;
                next[1].handler();
            }
            time = until;
        },
        pending: () => timers.size,
    };
}

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function setup(
    overrides: Record<string, unknown> = {},
    houses: Record<number, HmpHouseWarsHouse | null> = { 1: "gryffindor", 2: "gryffindor", 3: "slytherin", 4: "slytherin", 5: "ravenclaw" },
    onHouse?: (player: HouseWarsPlayer) => Promise<void>,
    dropAfterStart?: number,
) {
    const time = clock();
    const makePlayer = (id: number): TestPlayer => ({
        id, nickname: `P${id}`, position: { x: 0, y: 0, z: 0 }, virtualWorld: 0, sent: [], said: [], holds: [], holdZ: [], teleports: [],
        emit(event: string, payload?: unknown) { this.sent.push({ event, payload: JSON.parse(String(payload)) }); },
        location: () => ({ areaId: "Overland", regionId: "Hogsmeade" }),
        teleport(x: number, y: number, z: number, options) { this.position = { x, y, z }; this.teleports.push({ x, y, z, options }); return 1; },
        hold(options) { this.holds.push(`hold:${options.radius}`); this.holdZ.push(options.radiusZ ?? -1); return true; },
        release(owner: string) { this.holds.push(`release:${owner}`); return true; },
    });
    const players = [1, 2, 3, 4, 5].map(makePlayer);
    const core = { characters: { active: (player: HouseWarsPlayer | number) => { const id = typeof player === "number" ? player : player.id; return { id: id * 10, accountId: id, slot: 1, name: `C${id}`, status: "active", createdAt: "", updatedAt: "", deletedAt: null }; } } };
    let sequence = 0;
    const activities = createActivityService<HouseWarsPlayer>({ core: core as never, config: { command: "activities", enableCommands: false, maxDefinitions: 10, maxSessions: 10, maxMetadataBytes: 1024, maxInvitations: 20, defaultInvitationTtlSeconds: 30, maximumInvitationTtlSeconds: 60, defaultLobbyTtlSeconds: 300, maximumLobbyTtlSeconds: 900, sweepIntervalSeconds: 30, enableTestActivity: false }, id: () => `battle-${++sequence}` });
    let policy: ((hit: never) => unknown) | null = null;
    const pvp = createPvpService({ defaultDecision: "allow", initialLethalMode: false, install: (fn) => { policy = fn as never; }, clearPolicy: () => { policy = null; }, vitals: () => null, applyMode: () => undefined });
    const pairs = new Map<string, unknown>();
    const recovery = new Map<number, boolean>();
    const kneels: number[] = [];
    const awards: Array<[string, number, string]> = [];
    const ledger: HmpHousePointTransaction[] = [];
    const warnings: string[] = [];
    const finished: HmpHouseWarsFinished[] = [];
    let room = true;
    const config = normalizeConfig({ countdownSeconds: 3, intermissionSeconds: 5, roundSeconds: 60, ...overrides });
    let dropped: number | null = null;
    const sessions = dropAfterStart === undefined ? activities.sessions : {
        ...activities.sessions,
        start: async (id: string, owner: Parameters<typeof activities.sessions.start>[1]) => {
            const started = await activities.sessions.start(id, owner);
            dropped = dropAfterStart;
            return started;
        },
        get: (id: string) => {
            const session = activities.sessions.get(id);
            if (!session || dropped === null) return session;
            const leaving = dropped;
            dropped = null;
            return { ...session, participants: session.participants.filter((entry) => entry.playerId !== leaving) };
        },
    };
    const service = createHouseWarsService({
        config, activities: (dropAfterStart === undefined ? activities : { ...activities, sessions }) as never, pvp,
        player: (id) => players.find((player) => player.id === id) || null,
        character: (player) => ({ id: player.id * 10, name: `C${player.id}` }),
        house: async (player) => { if (onHouse) await onHouse(player); return houses[player.id] ?? null; },
        pair: (a, b, options) => { const key = a < b ? `${a}:${b}` : `${b}:${a}`; if (options === null) pairs.delete(key); else pairs.set(key, options); return room || options === null; },
        setRecovery: (id, on) => { recovery.set(id, on); },
        endKneel: (id) => { kneels.push(id); },
        award: async (house, amount, reference, reason, metadata) => {
            awards.push([house, amount, reference]);
            ledger.push({ id: ledger.length + 1, reference, house, amount, balanceAfter: null, actorCharacterId: null, resource: RESOURCE, reason, metadata: metadata || {}, status: "completed", error: "", createdAt: new Date(time.now()), completedAt: new Date(time.now()) });
        },
        history: async (house) => ledger.filter((row) => row.house === house).map((row) => ({ ...row })),
        emit: (player, event, payload) => player.emit(event, payload),
        say: (player, message) => { (player as TestPlayer).said.push(message); },
        finished: (event) => { finished.push(event); },
        warn: (message) => { warnings.push(message); },
        now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    });
    const hit = (casterId: number, victimId: number) => pvp.policy.evaluate({ casterId, victimId, spellId: 1, spell: "Stupefy", damage: 20, duration: 0 });
    return { time, players, activities, pvp, service, pairs, recovery, kneels, awards, ledger, warnings, finished, hit, setRoom: (value: boolean) => { room = value; }, policy: () => policy };
}

async function lobby(context: ReturnType<typeof setup>, ids = [1, 2, 3, 4]) {
    const [hostId, ...rest] = ids;
    await context.service.host(context.players[hostId - 1]);
    for (const id of rest) await context.service.join(context.players[id - 1]);
}

test("runs a best-of-three house battle and awards House Cup points", async () => {
    const context = setup();
    const { time, players: [p1, p2, p3, p4], service, pairs, recovery, kneels, awards, finished, hit } = context;
    await lobby(context);
    await assert.rejects(() => service.start(p3), /Only the battle's host/);
    await service.start(p1);

    // Countdown: in corners, held, everyone peaceful, recovery off.
    assert.strictEqual(pairs.size, 6);
    assert.ok([...pairs.values()].every((options) => (options as { hostile: boolean }).hostile === false));
    assert.ok(p1.position.x > 0 && p3.position.x < 0, "each house has its own corner");
    assert.deepStrictEqual([p1.holds[0], p1.holdZ[0], p1.teleports[0].options?.snapToGround, recovery.get(1)], ["hold:150", 150, true, false]);
    assert.deepStrictEqual(hit(1, 3), false, "no hits during the countdown");

    time.advance(3000);
    // Round 1: hostile across houses only, held inside the arena.
    assert.deepStrictEqual(pairs.get("1:3"), { hostile: true, aim: "lock", defeat: "kneel" });
    assert.deepStrictEqual(pairs.get("1:2"), { hostile: false });
    assert.strictEqual(p1.holds.at(-1), "hold:2500");
    assert.strictEqual(p1.holdZ.at(-1), 2500, "the arena holds the host's height too");
    assert.deepStrictEqual(hit(1, 3), { minHp: 1 });
    assert.strictEqual(hit(1, 2), false, "no friendly fire");
    assert.strictEqual(hit(5, 1), false, "an outsider cannot hit a fighter");
    assert.strictEqual(hit(1, 5), false, "a fighter cannot hit a bystander");
    const hud = p1.sent.filter((entry) => entry.event === "hmp-housewars:hud").at(-1)!.payload;
    assert.deepStrictEqual([hud.phase, hud.round, hud.house, hud.standing], ["fighting", 1, "gryffindor", true]);

    service.defeated(3, 1);
    assert.strictEqual(hit(2, 3), false, "a knocked-out fighter is left alone");
    assert.deepStrictEqual(pairs.get("2:3"), { hostile: false });
    service.defeated(4, 2);
    assert.ok(p3.said.some((line) => /Gryffindor takes round 1 by elimination/.test(line)));
    assert.strictEqual(recovery.get(3), true, "everyone heals between rounds");

    time.advance(5000 + 3000);
    // Round 2 goes to Slytherin on time: one Gryffindor is down when the clock runs out.
    service.died(1);
    time.advance(60_000);
    assert.ok(p1.said.some((line) => /Slytherin takes round 2 on time/.test(line)));

    time.advance(5000 + 3000);
    const kneelsBefore = kneels.length;
    service.defeated(3, 1);
    service.defeated(4, 1);
    await tick();
    assert.strictEqual(finished.length, 1);
    const result = finished[0];
    assert.deepStrictEqual([result.winner, result.score, result.rounds.map((round) => round.winner)], ["gryffindor", { gryffindor: 2, slytherin: 1 }, ["gryffindor", "slytherin", "gryffindor"]]);
    assert.strictEqual(result.fighters.find((entry) => entry.playerId === 1)!.knockouts, 3);
    assert.deepStrictEqual(awards, [["gryffindor", 60, `hmp-housewars:${result.activitySessionId}:gryffindor`], ["slytherin", 10, `hmp-housewars:${result.activitySessionId}:slytherin`]]);
    assert.deepStrictEqual(result.housePoints, { gryffindor: 60, slytherin: 10 });

    // Everyone is let go.
    assert.strictEqual(pairs.size, 0);
    assert.deepStrictEqual([recovery.get(1), recovery.get(4), p4.holds.at(-1)], [true, true, "release:hmp-housewars"]);
    assert.ok([3, 4].every((id) => kneels.slice(kneelsBefore).includes(id)), "knocked-out fighters stand up when released");
    assert.deepStrictEqual(p2.sent.at(-1)?.payload, { active: false });
    assert.strictEqual(hit(1, 3), true, "the battle's rule abstains once it is over, leaving the server's default");
    assert.strictEqual(time.pending(), 0);
    await service.stop();
});

test("refuses a battle of one house, an uneven one, and a player without a house", async () => {
    const context = setup({ maxPerHouse: 4 }, { 1: "gryffindor", 2: "gryffindor", 3: "gryffindor", 4: "slytherin", 5: null });
    const { players: [p1, , , , p5], service } = context;
    await assert.rejects(() => service.host(p5), /no house/);
    await lobby(context, [1, 2]);
    await assert.rejects(() => service.start(p1), /at least two houses/);
    await service.join(context.players[2]);
    await service.join(context.players[3]);
    await assert.rejects(() => service.start(p1), /uneven \(3 v 1\)/);
    await service.stop();
});

test("a house whose fighters leave forfeits; retiring keeps the activity until the end", async () => {
    const context = setup();
    const { time, players: [p1, , p3, p4], service, finished, awards } = context;
    await lobby(context);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(await service.leave(p3), true);
    assert.strictEqual(await service.leave(p3), false, "retired once");
    assert.ok(p1.said.some((line) => /P3 left the battle/.test(line)));
    assert.strictEqual(await service.leave(p4), true);
    await tick();
    assert.strictEqual(finished[0].winner, "gryffindor");
    assert.deepStrictEqual(finished[0].rounds.map((round) => round.reason), ["forfeit"]);
    assert.deepStrictEqual(finished[0].houses, Object.keys(finished[0].score), "a house whose fighters all left is still listed beside its score");
    assert.deepStrictEqual(finished[0].fighters.map((fighter) => [fighter.playerId, fighter.left]), [[1, false], [2, false], [3, true], [4, true]]);
    assert.deepStrictEqual([awards.length, finished[0].housePoints], [0, {}], "a match of forfeits only pays nobody");
    await service.stop();
});

test("a retired fighter who then disconnects is announced once", async () => {
    const context = setup();
    const { time, players: [p1, , p3], service, activities, finished } = context;
    await lobby(context);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(await service.leave(p3), true);
    await activities.disconnect(p3);
    await tick();
    assert.strictEqual(p1.said.filter((line) => /P3 left the battle/.test(line)).length, 1);
    assert.strictEqual(finished.length, 0, "the match goes on");
    await service.stop();
});

test("the host can stop a running battle: no winner and no points", async () => {
    const context = setup();
    const { time, players: [p1], service, finished, awards, pairs } = context;
    await lobby(context);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(await service.cancel(p1), true);
    await tick();
    assert.deepStrictEqual([finished[0].stopped, finished[0].winner, awards.length, pairs.size], [true, null, 0, 0]);
    await service.stop();
});

test("cancels the start when the host has no room for the pairs", async () => {
    const context = setup();
    const { players: [p1, p2], service, pairs, recovery, setRoom } = context;
    await lobby(context);
    setRoom(false);
    await service.start(p1);
    await tick();
    assert.ok(p2.said.some((line) => /no room/.test(line)));
    assert.deepStrictEqual([pairs.size, recovery.get(2), service.battleFor(p2)], [0, true, null]);
    await service.stop();
});

test("pays no points when a fighter walks out before the first round", async () => {
    const context = setup();
    const { players: [p1, , p3], service, finished, awards } = context;
    await lobby(context, [1, 3]);
    await service.start(p1);
    assert.strictEqual(await service.leave(p3), true, "leaving the countdown retires the fighter");
    await tick();
    assert.strictEqual(finished.length, 1);
    assert.deepStrictEqual([finished[0].stopped, finished[0].rounds.length], [false, 0]);
    assert.deepStrictEqual([awards.length, finished[0].housePoints], [0, {}]);
    await service.stop();
});

test("rechecks every participant's house at start", async () => {
    const context = setup();
    const { players: [p1, , p3], service, activities } = context;
    await lobby(context, [1, 3]);
    const sessionId = service.status().battles[0].sessionId;
    assert.strictEqual(activities.sessions.get(sessionId)!.metadata.hostedBy, "housewars", "host marks its lobby");
    await activities.sessions.select(p3, sessionId, { team: "ravenclaw" });
    await assert.rejects(() => service.start(p1), /P3 is no longer in Ravenclaw/);
    await service.stop();
});

test("reads a player-scoped cooldown from the ledger, not a per-house memory timer", async () => {
    const context = setup({ housePointsCooldownSeconds: 60, rounds: 1, minPayoutKillers: 1 });
    const { time, service, awards, ledger, warnings } = context;
    const quickMatch = async (ids = [1, 3]) => {
        await lobby(context, ids);
        await service.start(context.players[ids[0] - 1]);
        time.advance(3000);
        service.defeated(ids[1], ids[0]);
        await tick();
    };
    await quickMatch();
    assert.deepStrictEqual(awards.map(([house, amount]) => [house, amount]), [["gryffindor", 60], ["slytherin", 10]]);
    assert.deepStrictEqual(ledger[0].metadata.players, [1, 3], "the ledger records who fought");
    await quickMatch([2, 4]);
    assert.strictEqual(awards.length, 4, "a different pair of fighters is not blocked by the same houses");
    await quickMatch();
    assert.strictEqual(awards.length, 4, "the same fighters are blocked by the ledger cooldown");
    time.advance(60_000);
    await quickMatch();
    assert.strictEqual(awards.length, 6, "the cooldown expires");
    await service.stop();
});

test("caps the points a house can receive in a day", async () => {
    const context = setup({ rounds: 1, minPayoutKillers: 1, housePointsCooldownSeconds: 0, housePointsDailyCap: 70 });
    const { time, service, awards, warnings } = context;
    const quickMatch = async (ids: number[]) => {
        await lobby(context, ids);
        await service.start(context.players[ids[0] - 1]);
        time.advance(3000);
        service.defeated(ids[1], ids[0]);
        await tick();
    };
    await quickMatch([1, 3]);
    await quickMatch([2, 4]);
    assert.deepStrictEqual(awards.map(([house]) => house), ["gryffindor", "slytherin", "slytherin"], "the second win is under the daily cap");
    await service.stop();
});

test("no payout for a seconds-long match with one knock-out or a fall", async () => {
    const context = setup({ rounds: 1 });
    const { time, service, awards, finished } = context;
    for (const knock of ["defeated", "died"] as const) {
        await lobby(context, [1, 3]);
        await service.start(context.players[0]);
        time.advance(3000);
        if (knock === "defeated") service.defeated(3, 1);
        else service.died(3);
        await tick();
    }
    assert.deepStrictEqual([awards.length, finished.map((event) => event.housePoints)], [0, [{}, {}]], "a quick single KO or a fall pays nobody");
    await service.stop();
});

test("takes a leaver out of the match, so outsiders can hit them again", async () => {
    const context = setup();
    const { time, players: [p1, , p3], service, hit } = context;
    await lobby(context);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(hit(5, 3), false, "a fighter is protected while in the match");
    assert.strictEqual(await service.leave(p3), true);
    assert.strictEqual(hit(5, 3), true, "a leaver is no longer a fighter");
    await service.stop();
});

test("stands up a fighter who leaves while kneeling", async () => {
    const context = setup();
    const { time, players: [p1, , p3], service, kneels } = context;
    await lobby(context);
    await service.start(p1);
    time.advance(3000);
    service.defeated(3, 1);
    const before = kneels.filter((id) => id === 3).length;
    assert.strictEqual(await service.leave(p3), true);
    assert.strictEqual(kneels.filter((id) => id === 3).length, before + 1, "leaving ends the kneel at once");
    await service.stop();
});

test("re-reads the session after the membership awaits", async () => {
    let context!: ReturnType<typeof setup>;
    let left = false;
    let checking = false;
    context = setup({ rounds: 1 }, undefined, async (player) => {
        if (checking && player.id === 5 && !left) {
            left = true;
            await context.activities.sessions.leave(context.players[4], context.service.status().battles[0].sessionId);
        }
    });
    const { time, players: [p1, , , , p5], service, finished } = context;
    await lobby(context, [1, 3, 5]);
    checking = true;
    await service.start(p1);
    time.advance(3000);
    service.defeated(3, 1);
    await tick();
    assert.strictEqual(finished.length, 1);
    assert.deepStrictEqual(finished[0].houses, ["gryffindor", "slytherin"], "the fighter who left mid-await cannot keep a house alive");
    assert.strictEqual(finished[0].fighters.some((fighter) => fighter.playerId === p5.id), false);
    await service.stop();
});

test("re-reads the session after start", async () => {
    const context = setup({ rounds: 1 }, undefined, undefined, 5);
    const { time, players: [p1, , , , p5], service, finished, hit } = context;
    await lobby(context, [1, 3, 5]);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(hit(5, 1), false, "the fighter who left during the start is no fighter");
    service.defeated(3, 1);
    await tick();
    assert.strictEqual(finished.length, 1, "and cannot keep Ravenclaw alive");
    assert.strictEqual(finished[0].winner, "gryffindor");
    assert.strictEqual(finished[0].fighters.find((fighter) => fighter.playerId === p5.id)?.left, true);
    await service.stop();
});

test("raises a stopped finished event when the resource stops", async () => {
    const context = setup();
    const { players: [p1], service, finished, awards } = context;
    await lobby(context);
    await service.start(p1);
    await service.stop();
    assert.strictEqual(finished.length, 1);
    assert.deepStrictEqual([finished[0].stopped, finished[0].winner, awards.length], [true, null, 0]);
});

test("raises a stopped finished event when the activity is cancelled outside", async () => {
    const context = setup();
    const { players: [p1], service, activities, finished, awards } = context;
    await lobby(context);
    await service.start(p1);
    await activities.sessions.cancel(service.status().battles[0].sessionId, { actor: p1, reason: "cancelled by admin" });
    await tick();
    assert.strictEqual(finished.length, 1);
    assert.deepStrictEqual([finished[0].stopped, finished[0].winner, awards.length, service.battleFor(p1)], [true, null, 0, null]);
    await service.stop();
});

test("refuses /activities start on a hosted lobby", async () => {
    const context = setup();
    const { players: [p1], service, activities } = context;
    await lobby(context);
    const sessionId = service.status().battles[0].sessionId;
    await assert.rejects(() => activities.sessions.start(sessionId, { actor: p1, reason: "closed testing" }), /housewars start/i);
    assert.strictEqual(activities.sessions.get(sessionId)?.state, "forming");
    await service.start(p1);
    assert.strictEqual(activities.sessions.get(sessionId)?.state, "running");
    await service.stop();
});

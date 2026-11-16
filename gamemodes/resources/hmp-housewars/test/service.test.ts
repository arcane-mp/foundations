import assert = require("node:assert");
import { test } from "node:test";
import activityModule = require("../../../../resources/hmp-activities/server/service");
import pvpModule = require("../../../../resources/hmp-pvp/server/service");
import type { HmpHouseWarsFinished, HmpHouseWarsHouse } from "../types";
import { normalizeConfig } from "../server/config";
import { createHouseWarsService, type HouseWarsPlayer } from "../server/service";

const { createActivityService } = activityModule;
const { createPvpService } = pvpModule;

interface TestPlayer extends HouseWarsPlayer { sent: Array<{ event: string; payload: Record<string, unknown> }>; said: string[]; holds: string[] }

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

function setup(overrides: Record<string, unknown> = {}, houses: Record<number, HmpHouseWarsHouse | null> = { 1: "gryffindor", 2: "gryffindor", 3: "slytherin", 4: "slytherin", 5: "ravenclaw" }) {
    const time = clock();
    const makePlayer = (id: number): TestPlayer => ({
        id, nickname: `P${id}`, position: { x: 0, y: 0, z: 0 }, virtualWorld: 0, sent: [], said: [], holds: [],
        emit(event: string, payload?: unknown) { this.sent.push({ event, payload: JSON.parse(String(payload)) }); },
        location: () => ({ areaId: "Overland", regionId: "Hogsmeade" }),
        teleport(x: number, y: number, z: number) { this.position = { x, y, z }; return 1; },
        hold(options) { this.holds.push(`hold:${options.radius}`); return true; },
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
    const finished: HmpHouseWarsFinished[] = [];
    let room = true;
    const config = normalizeConfig({ countdownSeconds: 3, intermissionSeconds: 5, roundSeconds: 60, ...overrides });
    const service = createHouseWarsService({
        config, activities: activities as never, pvp,
        player: (id) => players.find((player) => player.id === id) || null,
        character: (player) => ({ id: player.id * 10, name: `C${player.id}` }),
        house: async (player) => houses[player.id] ?? null,
        pair: (a, b, options) => { const key = a < b ? `${a}:${b}` : `${b}:${a}`; if (options === null) pairs.delete(key); else pairs.set(key, options); return room || options === null; },
        setRecovery: (id, on) => { recovery.set(id, on); },
        endKneel: (id) => { kneels.push(id); },
        award: async (house, amount, reference) => { awards.push([house, amount, reference]); },
        emit: (player, event, payload) => player.emit(event, payload),
        say: (player, message) => { (player as TestPlayer).said.push(message); },
        finished: (event) => { finished.push(event); },
        now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    });
    const hit = (casterId: number, victimId: number) => pvp.policy.evaluate({ casterId, victimId, spellId: 1, spell: "Stupefy", damage: 20, duration: 0 });
    return { time, players, activities, pvp, service, pairs, recovery, kneels, awards, finished, hit, setRoom: (value: boolean) => { room = value; }, policy: () => policy };
}

async function lobby(context: ReturnType<typeof setup>, ids = [1, 2, 3, 4]) {
    const [hostId, ...rest] = ids;
    await context.service.host(context.players[hostId - 1]);
    for (const id of rest) await context.service.join(context.players[id - 1]);
}

test("runs a best-of-three house battle and awards House Cup points", async () => {
    const context = setup();
    const { time, players: [p1, p2, p3, p4], service, pairs, recovery, awards, finished, hit } = context;
    await lobby(context);
    await assert.rejects(() => service.start(p3), /Only the battle's host/);
    await service.start(p1);

    // Countdown: in corners, held, everyone peaceful, recovery off.
    assert.strictEqual(pairs.size, 6);
    assert.ok([...pairs.values()].every((options) => (options as { hostile: boolean }).hostile === false));
    assert.ok(p1.position.x > 0 && p3.position.x < 0, "each house has its own corner");
    assert.deepStrictEqual([p1.holds[0], recovery.get(1)], ["hold:150", false]);
    assert.deepStrictEqual(hit(1, 3), false, "no hits during the countdown");

    time.advance(3000);
    // Round 1: hostile across houses only, held inside the arena.
    assert.deepStrictEqual(pairs.get("1:3"), { hostile: true, aim: "lock", defeat: "kneel" });
    assert.deepStrictEqual(pairs.get("1:2"), { hostile: false });
    assert.strictEqual(p1.holds.at(-1), "hold:2500");
    assert.deepStrictEqual(hit(1, 3), { minHp: 1 });
    assert.strictEqual(hit(1, 2), false, "no friendly fire");
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
    assert.deepStrictEqual(p2.sent.at(-1)?.payload, { active: false });
    assert.strictEqual(hit(1, 3), true, "the battle's rule abstains once it is over, leaving the server's default");
    assert.strictEqual(time.pending(), 0);
    await service.stop();
});

test("refuses a battle of one house, an uneven one, and a player without a house", async () => {
    const context = setup({}, { 1: "gryffindor", 2: "gryffindor", 3: "gryffindor", 4: "slytherin", 5: null });
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
    assert.strictEqual(awards.length, 2, "both houses fought");
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

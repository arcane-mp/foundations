import assert = require("node:assert");
import { test } from "node:test";
import activityModule = require("../../../../resources/hmp-activities/server/service");
import type { HmpExpeditionFinished } from "../types";
import { normalizeConfig } from "../server/config";
import { createExpeditionService, type ExpeditionPlayer } from "../server/service";
import { createExpeditionStore, type KeyValueStore } from "../server/store";

const { createActivityService } = activityModule;

interface TestPlayer extends ExpeditionPlayer { sent: Array<{ event: string; payload: Record<string, unknown> }>; said: string[]; holds: string[] }

function clock() {
    let time = 9_000_000;
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

function memoryStore(): KeyValueStore {
    const data = new Map<string, string>();
    return {
        get: (system, key) => data.get(`${system}/${key}`) ?? null,
        list: (system) => [...data.entries()].filter(([key]) => key.startsWith(`${system}/`)).map(([key, value]) => ({ key: key.slice(system.length + 1), value })),
        set: async (system, key, value) => { data.set(`${system}/${key}`, value); return true; },
        delete: async (system, key) => data.delete(`${system}/${key}`),
    };
}

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

interface HistoryEntry { createdAt: string; resource: string; status: "completed" | "pending" | "failed" }

function setup(overrides: Record<string, unknown> = {}, options: { worlds?: boolean; history?: (characterId: number) => Promise<HistoryEntry[]> } = {}) {
    const time = clock();
    const makePlayer = (id: number): TestPlayer => ({
        id, nickname: `P${id}`, position: { x: 0, y: 0, z: 0 }, virtualWorld: 0, sent: [], said: [], holds: [],
        emit(event: string, payload?: unknown) { this.sent.push({ event, payload: JSON.parse(String(payload)) }); },
        location: () => ({ areaId: "Overland", regionId: "Feldcroft" }),
        teleport(x: number, y: number, z: number) { this.position = { x, y, z }; return 1; },
        hold(options) { this.holds.push(`hold:${options.radius}`); return true; },
        release(owner: string) { this.holds.push(`release:${owner}`); return true; },
    });
    const players = [1, 2, 3].map(makePlayer);
    const core = { characters: { active: (player: ExpeditionPlayer | number) => { const id = typeof player === "number" ? player : player.id; return { id: id * 10, accountId: id, slot: 1, name: `C${id}`, status: "active", createdAt: "", updatedAt: "", deletedAt: null }; } } };
    let sequence = 0;
    const activities = createActivityService<ExpeditionPlayer>({ core: core as never, config: { command: "activities", enableCommands: false, maxDefinitions: 10, maxSessions: 10, maxMetadataBytes: 1024, maxInvitations: 20, defaultInvitationTtlSeconds: 30, maximumInvitationTtlSeconds: 60, defaultLobbyTtlSeconds: 300, maximumLobbyTtlSeconds: 900, sweepIntervalSeconds: 30, enableTestActivity: false }, id: () => `exp-${++sequence}` });
    const config = normalizeConfig({
        countdownSeconds: 3, stageDelaySeconds: 2, timeLimitSeconds: 600,
        expeditions: {
            ruins: {
                label: "Forgotten Ruins", experience: 300, entrance: { x: 0, y: 0, z: 0, yaw: 0 },
                stages: [
                    { x: 1000, y: 0, z: 0, enemies: [{ id: "Goblin_Melee", count: 2 }] },
                    { x: 2000, y: 0, z: 0, enemies: [], boss: { id: "Troll_Forest", health: 4000 } },
                ],
            },
        },
        ...overrides,
    });
    const store = createExpeditionStore({ store: memoryStore(), configured: config.expeditions });
    const spawned: Array<{ id: number; enemyId: string; ownerId?: number; maxHealth?: number }> = [];
    const destroyed: number[] = [];
    const worldsSet: Array<[number, number]> = [];
    const npcWorlds: Array<[number, number]> = [];
    const rewards: Array<[number, number, string]> = [];
    const rewardLog: Array<{ characterId: number; at: number }> = [];
    const finished: HmpExpeditionFinished[] = [];
    const living = new Set<number>();
    let failSpawns = false;
    let spawnFailureAt = 0;
    let capacity = 256;
    let npcWorldResult: boolean | "throw" = true;
    const service = createExpeditionService({
        config, store, activities: activities as never,
        npcs: {
            spawn: (input) => {
                if (failSpawns || spawnFailureAt === spawned.length + 1) throw new Error("not in catalog");
                const npc = { id: 500 + spawned.length, enemyId: input.enemyId, ownerId: input.ownerId, maxHealth: input.maxHealth };
                spawned.push(npc); living.add(npc.id); return npc;
            },
            destroy: (id) => { destroyed.push(id); living.delete(id); return true; },
            setVirtualWorld: (id, _resource, world) => {
                npcWorlds.push([id, world]);
                if (npcWorldResult === "throw") throw new Error("host refused the world");
                return npcWorldResult;
            },
            get: (id) => living.has(id) ? { id, enemyId: "Goblin_Melee", resource: "hmp-expeditions", disposition: "hostile", alive: true, health: 1, maxHealth: 1, scale: 1 } : null,
            status: () => ({ state: "ready", managed: living.size, resources: { "hmp-expeditions": living.size }, catalogSize: 0, maximumManagedNpcs: 512, maximumPerResource: capacity }),
        },
        player: (id) => players.find((player) => player.id === id) || null,
        character: (player) => ({ id: player.id * 10, name: `C${player.id}` }),
        setWorld: (player, world) => { worldsSet.push([player.id, world]); if (options.worlds === false) return false; player.virtualWorld = world; return true; },
        reward: async (characterId, experience, reference) => { rewards.push([characterId, experience, reference]); rewardLog.push({ characterId, at: time.now() }); },
        history: async (characterId) => [
            ...(await (options.history?.(characterId) ?? [])),
            ...rewardLog.filter((entry) => entry.characterId === characterId).map((entry) => ({ createdAt: new Date(entry.at).toISOString(), resource: "hmp-expeditions", status: "completed" as const })),
        ],
        emit: (player, event, payload) => player.emit(event, payload),
        say: (player, message) => { (player as TestPlayer).said.push(message); },
        finished: (event) => { finished.push(event); },
        now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    });
    return {
        time, players, activities, service, store, spawned, destroyed, worldsSet, npcWorlds, rewards, finished,
        failSpawns: () => { failSpawns = true; },
        failAt: (index: number) => { spawnFailureAt = index; },
        setCapacity: (count: number) => { capacity = count; },
        setNpcWorld: (result: boolean | "throw") => { npcWorldResult = result; },
        vanish: (id: number) => { living.delete(id); },
    };
}

test("clears an expedition stage by stage, rewards the party and keeps the record", async () => {
    const context = setup();
    const { time, players: [p1, p2], service, store, spawned, rewards, finished } = context;
    await assert.rejects(() => service.host(p1, "nowhere"), /No expedition/);
    await service.host(p1, "ruins");
    await service.join(p2);
    await assert.rejects(() => service.start(p2), /Only the expedition's leader/);
    await service.start(p1);
    assert.deepStrictEqual([p1.holds[0], p2.position.y !== p1.position.y], ["hold:150", true], "gathered at the entrance, side by side");
    assert.strictEqual(spawned.length, 0, "nothing spawns during the countdown");

    time.advance(3000);
    // Stage 1 for two: 2 goblins plus half again for the second fighter, owners alternating.
    assert.deepStrictEqual(spawned.map((npc) => [npc.enemyId, npc.ownerId]), [["Goblin_Melee", 1], ["Goblin_Melee", 2], ["Goblin_Melee", 1]]);
    const objective = p2.sent.filter((entry) => entry.event === "hmp-expeditions:objective").at(-1)!.payload;
    assert.deepStrictEqual(objective, { active: true, x: 1000, y: 0, z: 0, boss: false });
    service.npcDied(spawned[0].id);
    service.npcDied(spawned[0].id);
    assert.strictEqual(p1.sent.filter((entry) => entry.event === "hmp-expeditions:hud").at(-1)!.payload.remaining, 2, "a death counts once");
    service.npcDied(spawned[1].id);
    service.npcDied(spawned[2].id);
    assert.ok(p1.said.some((line) => /Stage 1 cleared/.test(line)));
    assert.strictEqual(spawned.length, 3, "the next stage waits for the delay");
    time.advance(2000);
    // The boss has half again its health for the second fighter; owners keep rotating across stages.
    assert.deepStrictEqual(spawned.at(-1), { id: 503, enemyId: "Troll_Forest", ownerId: 2, maxHealth: 7000 });
    time.advance(60_000);
    for (const player of [p1, p2]) player.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(503);
    await tick();

    assert.strictEqual(finished.length, 1);
    const result = finished[0];
    assert.deepStrictEqual([result.result, result.cleared, result.stages, result.defeated, result.record, result.durationMs], ["cleared", 2, 2, 4, true, 65_000]);
    assert.deepStrictEqual(rewards, [[10, 300, `hmp-expeditions:${result.activitySessionId}:10`], [20, 300, `hmp-expeditions:${result.activitySessionId}:20`]]);
    assert.ok(result.participants.every((participant) => participant.rewarded));
    assert.deepStrictEqual(store.record("ruins"), { timeMs: 65_000, party: "C1, C2", at: result.finishedAt });
    assert.deepStrictEqual(p1.sent.filter((entry) => entry.event === "hmp-expeditions:hud").at(-1)!.payload, { active: false });
    assert.strictEqual(time.pending(), 0);
    await service.stop();
});

test("fails on a wipe, and on time; leftover enemies are removed, nobody is paid", async () => {
    const wipe = setup();
    await wipe.service.host(wipe.players[0], "ruins");
    await wipe.service.join(wipe.players[1]);
    await wipe.service.start(wipe.players[0]);
    wipe.time.advance(3000);
    wipe.service.downed(1);
    wipe.service.revived(1);
    wipe.service.downed(2);
    assert.strictEqual(wipe.finished.length, 0, "one fighter is still up");
    wipe.service.downed(1);
    await tick();
    assert.deepStrictEqual([wipe.finished[0].result, wipe.finished[0].cleared, wipe.rewards.length], ["wiped", 0, 0]);
    assert.deepStrictEqual(wipe.destroyed.sort(), wipe.spawned.map((npc) => npc.id).sort());
    await wipe.service.stop();

    const late = setup({ timeLimitSeconds: 60 });
    await late.service.host(late.players[0], "ruins");
    await late.service.start(late.players[0]);
    late.time.advance(3000 + 60_000);
    await tick();
    assert.deepStrictEqual([late.finished[0].result, late.store.record("ruins")], ["timeout", null]);
    await late.service.stop();
});

test("a wipe during the countdown and during a stage delay ends the run", async () => {
    const countdown = setup();
    await countdown.service.host(countdown.players[0], "ruins");
    await countdown.service.join(countdown.players[1]);
    await countdown.service.start(countdown.players[0]);
    countdown.service.downed(1);
    assert.strictEqual(countdown.finished.length, 0, "one fighter is still up");
    countdown.service.downed(2);
    await tick();
    assert.deepStrictEqual([countdown.finished[0].result, countdown.rewards.length, countdown.time.pending()], ["wiped", 0, 0]);
    await countdown.service.stop();

    const delay = setup();
    await delay.service.host(delay.players[0], "ruins");
    await delay.service.start(delay.players[0]);
    delay.time.advance(3000);
    for (const npc of [...delay.spawned]) delay.service.npcDied(npc.id);
    assert.strictEqual(delay.spawned.length, 2, "the next stage waits for the delay");
    delay.service.downed(1);
    await tick();
    assert.deepStrictEqual([delay.finished[0].result, delay.spawned.length], ["wiped", 2], "no next stage spawns after the wipe");
    await delay.service.stop();
});

test("pays a character only once per reward cooldown", async () => {
    const context = setup();
    const { time, players: [p1, p2], service, rewards, finished } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    for (const npc of [500, 501]) service.npcDied(npc);
    time.advance(2000);
    p1.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(502);
    await tick();
    assert.deepStrictEqual(rewards, [[10, 300, `hmp-expeditions:${finished[0].activitySessionId}:10`]]);

    await service.host(p1, "ruins");
    await service.join(p2);
    await service.start(p1);
    time.advance(3000);
    for (const npc of [503, 504, 505]) service.npcDied(npc);
    time.advance(2000);
    for (const player of [p1, p2]) player.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(506);
    await tick();
    assert.deepStrictEqual(finished[1].participants.map((member) => [member.characterId, member.rewarded]), [[10, false], [20, true]]);
    assert.deepStrictEqual(rewards.at(-1), [20, 300, `hmp-expeditions:${finished[1].activitySessionId}:20`]);
    await service.stop();
});

test("runs each party in a virtual world of its own, and gives the old one back", async () => {
    const context = setup({ instanced: true, firstVirtualWorld: 7000 });
    const { time, players: [p1, p2], service, npcWorlds, finished } = context;
    p2.virtualWorld = 3;
    await service.host(p1, "ruins");
    await service.join(p2);
    await service.start(p1);
    assert.deepStrictEqual([p1.virtualWorld, p2.virtualWorld, service.status().parties[0].world], [7000, 7000, 7000]);
    time.advance(3000);
    assert.ok(npcWorlds.length === 3 && npcWorlds.every(([, world]) => world === 7000));
    assert.strictEqual(await service.cancel(p1), true);
    await tick();
    assert.deepStrictEqual([finished[0].result, p1.virtualWorld, p2.virtualWorld], ["stopped", 0, 3]);
    await service.stop();

    // A host that will not move players runs the expedition in the shared world instead.
    const shared = setup({ instanced: true }, { worlds: false });
    await shared.service.host(shared.players[0], "ruins");
    await shared.service.start(shared.players[0]);
    shared.time.advance(3000);
    assert.deepStrictEqual([shared.service.status().parties[0].world, shared.npcWorlds.length], [0, 0]);
    await shared.service.stop();
});

test("a fighter who leaves is out; the last one leaving abandons the run", async () => {
    const context = setup();
    const { time, players: [p1, p2], service, finished } = context;
    await service.host(p1, "ruins");
    await service.join(p2);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(await service.leave(p2), true);
    assert.strictEqual(await service.leave(p2), false, "left once");
    assert.ok(p1.said.some((line) => /P2 left the expedition/.test(line)));
    assert.deepStrictEqual(p2.sent.filter((entry) => entry.event === "hmp-expeditions:hud").at(-1)!.payload, { active: false });
    service.downed(1);
    await tick();
    assert.deepStrictEqual([finished[0].result, finished[0].participants.map((participant) => participant.playerId)], ["wiped", [1, 2]]);
    await service.stop();
});

test("fails unpaid when a stage summons no enemies", async () => {
    const context = setup();
    const { time, players: [p1], service, spawned, finished, rewards, store, failSpawns } = context;
    failSpawns();
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    assert.ok(p1.said.some((line) => /Forgotten Ruins failed at stage 1: its enemies could not be summoned$/.test(line)));
    await tick();
    assert.deepStrictEqual([finished[0].result, finished[0].defeated, rewards.length, store.record("ruins")], ["failed", 0, 0, null]);
    assert.strictEqual(spawned.length, 0, "the boss is ordered first and fails the run up front");
    await service.stop();
});

test("spawns the boss first and fails without pay or record when a stage comes up short", async () => {
    const context = setup({
        expeditions: {
            ruins: {
                label: "Forgotten Ruins", experience: 300, entrance: { x: 0, y: 0, z: 0, yaw: 0 },
                stages: [
                    { x: 1000, y: 0, z: 0, enemies: [{ id: "Goblin_Melee", count: 2 }] },
                    { x: 2000, y: 0, z: 0, enemies: [{ id: "Goblin_Melee", count: 1 }], boss: { id: "Troll_Forest", health: 4000 } },
                ],
            },
        },
    });
    const { time, players: [p1], service, spawned, destroyed, finished, rewards, store } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    for (const npc of [500, 501]) service.npcDied(npc);
    context.failAt(4);
    time.advance(2000);
    await tick();
    assert.deepStrictEqual(spawned.map((npc) => npc.enemyId), ["Goblin_Melee", "Goblin_Melee", "Troll_Forest"]);
    assert.ok(destroyed.includes(502), "the boss already summoned is cleaned up");
    assert.ok(p1.said.some((line) => /Forgotten Ruins failed at stage 2: its enemies could not be summoned$/.test(line)));
    assert.deepStrictEqual([finished[0].result, rewards.length, store.record("ruins")], ["failed", 0, null]);
    await service.stop();
});

test("clamps a stage to the free hmp-npcs capacity", async () => {
    const context = setup();
    context.setCapacity(1);
    const { time, players: [p1], service, spawned, finished } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    assert.deepStrictEqual(spawned.map((npc) => npc.enemyId), ["Goblin_Melee"]);
    assert.strictEqual(service.status().parties[0].remaining, 1);
    await service.stop();
    assert.strictEqual(finished[0].result, "stopped");
});

test("a clear with a stage cut for room pays but sets no record", async () => {
    const context = setup();
    context.setCapacity(1);
    const { time, players: [p1], service, spawned, finished, rewards, store } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    service.npcDied(spawned[0].id);
    context.vanish(spawned[0].id);
    time.advance(2000);
    assert.strictEqual(spawned.at(-1)!.enemyId, "Troll_Forest", "the boss stage fits in the one slot");
    p1.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(spawned.at(-1)!.id);
    await tick();
    assert.deepStrictEqual([finished[0].result, finished[0].record, rewards.length, store.record("ruins")], ["cleared", false, 1, null]);
    assert.ok(p1.said.some((line) => /cut short for room, so no record/.test(line)));
    await service.stop();
});

test("fails the run when hmp-npcs has no free slots for a stage", async () => {
    const context = setup();
    context.setCapacity(0);
    const { time, players: [p1], service, spawned, finished, rewards, store } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    await tick();
    assert.ok(p1.said.some((line) => /failed at stage 1: hmp-npcs has no room for its enemies$/.test(line)));
    assert.ok(!p1.said.some((line) => /0 enemies/.test(line)), "no stage opens empty");
    assert.deepStrictEqual([spawned.length, finished[0].result, rewards.length, store.record("ruins"), time.pending()], [0, "failed", 0, null, 0]);
    await service.stop();
});

test("fails the run when the host will not instance its enemies", async () => {
    for (const result of [false, "throw"] as const) {
        const context = setup({ instanced: true });
        context.setNpcWorld(result);
        const { time, players: [p1], service, spawned, destroyed, finished, rewards, store } = context;
        await service.host(p1, "ruins");
        await service.start(p1);
        time.advance(3000);
        await tick();
        assert.deepStrictEqual([spawned.length, destroyed, finished[0].result, rewards.length, store.record("ruins")], [1, [500], "failed", 0, null]);
        assert.deepStrictEqual(p1.said.filter((line) => /failed/.test(line)), ["Forgotten Ruins failed at stage 1: the host could not instance its enemies"], "said once, with its reason");
        assert.deepStrictEqual(service.status().parties, []);
        await service.stop();
    }
});

test("fails the run when a standing enemy vanishes without an npcDied event", async () => {
    const context = setup();
    const { time, players: [p1], service, destroyed, finished, rewards, store } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    context.vanish(501);
    service.npcDied(500);
    time.advance(4000);
    assert.strictEqual(finished.length, 0, "a missing enemy has a grace for its npcDied");
    time.advance(2000);
    await tick();
    assert.ok(p1.said.some((line) => /failed at stage 1: an enemy vanished$/.test(line)));
    assert.deepStrictEqual([finished[0].result, rewards.length, store.record("ruins")], ["failed", 0, null]);
    assert.deepStrictEqual(destroyed, [501], "the standing foe is removed on failure");
    await service.stop();
});

test("fails the run when hmp-npcs drops every enemy and nothing else happens", async () => {
    const context = setup();
    const { time, players: [p1], service, spawned, finished, rewards } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    // An hmp-npcs restart: every enemy is gone, no event fires and nobody calls refresh.
    for (const npc of spawned) context.vanish(npc.id);
    time.advance(8000);
    await tick();
    assert.ok(p1.said.some((line) => /failed at stage 1: an enemy vanished$/.test(line)));
    assert.deepStrictEqual([finished[0].result, rewards.length, context.time.pending()], ["failed", 0, 0]);
    await service.stop();
});

test("enemies dying together do not read as vanished", async () => {
    const context = setup();
    const { time, players: [p1], service, spawned, finished } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    // An area spell kills both goblins: hmp-npcs forgets the second before its npcDied reaches the expedition.
    context.vanish(500);
    context.vanish(501);
    service.npcDied(500);
    time.advance(1000);
    service.npcDied(501);
    time.advance(10_000);
    assert.strictEqual(spawned.at(-1)!.enemyId, "Troll_Forest", "the next stage spawned");
    assert.strictEqual(finished.length, 0);
    p1.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(spawned.at(-1)!.id);
    await tick();
    assert.strictEqual(finished[0].result, "cleared");
    await service.stop();
});

test("stop raises a finished event for a run that started, but not for a lobby", async () => {
    const running = setup();
    await running.service.host(running.players[0], "ruins");
    await running.service.start(running.players[0]);
    await running.service.stop();
    assert.deepStrictEqual([running.finished.length, running.finished[0].result], [1, "stopped"]);

    const lobby = setup();
    await lobby.service.host(lobby.players[0], "ruins");
    await lobby.service.stop();
    assert.strictEqual(lobby.finished.length, 0);
});

test("a leader who leaves a running run keeps no stop command", async () => {
    const context = setup();
    const { time, players: [p1, p2], service, finished } = context;
    await service.host(p1, "ruins");
    await service.join(p2);
    await service.start(p1);
    time.advance(3000);
    assert.strictEqual(await service.leave(p1), true);
    await assert.rejects(() => service.cancel(p1), /Only the expedition's leader/);
    await assert.rejects(() => service.cancel(p2), /Only the expedition's leader/);
    await service.stop();
    assert.strictEqual(finished[0].result, "stopped");
});

test("a wipe when the last standing fighter leaves during the countdown says stage 1", async () => {
    const context = setup();
    const { players: [p1, p2], service, finished, rewards } = context;
    await service.host(p1, "ruins");
    await service.join(p2);
    await service.start(p1);
    service.downed(1);
    assert.strictEqual(await service.leave(p2), true);
    await tick();
    assert.strictEqual(finished[0].result, "wiped");
    assert.ok(p1.said.some((line) => /the party fell at stage 1/.test(line)), "no 'stage 0' during the countdown");
    assert.strictEqual(rewards.length, 0);
    await service.stop();
});

test("reads the reward cooldown from progression history, so a restart does not clear it", async () => {
    const recent = { createdAt: new Date(9_000_000 - 60_000).toISOString(), resource: "hmp-expeditions", status: "completed" as const };
    const context = setup({}, { history: async (characterId) => characterId === 10 ? [recent] : [] });
    const { time, players: [p1], service, finished, rewards } = context;
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    for (const npc of [500, 501]) service.npcDied(npc);
    time.advance(2000);
    p1.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(502);
    await tick();
    assert.deepStrictEqual([finished[0].result, rewards.length, finished[0].participants[0].rewarded], ["cleared", 0, false]);
    await service.stop();
});

test("pays only fighters still near the final fight", async () => {
    const context = setup();
    const { time, players: [p1, p2], service, finished, rewards } = context;
    await service.host(p1, "ruins");
    await service.join(p2);
    await service.start(p1);
    time.advance(3000);
    for (const npc of [500, 501, 502]) service.npcDied(npc);
    time.advance(2000);
    p1.position = { x: 2000, y: 0, z: 0 };
    service.npcDied(503);
    await tick();
    assert.strictEqual(finished[0].result, "cleared");
    assert.deepStrictEqual(finished[0].participants.map((member) => member.rewarded), [true, false]);
    assert.deepStrictEqual(rewards.map(([characterId]) => characterId), [10]);
    await service.stop();
});

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

function setup(overrides: Record<string, unknown> = {}, options: { worlds?: boolean } = {}) {
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
    const finished: HmpExpeditionFinished[] = [];
    let failSpawns = false;
    const service = createExpeditionService({
        config, store, activities: activities as never,
        npcs: {
            spawn: (input) => { if (failSpawns) throw new Error("not in catalog"); const npc = { id: 500 + spawned.length, enemyId: input.enemyId, ownerId: input.ownerId, maxHealth: input.maxHealth }; spawned.push(npc); return npc; },
            destroy: (id) => { destroyed.push(id); return true; },
            setVirtualWorld: (id, _resource, world) => { npcWorlds.push([id, world]); return true; },
        },
        player: (id) => players.find((player) => player.id === id) || null,
        character: (player) => ({ id: player.id * 10, name: `C${player.id}` }),
        setWorld: (player, world) => { worldsSet.push([player.id, world]); if (options.worlds === false) return false; player.virtualWorld = world; return true; },
        reward: async (characterId, experience, reference) => { rewards.push([characterId, experience, reference]); },
        emit: (player, event, payload) => player.emit(event, payload),
        say: (player, message) => { (player as TestPlayer).said.push(message); },
        finished: (event) => { finished.push(event); },
        now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    });
    return { time, players, activities, service, store, spawned, destroyed, worldsSet, npcWorlds, rewards, finished, failSpawns: () => { failSpawns = true; } };
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

test("moves on past a stage whose enemies cannot be summoned", async () => {
    const context = setup();
    const { time, players: [p1], service, finished, failSpawns } = context;
    failSpawns();
    await service.host(p1, "ruins");
    await service.start(p1);
    time.advance(3000);
    assert.ok(p1.said.some((line) => /could not be summoned; moving on/.test(line)));
    time.advance(2000);
    await tick();
    assert.deepStrictEqual([finished[0].result, finished[0].defeated], ["cleared", 0]);
    await service.stop();
});

import assert = require("node:assert");
import { test } from "node:test";
import type { HmpExpedition } from "../types";
import { normalizeConfig, normalizeExpedition } from "../server/config";
import { Run, spawnRing } from "../server/run";
import { EXPEDITIONS_SYSTEM, RECORDS_SYSTEM, createEditor, createExpeditionStore, parseWorldExpedition, serializeExpedition, type KeyValueStore } from "../server/store";

const ruins = (): HmpExpedition => normalizeExpedition("ruins", {
    label: "Forgotten Ruins", areaId: "Overland", experience: 300, entrance: { x: 0, y: 0, z: 0, yaw: 45 },
    stages: [
        { x: 1000, y: 0, z: 0, enemies: [{ id: "Goblin_Melee", count: 2 }, { id: "Spider_Small", count: 1 }] },
        { x: 2000, y: 0, z: 0, enemies: [{ id: "Goblin_Melee", count: 1 }], boss: { id: "Troll_Forest", health: 4000 } },
    ],
}, "config");
const scaling = { enemiesPerExtraFighter: 0.5, bossHealthPerExtraFighter: 0.75 };

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        get: (system, key) => data.get(`${system}/${key}`) ?? null,
        list: (system) => [...data.entries()].filter(([key]) => key.startsWith(`${system}/`)).map(([key, value]) => ({ key: key.slice(system.length + 1), value })),
        set: async (system, key, value) => { if (value.length > 256) throw new Error("too long"); data.set(`${system}/${key}`, value); return true; },
        delete: async (system, key) => data.delete(`${system}/${key}`),
    };
}

test("runs stage by stage, scaling enemies and the boss to the party", () => {
    const solo = new Run(ruins(), [1], 0, scaling);
    assert.deepStrictEqual(solo.advance().map((order) => order.enemyId), ["Goblin_Melee", "Goblin_Melee", "Spider_Small"]);

    const trio = new Run(ruins(), [1, 2, 3], 0, scaling);
    const first = trio.advance();
    // Two extra fighters add half a pack each: 2 goblins become 4, 1 spider becomes 2.
    assert.deepStrictEqual([first.filter((order) => order.enemyId === "Goblin_Melee").length, first.filter((order) => order.enemyId === "Spider_Small").length], [4, 2]);
    first.forEach((_, index) => trio.spawned(100 + index));
    assert.throws(() => trio.advance(), /still has enemies/);
    for (let index = 0; index < first.length - 1; index++) assert.strictEqual(trio.killed(100 + index), false);
    assert.strictEqual(trio.killed(999), false, "an NPC of another run counts for nothing");
    assert.strictEqual(trio.killed(100 + first.length - 1), true, "the stage's last enemy clears it");
    assert.deepStrictEqual([trio.defeated, trio.cleared, trio.onLastStage], [6, 0, false]);

    const second = trio.advance();
    const boss = second.find((order) => order.boss)!;
    assert.deepStrictEqual(boss, { enemyId: "Troll_Forest", boss: true, maxHealth: 10_000 });
    assert.strictEqual(trio.onLastStage, true);
    assert.strictEqual(trio.cleared, 1);
    trio.finish("cleared");
    assert.deepStrictEqual([trio.cleared, trio.result], [2, "cleared"]);
    trio.finish("wiped");
    assert.strictEqual(trio.result, "cleared", "a run ends once");
    assert.throws(() => trio.advance(), /over/);
});

test("knows a wipe: every fighter left down at once", () => {
    const run = new Run(ruins(), [1, 2], 0, scaling);
    assert.strictEqual(run.downed(1), false);
    run.revived(1);
    assert.strictEqual(run.downed(2), false);
    assert.strictEqual(run.downed(1), true);
    assert.strictEqual(run.downed(7), false, "a stranger going down changes nothing");
    const leaving = new Run(ruins(), [1, 2], 0, scaling);
    leaving.downed(1);
    assert.strictEqual(leaving.leave(2), false);
    assert.strictEqual(leaving.wiped, true, "the last one standing leaving leaves the party down");
    assert.strictEqual(leaving.leave(1), true);
});

test("spreads a pack on a ring round the stage", () => {
    assert.deepStrictEqual(spawnRing({ x: 5, y: 5, z: 5 }, 0, 1), { x: 5, y: 5, z: 5, yaw: 0 });
    const points = [0, 1, 2, 3].map((index) => spawnRing({ x: 0, y: 0, z: 0 }, index, 4, 600));
    assert.ok(Math.abs(points[0].x - 600) < 1e-9 && Math.abs(points[1].y - 600) < 1e-9 && Math.abs(points[2].x + 600) < 1e-9);
});

test("validates expeditions and settings", () => {
    assert.strictEqual(ruins().stages[1].boss?.health, 4000);
    assert.throws(() => normalizeExpedition("empty", { entrance: { x: 0, y: 0, z: 0 }, stages: [] }, "config"), /1-12 stages/);
    assert.throws(() => normalizeExpedition("quiet", { entrance: { x: 0, y: 0, z: 0 }, stages: [{ x: 0, y: 0, z: 0 }] }, "config"), /needs enemies or a boss/);
    assert.throws(() => normalizeExpedition("bad", { entrance: { x: 0, y: 0, z: 0 }, stages: [{ x: 0, y: 0, z: 0, enemies: [{ id: "no spaces" }] }] }, "config"), /catalog id/);
    const config = normalizeConfig({ expeditions: { ruins: { entrance: { x: 0, y: 0, z: 0 }, stages: [{ x: 1, y: 1, z: 1, boss: { id: "Troll_Forest" } }] } } });
    assert.deepStrictEqual([config.command, config.maxParty, config.instanced, config.expeditions[0].stages[0].boss], ["expedition", 4, false, { id: "Troll_Forest", health: 2000 }]);
    assert.throws(() => normalizeConfig({ enemiesPerExtraFighter: 9 }), /enemiesPerExtraFighter/);
});

test("stores an in-game expedition one key per stage, and keeps the fastest clear", async () => {
    const entries = serializeExpedition({ ...ruins(), source: "world" });
    const map = new Map(entries);
    assert.deepStrictEqual(parseWorldExpedition("ruins", (key) => map.get(key) ?? null), { ...ruins(), source: "world" });
    assert.throws(() => serializeExpedition({ ...ruins(), stages: [{ x: 0, y: 0, z: 0, boss: null, enemies: Array.from({ length: 6 }, (_, index) => ({ id: `${"E".repeat(60)}${index}`, count: 20 })) }] }), /split the stage/);

    const kv = memoryStore();
    const store = createExpeditionStore({ store: kv, configured: [ruins()] });
    await assert.rejects(() => store.save({ ...ruins() }), /data\/hmp-expeditions.json/);
    await store.save({ ...ruins(), id: "cave", label: "Cave" });
    assert.deepStrictEqual(store.list().map((entry) => [entry.id, entry.source]), [["cave", "world"], ["ruins", "config"]]);
    await store.save({ ...ruins(), id: "cave", label: "Cave", stages: ruins().stages.slice(0, 1) });
    assert.ok(!kv.data.has(`${EXPEDITIONS_SYSTEM}/cave:1`), "a shorter save drops the stages it no longer has");
    assert.strictEqual(await store.submit("cave", 90_000, ["Poppy", "Natsai"], "t1"), true);
    assert.strictEqual(await store.submit("cave", 95_000, ["Sebastian"], "t2"), false);
    assert.deepStrictEqual(store.record("cave"), { timeMs: 90_000, party: "Poppy, Natsai", at: "t1" });
    assert.strictEqual(await store.remove("cave"), true);
    assert.deepStrictEqual([store.get("cave"), kv.data.has(`${RECORDS_SYSTEM}/cave`)], [null, false]);
});

test("builds an expedition in game: entrance, stages with a boss, save", async () => {
    const store = createExpeditionStore({ store: memoryStore(), configured: [ruins()] });
    const catalog = new Set(["Goblin_Melee", "Spider_Small", "Troll_Forest"]);
    const editor = createEditor({ store, isEnemy: (id) => catalog.has(id) });
    const player = { id: 3, position: { x: 10, y: 20, z: 30 }, location: () => ({ areaId: "Overland", regionId: "Feldcroft" }) };
    assert.throws(() => editor.begin(player, "ruins"), /data\/hmp-expeditions.json/);
    editor.begin(player, "camp", "Poacher Camp");
    await assert.rejects(() => editor.save(player), /at least one stage/);
    player.position = { x: 500, y: 0, z: 30 };
    assert.throws(() => editor.stage(player, ["Dragon"]), /not in the hmp-npcs catalog/);
    editor.stage(player, ["Goblin_Melee", "x3", "Spider_Small"]);
    player.position = { x: 900, y: 0, z: 30 };
    editor.stage(player, ["Goblin_Melee", "boss", "Troll_Forest", "6000"]);
    editor.reward(player, 750);
    const saved = await editor.save(player);
    assert.deepStrictEqual(saved.stages.map((stage) => [stage.x, stage.enemies, stage.boss]), [
        [500, [{ id: "Goblin_Melee", count: 3 }, { id: "Spider_Small", count: 1 }], null],
        [900, [{ id: "Goblin_Melee", count: 1 }], { id: "Troll_Forest", health: 6000 }],
    ]);
    assert.deepStrictEqual([saved.entrance, saved.experience, saved.label], [{ x: 10, y: 20, z: 30, yaw: 0 }, 750, "Poacher Camp"]);
});

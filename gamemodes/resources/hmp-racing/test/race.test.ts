import assert = require("node:assert");
import { test } from "node:test";
import type { HmpRacingTrack } from "../types";
import { formatTime } from "../shared/types";
import { normalizeConfig, normalizeTrack } from "../server/config";
import { createEditor } from "../server/editor";
import { Race, crossed, gridSlot } from "../server/race";
import { RECORDS_SYSTEM, TRACKS_SYSTEM, createTrackStore, parseWorldTrack, serializeTrack, type KeyValueStore } from "../server/tracks";

// Three gates 100 m apart along +X, 5 m radius.
const track = (laps = 1): HmpRacingTrack => normalizeTrack("meadow", {
    label: "Meadow Dash", laps, areaId: "Overland", start: { x: 0, y: 0, z: 0, yaw: 0 },
    checkpoints: [{ x: 10_000, y: 0, z: 0, radius: 500 }, { x: 20_000, y: 0, z: 0, radius: 500 }, { x: 30_000, y: 0, z: 0, radius: 500 }],
}, "config");
const racers = [
    { playerId: 1, nickname: "Poppy", characterId: 10, characterName: "Poppy Sweeting" },
    { playerId: 2, nickname: "Natsai", characterId: 20, characterName: "Natsai Onai" },
];
const at = (x: number, y = 0, z = 0) => ({ x, y, z });

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        get: (system, key) => data.get(`${system}/${key}`) ?? null,
        list: (system) => [...data.entries()].filter(([key]) => key.startsWith(`${system}/`)).map(([key, value]) => ({ key: key.slice(system.length + 1), value })),
        set: async (system, key, value) => {
            if (value.length > 256) throw new Error("hmp-worldstate values hold at most 256 characters");
            if (key.length > 64) throw new Error("hmp-worldstate keys hold at most 64 characters");
            const changed = data.get(`${system}/${key}`) !== value; data.set(`${system}/${key}`, value); return changed;
        },
        delete: async (system, key) => data.delete(`${system}/${key}`),
    };
}

test("finds a gate crossed between two samples, not only one landed in", () => {
    const gate = { x: 0, y: 0, z: 0, radius: 100 };
    assert.strictEqual(crossed(null, at(50), gate), true);
    assert.strictEqual(crossed(null, at(500), gate), false);
    assert.strictEqual(crossed(at(-1000), at(1000), gate), true, "flew straight through");
    assert.strictEqual(crossed(at(-1000, 150), at(1000, 150), gate), false, "flew past beside it");
    assert.strictEqual(crossed(at(-1000, 0, 99), at(1000, 0, 99), gate), true, "a gate is a sphere");
    assert.strictEqual(crossed(at(500), at(500), gate), false);
});

test("runs a race: gates in order, laps, places and finish times", () => {
    const race = new Race(track(2), racers, 1000, { maxSpeedCmPerSecond: 0 });
    // Skipping a gate does not count the one after it.
    assert.deepStrictEqual(race.update(1, at(20_000), 2000), []);
    assert.deepStrictEqual(race.update(1, at(10_000), 3000), [{ type: "checkpoint", playerId: 1, lap: 1, checkpoint: 1 }]);
    // One sample may pass two gates, in order.
    assert.deepStrictEqual(race.update(1, at(30_000), 4000).map((event) => event.type), ["checkpoint", "lap"]);
    assert.deepStrictEqual(race.lapOf(1), { lap: 2, checkpoint: 0 });
    assert.deepStrictEqual(race.get(1)?.lapsMs, [3000]);
    race.update(2, at(10_000), 4500);
    // Poppy leads on progress; Natsai is closer to her next gate but a gate behind.
    assert.deepStrictEqual(race.standings().map((racer) => racer.playerId), [1, 2]);
    assert.strictEqual(race.placeOf(2), 2);

    race.update(1, at(0), 5000);
    for (const [index, x] of [10_000, 20_000].entries()) race.update(1, at(x), 6000 + index * 1000);
    const finish = race.update(1, at(30_000), 9000);
    assert.deepStrictEqual(finish.at(-1), { type: "finish", playerId: 1, place: 1, timeMs: 8000 });
    assert.deepStrictEqual(race.get(1)?.lapsMs, [3000, 5000]);
    assert.strictEqual(race.firstFinishMs, 8000);
    assert.deepStrictEqual(race.update(1, at(10_000), 9500), [], "a finisher is done");
    assert.strictEqual(race.running, true, "Natsai still flies");
    assert.strictEqual(race.leave(2), true);
    assert.strictEqual(race.running, false);
    assert.deepStrictEqual(race.standings().map((racer) => [racer.playerId, racer.status]), [[1, "finished"], [2, "left"]]);
});

test("needs two speed violations in a row to disqualify a teleport", () => {
    const race = new Race(track(), racers, 0, { maxSpeedCmPerSecond: 5000 });
    race.update(1, at(0), 0);
    assert.deepStrictEqual(race.update(1, at(4000), 1000), [], "40 m/s is a broom");
    // The first violation credits no gate and leaves the last good sample in place.
    assert.deepStrictEqual(race.update(1, at(6000), 1100), []);
    assert.strictEqual(race.get(1)?.status, "racing");
    assert.deepStrictEqual(race.get(1)?.last, at(4000));
    assert.strictEqual(race.get(1)?.lastAt, 1000);
    assert.strictEqual(race.get(1)?.speedViolations, 1);
    // Measured from that sample, the next one is clean, so a lag spike averages out.
    assert.deepStrictEqual(race.update(1, at(7000), 2000), []);
    assert.strictEqual(race.get(1)?.speedViolations, 0);
    assert.deepStrictEqual(race.get(1)?.last, at(7000));
    assert.deepStrictEqual(race.update(1, at(10_000), 3000).map((event) => event.type), ["checkpoint"], "clean flight still passes gates");
    // A jump across the next gate is not credited either; the following jump disqualifies.
    assert.deepStrictEqual(race.update(1, at(21_000), 3100), []);
    assert.strictEqual(race.get(1)?.passed, 1, "no gate from a jump counts");
    assert.deepStrictEqual(race.update(1, at(22_000), 3200), [{ type: "disqualified", playerId: 1, reason: "teleport" }]);
    assert.strictEqual(race.nextGate(1), null);
    // A sample without a position is skipped, not judged.
    assert.deepStrictEqual(race.update(2, { x: NaN, y: 0, z: 0 }, 100), []);
});

test("a jump followed by normal flight is caught from the frozen sample", () => {
    const race = new Race(track(), racers, 0, { maxSpeedCmPerSecond: 5000 });
    race.seed(1, at(0), 0);
    // Teleporting onto a gate scores nothing, even though the segment crosses it.
    assert.deepStrictEqual(race.update(1, at(10_000), 100), []);
    assert.strictEqual(race.get(1)?.passed, 0);
    assert.deepStrictEqual(race.get(1)?.last, at(0));
    // One ordinary sample after the jump is still over the limit from the grid slot.
    assert.deepStrictEqual(race.update(1, at(10_100), 200), [{ type: "disqualified", playerId: 1, reason: "teleport" }]);
    assert.strictEqual(race.get(1)?.passed, 0, "no gate survives the disqualification");
});

test("checks the first sample after Go against the racer's grid slot", () => {
    const race = new Race(track(), racers, 0, { maxSpeedCmPerSecond: 5000 });
    race.seed(1, at(0), 0);
    assert.deepStrictEqual(race.update(1, at(8000), 100), [], "the seeded sample catches the first violation");
    assert.deepStrictEqual(race.update(1, at(16_000), 200), [{ type: "disqualified", playerId: 1, reason: "teleport" }]);
});

test("forms the grid two abreast behind the start, facing its heading", () => {
    const near = (actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }) =>
        assert.ok(["x", "y", "z"].every((axis) => Math.abs(actual[axis as "x"] - expected[axis as "x"]) < 1e-9), `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);
    const start = { x: 0, y: 0, z: 100, yaw: 0 };
    near(gridSlot(start, 0, 300), { x: 0, y: -150, z: 100 });
    near(gridSlot(start, 1, 300), { x: 0, y: 150, z: 100 });
    near(gridSlot(start, 2, 300), { x: -300, y: -150, z: 100 });
    near(gridSlot({ ...start, yaw: 90 }, 2, 300), { x: 150, y: -300, z: 100 });
});

test("validates tracks and settings", () => {
    assert.strictEqual(track().checkpoints[0].radius, 500);
    assert.throws(() => normalizeTrack("Bad Id", {}, "config"), /track id/);
    assert.throws(() => normalizeTrack("short", { start: { x: 0, y: 0, z: 0 }, checkpoints: [{ x: 0, y: 0, z: 0 }] }, "config"), /2-64 checkpoints/);
    assert.throws(() => normalizeTrack("wide", { start: { x: 0, y: 0, z: 0 }, checkpoints: [{ x: 0, y: 0, z: 0, radius: 9000 }, { x: 1, y: 1, z: 1 }] }, "config"), /radius/);
    assert.strictEqual(normalizeTrack("turn", { start: { x: 0, y: 0, z: 0, yaw: -90 }, checkpoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }] }, "config").start.yaw, 270);
    const config = normalizeConfig({ tracks: { meadow: { start: { x: 0, y: 0, z: 0 }, checkpoints: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }] } } });
    assert.deepStrictEqual([config.command, config.maxRacers, config.minimumRacers, config.tracks.length, config.tracks[0].source], ["race", 12, 2, 1, "config"]);
    assert.strictEqual(normalizeConfig({ minimumRacers: 1 }).minimumRacers, 1);
    assert.throws(() => normalizeConfig({ minimumRacers: 0 }), /minimumRacers/);
    assert.throws(() => normalizeConfig({ tickMs: 5 }), /tickMs/);
    assert.throws(() => normalizeConfig({ command: "two words" }), /command/);
    assert.strictEqual(formatTime(83_456), "1:23.456");
});

test("stores an in-game track one key per gate within hmp-worldstate's limits", async () => {
    const long = normalizeTrack("a".repeat(32), {
        label: "L".repeat(48), laps: 20, areaId: "Overland", start: { x: -99_999_999, y: 99_999_999, z: -99_999_999, yaw: 359 },
        checkpoints: Array.from({ length: 64 }, (_, index) => ({ x: -99_999_999, y: index, z: 99_999_999, radius: 5000 })),
    }, "world");
    const entries = serializeTrack(long);
    assert.strictEqual(entries.length, 65);
    assert.ok(entries.every(([key, value]) => key.length <= 64 && value.length <= 256));
    const map = new Map(entries);
    assert.deepStrictEqual(parseWorldTrack(long.id, (key) => map.get(key) ?? null), long);

    const store = memoryStore();
    const tracks = createTrackStore({ store, configTracks: [track()] });
    const saved = await tracks.save({ ...track(), id: "loop", label: "Loop", checkpoints: track().checkpoints.concat([{ x: 0, y: 0, z: 0, radius: 500 }]) });
    assert.strictEqual(saved.source, "world");
    assert.deepStrictEqual(tracks.list().map((entry) => [entry.id, entry.source]), [["loop", "world"], ["meadow", "config"]]);
    // A shorter save drops the gates it no longer has.
    await tracks.save({ ...saved, checkpoints: saved.checkpoints.slice(0, 2) });
    assert.strictEqual(tracks.get("loop")?.checkpoints.length, 2);
    assert.ok(!store.data.has(`${TRACKS_SYSTEM}/loop:3`));
    await assert.rejects(() => tracks.save({ ...track(), id: "meadow" }), /data\/hmp-racing.json/);

    assert.strictEqual(await tracks.submit("loop", 60_000, 10, "Poppy", "t1"), true);
    assert.strictEqual(await tracks.submit("loop", 61_000, 20, "Natsai", "t2"), false);
    assert.strictEqual(await tracks.submit("loop", 59_000, 20, "Natsai", "t3"), true);
    assert.deepStrictEqual(tracks.record("loop"), { track: "loop", timeMs: 59_000, characterId: 20, name: "Natsai", at: "t3" });
    assert.strictEqual(await tracks.remove("loop"), true);
    assert.strictEqual(tracks.get("loop"), null);
    assert.strictEqual(store.data.get(`${RECORDS_SYSTEM}/loop`), undefined);

    // A track left unreadable is skipped with a warning, not thrown at every listing.
    const warnings: string[] = [];
    const broken = createTrackStore({ store, configTracks: [], warn: (message) => warnings.push(message) });
    await store.set(TRACKS_SYSTEM, "torn:meta", JSON.stringify({ l: "Torn", n: 1, a: "Overland", c: 2, s: [0, 0, 0, 0] }));
    assert.deepStrictEqual(broken.list(), []);
    assert.match(warnings[0], /torn is unreadable/);
});

test("serializes record writes per track so a slower time cannot overwrite a faster one", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = () => resolve(); });
    const gated: KeyValueStore = { ...store, set: async (system, key, value) => { await gate; return store.set(system, key, value); } };
    const tracks = createTrackStore({ store: gated, configTracks: [] });
    const faster = tracks.submit("loop", 59_000, 20, "Natsai", "t-fast");
    const slower = tracks.submit("loop", 60_000, 10, "Poppy", "t-slow");
    release();
    assert.deepStrictEqual(await Promise.all([faster, slower]), [true, false]);
    assert.deepStrictEqual(tracks.record("loop"), { track: "loop", timeMs: 59_000, characterId: 20, name: "Natsai", at: "t-fast" });
    assert.strictEqual(await tracks.submit("loop", 58_000, 10, "Poppy", "t-best"), true, "the queue drains after both writes");
    assert.strictEqual(tracks.record("loop")?.timeMs, 58_000);
});

test("authors a track in game: grid, gates, undo and save", async () => {
    const store = memoryStore();
    const tracks = createTrackStore({ store, configTracks: [track()] });
    const editor = createEditor({ tracks, defaultRadiusCm: 800 });
    const player = { id: 7, position: at(100, 200, 300), location: () => ({ areaId: "Overland", regionId: "Hogsmeade" }) };
    assert.throws(() => editor.point(player), /not editing/);
    assert.throws(() => editor.begin(player, "meadow"), /data\/hmp-racing.json/);
    const draft = editor.begin(player, "village", 2, "Village Sprint");
    assert.deepStrictEqual([draft.start, draft.areaId, draft.laps], [{ x: 100, y: 200, z: 300, yaw: 0 }, "Overland", 2]);
    player.position = at(5000, 0, 1000);
    editor.point(player);
    await assert.rejects(() => editor.save(player), /at least 2/);
    player.position = at(9000.4, 0, 1200);
    editor.point(player, 12.5);
    assert.deepStrictEqual(editor.get(player)?.checkpoints.at(-1), { x: 9000, y: 0, z: 1200, radius: 1250 });
    assert.throws(() => editor.point(player, 0.5), /radius/);
    editor.point(player);
    editor.undo(player);
    editor.setStart(player, 450);
    assert.strictEqual(editor.get(player)?.start.yaw, 90);
    const saved = await editor.save(player);
    assert.deepStrictEqual([saved.id, saved.label, saved.checkpoints.length, saved.source], ["village", "Village Sprint", 2, "world"]);
    assert.strictEqual(editor.get(player), null);
    // Reopening an in-game track edits a copy until it is saved again.
    editor.begin(player, "village");
    editor.point(player);
    assert.strictEqual(tracks.get("village")?.checkpoints.length, 2);
    assert.strictEqual(editor.discard(player), true);
});

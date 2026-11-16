import assert = require("node:assert");
import { test } from "node:test";
import activityModule = require("../../../../resources/hmp-activities/server/service");
import type { HmpRacingFinished } from "../types";
import { normalizeConfig } from "../server/config";
import { createRacingService, type RacingPlayer } from "../server/service";
import { createTrackStore, type KeyValueStore } from "../server/tracks";

const { createActivityService } = activityModule;

interface TestPlayer extends RacingPlayer {
    sent: Array<{ event: string; payload: Record<string, unknown> }>;
    said: string[];
    holds: string[];
    fastTravel: boolean;
}

function clock() {
    let time = 1_000_000;
    let sequence = 0;
    const timers = new Map<number, { at: number; handler: () => void }>();
    return {
        now: () => time,
        setTimer: (handler: () => void, ms: number) => { const id = ++sequence; timers.set(id, { at: time + ms, handler }); return id as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); },
        /** Runs every timer due within `ms`, in order, moving the clock to each. */
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: Record<string, unknown> = {}) {
    const time = clock();
    const makePlayer = (id: number, nickname: string): TestPlayer => ({
        id, nickname, position: { x: 0, y: 0, z: 0 }, virtualWorld: 0, sent: [], said: [], holds: [], fastTravel: true,
        emit(event: string, payload?: unknown) { this.sent.push({ event, payload: JSON.parse(String(payload)) }); },
        location: () => ({ areaId: "Overland", regionId: "Hogsmeade" }),
        teleport(x: number, y: number, z: number) { this.position = { x, y, z }; return 1; },
        hold(options) { this.holds.push(`hold:${options.owner}`); return true; },
        release(owner: string) { this.holds.push(`release:${owner}`); return true; },
        setFastTravelEnabled(on: boolean) { this.fastTravel = on; },
        getFastTravelEnabled() { return this.fastTravel; },
    });
    const players = [makePlayer(1, "Poppy"), makePlayer(2, "Natsai"), makePlayer(3, "Sebastian")];
    const core = { characters: { active: (player: RacingPlayer | number) => { const id = typeof player === "number" ? player : player.id; return { id: id * 10, accountId: id, slot: 1, name: `Character ${id}`, status: "active", createdAt: "", updatedAt: "", deletedAt: null }; } } };
    let sequence = 0;
    const activities = createActivityService<RacingPlayer>({ core: core as never, config: { command: "activities", enableCommands: false, maxDefinitions: 10, maxSessions: 10, maxMetadataBytes: 1024, maxInvitations: 20, defaultInvitationTtlSeconds: 30, maximumInvitationTtlSeconds: 60, defaultLobbyTtlSeconds: 300, maximumLobbyTtlSeconds: 900, sweepIntervalSeconds: 30, enableTestActivity: false }, id: () => `race-${++sequence}` });
    const config = normalizeConfig({
        countdownSeconds: 3, finishGraceSeconds: 10, timeLimitSeconds: 120, tickMs: 100, maxSpeedCmPerSecond: 20_000,
        tracks: { meadow: { label: "Meadow Dash", laps: 1, areaId: "Overland", start: { x: 0, y: 0, z: 0, yaw: 0 }, checkpoints: [{ x: 10_000, y: 0, z: 0, radius: 500 }, { x: 20_000, y: 0, z: 0, radius: 500 }] } },
        ...overrides,
    });
    const tracks = createTrackStore({ store: memoryStore(), configTracks: config.tracks });
    const bests = new Map<number, Record<string, number>>();
    const finished: HmpRacingFinished[] = [];
    const service = createRacingService({
        config, tracks, activities: activities as never,
        player: (id) => players.find((player) => player.id === id) || null,
        character: (player) => ({ id: player.id * 10, name: `Character ${player.id}` }),
        bests: { get: async (id) => ({ ...(bests.get(id) || {}) }), set: async (id, value) => { bests.set(id, value); } },
        emit: (player, event, payload) => player.emit(event, payload),
        say: (player, message) => { (player as TestPlayer).said.push(message); },
        finished: (event) => { finished.push(event); },
        now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    });
    /** Moves a racer and lets the next server sample see it. */
    const fly = (player: TestPlayer, x: number) => { player.position = { x, y: 0, z: 0 }; time.advance(100); };
    return { time, players, activities, service, tracks, bests, finished, fly };
}

test("runs a race from lobby to results, with a record and personal bests", async () => {
    const { time, players: [poppy, natsai], activities, service, tracks, bests, finished, fly } = setup();
    await assert.rejects(() => service.host(poppy, "nowhere"), /No track named/);
    const session = await service.host(poppy, "meadow");
    assert.strictEqual(session.title, "Meadow Dash (1 lap)");
    await service.join(natsai);
    await assert.rejects(() => service.start(natsai), /Only the race's host/);
    await service.start(poppy);

    // The countdown: both on the grid, held, fast travel off and refused.
    assert.deepStrictEqual([poppy.position.y, natsai.position.y, Math.abs(poppy.position.x)], [-150, 150, 0]);
    assert.deepStrictEqual([poppy.holds, poppy.fastTravel, service.racing(poppy.id)], [["hold:hmp-racing"], false, true]);
    assert.ok(poppy.sent.some((entry) => entry.event === "hmp-racing:countdown" && entry.payload.seconds === 3));
    time.advance(3000);
    assert.deepStrictEqual(poppy.holds, ["hold:hmp-racing", "release:hmp-racing"]);
    const gates = poppy.sent.filter((entry) => entry.event === "hmp-racing:gates").at(-1)!.payload.gates as Array<{ kind: string; x: number }>;
    assert.deepStrictEqual(gates.map((gate) => [gate.kind, gate.x]), [["next", 10_000], ["finish", 20_000]]);

    fly(poppy, 0); fly(natsai, 0);
    fly(poppy, 1_500); fly(poppy, 3_000); fly(poppy, 4_500); fly(poppy, 6_000); fly(poppy, 7_500); fly(poppy, 9_000); fly(poppy, 10_000);
    const hud = poppy.sent.filter((entry) => entry.event === "hmp-racing:hud").at(-1)!.payload;
    assert.deepStrictEqual([hud.place, hud.checkpoint, hud.checkpoints], [1, 1, 2]);
    for (let x = 11_500; x <= 20_000; x += 1_500) fly(poppy, x);
    fly(poppy, 20_000);
    assert.ok(poppy.said.some((line) => /Poppy finishes 1st/.test(line)));
    assert.ok(natsai.said.some((line) => /10 seconds left to finish/.test(line)));
    assert.strictEqual(finished.length, 0, "Natsai still has her grace time");

    for (let x = 1_500; x <= 20_000; x += 1_500) fly(natsai, x);
    fly(natsai, 20_000);
    await tick(); await tick();
    assert.strictEqual(finished.length, 1);
    const [first, second] = finished[0].results;
    assert.deepStrictEqual([first.nickname, first.place, first.status, first.trackRecord, first.personalBest], ["Poppy", 1, "finished", true, true]);
    assert.deepStrictEqual([second.nickname, second.place, second.trackRecord, second.personalBest], ["Natsai", 2, false, true]);
    assert.ok(first.timeMs! < second.timeMs!);
    assert.strictEqual(tracks.record("meadow")?.timeMs, first.timeMs);
    assert.strictEqual(bests.get(10)?.meadow, first.timeMs);
    assert.strictEqual(finished[0].cut, false);

    // Everyone is let go: HUD and gates off, fast travel back, the activity done.
    assert.deepStrictEqual([poppy.fastTravel, service.racing(poppy.id)], [true, false]);
    assert.deepStrictEqual(poppy.sent.filter((entry) => entry.event === "hmp-racing:hud").at(-1)!.payload, { active: false });
    assert.strictEqual(activities.sessions.get(session.id), null);
    assert.strictEqual(time.pending(), 0);
    await service.stop(); await activities.stop();
});

test("ends the race after the grace time, and disqualifies a teleport", async () => {
    const { time, players: [poppy, natsai, sebastian], activities, service, finished, fly } = setup();
    await service.host(poppy, "meadow");
    await service.join(natsai, poppy);
    await service.join(sebastian);
    await service.start(poppy);
    time.advance(3000);
    fly(sebastian, 0);
    fly(sebastian, 15_000);
    assert.ok(poppy.said.some((line) => /Sebastian is disqualified \(teleported\)/.test(line)));
    for (let x = 0; x <= 21_000; x += 1_500) fly(poppy, x);
    // Natsai dawdles at the grid past the grace time.
    time.advance(10_000);
    await tick(); await tick();
    assert.strictEqual(finished.length, 1);
    assert.deepStrictEqual(finished[0].results.map((result) => [result.nickname, result.status]), [["Poppy", "finished"], ["Natsai", "dnf"], ["Sebastian", "disqualified"]]);
    assert.strictEqual(finished[0].results[2].reason, "teleport");
    assert.strictEqual(finished[0].cut, true);
    await service.stop(); await activities.stop();
});

test("a racer who leaves or falls is out; the last one out ends the race", async () => {
    const { time, players: [poppy, natsai], activities, service, finished, fly } = setup();
    await service.host(poppy, "meadow");
    await service.join(natsai);
    await assert.rejects(() => service.join(natsai), /already in a race/);
    await service.start(poppy);
    time.advance(3000);
    fly(poppy, 0);
    assert.strictEqual(await service.leave(natsai), true);
    assert.deepStrictEqual([natsai.fastTravel, service.racing(natsai.id)], [true, false], "her fast travel is back");
    assert.strictEqual(await service.leave(natsai), false, "retired once");
    service.died(poppy.id);
    await tick(); await tick();
    assert.deepStrictEqual(finished[0].results.map((result) => [result.nickname, result.status, result.reason]), [["Poppy", "disqualified", "fell"], ["Natsai", "left", ""]]);
    assert.strictEqual(service.racing(poppy.id), false);
    await service.stop(); await activities.stop();
});

test("the host can cancel a lobby, and stopping the resource lets every racer go", async () => {
    const { time, players: [poppy, natsai], activities, service, finished } = setup();
    const session = await service.host(poppy, "meadow");
    await service.join(natsai);
    await assert.rejects(() => service.cancel(natsai), /Only the race's host/);
    assert.strictEqual(await service.cancel(poppy), true);
    assert.strictEqual(activities.sessions.get(session.id), null);
    assert.strictEqual(service.recordFor(natsai), null);

    await service.host(poppy, "meadow");
    await service.join(natsai);
    await service.start(poppy);
    assert.strictEqual(natsai.fastTravel, false);
    await service.stop();
    assert.deepStrictEqual([natsai.fastTravel, natsai.holds.at(-1), time.pending(), finished.length], [true, "release:hmp-racing", 0, 0]);
    await assert.rejects(() => service.host(poppy, "meadow"), /stopped/);
    await activities.stop();
});

test("a racer who retires during the countdown never starts", async () => {
    const { time, players: [poppy, natsai], activities, service, finished, fly } = setup();
    await service.host(poppy, "meadow");
    await service.join(natsai);
    await service.start(poppy);
    assert.strictEqual(await service.leave(natsai), true);
    time.advance(3000);
    for (let x = 0; x <= 21_000; x += 1_500) fly(poppy, x);
    await tick(); await tick();
    assert.deepStrictEqual(finished[0].results.map((result) => [result.nickname, result.status]), [["Poppy", "finished"], ["Natsai", "left"]]);
    await service.stop(); await activities.stop();
});

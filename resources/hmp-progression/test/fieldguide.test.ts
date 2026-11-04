import assert = require("node:assert/strict");
import clientModule = require("../client/fieldguide");
import serverModule = require("../server/fieldguide");
import sharedModule = require("../shared/fieldguide");
import type { Player, ProgressionRepository } from "../server/internal";

const { createFieldGuideClient } = clientModule;
const { createFieldGuideSync } = serverModule;
const { normalizeSnapshot } = sharedModule;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function snapshot(pages = 1, idLength = 0): HogwartsMpFieldGuideSnapshot {
    return {
        version: 1,
        collections: Array.from({ length: pages }, (_, index) => ({
            id: `LORE_Page_${index}`.padEnd(idLength, "x"), category: "Exploration", subcategory: "Hogwarts", state: "Obtained" as const,
            updated: 638_000_000_000_000_000 + index,
        })),
        challenges: [{ id: "FGC_Pages_Hogwarts_000", instances: pages, goal: 5, complete: false, counted: ["LORE_Page_0"], unclaimedRewards: 0 }],
        locks: [{ id: "FGC_Pages_Hogwarts_001", unlocked: true }],
        pages: { investigated: [{ id: "INT_Page_0", count: 1 }], beacons: [{ id: "KIO_Page_0", state: 11 }], keys: [{ name: "PageCollected_0", value: "1" }] },
    };
}

interface Sent { name: string; message: Record<string, unknown> }
function makePlayer(id: number): Player & { sent: Sent[] } {
    const sent: Sent[] = [];
    return { id, nickname: `Player ${id}`, sent, emit(name: string, payload: string) { sent.push({ name, message: JSON.parse(payload) }); } } as unknown as Player & { sent: Sent[] };
}

function server(options: { enabled?: boolean } = {}) {
    const rows = new Map<number, string>();
    const writes: Array<[number, string]> = [];
    const active = new Map<Player, number | null>();
    const warnings: string[] = [];
    const infos: string[] = [];
    let gate: Promise<void> | null = null;
    const repository: Pick<ProgressionRepository, "fieldGuide" | "saveFieldGuide"> = {
        fieldGuide: async (id) => rows.get(id) ?? null,
        saveFieldGuide: async (id, json) => { if (gate) await gate; writes.push([id, json]); rows.set(id, json); },
    };
    const core = { characters: { active: (player: Player) => { const id = active.get(player); return id ? { id } : null; } } };
    const sync = createFieldGuideSync({
        repository, core: core as never, enabled: options.enabled !== false, ready: async () => {},
        logger: { info(message: string) { infos.push(message); }, warn(message: string) { warnings.push(message); }, error() {} } as never,
    });
    return { sync, rows, writes, active, warnings, infos, hold: (promise: Promise<void> | null) => { gate = promise; } };
}

async function validation(): Promise<void> {
    const normalized = normalizeSnapshot({ ...snapshot(2), extra: true, collections: snapshot(2).collections.map((entry) => ({ ...entry, injected: "x" })) });
    assert.deepEqual(normalized, snapshot(2), "only the known fields are kept; a large change stamp is accepted");
    assert.throws(() => normalizeSnapshot({ ...snapshot(), version: 2 }), /version must be 1/);
    assert.throws(() => normalizeSnapshot({ ...snapshot(), challenges: undefined }), /challenges must be an array/);
    assert.throws(() => normalizeSnapshot({ ...snapshot(), locks: [{ id: "FGC_A", unlocked: "yes" }] }), /locks\[0\]\.unlocked must be a boolean/);
    assert.throws(() => normalizeSnapshot({ ...snapshot(), collections: [{ ...snapshot().collections[0], state: "Stolen" }] }), /state must be/);
    assert.throws(() => normalizeSnapshot(null), /must be an object/);
}

async function serverFlow(): Promise<void> {
    const { sync, rows, writes, active, warnings, infos, hold } = server();
    const player = makePlayer(7);
    const save = (characterId: number, token: unknown, value: unknown = snapshot()) => sync.save(player, { characterId, token, snapshot: value });

    // The first character with nothing saved adopts what the game holds.
    active.set(player, 42);
    await sync.characterLoaded(player);
    const first = player.sent.at(-1)!;
    assert.equal(first.name, "hmp-progression:field-guide");
    assert.deepEqual({ ...first.message, token: 0 }, { characterId: 42, token: 0, restore: false, snapshot: null });
    const token = first.message.token as number;
    save(42, token);
    await sync.idle();
    assert.equal(writes.length, 0, "a save before the restore result is dropped");
    sync.worldReady(player);
    assert.equal(player.sent.length, 2, "an unanswered restore is sent again once the world is ready");
    sync.result(player, { characterId: 42, token: token + 100, ok: true, adopted: true });
    save(42, token);
    await sync.idle();
    assert.equal(writes.length, 0, "a result for another load changes nothing");

    sync.result(player, JSON.stringify({ characterId: 42, token, ok: true, adopted: true }));
    sync.worldReady(player);
    assert.equal(player.sent.length, 2);
    save(42, token, { ...snapshot(2), extra: 1 });
    save(43, token);
    save(42, token, { ...snapshot(), version: 2 });
    save(42, token, snapshot(3_000, 200));
    sync.save(player, "x".repeat(600 * 1024));
    await sync.idle();
    assert.deepEqual(writes, [[42, JSON.stringify(snapshot(2))]], "only a valid save for the current load is stored");
    assert.ok(warnings.some((message) => message.includes("version must be 1")));
    assert.equal(warnings.filter((message) => message.includes("larger than 524288 bytes")).length, 2);

    // Saves are written one at a time, and only the newest waiting one.
    let release!: () => void;
    hold(new Promise((resolve) => { release = resolve; }));
    save(42, token, snapshot(4));
    await flush();
    save(42, token, snapshot(5));
    save(42, token, snapshot(6));
    release();
    hold(null);
    await sync.idle();
    assert.deepEqual(writes.slice(1).map(([, json]) => JSON.parse(json).collections.length), [4, 6]);

    // A later character with nothing saved starts clean instead of inheriting the first one's.
    sync.characterUnloaded(player);
    save(42, token);
    await sync.idle();
    assert.equal(writes.length, 3, "a save after the character is unloaded is dropped");
    active.set(player, 43);
    await sync.characterLoaded(player);
    const second = player.sent.at(-1)!.message;
    assert.equal(second.restore, true);
    assert.equal(second.snapshot, null);
    sync.result(player, { characterId: 43, token: second.token, ok: true, mismatches: [], needsTravel: true });
    assert.ok(infos.some((message) => message.includes("next map load")));
    save(43, second.token);
    await sync.idle();
    assert.equal(rows.has(43), true);

    // A saved character is restored from its row, and a failed restore keeps that row.
    active.set(player, 42);
    await sync.characterLoaded(player);
    const third = player.sent.at(-1)!.message;
    assert.deepEqual(third.snapshot, snapshot(6));
    sync.result(player, { characterId: 42, token: third.token, ok: false, reason: "unavailable", mismatches: [], needsTravel: false });
    save(42, third.token, snapshot(1));
    await sync.idle();
    assert.equal(JSON.parse(rows.get(42)!).collections.length, 6);
    assert.ok(warnings.some((message) => message.includes("unavailable") && message.includes("kept")));

    // Readback differences are reported, and the game's state is saved from then on.
    active.set(player, 43);
    await sync.characterLoaded(player);
    const fourth = player.sent.at(-1)!.message;
    sync.result(player, { characterId: 43, token: fourth.token, ok: false, mismatches: ["collection LORE_Page_0: missing"], needsTravel: false });
    assert.ok(warnings.some((message) => message.includes("1 difference(s)")));
    save(43, fourth.token, snapshot(7));
    await sync.idle();
    assert.equal(JSON.parse(rows.get(43)!).collections.length, 7);

    // A load overtaken by another selection, or with an unreadable row, sends nothing.
    const sent = player.sent.length;
    active.set(player, 44);
    const overtaken = sync.characterLoaded(player);
    active.set(player, 45);
    await overtaken;
    rows.set(46, "{not json");
    active.set(player, 46);
    await sync.characterLoaded(player);
    assert.equal(player.sent.length, sent);
    assert.ok(warnings.some((message) => message.includes("Could not load #7's Field Guide")));

    sync.disconnect(player);
    sync.result(player, { characterId: 43, token: fourth.token, ok: true });
    save(43, fourth.token, snapshot(8));
    await sync.idle();
    assert.equal(JSON.parse(rows.get(43)!).collections.length, 7, "nothing is taken after a disconnect");
}

async function olderClient(): Promise<void> {
    const { sync, active, warnings } = server();
    const first = makePlayer(1);
    const second = makePlayer(2);
    active.set(first, 42);
    active.set(second, 43);
    await sync.characterLoaded(first);
    sync.result(first, { characterId: 42, token: first.sent[0].message.token, ok: false, unsupported: true });
    active.set(first, 44);
    await sync.characterLoaded(first);
    assert.equal(first.sent.length, 1, "a client without FieldGuide is not asked again this connection");
    await sync.characterLoaded(second);
    sync.result(second, { characterId: 43, token: second.sent[0].message.token, ok: false, unsupported: true });
    assert.equal(warnings.filter((message) => message.includes("HogwartsMP 1.11")).length, 1, "an older host is reported once");
}

async function disabled(): Promise<void> {
    const { sync, active } = server({ enabled: false });
    const player = makePlayer(1);
    active.set(player, 42);
    await sync.characterLoaded(player);
    assert.deepEqual(player.sent, []);
}

function clientHarness(options: { native?: boolean; readyAt?: number; result?: HogwartsMpFieldGuideRestoreResult; current?: HogwartsMpFieldGuideSnapshot | null } = {}) {
    let time = 0;
    let nextTimer = 1;
    const timers = new Map<number, { at: number; handler: () => void }>();
    const emitted: Sent[] = [];
    const warnings: string[] = [];
    const restored: Array<HogwartsMpFieldGuideSnapshot | null> = [];
    let current = options.current === undefined ? snapshot(2) : options.current;
    const native = {
        ready: () => time >= (options.readyAt ?? 0),
        snapshot: () => current,
        restore: (value: HogwartsMpFieldGuideSnapshot | null) => { restored.push(value); return options.result ?? { ok: true, mismatches: [], needsTravel: true }; },
    };
    const client = createFieldGuideClient({
        native: options.native === false ? null : native,
        emitServer: (name, payload) => emitted.push({ name, message: JSON.parse(payload) }),
        setTimer: (handler, delay) => { timers.set(nextTimer, { at: time + delay, handler }); return nextTimer++; },
        clearTimer: (timer) => { timers.delete(timer as number); },
        warn: (message) => warnings.push(message),
        now: () => time,
    });
    function advance(ms: number): void {
        const end = time + ms;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]);
            time = due[1].at;
            due[1].handler();
        }
        time = end;
    }
    return { client, emitted, warnings, restored, advance, setCurrent: (value: HogwartsMpFieldGuideSnapshot | null) => { current = value; } };
}

async function clientFlow(): Promise<void> {
    const { client, emitted, warnings, restored, advance, setCurrent } = clientHarness({ readyAt: 1_200 });
    client.receive(JSON.stringify({ characterId: 42, token: 1, restore: true, snapshot: snapshot(3) }));
    assert.equal(client.state(), "restoring");
    advance(1_000);
    assert.equal(emitted.length, 0, "nothing is restored before FieldGuide.ready()");
    advance(500);
    assert.deepEqual(restored, [snapshot(3)]);
    assert.deepEqual([...emitted], [{ name: "hmp-progression:field-guide-result", message: { characterId: 42, token: 1, ok: true, mismatches: [], needsTravel: true } }]);
    client.receive({ characterId: 42, token: 1, restore: true, snapshot: snapshot(3) });
    assert.equal(restored.length, 1, "a resent restore is applied once");

    client.changed();
    client.changed();
    advance(1_999);
    assert.equal(emitted.length, 1);
    advance(1);
    assert.deepEqual(emitted.slice(1), [{ name: "hmp-progression:field-guide-save", message: { characterId: 42, token: 1, snapshot: snapshot(2) } }], "changes are batched into one save");

    // A snapshot that is not ready yet is tried again; an oversized one is never sent.
    setCurrent(null);
    client.changed();
    advance(2_000);
    setCurrent(snapshot(4));
    advance(2_000);
    assert.equal((emitted.at(-1)!.message.snapshot as HogwartsMpFieldGuideSnapshot).collections.length, 4);
    setCurrent(snapshot(3_000, 200));
    client.changed();
    advance(2_000);
    assert.equal(emitted.length, 3);
    assert.ok(warnings.some((message) => message.includes("larger than")));

    // A new load drops the earlier character's waiting save, and adopting saves at once.
    setCurrent(snapshot(5));
    client.changed();
    client.receive({ characterId: 43, token: 2, restore: false, snapshot: null });
    advance(5_000);
    assert.deepEqual(emitted.slice(3).map((entry) => [entry.name, entry.message.token]), [["hmp-progression:field-guide-result", 2], ["hmp-progression:field-guide-save", 2]]);
    assert.equal(emitted[3].message.adopted, true);
    assert.equal(restored.length, 1, "adopting restores nothing");

    // A reset restores null and saves the clean state.
    client.receive({ characterId: 44, token: 3, restore: true, snapshot: null });
    assert.deepEqual(restored.at(-1), null);
    assert.deepEqual(emitted.slice(5).map((entry) => entry.name), ["hmp-progression:field-guide-result", "hmp-progression:field-guide-save"]);
}

async function clientFailures(): Promise<void> {
    const refused = clientHarness({ result: { ok: false, reason: "unavailable", mismatches: [], needsTravel: false } });
    refused.client.receive({ characterId: 42, token: 1, restore: true, snapshot: snapshot() });
    assert.equal(refused.emitted[0].message.reason, "unavailable");
    assert.equal(refused.client.state(), "failed");
    refused.client.changed();
    refused.advance(10_000);
    assert.equal(refused.emitted.length, 1, "nothing is saved after a failed restore");

    const late = clientHarness({ readyAt: Infinity });
    late.client.receive({ characterId: 42, token: 1, restore: true, snapshot: snapshot() });
    late.advance(120_000);
    assert.deepEqual(late.emitted.map((entry) => entry.message.reason), ["the Field Guide did not become ready"]);
    assert.deepEqual(late.restored, []);

    const older = clientHarness({ native: false });
    older.client.receive({ characterId: 42, token: 1, restore: false, snapshot: null });
    assert.deepEqual(older.emitted, [{ name: "hmp-progression:field-guide-result", message: { characterId: 42, token: 1, ok: false, unsupported: true } }]);
    assert.equal(older.client.state(), "unsupported");
    older.client.receive("not json");
    older.client.receive({ characterId: "42", token: 2 });
    assert.equal(older.emitted.length, 1);
}

async function run(): Promise<void> {
    await validation();
    await serverFlow();
    await olderClient();
    await disabled();
    await clientFlow();
    await clientFailures();
    console.log("hmp-progression Field Guide tests passed");
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });

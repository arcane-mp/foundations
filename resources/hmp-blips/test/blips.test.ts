import assert = require("node:assert");
import serverModule = require("../server/service");
import configModule = require("../server/config");
import clientModule = require("../client/service");
import type { HmpBlipPlayer } from "../types";

const { createBlipsService } = serverModule;
const { nativeIcons: normalizeNativeIcons } = configModule;
const { createBlipsClient } = clientModule;

interface TestPlayer extends HmpBlipPlayer {
    area: string;
    region: string;
    messages: Array<{ name: string; payload: unknown }>;
}

function makePlayer(id: number, area = "Hogwarts", region = "GreatHall", virtualWorld = 0): TestPlayer {
    return {
        id,
        nickname: `Player${id}`,
        position: { x: id * 100, y: 20, z: 30 },
        virtualWorld,
        area,
        region,
        messages: [],
        emit(name, raw) {
            let payload = raw;
            if (typeof raw === "string") try { payload = JSON.parse(raw); } catch (_) { /* keep raw */ }
            this.messages.push({ name, payload });
        },
        location() {
            return { areaId: this.area, regionId: this.region, destinationId: null, x: this.position.x, y: this.position.y, z: this.position.z, yaw: 0, revision: 1 };
        },
    };
}

async function run(): Promise<void> {
    const first = makePlayer(1);
    const second = makePlayer(2);
    const third = makePlayer(3, "Hogsmeade", "Square");
    const connected = [first, second, third];
    const memberships = new Map<number, Set<string>>([[1, new Set(["job:auror"])], [2, new Set(["job:auror"])] ]);
    const broadcasts: Array<{ name: string; payload: unknown }> = [];
    const timers: Array<{ handler: () => void; cleared: boolean }> = [];
    const service = createBlipsService<TestPlayer>({
        core: { groups: { has: async (player, key) => memberships.get(Number(typeof player === "object" ? player.id : player))?.has(key) || false } },
        config: {
            defaultTtl: 600,
            maxTtl: 900,
            maxMarkersPerResource: 4,
            showAllPlayers: false,
            houseTint: true,
            playerBlipScale: 1.2,
            hideBaseIcon: false,
            nativeIcons: { hide: [], labels: {} },
            enableCommands: false,
            command: "blips",
        },
        players: () => connected,
        events: { emit() {}, emitAllClients: (name, raw) => broadcasts.push({ name, payload: typeof raw === "string" ? JSON.parse(raw) : raw }) },
        logger: { warn() {}, error() {} },
        now: () => 1000,
        setTimer: (handler) => {
            const timer = { handler, cleared: false };
            timers.push(timer);
            return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (timer) => { (timer as unknown as { cleared: boolean }).cleared = true; },
    });

    const publicMarker = await service.markers.upsert({
        resource: "hmp-test",
        id: "shop",
        kind: "marker",
        position: { x: 10, y: 20, z: 30 },
        icon: "UI_T_MiniMap_Waypoint",
        label: "Shop",
        ttl: 0,
    });
    assert.strictEqual(publicMarker.key, "hmp:hmp-test:shop");
    assert.strictEqual(publicMarker.ttl, 900, "maxTtl clamps requested permanence");
    assert.ok(connected.every((player) => player.messages.some((message) => message.name === "hmp-blips:set")));

    first.messages.length = 0;
    second.messages.length = 0;
    await service.markers.upsert({ resource: "hmp-test", id: "private", kind: "circle", position: { x: 0, y: 0, z: 0 }, radius: 80, ttl: 30, audience: [first] });
    assert.ok(first.messages.some((message) => message.name === "hmp-blips:set"));
    assert.ok(!second.messages.some((message) => message.name === "hmp-blips:set" && String((message.payload as { key?: string })?.key || "").endsWith("private")));
    await service.markers.upsert({ resource: "hmp-test", id: "private", kind: "circle", position: { x: 1, y: 2, z: 3 }, radius: 100, ttl: 30, audience: [second] });
    assert.ok(first.messages.some((message) => message.name === "hmp-blips:remove"));
    assert.ok(second.messages.some((message) => message.name === "hmp-blips:set"));
    assert.strictEqual(timers[1].cleared, true, "upsert disarms the previous ttl");

    first.messages.length = 0;
    third.messages.length = 0;
    await service.markers.upsert({
        resource: "hmp-test",
        id: "castle-only",
        kind: "marker",
        position: { x: 50, y: 60, z: 70 },
        areaId: "Hogwarts",
        audience: { groups: [{ key: "job:auror" }] },
    });
    assert.ok(first.messages.some((message) => message.name === "hmp-blips:set"));
    assert.ok(!third.messages.some((message) => message.name === "hmp-blips:set" && String((message.payload as { key?: string })?.key || "").endsWith("castle-only")));

    await service.players.track({
        resource: "hmp-test",
        id: "aurors",
        subjects: { groups: [{ key: "job:auror" }] },
        audience: { groups: [{ key: "job:auror" }] },
        color: [0.2, 0.5, 1],
        priority: 10,
        sameArea: true,
    });
    const firstView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[]; colors: Record<string, number[]> };
    assert.deepStrictEqual(firstView.visible, [2]);
    assert.deepStrictEqual(firstView.colors[2], [0.2, 0.5, 1, 1]);
    const thirdView = [...third.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[] };
    assert.deepStrictEqual(thirdView.visible, []);

    await service.players.track({ resource: "hmp-test", id: "dispatch", subjects: [second], audience: [first], color: [1, 0, 0, 1], priority: 20 });
    const priorityView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { colors: Record<string, number[]> };
    assert.deepStrictEqual(priorityView.colors[2], [1, 0, 0, 1]);
    second.area = "Hogsmeade";
    await service.players.refresh(first);
    const movedView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[] };
    assert.deepStrictEqual(movedView.visible, [2], "dispatch group still includes the subject despite the area-scoped auror group");
    await service.players.untrack("dispatch", "hmp-test");
    const areaView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[] };
    assert.deepStrictEqual(areaView.visible, []);

    const failed = await service.markers.upsert({
        resource: "hmp-fail",
        id: "closed",
        kind: "marker",
        position: { x: 0, y: 0, z: 0 },
        audience: () => { throw new Error("resolver down"); },
    });
    assert.strictEqual(failed.scoped, true);
    assert.ok(!connected.some((player) => [...player.messages].reverse().some((message) => message.name === "hmp-blips:set" && (message.payload as { key?: string })?.key === failed.key)));

    const cleanupCount = await service.cleanup("hmp-test");
    assert.ok(cleanupCount >= 4);
    assert.strictEqual(service.markers.list("hmp-test").length, 0);
    assert.strictEqual(service.players.list("hmp-test").length, 0);
    assert.ok(broadcasts.some((event) => event.name === "hmp-blips:remove"));

    const nativeCalls: Array<{ name: string; args: unknown[] }> = [];
    const reports: Array<{ name: string; payload: unknown }> = [];
    const client = createBlipsClient({
        emitServer: (name, payload) => { reports.push({ name, payload: JSON.parse(payload) }); },
        native: {
            setMarker: (...args) => { nativeCalls.push({ name: "marker", args }); return true; },
            setCircle: (...args) => { nativeCalls.push({ name: "circle", args }); return true; },
            remove: (...args) => { nativeCalls.push({ name: "remove", args }); return true; },
            clear: () => { nativeCalls.push({ name: "clear", args: [] }); },
            pulseCircle: (...args) => { nativeCalls.push({ name: "pulse", args }); return true; },
            setPlayerColor: (...args) => { nativeCalls.push({ name: "color", args }); },
            setTrackedPlayers: (...args) => { nativeCalls.push({ name: "tracked", args }); },
            trackAllPlayers: (...args) => { nativeCalls.push({ name: "all", args }); },
            setHouseTint: (...args) => { nativeCalls.push({ name: "tint", args }); return true; },
            setBlipScale: (...args) => { nativeCalls.push({ name: "scale", args }); },
            hideBaseIcon: (...args) => { nativeCalls.push({ name: "base", args }); },
        },
        logger: { info() {}, warn() {} },
        now: () => 1000,
    });
    assert.strictEqual(client.set({ key: "one", kind: "marker", x: 1, y: 2, z: 3, icon: "icon", label: "label", showOnHud: false, showDistance: false }), true);
    assert.deepStrictEqual(nativeCalls.find((call) => call.name === "marker")?.args, ["one", 1, 2, 3, "icon", "label", false, false]);
    assert.strictEqual(client.set({ key: "area", kind: "circle", x: 0, y: 0, z: 0, radius: 50 }), true);
    assert.strictEqual(client.pulse({ key: "area", pulse: false }), true);
    assert.strictEqual(client.replay({ blips: [{ key: "two", kind: "marker", x: 4, y: 5, z: 6 }] }), 1);
    assert.strictEqual(client.status().markers, 1);
    assert.strictEqual(client.setPlayers({ all: false, visible: [2], colors: { 2: [0.1, 0.2, 0.3, 1] }, houseTint: true, scale: 1.2, hideBaseIcon: true }), true);
    assert.deepStrictEqual(nativeCalls.find((call) => call.name === "tracked")?.args, [[2]]);
    client.setPlayers({ all: true, visible: [], colors: {} });
    assert.ok(nativeCalls.some((call) => call.name === "color" && call.args.length === 1));
    assert.strictEqual(client.reportWaypoint({ x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" }), true);
    assert.strictEqual(client.reportWaypoint(null), true);
    assert.deepStrictEqual(reports, [
        { name: "hmp-blips:waypoint", payload: { waypoint: { x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" } } },
        { name: "hmp-blips:waypoint", payload: { waypoint: null } },
    ]);
    client.stop();
    assert.strictEqual(client.status().state, "stopped");
    assert.strictEqual(client.reportWaypoint({ x: 1, y: 2, z: 3, target: null }), false);
    service.stop();
}

async function waypoints(): Promise<void> {
    const sharer = makePlayer(1);
    const friend = makePlayer(2);
    const stranger = makePlayer(3);
    const connected = [sharer, friend, stranger];
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const broadcasts: Array<{ name: string; payload: unknown }> = [];
    const service = createBlipsService<TestPlayer>({
        core: { groups: { has: async () => false } },
        config: { defaultTtl: 600, maxTtl: 0, maxMarkersPerResource: 4, showAllPlayers: true, houseTint: true, playerBlipScale: 1, hideBaseIcon: false, nativeIcons: { hide: [], labels: {} }, enableCommands: false, command: "blips" },
        players: () => connected,
        events: { emit: (name, payload) => emitted.push({ name, payload }), emitAllClients: (name, payload) => broadcasts.push({ name, payload }) },
        logger: { warn() {}, error() {} },
        now: () => 1000,
        setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
        clearTimer() {},
    });
    const lastSet = (player: TestPlayer) => [...player.messages].reverse().find((message) => message.name === "hmp-blips:set")?.payload as Record<string, unknown> | undefined;

    // Until the sharer's client reports one (never, on a host without Blips.waypoint), a share shows nothing.
    assert.strictEqual(service.waypoints.get(sharer), null);
    const info = await service.waypoints.share({ resource: "hmp-party", id: "lead", player: sharer, audience: [sharer, friend] });
    assert.deepStrictEqual(info, { resource: "hmp-party", id: "lead", key: "hmp:hmp-party:lead", playerId: 1, shown: false });
    assert.strictEqual(lastSet(friend), undefined);

    assert.strictEqual(await service.reportWaypoint(sharer, "{"), false);
    assert.strictEqual(await service.reportWaypoint(sharer, { waypoint: { x: "here", y: 0, z: 0 } }), false);
    assert.strictEqual(await service.reportWaypoint(sharer, JSON.stringify({})), false);
    assert.strictEqual(emitted.length, 0);

    // A placed waypoint is kept with the map it is in, announced, and shown to the audience but never the sharer.
    assert.strictEqual(await service.reportWaypoint(sharer, JSON.stringify({ waypoint: { x: 10, y: 20, z: 30, target: "FT_HW_GreatHall" } })), true);
    const placed = { x: 10, y: 20, z: 30, target: "FT_HW_GreatHall", areaId: "Hogwarts" };
    assert.deepStrictEqual(service.waypoints.get(1), placed);
    assert.deepStrictEqual(emitted, [{ name: "hmp:blips:waypoint", payload: { player: sharer, waypoint: placed, previous: null } }]);
    assert.deepStrictEqual(lastSet(friend), { key: "hmp:hmp-party:lead", kind: "marker", x: 10, y: 20, z: 30, icon: "UI_T_MiniMap_Waypoint", label: "Player1", showOnHud: true, showDistance: true });
    assert.strictEqual(lastSet(sharer), undefined);
    assert.strictEqual(lastSet(stranger), undefined);
    assert.strictEqual(service.markers.get("lead", "hmp-party")?.areaId, "Hogwarts");
    assert.strictEqual(service.waypoints.list()[0].shown, true);
    assert.strictEqual(await service.reportWaypoint(sharer, { waypoint: { x: 10, y: 20, z: 30, target: "FT_HW_GreatHall" } }), false, "the same waypoint is no change");

    // Moving it moves the marker; lifting it hides the marker and keeps the share.
    await service.reportWaypoint(sharer, { waypoint: { x: 40, y: 50, z: 60, target: null } });
    assert.deepStrictEqual([lastSet(friend)?.x, lastSet(friend)?.y, lastSet(friend)?.z], [40, 50, 60]);
    await service.reportWaypoint(sharer, { waypoint: null });
    assert.strictEqual(service.waypoints.get(sharer), null);
    assert.deepStrictEqual((emitted.at(-1)?.payload as { previous: unknown }).previous, { x: 40, y: 50, z: 60, target: null, areaId: "Hogwarts" });
    assert.strictEqual(service.markers.get("lead", "hmp-party"), null);
    assert.deepStrictEqual(broadcasts.at(-1), { name: "hmp-blips:remove", payload: JSON.stringify({ key: "hmp:hmp-party:lead" }) });
    assert.strictEqual(service.waypoints.list()[0].shown, false);

    // The sharer leaving ends their shares.
    await service.reportWaypoint(sharer, { waypoint: { x: 1, y: 2, z: 3, target: null } });
    assert.ok(service.markers.get("lead", "hmp-party"));
    service.disconnect(sharer);
    assert.deepStrictEqual(service.waypoints.list(), []);
    assert.strictEqual(service.markers.get("lead", "hmp-party"), null);

    // Unsharing, and the owning resource stopping, end a share too.
    await service.reportWaypoint(friend, { waypoint: { x: 7, y: 8, z: 9, target: null } });
    await service.waypoints.share({ resource: "hmp-party", id: "rally", player: 2, audience: "all", label: "Rally" });
    assert.strictEqual(lastSet(stranger)?.label, "Rally");
    assert.strictEqual(service.waypoints.unshare("rally", "hmp-party"), true);
    assert.strictEqual(service.waypoints.unshare("rally", "hmp-party"), false);
    assert.strictEqual(service.markers.get("rally", "hmp-party"), null);
    await service.waypoints.share({ resource: "hmp-party", id: "rally", player: friend, audience: [stranger] });
    await service.cleanup("hmp-party");
    assert.deepStrictEqual(service.waypoints.list(), []);
    assert.strictEqual(service.markers.list("hmp-party").length, 0);

    await assert.rejects(service.waypoints.share({ resource: "hmp-party", id: "gone", player: 99, audience: "all" }), /must be connected/);
    await assert.rejects(service.waypoints.share({ resource: "hmp-party", id: "open", player: friend } as never), /audience is required/);
    await assert.rejects(service.waypoints.share({ resource: "hmp-party", id: "long", player: friend, audience: "all", label: "x".repeat(121) }), /label/);
    assert.deepStrictEqual([service.status().waypoints, service.status().waypointShares], [1, 0]);
    service.stop();
    assert.strictEqual(service.waypoints.get(friend), null);
}

const noNative = {
    setMarker: () => true,
    setCircle: () => true,
    remove: () => true,
    clear() {},
    pulseCircle: () => true,
    setPlayerColor() {},
    setTrackedPlayers() {},
    trackAllPlayers() {},
    setHouseTint: () => true,
    setBlipScale() {},
    hideBaseIcon() {},
};

async function nativeIcons(): Promise<void> {
    // The config keeps one rule per target whatever its case, and refuses a label without a title.
    assert.deepStrictEqual(normalizeNativeIcons(undefined), { hide: [], labels: {} });
    assert.deepStrictEqual(normalizeNativeIcons({
        hide: [" fasttravel ", "FastTravel", "HM_JPippensPotions"],
        labels: { HM_JPippensPotions: { title: "Apothecary", description: "" }, FT_HW_GreatHall: { title: "Dinner" } },
    }), {
        hide: ["fasttravel", "HM_JPippensPotions"],
        labels: { HM_JPippensPotions: { title: "Apothecary", description: "" }, FT_HW_GreatHall: { title: "Dinner" } },
    });
    assert.throws(() => normalizeNativeIcons({ hide: "fasttravel" }), /hide must be an array/);
    assert.throws(() => normalizeNativeIcons({ hide: [""] }), /hide entry/);
    assert.throws(() => normalizeNativeIcons({ labels: { HM_JPippensPotions: { description: "x" } } }), /HM_JPippensPotions\.title/);
    assert.throws(() => normalizeNativeIcons({ labels: { HM_JPippensPotions: { title: "x".repeat(121) } } }), /title/);

    // The server sends each joining client its config, and an empty one when it stops.
    const player = makePlayer(1);
    const broadcasts: Array<{ name: string; payload: unknown }> = [];
    const config = { hide: ["fasttravel"], labels: { HM_JPippensPotions: { title: "Apothecary" } } };
    const service = createBlipsService<TestPlayer>({
        core: { groups: { has: async () => false } },
        config: { defaultTtl: 600, maxTtl: 0, maxMarkersPerResource: 4, showAllPlayers: true, houseTint: true, playerBlipScale: 1, hideBaseIcon: false, nativeIcons: config, enableCommands: false, command: "blips" },
        players: () => [player],
        events: { emit() {}, emitAllClients: (name, payload) => broadcasts.push({ name, payload: typeof payload === "string" ? JSON.parse(payload) : payload }) },
        logger: { warn() {}, error() {} },
        now: () => 1000,
    });
    await service.syncPlayer(player);
    assert.deepStrictEqual(player.messages.find((message) => message.name === "hmp-blips:native-icons")?.payload, config);
    service.stop();
    assert.deepStrictEqual(broadcasts.find((message) => message.name === "hmp-blips:native-icons")?.payload, { hide: [], labels: {} });

    // The client applies it through MapIcons as its own rules, once per change, and resets them when it stops.
    const calls: unknown[][] = [];
    const warnings: unknown[] = [];
    const mapIcons = {
        setHidden: (target: string, hidden: boolean) => {
            if (!target) throw new TypeError("target cannot be empty");
            calls.push(["hide", target, hidden]);
        },
        setLabel: (id: string, title: string, description?: string | null) => { calls.push(["label", id, title, description]); },
        reset: () => { calls.push(["reset"]); },
    };
    const client = createBlipsClient({ native: noNative, mapIcons, logger: { info() {}, warn: (...args) => warnings.push(args) } });
    assert.strictEqual(client.nativeIcons(JSON.stringify({ hide: ["fasttravel", "HM_JPippensPotions"], labels: { HM_JPippensPotions: { title: "Apothecary", description: "" }, FT_HW_GreatHall: { title: "Dinner" } } })), true);
    assert.deepStrictEqual(calls, [
        ["reset"],
        ["hide", "fasttravel", true],
        ["hide", "HM_JPippensPotions", true],
        ["label", "HM_JPippensPotions", "Apothecary", ""],
        ["label", "FT_HW_GreatHall", "Dinner", undefined],
    ]);
    assert.deepStrictEqual(client.status().nativeIcons, { hidden: 2, labels: 2 });
    calls.length = 0;
    assert.strictEqual(client.nativeIcons({ hide: ["fasttravel", "HM_JPippensPotions"], labels: { HM_JPippensPotions: { title: "Apothecary", description: "" }, FT_HW_GreatHall: { title: "Dinner" } } }), true);
    assert.deepStrictEqual(calls, [], "the same config is not applied twice");
    assert.strictEqual(client.nativeIcons({ hide: ["treasurechest"], labels: {} }), true);
    assert.deepStrictEqual(calls, [["reset"], ["hide", "treasurechest", true]]);
    assert.strictEqual(client.nativeIcons("{"), false);
    calls.length = 0;
    client.stop();
    assert.deepStrictEqual(calls, [["reset"]]);
    assert.deepStrictEqual(client.status().nativeIcons, { hidden: 0, labels: 0 });
    assert.strictEqual(client.nativeIcons({ hide: ["fasttravel"], labels: {} }), false);
    assert.deepStrictEqual(warnings, []);

    // A host without MapIcons applies nothing and warns once, and only when there is something to apply.
    const olderWarnings: unknown[] = [];
    const older = createBlipsClient({ native: noNative, mapIcons: null, logger: { info() {}, warn: (...args) => olderWarnings.push(args) } });
    assert.strictEqual(older.nativeIcons({ hide: [], labels: {} }), false);
    assert.strictEqual(olderWarnings.length, 0);
    assert.strictEqual(older.nativeIcons({ hide: ["fasttravel"], labels: {} }), false);
    assert.strictEqual(older.nativeIcons({ hide: ["treasurechest"], labels: {} }), false);
    assert.strictEqual(olderWarnings.length, 1);
    assert.match(String((olderWarnings[0] as unknown[])[0]), /1\.11.*MapIcons/);
    assert.deepStrictEqual(older.status().nativeIcons, { hidden: 0, labels: 0 });
    older.stop();
}

async function scale(): Promise<void> {
    // Sixty players across two areas; every third is an Auror, and Aurors see the Aurors in their own area.
    const players = Array.from({ length: 60 }, (_, index) => makePlayer(index + 1, index % 2 ? "Hogsmeade" : "Hogwarts"));
    const aurors = new Set(players.filter((player) => player.id % 3 === 0).map((player) => player.id));
    const failing = new Set<number>();
    let groupQueries = 0;
    let playerReads = 0;
    let clock = 1000;
    const timers: Array<{ handler: () => void; delay: number }> = [];
    const service = createBlipsService<TestPlayer>({
        core: { groups: { has: async (player, key) => {
            const id = Number(typeof player === "object" ? player.id : player);
            groupQueries++;
            if (failing.delete(id)) throw new Error("database down");
            return key === "job:auror" && aurors.has(id);
        } } },
        config: { defaultTtl: 600, maxTtl: 0, maxMarkersPerResource: 4, showAllPlayers: false, houseTint: true, playerBlipScale: 1, hideBaseIcon: false, nativeIcons: { hide: [], labels: {} }, enableCommands: false, command: "blips" },
        players: () => { playerReads++; return players; },
        events: { emit() {}, emitAllClients() {} },
        logger: { warn() {}, error() {} },
        now: () => clock,
        setTimer: (handler, delay) => { timers.push({ handler, delay }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
        clearTimer() {},
    });
    // What each client holds: the last view it was sent, whatever the tests clear from its messages.
    const shown = new Map<number, number[]>();
    const watch = (player: TestPlayer) => {
        const record = player.emit;
        player.emit = function (name, raw) {
            record.call(this, name, raw);
            if (name === "hmp-blips:players") shown.set(this.id, JSON.parse(String(raw)).visible);
        };
        return player;
    };
    players.forEach(watch);
    const views = (player: TestPlayer) => player.messages.filter((message) => message.name === "hmp-blips:players");
    const lastView = (player: TestPlayer) => views(player).at(-1)?.payload as { visible: number[] } | undefined;
    const expected = (viewer: TestPlayer) => players.filter((subject) => subject !== viewer && aurors.has(viewer.id) && aurors.has(subject.id) && subject.area === viewer.area).map((subject) => subject.id).sort((a, b) => a - b);
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const runTimers = async () => {
        for (const timer of timers.splice(0)) timer.handler();
        await settle();
    };

    // One question per player, shared by the audience and the subjects, where every viewer used to ask again.
    await service.players.track({ resource: "hmp-test", id: "aurors", subjects: { groups: [{ key: "job:auror" }] }, audience: { groups: [{ key: "job:auror" }] }, sameArea: true });
    assert.strictEqual(groupQueries, 60);
    assert.ok(playerReads <= 2, `a refresh reads the player list ${playerReads} times`);
    for (const player of players) assert.deepStrictEqual([...(lastView(player)?.visible || [])].sort((a, b) => a - b), expected(player));

    // Kept answers are not asked again, and a view that did not change is not sent again.
    groupQueries = 0;
    for (const player of players) player.messages.length = 0;
    assert.strictEqual(await service.players.refresh(), 60);
    assert.strictEqual(groupQueries, 0);
    assert.ok(players.every((player) => views(player).length === 0));

    // An Auror walks to the other area: only the Aurors' views change, so only Aurors are sent one.
    const walker = players[2];
    walker.area = "Hogsmeade";
    await service.players.refresh();
    assert.deepStrictEqual(players.filter((player) => views(player).length).map((player) => player.id), [...aurors]);
    assert.deepStrictEqual([...(lastView(walker)?.visible || [])].sort((a, b) => a - b), expected(walker));

    // A burst of events is one pass, a moment later, outside the handlers that asked for it.
    playerReads = 0;
    for (let index = 0; index < 15; index++) service.schedule({ views: true });
    service.schedule({ markers: 5 });
    assert.strictEqual(timers.length, 1);
    assert.ok(timers[0].delay > 0);
    assert.strictEqual(playerReads, 0);
    await runTimers();
    assert.ok(playerReads <= 4, `a scheduled pass reads the player list ${playerReads} times`);

    // A marker refresh for one player asks the audience about that player alone; for everyone, once each.
    let asked = 0;
    await service.markers.upsert({ resource: "hmp-test", id: "duty", kind: "marker", position: { x: 0, y: 0, z: 0 }, ttl: 0, audience: { where: () => { asked++; return true; } } });
    asked = 0;
    service.schedule({ markers: 5, views: true });
    await runTimers();
    assert.strictEqual(asked, 1);
    assert.ok(players[4].messages.some((message) => message.name === "hmp-blips:replay"));
    asked = 0;
    service.schedule({ markers: true });
    await runTimers();
    assert.strictEqual(asked, 60);

    // A kept answer holds until it is forgotten (a group, duty or character change), then only that player is asked.
    aurors.add(1);
    service.schedule({ views: true });
    await runTimers();
    assert.ok(!lastView(players[2])?.visible.includes(1) && !lastView(players[8])?.visible.includes(1));
    groupQueries = 0;
    service.forgetGroups(1);
    service.schedule({ views: true });
    await runTimers();
    assert.strictEqual(groupQueries, 1);
    assert.ok(lastView(players[8])?.visible.includes(1), "a Hogwarts Auror sees the new Auror");

    // Answers expire on their own, and a failed one is asked again rather than kept. Aurors 6 and 12 are in Hogsmeade.
    clock += 30_001;
    failing.add(6);
    groupQueries = 0;
    await service.players.refresh();
    assert.strictEqual(groupQueries, 60);
    assert.ok(!lastView(players[11])?.visible.includes(6), "a failed lookup fails closed");
    groupQueries = 0;
    await service.players.refresh();
    assert.strictEqual(groupQueries, 1);
    assert.ok(lastView(players[11])?.visible.includes(6), "Auror 12 sees Auror 6 once the lookup works");

    // A sync sends a client everything again, even a view it already has.
    for (const player of players) player.messages.length = 0;
    service.schedule({ sync: 9 });
    await runTimers();
    assert.deepStrictEqual(players[8].messages.map((message) => message.name), ["hmp-blips:replay", "hmp-blips:players", "hmp-blips:native-icons"]);
    assert.ok(players.every((player) => player.id === 9 || player.messages.length === 0));

    // Overlapping passes. A gated marker audience and a gated player group (which adds nobody) hold a pass open.
    const hold = () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        return { gate, release };
    };
    let markerGate: Promise<void> | null = null;
    let groupGate: Promise<void> | null = null;
    await service.markers.upsert({ resource: "hmp-test", id: "gated", kind: "marker", position: { x: 0, y: 0, z: 0 }, ttl: 0, audience: async () => { if (markerGate) await markerGate; return players; } });
    await service.players.track({ resource: "hmp-test", id: "gated", subjects: async () => { if (groupGate) await groupGate; return []; } });

    // A resync overtaken by another refresh still reaches its client, which may hold none of what it was sent.
    const heldSync = hold();
    groupGate = heldSync.gate;
    for (const player of players) player.messages.length = 0;
    service.schedule({ sync: 9 });
    timers.splice(0)[0].handler();
    await settle();
    const overtaking = service.players.refresh();
    groupGate = null;
    heldSync.release();
    await overtaking;
    await settle();
    assert.strictEqual(views(players[8]).length, 1, "client 9 is sent its view");
    assert.ok(players.every((player) => player.id === 9 || views(player).length === 0));

    // A pass held up in its replay works its views out afterwards, from the players connected then, so it cannot undo a
    // refresh made meanwhile.
    const heldReplay = hold();
    markerGate = heldReplay.gate;
    service.schedule({ markers: true, views: true });
    timers.splice(0)[0].handler();
    await settle();
    const joiner = watch(makePlayer(63));
    aurors.add(63);
    players.push(joiner);
    await service.players.refresh();
    markerGate = null;
    heldReplay.release();
    await settle();
    for (const player of players) assert.deepStrictEqual(shown.get(player.id) ?? [], expected(player), `view of #${player.id}`);

    // An audience that throws fails closed for its own marker and keeps nothing else from the clients.
    await assert.rejects(service.markers.upsert({ resource: "hmp-test", id: "broken", kind: "marker", position: { x: 0, y: 0, z: 0 }, ttl: 0, audience: { areaId: 123 as unknown as string } }));
    const newcomer = watch(makePlayer(64, "Hogsmeade"));
    players.push(newcomer);
    service.schedule({ sync: 64, markers: true, views: true });
    await runTimers();
    assert.deepStrictEqual(newcomer.messages.map((message) => message.name), ["hmp-blips:replay", "hmp-blips:players", "hmp-blips:native-icons"]);
    const replayKeys = (newcomer.messages[0].payload as { blips: Array<{ key: string }> }).blips.map((blip) => blip.key);
    assert.ok(replayKeys.includes("hmp:hmp-test:gated") && !replayKeys.includes("hmp:hmp-test:broken"));
    assert.ok(service.markers.remove("broken", "hmp-test"));

    // A player who leaves while a pass is on its way is sent nothing by it.
    const heldLeave = hold();
    markerGate = heldLeave.gate;
    for (const player of players) player.messages.length = 0;
    service.schedule({ markers: true, views: true });
    timers.splice(0)[0].handler();
    await settle();
    const leaver = players.find((player) => player.id === 60)!;
    players.splice(players.indexOf(leaver), 1);
    service.disconnect(leaver);
    markerGate = null;
    heldLeave.release();
    await settle();
    assert.strictEqual(leaver.messages.length, 0);
    assert.ok(players.every((player) => player.messages.some((message) => message.name === "hmp-blips:replay")));
    for (const player of players) assert.deepStrictEqual(shown.get(player.id) ?? [], expected(player), `view of #${player.id} after #60 left`);

    service.stop();
    service.schedule({ views: true });
    assert.strictEqual(timers.length, 0, "a stopped service schedules nothing");
}

run().then(waypoints).then(nativeIcons).then(scale).then(() => console.log("hmp-blips tests passed"));

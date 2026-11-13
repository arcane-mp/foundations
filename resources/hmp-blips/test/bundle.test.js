const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const broadcasts = [];
const sent = [];
const player = {
    id: 1,
    nickname: "Smoke",
    position: { x: 1, y: 2, z: 3 },
    virtualWorld: 0,
    emit: (name) => { sent.push(name); },
    sendChat() {},
    location: () => ({ areaId: "Hogwarts", regionId: "GreatHall", destinationId: null, x: 1, y: 2, z: 3, yaw: 0, revision: 1 }),
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const router = { register() {}, handle() {} };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        text: { clean: (value) => String(value).trim() },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        command: { createRouter: () => router },
    };
    if (name === "hmp-core") return { groups: { has: async () => true } };
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit() {},
    emitAllClients: (name, payload) => broadcasts.push({ name, payload }),
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["markers", "players", "waypoints", "status"]);
assert.ok(serverHandlers.has("client:hmp-blips:ready"));
assert.ok(serverHandlers.has("client:hmp-blips:waypoint"));
assert.ok(serverHandlers.has("playerLocationChanged"));
assert.ok(broadcasts.some((entry) => entry.name === "hmp-blips:clear"));
assert.ok(broadcasts.some((entry) => entry.name === "hmp-blips:native-icons" && entry.payload === JSON.stringify({ hide: [], labels: {} })));

void (async () => {
    await serverHandlers.get("client:hmp-blips:waypoint")(player, JSON.stringify({ waypoint: { x: 4, y: 5, z: 6, target: null } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(serverExports.get("waypoints").get(player), { x: 4, y: 5, z: 6, target: null, areaId: "Hogwarts" });

    // These events arrive inside the packet that raised them, so their handlers only note the work, which runs a moment
    // later, once for the burst.
    for (const name of ["playerConnect", "playerDisconnect", "hmp:groups:changed", "hmp:jobs:duty", "hmp:character:selected", "hmp:character:unloaded", "hmp:session:ready", "hmp:session:ended"]) {
        assert.ok(serverHandlers.has(name), `handles ${name}`);
    }
    let reads = 0;
    global.PlayerManager = { getAll: () => { reads++; return [player]; } };
    sent.length = 0;
    serverHandlers.get("playerConnect")(player);
    serverHandlers.get("playerLocationChanged")(player);
    serverHandlers.get("hmp:session:ready")({ playerId: 1 });
    serverHandlers.get("client:hmp-blips:ready")(player);
    await Promise.resolve();
    assert.strictEqual(reads, 0, "no handler reads the players itself");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(reads > 0);
    assert.strictEqual(sent.filter((name) => name === "hmp-blips:native-icons").length, 1, "one sync for the burst");
    assert.ok(sent.includes("hmp-blips:replay") && sent.includes("hmp-blips:players"));

    const clientBundle = path.resolve(__dirname, "..", "dist", "client.js");
    function loadClient(waypoint, mapIcons) {
        delete require.cache[clientBundle];
        const loaded = { exports: new Map(), handlers: new Map(), emits: [], nativeCalls: [], iconCalls: [] };
        global.Exports = { register: (name, value) => loaded.exports.set(name, value) };
        global.Imports = { get: () => ({ logger: { create: () => logger } }) };
        global.Events = {
            on: (name, handler) => loaded.handlers.set(name, handler),
            emitServer: (name, payload) => loaded.emits.push({ name, payload }),
        };
        global.Blips = {
            setMarker: (...args) => { loaded.nativeCalls.push(["marker", ...args]); return true; },
            setCircle: (...args) => { loaded.nativeCalls.push(["circle", ...args]); return true; },
            remove: () => true,
            clear() {},
            pulseCircle: () => true,
            setPlayerColor() {},
            setTrackedPlayers() {},
            trackAllPlayers() {},
            setHouseTint: () => true,
            setBlipScale() {},
            hideBaseIcon() {},
            ...(waypoint === undefined ? {} : { waypoint: () => waypoint }),
        };
        if (mapIcons) global.MapIcons = {
            setHidden: (...args) => { loaded.iconCalls.push(["hide", ...args]); },
            setLabel: (...args) => { loaded.iconCalls.push(["label", ...args]); },
            reset: () => { loaded.iconCalls.push(["reset"]); },
        };
        else delete global.MapIcons;
        require(clientBundle);
        return loaded;
    }

    // A host with waypoint reads reports the waypoint already placed, then each change.
    const client = loadClient({ x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" }, true);
    assert.deepStrictEqual([...client.exports.keys()], ["status"]);
    assert.deepStrictEqual(client.emits, [
        { name: "hmp-blips:ready", payload: "{}" },
        { name: "hmp-blips:waypoint", payload: JSON.stringify({ waypoint: { x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" } }) },
    ]);
    client.handlers.get("waypointChanged")(null, { x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" });
    assert.deepStrictEqual(client.emits.at(-1), { name: "hmp-blips:waypoint", payload: JSON.stringify({ waypoint: null }) });
    client.handlers.get("hmp-blips:set")({ key: "smoke", kind: "marker", x: 1, y: 2, z: 3 });
    assert.ok(client.nativeCalls.some((entry) => entry[0] === "marker"));
    client.handlers.get("hmp-blips:native-icons")(JSON.stringify({ hide: ["fasttravel"], labels: { HM_JPippensPotions: { title: "Apothecary" } } }));
    assert.deepStrictEqual(client.iconCalls, [["reset"], ["hide", "fasttravel", true], ["label", "HM_JPippensPotions", "Apothecary", undefined]]);
    client.handlers.get("resourceStop")("hmp-blips");
    assert.strictEqual(client.exports.get("status")().state, "stopped");
    assert.deepStrictEqual(client.iconCalls.at(-1), ["reset"]);

    // An older host has no Blips.waypoint: nothing is reported.
    const older = loadClient(undefined);
    assert.deepStrictEqual(older.emits.map((entry) => entry.name), ["hmp-blips:ready"]);
    assert.ok(!older.handlers.has("waypointChanged"));
    // Nor MapIcons: the game's own icons stay as they are.
    assert.strictEqual(older.handlers.get("hmp-blips:native-icons")(JSON.stringify({ hide: ["fasttravel"], labels: {} })), false);
    assert.deepStrictEqual(older.exports.get("status")().nativeIcons, { hidden: 0, labels: 0 });
    console.log("hmp-blips bundle contract passed");
})().catch((error) => { console.error(error); process.exit(1); });

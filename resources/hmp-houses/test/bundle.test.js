const assert = require("node:assert");
const path = require("node:path");

const exportsMap = new Map();
const handlers = new Map();
const warnings = [];
const logger = { info() {}, warn(message) { warnings.push(String(message)); }, error() {}, debug() {} };
let configFile = {};
const player = { id: 1, nickname: "Smoke", house: "Unaffiliated", sendChat() {} };
const database = {
    transaction: async (work) => typeof work === "function" ? work(database) : [],
    migrate: async () => ({ applied: [], skipped: [], currentVersion: 1 }),
    query: async (sql) => sql.includes("status = 'pending'") ? [] : [],
    single: async () => null, scalar: async () => null, insert: async () => 1, update: async () => 0,
};
const core = {
    characters: { active: () => null },
    sessions: { all: () => [] },
    groups: { has: async () => true, listCharacter: async () => [], setCharacter: async () => ({}), removeCharacter: async () => false },
};
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => ({ ...options.defaults, ...configFile }), env: { boolean: (_value, fallback) => fallback } },
        player: { find: () => player },
    };
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return core;
    throw new Error(`Unexpected import ${name}`);
} };
global.Events = {
    on: (name, handler) => handlers.set(name, handler),
    emit() {},
};
const serverBundle = path.resolve(__dirname, "..", "dist", "server.js");
require(serverBundle);
assert.deepStrictEqual([...exportsMap.keys()], ["membership", "points", "commonRooms", "status"]);
assert.ok(handlers.has("hmp:groups:changed"));
assert.ok(handlers.has("hmp:character:loaded"));
assert.ok(handlers.has("hmp:character:unloaded"));
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("resourceStop"));

const disconnectedPlayer = { id: 2, nickname: "Gone" };
Object.defineProperty(disconnectedPlayer, "house", {
    set() { throw new Error("Player is not connected"); },
});
assert.doesNotThrow(() => handlers.get("hmp:character:unloaded")({ session: { player: disconnectedPlayer } }));

// Unloading a character takes its common rooms back along with its house.
const leaving = { id: 3, nickname: "Leaving", house: "Gryffindor", commonRooms: ["Slytherin"] };
handlers.get("hmp:character:unloaded")({ session: { player: leaving } });
assert.strictEqual(leaving.house, "Unaffiliated");
assert.deepStrictEqual(leaving.commonRooms, []);

void (async () => {
    await handlers.get("resourceStart")("hmp-houses");
    assert.deepStrictEqual(warnings, [], "the game's own banners need no host support");

    // Pinned banners hang once the ledger is ready, and "game" comes back at stop.
    const hung = [];
    configFile = { greatHallBanners: "Hufflepuff" };
    global.World = { setGreatHallBanners: (banners) => { hung.push(banners); return true; } };
    delete require.cache[serverBundle];
    require(serverBundle);
    await handlers.get("resourceStart")("hmp-houses");
    assert.deepStrictEqual(hung, ["Hufflepuff"]);
    handlers.get("resourceStop")("hmp-houses");
    assert.deepStrictEqual(hung, ["Hufflepuff", "game"]);

    // An older host has no World.setGreatHallBanners and only warns.
    delete global.World;
    delete require.cache[serverBundle];
    require(serverBundle);
    await handlers.get("resourceStart")("hmp-houses");
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /World.setGreatHallBanners/);
    console.log("hmp-houses bundle contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

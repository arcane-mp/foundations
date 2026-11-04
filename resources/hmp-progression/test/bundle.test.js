const assert = require("node:assert");
const path = require("node:path");

const exportsMap = new Map();
const handlers = new Map();
const clientHandlers = new Map();
const logger = { info() {}, warn() {}, error() {} };
const database = {
    transaction: async (work) => typeof work === "function" ? work(database) : [],
    migrate: async () => ({ applied: [], skipped: [], currentVersion: 1 }),
    query: async () => [], single: async () => null, scalar: async () => null, insert: async () => 1,
    update: async (sql) => sql.includes("INSERT IGNORE INTO hmp_progression_profiles") ? 1 : 0,
};
const core = {
    characters: { active: () => null }, sessions: { all: () => [] }, groups: { has: async () => true },
};
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        player: { find: () => null },
    };
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return core;
    throw new Error(`Unexpected import ${name}`);
} };
global.Events = {
    on: (name, handler) => handlers.set(name, handler),
    onClient: (name, handler) => clientHandlers.set(name, handler),
    emit() {},
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsMap.keys()], ["progression", "talents", "flooFlames", "status"]);
assert.ok(handlers.has("hmp:character:loaded"));
assert.ok(handlers.has("worldReady"));
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("playerFastTravelUnlocked"));
assert.ok(clientHandlers.has("hmp-progression:native-report"));
assert.ok(clientHandlers.has("hmp-progression:native-result"));
console.log("hmp-progression bundle contract passed");

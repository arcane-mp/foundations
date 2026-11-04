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
assert.ok(clientHandlers.has("hmp-progression:field-guide-result"));
assert.ok(clientHandlers.has("hmp-progression:field-guide-save"));

const clientBundle = path.resolve(__dirname, "..", "dist", "client.js");
function loadClient(fieldGuide) {
    delete require.cache[clientBundle];
    const loaded = { exports: new Map(), handlers: new Map(), emits: [] };
    global.Exports = { register: (name, value) => loaded.exports.set(name, value) };
    global.Events = {
        on: (name, handler) => loaded.handlers.set(name, handler),
        emitServer: (name, payload) => loaded.emits.push({ name, payload: JSON.parse(payload) }),
    };
    if (fieldGuide) global.FieldGuide = fieldGuide;
    else delete global.FieldGuide;
    require(clientBundle);
    return loaded;
}

// A host without FieldGuide answers the restore as unsupported.
const older = loadClient(null);
older.handlers.get("hmp-progression:field-guide")(JSON.stringify({ characterId: 42, token: 1, restore: false, snapshot: null }));
assert.deepStrictEqual(older.emits, [{ name: "hmp-progression:field-guide-result", payload: { characterId: 42, token: 1, ok: false, unsupported: true } }]);
assert.strictEqual(older.exports.get("clientStatus")().fieldGuide, "unsupported");

const restored = [];
const current = loadClient({ ready: () => true, snapshot: () => null, restore: (value) => { restored.push(value); return { ok: true, mismatches: [], needsTravel: false }; } });
assert.ok(current.handlers.has("fieldGuideCollectionChanged"));
assert.ok(current.handlers.has("fieldGuideChallengeChanged"));
current.handlers.get("hmp-progression:field-guide")(JSON.stringify({ characterId: 42, token: 1, restore: true, snapshot: null }));
assert.deepStrictEqual(restored, [null]);
assert.strictEqual(current.emits[0].payload.ok, true);
current.handlers.get("resourceStop")("hmp-progression");
console.log("hmp-progression bundle contract passed");

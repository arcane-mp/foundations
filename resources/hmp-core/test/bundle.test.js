const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const handlers = new Map();
const logger = { info() {}, error() {}, warn() {}, debug() {} };
const database = {
    query: async () => [],
    single: async () => null,
    scalar: async () => null,
    insert: async () => 1,
    update: async () => 0,
    transaction: async (work) => work(database),
    migrate: async () => ({ resource: "hmp-core", applied: [], skipped: [], currentVersion: 1 }),
    ready: async () => true,
};

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = {
    get(name) {
        if (name === "hmp-mysql") return database;
        if (name === "hmp-lib") return {
            logger: { create: () => logger },
            config: { load: (_path, options) => ({ ...options.defaults }), env: { number: Number, boolean: (value) => value === "true" } },
            player: { format: (player) => `#${player.id}` },
        };
        throw new Error(`Unexpected import ${name}`);
    },
};
global.Events = { on: (name, handler) => handlers.set(name, handler), emit: async () => {} };
global.PlayerManager = { getAll: () => [] };

require(path.resolve(__dirname, "..", "dist", "main.js"));

const expected = ["status", "identity", "accounts", "sessions", "characters", "groups", "metadata", "tickets"];
assert.deepStrictEqual([...exportsSeen.keys()], expected);
assert.strictEqual(typeof exportsSeen.get("status"), "function");
for (const name of expected.slice(1)) assert.strictEqual(typeof exportsSeen.get(name), "object");
assert.ok(handlers.has("playerConnecting"));
assert.ok(handlers.has("playerConnect"));
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("resourceStart"));
assert.ok(handlers.has("resourceStop"));
const clientSource = fs.readFileSync(path.resolve(__dirname, "..", "dist", "client.js"), "utf8");
assert.ok(clientSource.includes("client dependency shim ready"));
void (async () => {
    let kickReason = "";
    handlers.get("playerConnect")({ id: 7, nickname: "Not Ready", hardwareId: "123", kick: (reason) => { kickReason = reason; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(kickReason, /temporarily unavailable/i);

    // A ticket a redeemer accepts reaches the player who takes the slot; nothing is turned away by default.
    const tickets = exportsSeen.get("tickets");
    assert.strictEqual(tickets.required(), false);
    tickets.register({ name: "website", resource: "smoke", redeem: ({ ticket }) => ticket === "good" && { accountId: 9 } });
    let rejected = "";
    const connection = { nickname: "Linked", steamId: "", epicId: "", discordId: "", hardwareId: "77", ip: "198.51.100.2", reject: (reason) => { rejected = reason; } };
    await handlers.get("playerConnecting")({ ...connection, ticket: "good" });
    await handlers.get("playerConnecting")({ ...connection, ticket: "" });
    assert.strictEqual(rejected, "");
    handlers.get("playerConnect")({ id: 8, nickname: "Linked", hardwareId: "77", ip: "198.51.100.2", kick() {} });
    assert.deepStrictEqual(tickets.get(8), { redeemer: "website", result: { accountId: 9 }, repeat: false });
    handlers.get("playerDisconnect")({ id: 8, nickname: "Linked" });
    assert.strictEqual(tickets.get(8), null);
    console.log("hmp-core bundle contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const commands = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const player = { id: 1, nickname: "Smoke", emit() {}, sendChat() {} };
const database = {
    ready: async () => true, migrate: async () => ({}), query: async () => [], update: async () => 1,
};
const core = {
    accounts: { getByPlayer: () => ({ id: 1 }) },
    groups: { has: async () => true },
    metadata: { getAccount: async () => [], setAccount: async (_id, _key, value) => value },
};
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return core;
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        rateLimit: { create: () => ({ allow: () => true }) },
        command: { createRouter: () => ({
            register: (name, options, handler) => { commands.set(name, { options, handler }); return () => true; },
            handle: async () => false,
        }) },
    };
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit() {},
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
const menuPath = path.resolve(__dirname, "..", "dist", "menu.html");
assert.ok(fs.statSync(menuPath).size > 1000);
assert.ok(fs.statSync(path.resolve(__dirname, "..", "dist", "emote_assets.json")).size > 500000);
const menu = fs.readFileSync(menuPath, "utf8");
assert.match(menu, /allowToggle/);
assert.match(menu, /server-wide allowAll policy/);
assert.match(menu, /Click to set the server-level \/e alias/);
const menuScript = menu.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(menuScript);
new Function(menuScript);
assert.deepStrictEqual([...serverExports.keys()], ["emotes", "aliases", "favorites", "ui", "activities", "status"]);
assert.match(menu, /em:activities/);
assert.ok(serverHandlers.has("client:hmp-emotes:ready"));
assert.ok(serverHandlers.has("client:hmp-emotes:alias-set"));
assert.ok(serverHandlers.has("client:hmp-emotes:allow-toggle"));
assert.ok(commands.has("emote"));

const clientExports = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const webEmits = [];
const clientEmits = [];
const shortcuts = [];
global.Exports = { register: (name, value) => clientExports.set(name, value) };
global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => clientEmits.push({ name, payload }),
};
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return { input: {
        controls: { acquire: () => ({ release: () => true }) },
        shortcuts: { register: (definition) => { shortcuts.push(definition); return () => true; }, isDown: () => false },
        cleanup: () => 0,
    } };
    throw new Error(`Unexpected client import ${name}`);
} };
global.LocalPlayer = {
    stopEmote: () => true, playClip: () => true, playAbility: () => true,
    stopPlayerInput: () => true, restorePlayerInput: () => true,
    emotePreview: () => ({ ok: true, visible: false, ready: true, placeable: false, committed: false, anchored: false, status: "" }),
};
global.Web = {
    createView: () => 2, on: (_view, name, handler) => webHandlers.set(name, handler), emit: (_view, name, payload) => webEmits.push({ name, payload }),
    showView() {}, focusView() {}, hideView() {}, destroyView() {},
};
global.Game = { notify() {} };
const clientBundle = path.resolve(__dirname, "..", "dist", "client.js");
require(clientBundle);
assert.ok(clientHandlers.has("hmp-emotes:open"));
assert.ok(clientHandlers.has("hmp-emotes:play"));
clientHandlers.get("hmp-emotes:open")();
assert.ok(webHandlers.has("allowToggle"));
assert.strictEqual(shortcuts.length, 5);
assert.deepStrictEqual(clientEmits.map((entry) => entry.name), ["hmp-emotes:ready"]);
// An older host has no player activities: the menu is offered none.
const offered = JSON.stringify({ activities: [{ id: "kite", variants: ["ravenclaw"] }, { id: "cards", variants: [] }] });
clientHandlers.get("hmp-emotes:activities")(offered);
webHandlers.get("ready")();
assert.deepStrictEqual(webEmits.filter((entry) => entry.name === "em:activities").at(-1).payload, { activities: [] });
clientHandlers.get("resourceStop")("hmp-emotes");

// A host with them passes the server's offer to the menu and starts what the page picks.
const activityCalls = [];
global.LocalPlayer = { ...global.LocalPlayer, startActivity: (id, variant) => { activityCalls.push([id, variant]); return true; }, finishActivity: () => { activityCalls.push(["finish"]); return true; } };
delete require.cache[clientBundle];
require(clientBundle);
clientHandlers.get("hmp-emotes:open")();
webHandlers.get("ready")();
clientHandlers.get("hmp-emotes:activities")(offered);
assert.deepStrictEqual(webEmits.at(-1), { name: "em:activities", payload: JSON.parse(offered) });
webHandlers.get("activity")(JSON.stringify({ id: "kite", variant: "ravenclaw" }));
webHandlers.get("activity")(JSON.stringify({ id: "cards", variant: "" }));
webHandlers.get("activity")(JSON.stringify({ id: "snitch" }));
webHandlers.get("activityFinish")();
assert.deepStrictEqual(activityCalls, [["kite", "ravenclaw"], ["cards", undefined], ["finish"]]);
clientHandlers.get("resourceStop")("hmp-emotes");

// /e <activity> [variant] starts it on the server's player; an older host's player is told what it needs.
void (async () => {
    const started = [], replies = [];
    const reply = (text) => replies.push(text);
    const flier = { ...player, startActivity: (id, variant) => started.push([id, variant]) };
    await commands.get("emote").handler({ player: flier, args: ["kite", "Slytherin"], invokedAs: "e", reply });
    await commands.get("emote").handler({ player: flier, args: ["howler", "banshee"], invokedAs: "e", reply });
    assert.deepStrictEqual(started, [["kite", "slytherin"]]);
    assert.match(replies.at(-1), /howler takes female, male/);
    await commands.get("emote").handler({ player, args: ["kite"], invokedAs: "e", reply });
    assert.match(replies.at(-1), /1\.11/);
    console.log("hmp-emotes bundle contract passed");
})().catch((error) => { console.error(error); process.exit(1); });

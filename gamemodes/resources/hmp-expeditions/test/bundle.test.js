const assert = require("node:assert");
const path = require("node:path");

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const commands = new Map();
const serverHandlers = new Map();
const emitted = [];
const spawned = [];
const rewards = [];

const makePlayer = (id, nickname) => ({
    id, nickname, position: { x: 100, y: 200, z: 300 }, virtualWorld: 0, sent: [],
    emit(event, payload) { this.sent.push({ event, payload: JSON.parse(payload) }); },
    sendChat() {}, location: () => ({ areaId: "Overland", regionId: "Feldcroft" }),
    teleport: () => 1, hold: () => true, release: () => true,
});
const leader = makePlayer(1, "Leader");
const players = [leader];

const definitions = [];
let session = null;
const activities = {
    definitions: { register: (definition) => { definitions.push(definition); return async () => 1; } },
    sessions: {
        create: async (player, activityId, input) => {
            session = { id: "exp-1", activityId, state: "forming", title: input.title, leaderPlayerId: player.id, maximumPlayers: 4, participants: [{ playerId: player.id, nickname: player.nickname, characterId: 10, characterName: "C1" }] };
            return session;
        },
        start: async () => { session.state = "running"; return session; },
        complete: async () => { definitions[0].onCompleted({ session }); return session; },
        cancel: async () => { definitions[0].onCancelled({ session }); return session; },
        get: () => session,
    },
};
const state = new Map();
const services = {
    "hmp-lib": {
        logger: { create: () => logger },
        config: { load: (_candidates, options) => ({ ...options.defaults, countdownSeconds: 1, stageDelaySeconds: 0 }) },
        command: { createRouter: () => ({ register: (name, handler) => { commands.set(name, handler); return () => true; }, handle: async () => false }) },
    },
    "hmp-core": {
        characters: { active: (player) => ({ id: player.id * 10, name: `C${player.id}` }) },
        groups: { has: async (player) => player.id === 1 },
    },
    "hmp-activities": activities,
    "hmp-npcs": {
        catalog: { has: (id) => ["Goblin_Melee", "Troll_Forest"].includes(id), list: () => [{ id: "Goblin_Melee", label: "Goblin" }, { id: "Troll_Forest", label: "Troll" }] },
        spawn: (input) => { const npc = { id: 900 + spawned.length }; spawned.push({ ...input, id: npc.id }); return npc; },
        destroy: () => true,
        setVirtualWorld: () => true,
    },
    "hmp-progression": { progression: { add: async (characterId, points, options) => { rewards.push([characterId, points, options.reference]); return {}; } } },
    "hmp-worldstate": {
        systems: { register: () => () => true },
        state: {
            get: (system, key) => state.get(`${system}/${key}`) ?? null,
            list: (system) => [...state.entries()].filter(([key]) => key.startsWith(`${system}/`)).map(([key, value]) => ({ key: key.slice(system.length + 1), value })),
            set: async (system, key, value) => { assert.ok(value.length <= 256); state.set(`${system}/${key}`, value); return true; },
            delete: async (system, key) => state.delete(`${system}/${key}`),
        },
    },
};

global.Imports = { get: (name) => services[name] };
global.PlayerManager = { getAll: () => players, getById: (id) => players.find((player) => player.id === id) || null };
global.Events = { on: (name, handler) => serverHandlers.set(name, handler), emit: (name, payload) => emitted.push({ name, payload }) };

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function runServer() {
    require(path.resolve(__dirname, "..", "dist", "server.js"));
    const command = commands.get("expedition");
    assert.ok(command, "the /expedition command must be registered");
    assert.strictEqual(definitions[0].id, "hmp-expeditions:run");
    for (const name of ["chatCommand", "npcDied", "playerDied", "playerDowned", "playerDownedEnd", "playerDisconnect", "resourceStop"]) assert.ok(serverHandlers.has(name), `missing ${name} handler`);
    const run = async (...args) => { const replies = []; await command({ player: leader, args, reply: (message) => replies.push(message), findPlayer: () => null }); return replies; };

    // Built in game: entrance where the editor stands, one fight with a boss.
    assert.match((await run("edit", "new", "camp", "Poacher", "Camp"))[0], /Editing camp/);
    leader.position = { x: 900, y: 200, z: 300 };
    assert.match((await run("edit", "stage", "Goblin_Melee", "boss", "Troll_Forest", "3000"))[0], /Stage added/);
    assert.match((await run("edit", "save"))[0], /Saved camp — Poacher Camp, 1 stage\(s\), 1 boss\(es\), 500 XP/);
    assert.match((await run("edit", "enemies", "troll"))[0], /^Troll_Forest$/);

    assert.match((await run("host", "camp"))[0], /Leading Poacher Camp/);
    await run("start");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepStrictEqual(spawned.map((npc) => [npc.enemyId, npc.maxHealth]), [["Goblin_Melee", undefined], ["Troll_Forest", 3000]]);
    for (const npc of spawned) serverHandlers.get("npcDied")(npc.id);
    await settle();
    const finished = emitted.find((entry) => entry.name === "hmp-expeditions:finished");
    assert.ok(finished, "a finished run raises hmp-expeditions:finished");
    assert.deepStrictEqual([finished.payload.result, finished.payload.record], ["cleared", true]);
    assert.deepStrictEqual(rewards, [[10, 500, "hmp-expeditions:exp-1:10"]]);
    assert.match((await run("list"))[0], /camp — Poacher Camp.*record 0:0\d by C1/);
    serverHandlers.get("resourceStop")("hmp-expeditions");
}

function runClient() {
    const clientHandlers = new Map();
    const shapes = new Map();
    const views = [];
    global.Events = { on: (name, handler) => clientHandlers.set(name, handler), emitServer() {} };
    global.Shapes = { create: (key, shape) => { shapes.set(key, shape); return true; }, destroy: (key) => shapes.delete(key) };
    global.Web = { createView: () => { views.push("open"); return 4; }, destroyView: () => { views.push("closed"); return true; }, on() {}, emit: () => true, showView: () => true, hideView: () => true };
    global.Game = { notify() {} };
    require(path.resolve(__dirname, "..", "dist", "client.js"));
    clientHandlers.get("hmp-expeditions:objective")(JSON.stringify({ active: true, x: 1, y: 2, z: 3, boss: true }));
    assert.deepStrictEqual([...shapes.values()].map((shape) => [shape.type, shape.color.r, shape.ground]), [["ring", 230, true]]);
    clientHandlers.get("hmp-expeditions:hud")(JSON.stringify({ active: true, expedition: "Camp", phase: "running", stage: 1, stages: 1, remaining: 2, boss: true, remainingMs: 1000, recordMs: 0 }));
    clientHandlers.get("hmp-expeditions:hud")(JSON.stringify({ active: false }));
    assert.deepStrictEqual([views, shapes.size], [["open", "closed"], 0]);
    clientHandlers.get("resourceStop")("hmp-expeditions");
}

runServer().then(runClient).then(() => console.log("hmp-expeditions bundle contract passed"))
    .catch((error) => { console.error(error); process.exitCode = 1; });

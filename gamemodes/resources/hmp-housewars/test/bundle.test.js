const assert = require("node:assert");
const path = require("node:path");

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const commands = new Map();
const serverHandlers = new Map();
const emitted = [];
const pairs = [];
const awarded = [];

const makePlayer = (id, nickname) => ({
    id, nickname, position: { x: 0, y: 0, z: 0 }, sent: [],
    emit(event, payload) { this.sent.push({ event, payload: JSON.parse(payload) }); },
    sendChat() {}, location: () => ({ areaId: "Overland", regionId: "Hogsmeade" }),
    teleport: () => 1, hold: () => true, release: () => true, setHealthRecovery() {}, endKneel: () => true,
});
const lion = makePlayer(1, "Lion");
const snake = makePlayer(2, "Snake");
const players = [lion, snake];
const houses = { 1: "gryffindor", 2: "slytherin" };

const definitions = [];
let session = null;
const activities = {
    definitions: { register: (definition) => { definitions.push(definition); return async () => 1; } },
    sessions: {
        create: async (player, activityId, input) => {
            session = { id: "battle-1", activityId, state: "forming", title: input.title, leaderPlayerId: player.id, participants: [{ playerId: player.id, nickname: player.nickname, characterId: 10, characterName: "C1", team: input.team }] };
            return session;
        },
        join: async (player, _id, selection) => { session.participants.push({ playerId: player.id, nickname: player.nickname, characterId: 20, characterName: "C2", team: selection.team }); definitions[0].onJoined({ session, player }); return session; },
        start: async () => { session.state = "running"; return session; },
        complete: async () => { definitions[0].onCompleted({ session }); return session; },
        cancel: async () => { definitions[0].onCancelled({ session }); return session; },
        get: () => session,
    },
};
const rules = [];
const services = {
    "hmp-lib": {
        logger: { create: () => logger },
        config: { load: (_candidates, options) => ({ ...options.defaults, rounds: 1, countdownSeconds: 1 }) },
        command: { createRouter: () => ({ register: (name, handler) => { commands.set(name, handler); return () => true; }, handle: async () => false }) },
    },
    "hmp-core": { characters: { active: (player) => ({ id: player.id * 10, name: `C${player.id}` }) } },
    "hmp-activities": activities,
    "hmp-houses": {
        membership: { get: async (player) => ({ house: houses[player.id] }) },
        points: { award: async (house, amount, options) => { awarded.push([house, amount, options.reference]); return {}; }, standings: async () => [{ house: "gryffindor", points: 60 }, { house: "slytherin", points: 10 }] },
    },
    "hmp-pvp": { policy: { register: (rule) => { rules.push(rule); return () => true; } } },
};

global.Imports = { get: (name) => services[name] };
global.PlayerManager = { getAll: () => players, getById: (id) => players.find((player) => player.id === id) || null };
global.Events = { on: (name, handler) => serverHandlers.set(name, handler), emit: (name, payload) => emitted.push({ name, payload }) };
global.Pvp = { setPair: (a, b, options) => { pairs.push([a, b, options]); return true; } };

async function runServer() {
    require(path.resolve(__dirname, "..", "dist", "server.js"));
    const command = commands.get("housewars");
    assert.ok(command, "the /housewars command must be registered");
    assert.deepStrictEqual(definitions[0].teams.map((team) => team.id), ["gryffindor", "hufflepuff", "ravenclaw", "slytherin"]);
    assert.deepStrictEqual([rules[0].id, rules[0].priority], ["housewars", 900]);
    for (const name of ["chatCommand", "pvpDefeat", "playerDied", "resourceStop"]) assert.ok(serverHandlers.has(name), `missing ${name} handler`);
    const run = async (player, ...args) => { const replies = []; await command({ player, args, reply: (message) => replies.push(message), findPlayer: () => lion }); return replies; };

    assert.match((await run(lion, "host"))[0], /Hosting House battle at Open ground/);
    assert.match((await run(snake, "join"))[0], /Joined/);
    await run(lion, "start");
    assert.deepStrictEqual(pairs.at(-1), [1, 2, { hostile: false }]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepStrictEqual(pairs.at(-1), [1, 2, { hostile: true, aim: "lock", defeat: "kneel" }]);
    assert.deepStrictEqual(rules[0].decide({ casterId: 1, victimId: 2 }), { minHp: 1 });
    serverHandlers.get("pvpDefeat")(snake, lion);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    const finished = emitted.find((entry) => entry.name === "hmp-housewars:finished");
    assert.ok(finished, "a finished battle raises hmp-housewars:finished");
    assert.strictEqual(finished.payload.winner, "gryffindor");
    assert.deepStrictEqual(awarded.map(([house, amount]) => [house, amount]), [["gryffindor", 60], ["slytherin", 10]]);
    assert.deepStrictEqual(pairs.at(-1), [1, 2, null]);
    assert.match((await run(lion, "cup"))[0], /Gryffindor 60 · Slytherin 10/);
    serverHandlers.get("resourceStop")("hmp-housewars");
}

function runClient() {
    const clientHandlers = new Map();
    const views = [];
    global.Events = { on: (name, handler) => clientHandlers.set(name, handler), emitServer() {} };
    global.Web = { createView: () => { views.push("open"); return 3; }, destroyView: () => { views.push("closed"); return true; }, on() {}, emit: () => true, showView: () => true, hideView: () => true };
    global.Game = { notify() {} };
    require(path.resolve(__dirname, "..", "dist", "client.js"));
    clientHandlers.get("hmp-housewars:hud")(JSON.stringify({ active: true, arena: "Open ground", phase: "fighting", round: 1, rounds: 3, house: "gryffindor", standing: true, houses: [{ house: "gryffindor", wins: 0, standing: 2, fighters: 2 }], remainingMs: 1000 }));
    clientHandlers.get("hmp-housewars:hud")(JSON.stringify({ active: true, house: "not-a-house" }));
    assert.deepStrictEqual(views, ["open", "closed"], "a malformed HUD state closes the HUD");
    clientHandlers.get("resourceStop")("hmp-housewars");
}

runServer().then(runClient).then(() => console.log("hmp-housewars bundle contract passed"))
    .catch((error) => { console.error(error); process.exitCode = 1; });

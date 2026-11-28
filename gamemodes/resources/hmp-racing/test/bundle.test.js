const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const commands = new Map();
const serverHandlers = new Map();
const emitted = [];

const makePlayer = (id, nickname) => ({
    id, nickname, position: { x: 100, y: 200, z: 300 }, sent: [], messages: [], fastTravel: true,
    emit(event, payload) { this.sent.push({ event, payload: JSON.parse(payload) }); },
    sendChat(message) { this.messages.push(message); },
    location: () => ({ areaId: "Overland", regionId: "Hogsmeade" }),
    teleport(x, y, z) { this.position = { x, y, z }; return 1; },
    hold: () => true, release: () => true,
    setFastTravelEnabled(on) { this.fastTravel = on; }, getFastTravelEnabled() { return this.fastTravel; },
});
const editor = makePlayer(1, "Editor");
const rival = makePlayer(2, "Rival");
const players = [editor, rival];

const definitions = [];
let session = null;
const activities = {
    definitions: { register: (definition) => { definitions.push(definition); return async () => 1; } },
    sessions: {
        create: async (player, activityId, input) => {
            session = { id: "race-1", activityId, state: "forming", title: input.title, leaderPlayerId: player.id, maximumPlayers: 12, participants: [{ playerId: player.id, nickname: player.nickname, characterName: null }] };
            return session;
        },
        join: async (player) => { session.participants.push({ playerId: player.id, nickname: player.nickname, characterName: null }); definitions[0].onJoined({ session, player }); return session; },
        start: async () => { session.state = "running"; return session; },
        complete: async (_id, result) => { session.result = result; definitions[0].onCompleted({ session }); return session; },
        cancel: async () => { definitions[0].onCancelled({ session }); return session; },
        leave: async () => session,
        get: () => session,
    },
};

const state = new Map();
const systems = [];
const services = {
    "hmp-lib": {
        logger: { create: () => logger },
        config: { load: (_candidates, options) => ({ ...options.defaults, countdownSeconds: 1 }) },
        command: { createRouter: () => ({ register: (name, handler) => { commands.set(name, handler); return () => true; }, handle: async () => false }) },
    },
    "hmp-core": {
        characters: { active: (player) => ({ id: (typeof player === "number" ? player : player.id) * 10, name: `Character ${typeof player === "number" ? player : player.id}` }) },
        metadata: { getCharacter: async () => undefined, setCharacter: async (_id, _key, value) => value },
        groups: { has: async (player, group) => player.id === 1 && group === "admin" },
    },
    "hmp-activities": activities,
    "hmp-worldstate": {
        systems: { register: (name, options) => { systems.push([name, options.broadcast]); return () => true; } },
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

async function runServer() {
    require(path.resolve(__dirname, "..", "dist", "server.js"));
    const race = commands.get("race");
    assert.ok(race, "the /race command must be registered");
    assert.strictEqual(definitions[0].id, "hmp-racing:race");
    assert.deepStrictEqual(systems, [["racing-tracks", false], ["racing-records", false]]);
    for (const name of ["chatCommand", "playerFastTravelRequest", "playerDied", "playerDisconnect", "resourceStop"]) {
        assert.ok(serverHandlers.has(name), `missing ${name} handler`);
    }
    const run = async (player, ...args) => { const replies = []; await race({ player, args, reply: (message) => replies.push(message), findPlayer: () => editor }); return replies; };

    // Only an editor may author; the editor flies a course and saves it.
    assert.match((await run(rival, "edit", "new", "loop"))[0], /Only track editors/);
    assert.match((await run(editor, "edit", "new", "loop", "1", "Bundle", "Loop"))[0], /Editing loop/);
    for (const x of [1000, 2000]) { editor.position = { x, y: 200, z: 300 }; await run(editor, "edit", "point", "5"); }
    assert.deepStrictEqual(editor.sent.at(-1).payload.gates.map((gate) => gate.x), [1000, 2000], "the editor sees the draft's gates");
    assert.match((await run(editor, "edit", "save"))[0], /Saved loop — Bundle Loop/);
    assert.match((await run(rival, "tracks"))[0], /^loop — Bundle Loop, 1 lap/);

    // A hosted race, joined and started: the countdown holds fast travel.
    editor.position = { x: 0, y: 200, z: 300 };
    assert.match((await run(editor, "host", "loop"))[0], /Hosting Bundle Loop/);
    assert.match((await run(rival, "join", "Editor"))[0], /Joined/);
    await run(editor, "start");
    assert.strictEqual(serverHandlers.get("playerFastTravelRequest")(rival), false);
    assert.ok(rival.sent.some((entry) => entry.event === "hmp-racing:countdown"));

    // The countdown and samples run on real timers here.
    await new Promise((resolve) => setTimeout(resolve, 1150));
    // The rival falls before anyone finishes, so the run is no longer ranked.
    serverHandlers.get("playerDied")(rival);
    for (const x of [0, 1000, 2000]) { editor.position = { x, y: 200, z: 300 }; await new Promise((resolve) => setTimeout(resolve, 120)); }
    await new Promise((resolve) => setTimeout(resolve, 150));
    await tick();
    const finished = emitted.find((entry) => entry.name === "hmp-racing:finished");
    assert.ok(finished, "a finished race raises hmp-racing:finished");
    assert.deepStrictEqual(finished.payload.results.map((result) => [result.nickname, result.status]), [["Editor", "finished"], ["Rival", "disqualified"]]);
    assert.strictEqual(finished.payload.ranked, false, "a disqualified rival does not count");
    assert.strictEqual(finished.payload.results[0].trackRecord, false);
    assert.strictEqual(serverHandlers.get("playerFastTravelRequest")(rival), undefined);
    assert.match((await run(rival, "top", "loop"))[0], /Bundle Loop: no record/);
    serverHandlers.get("resourceStop")("hmp-racing");
}

function runClient() {
    const clientHandlers = new Map();
    const shapes = new Map();
    const views = [];
    const viewOptions = [];
    const notices = [];
    global.Events = { on: (name, handler) => clientHandlers.set(name, handler), emitServer() {} };
    global.Shapes = { create: (key, shape) => { shapes.set(key, shape); return true; }, destroy: (key) => shapes.delete(key), destroyAll: () => { const count = shapes.size; shapes.clear(); return count; } };
    global.Web = { createView: (_url, options) => { views.push("open"); viewOptions.push(options); return 7; }, destroyView: () => { views.push("closed"); return true; }, on() {}, emit: () => true, showView: () => true, hideView: () => true };
    global.Game = { notify: (message) => notices.push(message) };
    require(path.resolve(__dirname, "..", "dist", "client.js"));
    clientHandlers.get("hmp-racing:gates")(JSON.stringify({ gates: [{ x: 1, y: 2, z: 3, radius: 500, kind: "next" }, { x: 4, y: 5, z: 6, radius: 500, kind: "finish" }] }));
    assert.deepStrictEqual([...shapes.values()].map((shape) => [shape.type, shape.radius, shape.color.g]), [["sphere", 500, 200], ["sphere", 500, 230]]);
    clientHandlers.get("hmp-racing:gates")(JSON.stringify({ gates: [] }));
    assert.strictEqual(shapes.size, 0);
    clientHandlers.get("hmp-racing:hud")(JSON.stringify({ active: true, track: "Loop", phase: "racing", place: 1, racers: 2, lap: 1, laps: 1, checkpoint: 0, checkpoints: 2, elapsedMs: 0, lastLapMs: 0, recordMs: 0 }));
    clientHandlers.get("hmp-racing:hud")(JSON.stringify({ active: false }));
    assert.deepStrictEqual(views, ["open", "closed"]);
    assert.deepStrictEqual(viewOptions[0], { visible: false, focus: false }, "the HUD must not steal focus");
    const hud = fs.readFileSync(path.resolve(__dirname, "..", "client", "hud.html"), "utf8");
    assert.match(hud, /pointer-events:\s*none/, "the HUD must not take input");
    for (const [, size] of hud.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(size) >= 12, `${size}px HUD text is too small`);
    clientHandlers.get("resourceStop")("hmp-racing");
}

runServer().then(runClient).then(() => console.log("hmp-racing bundle contract passed"))
    .catch((error) => { console.error(error); process.exitCode = 1; });

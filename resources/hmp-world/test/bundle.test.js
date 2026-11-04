const assert = require("node:assert");
const path = require("node:path");

const warnings = [];
const logger = { info() {}, warn(message) { warnings.push(message); }, error() {}, debug() {} };
const serverExports = new Map();
const serverHandlers = new Map();
const playerEvents = [];
const fastTravel = [];
const keepHealth = [];
const player = {
    id: 1, nickname: "Smoke", connected: true, emit: (name, payload) => playerEvents.push({ name, payload }),
    setFastTravelEnabled: (on) => fastTravel.push(on), setKeepHealthOnTravel: (on) => keepHealth.push(on),
};
let environment = { weather: "Default_PHY", hour: 12, minute: 0, second: 0, day: 1, month: 1, year: 0, season: 0, timeScale: 1, revision: 0 };
const encounterPolicies = [];
const collisionPolicies = [];
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name !== "hmp-lib") throw new Error(`Unexpected import ${name}`);
    return {
        logger: { create: () => logger },
        config: { load: (_file, options) => options.defaults },
    };
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emitAllClients() {},
};
global.World = {
    get weather() { return environment.weather; },
    get hour() { return environment.hour; },
    get minute() { return environment.minute; },
    get second() { return environment.second; },
    get day() { return environment.day; },
    get month() { return environment.month; },
    get year() { return environment.year; },
    get season() { return environment.season; },
    get timeScale() { return environment.timeScale; },
    get revision() { return environment.revision; },
    setWeather: (weather) => { environment.weather = weather; environment.revision++; return true; },
    setTime: (hour, minute, second = 0) => { Object.assign(environment, { hour, minute, second }); environment.revision++; return true; },
    setDate: (day, month, year = 0) => { Object.assign(environment, { day, month, year }); environment.revision++; return true; },
    setSeason: (season) => { environment.season = season; environment.revision++; return true; },
    setTimeScale: (timeScale) => { environment.timeScale = timeScale; environment.revision++; return true; },
    setEncounterPolicy: (policy) => { encounterPolicies.push(policy); return true; },
    setPlayerCollision: (on) => { collisionPolicies.push(on); return true; },
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["environment", "policy", "status"]);
assert.deepStrictEqual(encounterPolicies, ["suppressed"]);
assert.deepStrictEqual(collisionPolicies, [false]);
assert.ok(serverHandlers.has("client:hmp-world:ready"));
assert.ok(serverHandlers.has("worldReady"));
assert.strictEqual(serverExports.get("policy").current().removeBoundaryVolumes, true);
serverHandlers.get("client:hmp-world:ready")(player);
assert.strictEqual(playerEvents[0].name, "hmp-world:policy");
assert.ok(!("encounters" in JSON.parse(playerEvents[0].payload)));
assert.ok(!("playerCollision" in JSON.parse(playerEvents[0].payload)));
const gameCrowd = { density: 1, exclusions: { names: [], types: [] } };
assert.deepStrictEqual(JSON.parse(playerEvents[0].payload).population, gameCrowd);
serverExports.get("policy").set({ playerCollision: true });
assert.deepStrictEqual(collisionPolicies, [false, true]);
serverHandlers.get("playerConnect")(player);
assert.deepStrictEqual(fastTravel, [], "a connection starts with fast travel allowed");
serverExports.get("policy").set({ fastTravel: false });
serverHandlers.get("playerConnect")(player);
assert.deepStrictEqual(fastTravel, [false, false]);
serverExports.get("policy").sync(player);
assert.ok(!("fastTravel" in JSON.parse(playerEvents.at(-1).payload)));
assert.deepStrictEqual(keepHealth, [], "a connection starts without keeping health over map loads");
serverExports.get("policy").set({ keepHealthOnTravel: true });
assert.deepStrictEqual(keepHealth, [true]);
serverHandlers.get("resourceStop")("hmp-world");
assert.deepStrictEqual(fastTravel, [false, false, true]);
assert.deepStrictEqual(keepHealth, [true, false]);

const clientExports = new Map();
const clientHandlers = new Map();
const clientEmits = [];
const worldCalls = [];
global.Exports = { register: (name, value) => clientExports.set(name, value) };
global.Imports = { get: () => ({ logger: { create: () => logger } }) };
global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => clientEmits.push({ name, payload }),
};
global.World = {
    setBoundaryPolicy: (value) => { worldCalls.push(["boundaries", value]); return 1; },
    setAmbientPopulation: (value) => { worldCalls.push(["population", value]); return true; },
};
global.LocalPlayer = {
    setJumpEnabled: (value) => { worldCalls.push(["jump", value]); },
    setSprintEnabled: (value) => { worldCalls.push(["sprint", value]); },
};
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.deepStrictEqual([...clientExports.keys()], ["policy", "status"]);
assert.deepStrictEqual(clientEmits.map((entry) => entry.name), ["hmp-world:ready"]);
assert.ok(clientHandlers.has("hmp-world:policy"));
clientHandlers.get("hmp-world:policy")(playerEvents[0].payload);
assert.deepStrictEqual(worldCalls, [["boundaries", true], ["population", false], ["jump", true], ["sprint", true]]);
clientHandlers.get("hmp-world:policy")({ removeBoundaryVolumes: true, ambientPopulation: false, jump: false, sprint: true, population: gameCrowd });
assert.deepStrictEqual(worldCalls.slice(-2), [["jump", false], ["sprint", true]]);
assert.strictEqual(clientExports.get("policy").restore(), true);
// HogwartsMP 1.10 has no World.setPopulationDensity: a thinned crowd is warned about once, and the rest applies.
const thinned = { removeBoundaryVolumes: true, ambientPopulation: true, jump: true, sprint: true, population: { density: 0.4, exclusions: { names: [], types: ["vendors"] } } };
clientHandlers.get("hmp-world:policy")(JSON.stringify(thinned));
clientHandlers.get("hmp-world:policy")(JSON.stringify(thinned));
assert.deepStrictEqual(worldCalls.slice(-4), [["boundaries", true], ["population", true], ["jump", true], ["sprint", true]]);
assert.strictEqual(warnings.filter((message) => message.includes("World.setPopulationDensity")).length, 1);
clientHandlers.get("resourceStop")("hmp-world");

const clientBundle = path.resolve(__dirname, "..", "dist", "client.js");
delete require.cache[clientBundle];
global.World = {
    ...global.World,
    setPopulationDensity: (value) => { worldCalls.push(["density", value]); return value; },
    setPopulationExclusions: (value) => { worldCalls.push(["exclusions", value]); return value; },
};
require(clientBundle);
clientHandlers.get("hmp-world:policy")(JSON.stringify(thinned));
assert.deepStrictEqual(worldCalls.slice(-2), [["density", 0.4], ["exclusions", { names: [], types: ["vendors"] }]]);
clientHandlers.get("resourceStop")("hmp-world");
assert.deepStrictEqual(worldCalls.slice(-2), [["density", 1], ["exclusions", { names: [], types: [] }]], "stopping hands the crowd back");
console.log("hmp-world bundle contract passed");

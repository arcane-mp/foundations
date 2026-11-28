const assert = require("node:assert"); const path = require("node:path");
const manifest = require("../package.json").mafiahub;
assert.ok(manifest.resourceDependencies.some((dependency) => dependency.name === "hmp-mysql"), "the manifest still declares hmp-mysql");
const serverExports = new Map(), serverHandlers = new Map();
const kneels = [], timers = [], gearCalls = [], dodgeEmits = [], chat = [];
const recordDodge = (id) => (event, payload) => { if (event === "hmp-duels:dodge") dodgeEmits.push([id, JSON.parse(payload).enabled]); };
const player = {
  id: 1, nickname: "Smoke", emit: recordDodge(1), sendChat(message) { chat.push(message); }, endKneel: () => { kneels.push(1); return true; },
  gearStatMultiplier: 0.75, gearTraits: true,
  setGearStatMultiplier(value) { this.gearStatMultiplier = value; gearCalls.push(["multiplier", value]); },
  setGearTraits(value) { this.gearTraits = value; gearCalls.push(["traits", value]); },
};
const rival = { id: 2, nickname: "Rival", emit: recordDodge(2), sendChat() {} }; // an older host's player: no gear rules
const session = { id: "s", participants: [{ playerId: 1, nickname: "Smoke" }, { playerId: 2, nickname: "Rival" }] };
let definition = null, rules = {}, defaults = null;
const activity = {
  definitions: { register: (value) => { definition = value; return async () => 0; } },
  sessions: { forPlayer: () => [], get: () => null, create: async () => { throw new Error("unused"); }, cancel: async () => {}, complete: async () => {}, start: async () => session },
  invitations: { list: () => [{ id: "i", sessionId: "s", activityId: "duel:standard" }], invite: async () => {}, accept: async () => session, decline: async () => {}, cancel: async () => {} },
};
const pvp = { policy: { register: () => () => true }, status: () => ({}) };
const ui = { notify() {}, alert: async () => null, close() {} };
const migrated = [];
const database = { transaction: async () => { throw new Error("unused"); }, migrate: async (resource, list) => { migrated.push([resource, list.length]); return {}; } };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
const rateLimiter = () => { const used = new Map(); return { allow: (id) => { const count = used.get(id) || 0; if (count >= 5) return false; used.set(id, count + 1); return true; } }; };
global.Imports = { get: (name) => name === "hmp-lib" ? { logger: { create: () => ({ info() {}, warn() {}, error() {} }) }, config: { load: (_p, o) => { defaults = o.defaults; return { ...o.defaults, cosmeticGear: true, dodge: false }; } }, player: { find: () => null }, rateLimit: { create: rateLimiter } } : name === "hmp-core" ? {} : name === "hmp-mysql" ? database : name === "hmp-activities" ? activity : name === "hmp-pvp" ? pvp : ui };
global.PlayerManager = { getById: (id) => id === 2 ? rival : player };
global.Events = { on: (name, handler) => serverHandlers.set(name, handler) };
global.Pvp = { getRules: () => rules };
const realSetTimeout = global.setTimeout;
global.setTimeout = (handler, ms) => { timers.push({ handler, ms }); return timers.length; };
require(path.resolve(__dirname, "..", "dist", "server.js"));
global.setTimeout = realSetTimeout;
assert.deepStrictEqual([...serverExports.keys()], ["challenge", "accept", "decline", "cancel", "forfeit", "status", "ranking"]);
assert.strictEqual(serverExports.get("ranking").config().initialRating, 1000);
// The ranking migrates its own tables when the resource starts.
serverHandlers.get("resourceStart")("hmp-duels");
assert.ok(serverHandlers.has("playerDied")); assert.ok(serverHandlers.has("pvpDefeat")); assert.ok(serverHandlers.has("hmp:activities:invitation:expired"));
// A knock-out's loser is stood up with endKneel only when the host's rules hold kneels; an older host's have no kneelSeconds.
const ko = { session: { id: "s", participants: [{ playerId: 1, nickname: "Smoke" }, { playerId: 2, nickname: "Rival" }] }, result: { winnerId: 2, loserId: 1, reason: "ko" } };
definition.onCompleted(ko);
assert.strictEqual(timers.length, 0);
rules = { kneelSeconds: 0 };
definition.onCompleted(ko);
assert.strictEqual(timers.at(-1).ms, 4000);
timers.at(-1).handler();
assert.deepStrictEqual(kneels, [1]);
delete player.endKneel; // and a player object without it is left alone
definition.onCompleted(ko); timers.at(-1).handler();

// The client uses the host's client Pvp surface, the opponent meter, and holds dodge when the server says.
const clientHandlers = new Map(), calls = [], meters = [], warnings = [];
global.Events = { on: (name, handler) => clientHandlers.set(name, handler), emitServer() {} };
global.Pvp = { showMeter: (id) => { meters.push(id); return "ok"; } };
delete global.Imports; delete global.LocalPlayer; global.Game = { notify: (value) => calls.push(value) };
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const clientBundle = path.resolve(__dirname, "..", "dist", "client.js");
require(clientBundle);
assert.ok(clientHandlers.has("hmp-duels:countdown")); assert.ok(clientHandlers.has("hmp-duels:end"));
clientHandlers.get("hmp-duels:countdown")({ seconds: 3, opponentId: 2, opponentName: "Smoke" });
clientHandlers.get("hmp-duels:start")({ opponentId: 2, opponentName: "Smoke" });
clientHandlers.get("hmp-duels:end")({ result: "win", opponentName: "Smoke" });
assert.ok(calls.some((value) => String(value).includes("Victory")));
assert.deepStrictEqual(meters, [null, 2, 2, null]);
// An older host has no LocalPlayer.setDodgeEnabled: duelists still dodge, and the client says so once.
clientHandlers.get("hmp-duels:dodge")(JSON.stringify({ enabled: false }));
clientHandlers.get("hmp-duels:dodge")(JSON.stringify({ enabled: false }));
assert.strictEqual(warnings.length, 1);
assert.match(warnings[0], /1\.11.*setDodgeEnabled/);
const dodgeCalls = [];
global.LocalPlayer = { setDodgeEnabled: (enabled) => dodgeCalls.push(enabled) };
delete require.cache[clientBundle];
require(clientBundle);
clientHandlers.get("hmp-duels:dodge")(JSON.stringify({ enabled: false }));
clientHandlers.get("hmp-duels:end")({ result: "lose", opponentName: "Smoke" });
clientHandlers.get("hmp-duels:end")({ result: "cancelled" });
clientHandlers.get("hmp-duels:dodge")({ enabled: false });
clientHandlers.get("resourceStop")("hmp-duels");
assert.deepStrictEqual(dodgeCalls, [false, true, false, true]);
console.warn = realWarn;

// cosmeticGear, off by default, makes a new host's duelist's gear cosmetic for the duel and gives their own rules back
// when it ends; an older host's player is left alone.
void (async () => {
  assert.strictEqual(defaults.cosmeticGear, false);
  assert.strictEqual(defaults.dodge, true);
  global.Pvp = { setPair: () => true, getRules: () => rules };
  assert.strictEqual(await serverExports.get("accept")(rival), true);
  assert.deepStrictEqual(gearCalls, [["multiplier", 0], ["traits", false]]);
  definition.onCompleted({ session, result: { winnerId: 1, loserId: 2, reason: "forfeit" } });
  assert.deepStrictEqual(gearCalls.slice(2), [["multiplier", 0.75], ["traits", true]]);
  // dodge: false holds both duelists' dodge from the countdown to the end.
  assert.deepStrictEqual(dodgeEmits, [[1, false], [2, false], [1, true], [2, true]]);
  // Chat ranking queries are throttled per player: the sixth /duel top in a burst is refused.
  const command = serverHandlers.get("chatCommand");
  for (let i = 0; i < 6; i++) command(player, "duel top", "duel", ["top"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(chat.filter((message) => message.includes("Please slow down.")).length, 1);

  // A rating notice goes only to a player still in the character that fought: player ids get reused.
  const ratedHandlers = new Map(), ratedExports = new Map(), ratedEvents = [], ratedNotes = [];
  const active = new Map([[1, { id: 10, name: "Poppy", accountId: 7 }], [2, { id: 20, name: "Natsai", accountId: 8 }]]);
  const ratedPlayers = [1, 2].map((id) => ({ id, nickname: `Player ${id}`, sendChat() {}, emit: (name, payload) => { if (name === "hmp-duels:rated") ratedNotes.push([id, JSON.parse(payload).note]); } }));
  const ratedSession = { id: "s", participants: [{ playerId: 1, nickname: "Player 1" }, { playerId: 2, nickname: "Player 2" }] };
  let ratedDefinition;
  const ratedActivities = {
    definitions: { register: (value) => { ratedDefinition = value; return async () => {}; } },
    sessions: { forPlayer: () => [], get: () => session, create: async () => { throw new Error("unused"); }, cancel: async () => {}, complete: async () => {}, start: async () => session },
    invitations: { list: () => [{ id: "i", sessionId: "s", activityId: "duel:standard" }], invite: async () => {}, accept: async () => session, decline: async () => {}, cancel: async () => {} },
  };
  let stored = null;
  const transaction = {
    async single(sql) { return sql.includes("reference_id = ?") ? stored : null; },
    async query(_sql, ids) { return ids.map((id) => ({ character_id: id, rating: 1000, wins: 0, losses: 0, streak: 0, best_streak: 0 })); },
    async scalar() { return 0; }, async update() { return 1; },
    async insert(_sql, values) {
      stored = { id: 1, reference_id: values[0], winner_character_id: values[1], loser_character_id: values[2], winner_name: "Poppy", loser_name: "Natsai", reason: values[5], rated: values[6], winner_before: values[7], winner_after: values[8], loser_before: values[9], loser_after: values[10], created_at: "2026-11-27" };
      return 1;
    },
  };
  const ratedDb = { ...transaction, transaction: async (work) => work(transaction), migrate: async () => ({}) };
  const lib = { logger: { create: () => ({ info() {}, warn() {}, error() {} }) }, config: { load: (_path, options) => ({ ...options.defaults }) }, player: { find: () => null }, rateLimit: { create: rateLimiter } };
  global.Exports = { register: (name, value) => ratedExports.set(name, value) };
  global.Events = { on: (name, handler) => ratedHandlers.set(name, handler), emit: (name, payload) => ratedEvents.push([name, payload]) };
  global.PlayerManager = { getById: (id) => ratedPlayers.find((entry) => entry.id === id) || null };
  global.Imports = { get: (name) => name === "hmp-lib" ? lib : name === "hmp-core" ? { characters: { active: (value) => active.get(typeof value === "number" ? value : value.id) || null } } : name === "hmp-mysql" ? ratedDb : name === "hmp-activities" ? ratedActivities : name === "hmp-pvp" ? { policy: { register: () => () => {} }, setPair: () => true, getRules: () => ({}) } : ui };
  const realTimeout = global.setTimeout;
  global.setTimeout = (handler) => { handler(); return 1; }; // run the countdown at once
  const bundlePath = path.resolve(__dirname, "..", "dist", "server.js");
  delete require.cache[bundlePath];
  require(bundlePath);
  global.setTimeout = realTimeout;
  ratedHandlers.get("resourceStart")("hmp-duels");
  assert.strictEqual(await ratedExports.get("accept")(ratedPlayers[1]), true);
  ratedDefinition.onCompleted({ session: ratedSession, result: { winnerId: 1, loserId: 2, reason: "ko" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(ratedNotes, [[1, "Duel rating 1024 (+24)"], [2, "Duel rating 976 (-24)"]]);
  assert.strictEqual(ratedEvents.length, 1);
  assert.deepStrictEqual([ratedEvents[0][0], ratedEvents[0][1].winnerPlayerId, ratedEvents[0][1].loserPlayerId], ["hmp:duels:rated", 1, 2]);
  stored = null;
  assert.strictEqual(await ratedExports.get("accept")(ratedPlayers[1]), true);
  ratedDefinition.onCompleted({ session: ratedSession, result: { winnerId: 1, loserId: 2, reason: "ko" } });
  active.set(1, { id: 99, name: "Someone else", accountId: 7 }); // that player id now belongs to another character while the DB write finishes
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(ratedNotes[2], [2, "Duel rating 976 (-24)"]);
  assert.strictEqual(ratedNotes.length, 3);
  assert.deepStrictEqual([ratedEvents[1][1].winnerPlayerId, ratedEvents[1][1].loserPlayerId], [null, 2], "the stale player id is nulled");
  assert.strictEqual(ratedEvents[1][1].match.winnerCharacterId, 10, "the character id is still trusted");

  // Ranking off loads without hmp-mysql at all.
  const offExports = new Map(), offHandlers = new Map();
  global.Exports = { register: (name, value) => offExports.set(name, value) };
  global.Events = { on: (name, handler) => offHandlers.set(name, handler) };
  global.Imports = { get: (name) => {
    if (name === "hmp-mysql") throw new Error("hmp-mysql is not installed");
    if (name === "hmp-lib") return { ...lib, config: { load: (_path, options) => ({ ...options.defaults, ranking: { enabled: false } }) } };
    if (name === "hmp-core") return {};
    if (name === "hmp-activities") return ratedActivities;
    if (name === "hmp-pvp") return { policy: { register: () => () => {} } };
    return ui;
  } };
  delete require.cache[bundlePath];
  require(bundlePath);
  assert.strictEqual(offExports.get("ranking").config().enabled, false);
  offHandlers.get("resourceStart")("hmp-duels");
  assert.strictEqual(offExports.get("ranking").status().state, "disabled");
  console.log("hmp-duels bundle contract passed");
})();

import assert = require("node:assert");
import { test } from "node:test";
import { normalizeConfig } from "../server/config";
import { Match, spawnPoint, type FighterInput } from "../server/match";

const fighter = (playerId: number, house: FighterInput["house"]): FighterInput => ({ playerId, nickname: `P${playerId}`, characterId: playerId * 10, characterName: null, house });
const lions = [fighter(1, "gryffindor"), fighter(2, "gryffindor")];
const snakes = [fighter(3, "slytherin"), fighter(4, "slytherin")];

test("needs two houses and an odd number of rounds", () => {
    assert.throws(() => new Match(lions, 3), /at least two houses/);
    assert.throws(() => new Match([...lions, ...snakes], 2), /odd/);
    const match = new Match([...snakes, ...lions], 3);
    assert.deepStrictEqual(match.houses(), ["gryffindor", "slytherin"]);
    assert.strictEqual(match.winsNeeded, 2);
});

test("eliminates a house to win a round, and the first to two rounds wins", () => {
    const match = new Match([...lions, ...snakes], 3);
    assert.strictEqual(match.hostile(1, 3), false, "nobody fights before the round");
    match.startRound(0);
    assert.deepStrictEqual([match.hostile(1, 3), match.hostile(1, 2)], [true, false]);
    assert.strictEqual(match.knockout(2, 1, 100), null, "a housemate cannot knock you out");
    assert.strictEqual(match.knockout(3, 1, 1000), null);
    assert.strictEqual(match.hostile(1, 3), false, "a knocked-out fighter is out of the fight");
    assert.strictEqual(match.knockout(3, 2, 1100), null, "and cannot be knocked out twice");
    assert.deepStrictEqual(match.knockout(4, 2, 5000), { round: 1, winner: "gryffindor", reason: "elimination", durationMs: 5000, killers: [1, 2] });
    assert.deepStrictEqual([match.fighters.get(1)!.knockouts, match.fighters.get(2)!.knockouts], [1, 1]);
    assert.deepStrictEqual([match.fighters.get(1)!.survived, match.fighters.get(3)!.survived], [1, 0]);
    assert.strictEqual(match.over, false);

    match.startRound(10_000);
    assert.strictEqual(match.standingBy("slytherin"), 2, "everyone is back up for a new round");
    match.knockout(1, 3, 11_000);
    match.knockout(2, null, 12_000);
    assert.strictEqual(match.rounds.at(-1)!.winner, "slytherin");
    match.startRound(20_000);
    match.knockout(3, 1, 21_000);
    match.knockout(4, 1, 22_000);
    assert.deepStrictEqual([match.over, match.winner, match.scoreRecord()], [true, "gryffindor", { gryffindor: 2, slytherin: 1 }]);
    assert.throws(() => match.startRound(30_000), /over/);
});

test("settles a round on time by fighters standing, and a draw scores nobody", () => {
    const match = new Match([...lions, ...snakes], 1);
    match.startRound(0);
    match.knockout(3, 1, 10);
    assert.deepStrictEqual(match.timeUp(180_000), { round: 1, winner: "gryffindor", reason: "time", durationMs: 180_000, killers: [1] });
    assert.strictEqual(match.winner, "gryffindor");

    const level = new Match([...lions, ...snakes], 1);
    level.startRound(0);
    assert.strictEqual(level.timeUp(1000)?.winner, null);
    assert.deepStrictEqual([level.over, level.winner], [true, null]);
});

test("a house whose fighters all leave forfeits the round and the match", () => {
    const match = new Match([...lions, ...snakes, fighter(5, "ravenclaw")], 3);
    match.startRound(0);
    assert.strictEqual(match.leave(5, 100)?.winner ?? "open", "open", "two houses still stand");
    assert.strictEqual(match.fighters.has(5), false, "a leaver leaves the fighter set");
    assert.strictEqual(match.hostile(5, 1), false);
    assert.strictEqual(match.leave(3, 200), null);
    assert.deepStrictEqual(match.leave(4, 300), { round: 1, winner: "gryffindor", reason: "forfeit", durationMs: 300, killers: [] });
    assert.deepStrictEqual([match.contenders(), match.over, match.winner], [["gryffindor"], true, "gryffindor"]);
    // Leaving between rounds settles nothing by itself.
    const between = new Match([...lions, ...snakes], 3);
    assert.strictEqual(between.leave(1, 0), null);
    assert.strictEqual(between.active().length, 3);
});

test("places each house in its own corner, facing the centre", () => {
    const center = { x: 0, y: 0, z: 50 };
    const first = spawnPoint(center, 1000, 0, 2, 0);
    const second = spawnPoint(center, 1000, 1, 2, 0);
    assert.ok(Math.abs(first.x - 700) < 1e-6 && Math.abs(first.y) < 1e-6 && Math.abs(first.yaw - 180) < 1e-6);
    assert.ok(Math.abs(second.x + 700) < 1e-6 && Math.abs(second.yaw) < 1e-6);
    const beside = spawnPoint(center, 1000, 0, 2, 1);
    assert.ok(Math.abs(beside.y + 250) < 1e-6 && beside.z === 50);
});

test("validates the settings", () => {
    const config = normalizeConfig({ arenas: { courtyard: { label: "Courtyard", center: { x: 1, y: 2, z: 3 }, radius: 3000 } } });
    assert.deepStrictEqual([config.command, config.rounds, config.housePoints, config.arenas[0].radius], ["housewars", 3, { win: 50, participation: 10 }, 3000]);
    assert.deepStrictEqual([config.maxPerHouse, config.minPayoutRoundSeconds, config.minPayoutKillers, config.housePointsCooldownSeconds, config.housePointsDailyCap], [2, 30, 2, 300, 200]);
    assert.throws(() => normalizeConfig({ housePointsCooldownSeconds: -1 }), /housePointsCooldownSeconds/);
    assert.throws(() => normalizeConfig({ housePointsDailyCap: -1 }), /housePointsDailyCap/);
    assert.throws(() => normalizeConfig({ minPayoutKillers: -1 }), /minPayoutKillers/);
    assert.throws(() => normalizeConfig({ rounds: 4 }), /odd/);
    assert.throws(() => normalizeConfig({ arenas: { "Bad Id": {} } }), /arena id/);
    assert.throws(() => normalizeConfig({ arenas: { pit: { center: { x: "nope", y: 0, z: 0 } } } }), /center.x/);
});

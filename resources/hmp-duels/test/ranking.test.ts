import assert = require("node:assert");
import activityModule = require("../../hmp-activities/server/service");
import pvpModule = require("../../hmp-pvp/server/service");
import duelModule = require("../server/service");
import rankingModule = require("../server/ranking");
import ratingModule = require("../server/rating");
import repositoryModule = require("../server/repository");
import schemaModule = require("../server/schema");
import type { HmpMySQL } from "../../hmp-mysql/types";
import type { HmpDuelMatchRecord, HmpDuelPlayer, HmpDuelStanding } from "../types";
import type { DuelRepository, MatchDecision, MatchDraft, PairCounts, RatingRow } from "../server/internal";

const { createActivityService } = activityModule;
const { createPvpService } = pvpModule;
const { createDuelService } = duelModule;
const { createRanking } = rankingModule;
const { DEFAULT_RANKING, rankingConfig, expectedScore, rate } = ratingModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;

function memoryRepository(names: Record<number, string> = {}) {
    const ratings = new Map<number, RatingRow>();
    const matches: Array<HmpDuelMatchRecord & { low: number; high: number; accountLow: number | null; accountHigh: number | null; at: number }> = [];
    let clock = 0;
    const migrated: number[] = [];
    const repository: DuelRepository & { tick(minutes: number): void } = {
        tick(minutes: number) { clock += minutes; },
        async migrate(list) { migrated.push(list.length); },
        async record(draft: MatchDraft, initialRating: number, windowMinutes: number, decide: (w: RatingRow, l: RatingRow, counts: PairCounts) => MatchDecision) {
            const existing = matches.find((match) => match.reference === draft.reference);
            if (existing) return existing;
            for (const side of [draft.winner, draft.loser]) {
                if (!ratings.has(side.characterId)) ratings.set(side.characterId, { characterId: side.characterId, rating: initialRating, wins: 0, losses: 0, streak: 0, bestStreak: 0 });
            }
            const winner = { ...ratings.get(draft.winner.characterId)! }, loser = { ...ratings.get(draft.loser.characterId)! };
            const low = Math.min(winner.characterId, loser.characterId), high = Math.max(winner.characterId, loser.characterId);
            const recent = matches.filter((match) => match.low === low && match.high === high && match.rated && match.at > clock - windowMinutes).length;
            const accounts = [Number(draft.winner.accountId), Number(draft.loser.accountId)];
            const accountPair = accounts.every((id) => Number.isSafeInteger(id) && id > 0) ? [Math.min(...accounts), Math.max(...accounts)] : null;
            const recentAccount = accountPair ? matches.filter((match) => match.accountLow === accountPair[0] && match.accountHigh === accountPair[1] && match.rated && match.at > clock - windowMinutes).length : 0;
            const today = matches.filter((match) => match.low === low && match.high === high && match.rated && match.at > clock - 1440).length;
            const todayAccount = accountPair ? matches.filter((match) => match.accountLow === accountPair[0] && match.accountHigh === accountPair[1] && match.rated && match.at > clock - 1440).length : 0;
            const decision = decide(winner, loser, { recent, recentAccount, today, todayAccount });
            if (decision.rated) { ratings.set(winner.characterId, decision.winner); ratings.set(loser.characterId, decision.loser); }
            const match = {
                id: matches.length + 1, reference: draft.reference,
                winnerCharacterId: winner.characterId, loserCharacterId: loser.characterId,
                winnerName: names[winner.characterId] || draft.winner.name, loserName: names[loser.characterId] || draft.loser.name,
                reason: draft.reason, rated: decision.rated,
                winner: decision.rated ? { before: winner.rating, after: decision.winner.rating, delta: decision.winner.rating - winner.rating } : null,
                loser: decision.rated ? { before: loser.rating, after: decision.loser.rating, delta: decision.loser.rating - loser.rating } : null,
                createdAt: new Date(0).toISOString(), low, high, accountLow: accountPair?.[0] ?? null, accountHigh: accountPair?.[1] ?? null, at: clock,
            };
            matches.push(match);
            return match;
        },
        async standing(characterId: number, minimumMatches: number): Promise<HmpDuelStanding | null> {
            const row = ratings.get(characterId);
            if (!row) return null;
            const matchesPlayed = row.wins + row.losses;
            const ranked = matchesPlayed >= Math.max(1, minimumMatches);
            const above = [...ratings.values()].filter((other) => other.rating > row.rating && other.wins + other.losses >= Math.max(1, minimumMatches)).length;
            return { ...row, name: names[characterId] || "", matches: matchesPlayed, rank: ranked ? above + 1 : null };
        },
        async leaderboard(limit: number, minimumMatches: number) {
            const sorted = [...ratings.values()].filter((row) => row.wins + row.losses >= Math.max(1, minimumMatches))
                .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.characterId - b.characterId).slice(0, limit);
            let rank = 0, previous: number | null = null;
            return sorted.map((row, index) => {
                if (row.rating !== previous) { rank = index + 1; previous = row.rating; }
                return { ...row, name: names[row.characterId] || "", matches: row.wins + row.losses, rank };
            });
        },
        async history(characterId: number, limit: number) {
            return matches.filter((match) => match.winnerCharacterId === characterId || match.loserCharacterId === characterId).reverse().slice(0, limit);
        },
    };
    return { repository, ratings, matches, migrated };
}

const side = (characterId: number) => ({ playerId: characterId, characterId, name: `Character ${characterId}` });
const draft = (reference: string, winner: number, loser: number, reason = "ko", foughtMs: number | null = 60_000): MatchDraft => ({ reference, winner: side(winner), loser: side(loser), reason, foughtMs });
const accountDraft = (reference: string, winner: number, winnerAccount: number, loser: number, loserAccount: number): MatchDraft => ({
    ...draft(reference, winner, loser, "forfeit"), winner: { ...side(winner), accountId: winnerAccount }, loser: { ...side(loser), accountId: loserAccount },
});

function elo(): void {
    assert.strictEqual(expectedScore(1000, 1000), 0.5);
    assert.ok(Math.abs(expectedScore(1200, 1000) - 0.7597) < 0.0001);

    const established = { kFactor: 32, provisionalKFactor: 48, provisionalMatches: 10, floor: 100 };
    // Even ratings: each side moves by half of K.
    assert.deepStrictEqual(rate({ rating: 1000, matches: 20 }, { rating: 1000, matches: 20 }, established), {
        winner: { before: 1000, after: 1016, delta: 16 },
        loser: { before: 1000, after: 984, delta: -16 },
    });
    // An upset moves more than an expected win.
    const upset = rate({ rating: 1000, matches: 20 }, { rating: 1400, matches: 20 }, established);
    const expected = rate({ rating: 1400, matches: 20 }, { rating: 1000, matches: 20 }, established);
    assert.ok(upset.winner.delta > expected.winner.delta);
    assert.strictEqual(upset.winner.delta, 29);
    // A provisional player moves by the provisional K; the established opponent by their own.
    const fresh = rate({ rating: 1000, matches: 0 }, { rating: 1000, matches: 20 }, established);
    assert.deepStrictEqual([fresh.winner.delta, fresh.loser.delta], [24, -16]);
    // A win always gains a point, even against a far weaker opponent.
    assert.strictEqual(rate({ rating: 3000, matches: 20 }, { rating: 100, matches: 20 }, established).winner.delta, 1);
    // The floor holds.
    assert.deepStrictEqual(rate({ rating: 150, matches: 20 }, { rating: 110, matches: 20 }, established).loser, { before: 110, after: 100, delta: -10 });
}

function config(): void {
    assert.deepStrictEqual(rankingConfig(undefined), { ...DEFAULT_RANKING, ratedReasons: ["ko", "forfeit", "disconnect"] });
    assert.strictEqual(rankingConfig({ enabled: false }).enabled, false);
    assert.deepStrictEqual(rankingConfig({ ratedReasons: ["ko", "ko"] }).ratedReasons, ["ko"]);
    assert.throws(() => rankingConfig({ ratedReasons: ["cancelled"] }), /ratedReasons/);
    assert.throws(() => rankingConfig({ kFactor: 0 }), /kFactor/);
    assert.throws(() => rankingConfig({ dailyPairLimit: -1 }), /dailyPairLimit/);
    assert.throws(() => rankingConfig({ minimumFightSeconds: 61 }), /minimumFightSeconds/);
    assert.throws(() => rankingConfig({ initialRating: 1.5 }), /initialRating/);
    assert.throws(() => rankingConfig({ floor: 2000, initialRating: 1000 }), /floor/);
}

async function ranking(): Promise<void> {
    const { repository, migrated } = memoryRepository({ 10: "Poppy", 20: "Natsai", 30: "Sebastian" });
    const ranked = createRanking({ repository, migrations, config: rankingConfig({}) });
    assert.strictEqual(ranked.status().state, "starting");
    await ranked.start();
    assert.deepStrictEqual(migrated, [migrations.length]);
    assert.strictEqual(ranked.status().state, "ready");

    const first = await ranked.record(draft("duel-1", 10, 20));
    assert.ok(first);
    assert.strictEqual(first.unrated, null);
    assert.deepStrictEqual([first.match.winner, first.match.loser], [{ before: 1000, after: 1024, delta: 24 }, { before: 1000, after: 976, delta: -24 }]);

    // The same duel finished twice is recorded once.
    assert.strictEqual((await ranked.record(draft("duel-1", 10, 20)))?.match.id, first.match.id);

    // Only the configured endings count; the duel is still kept, unrated.
    const died = await ranked.record(draft("duel-2", 20, 10, "died"));
    assert.deepStrictEqual([died?.match.rated, died?.unrated], [false, "reason"]);

    // A pair past the repeat limit within the window plays unrated, whoever wins.
    await ranked.record(draft("duel-3", 20, 10, "forfeit"));
    await ranked.record(draft("duel-4", 10, 20, "disconnect"));
    const farmed = await ranked.record(draft("duel-5", 10, 20));
    assert.deepStrictEqual([farmed?.match.rated, farmed?.unrated], [false, "repeat"]);
    repository.tick(61);
    assert.strictEqual((await ranked.record(draft("duel-6", 10, 20)))?.match.rated, true, "the window passed");
    // Other opponents are not limited by the first pair's history.
    assert.strictEqual((await ranked.record(draft("duel-7", 30, 10)))?.match.rated, true);

    const poppy = await ranked.standing(10);
    assert.ok(poppy);
    assert.deepStrictEqual([poppy.wins, poppy.losses, poppy.matches, poppy.streak, poppy.bestStreak], [3, 2, 5, -1, 2]);
    const board = await ranked.leaderboard();
    // Sebastian's upset over Poppy, in his provisional matches, puts him on top: 1027 to her 1015.
    assert.deepStrictEqual(board.map((entry) => [entry.name, entry.rating, entry.rank]), [["Sebastian", 1027, 1], ["Poppy", 1015, 2], ["Natsai", 958, 3]]);
    assert.strictEqual(poppy.rank, 2);
    assert.deepStrictEqual((await ranked.history(10, 2)).map((match) => match.reference), ["duel-7", "duel-6"]);
    assert.deepStrictEqual([ranked.status().rated, ranked.status().unrated], [5, 2]);

    // No character on either side, or the same character twice: nothing to rate.
    assert.strictEqual(await ranked.record({ ...draft("duel-8", 10, 20), loser: { playerId: 2, characterId: 0, name: "" } }), null);
    assert.strictEqual(await ranked.record(draft("duel-9", 10, 10)), null);
    await assert.rejects(() => ranked.standing(-1), /character id/);

    // A ranking turned off records nothing and refuses lookups.
    const off = memoryRepository();
    const disabled = createRanking({ repository: off.repository, migrations, config: rankingConfig({ enabled: false }) });
    await disabled.start();
    assert.deepStrictEqual(off.migrated, []);
    assert.strictEqual(disabled.status().state, "disabled");
    assert.strictEqual(await disabled.record(draft("duel-1", 10, 20)), null);
    await assert.rejects(() => disabled.leaderboard(), (error: Error & { code?: string }) => error.code === "HMP_DUELS_RANKING_DISABLED");

    // A failed migration leaves the ranking degraded, and the next use tries again.
    let failures = 1;
    const flaky = memoryRepository();
    const retrying = createRanking({ repository: { ...flaky.repository, migrate: async () => { if (failures-- > 0) throw new Error("database down"); } }, migrations, config: rankingConfig({}) });
    await assert.rejects(() => retrying.start(), /database down/);
    assert.deepStrictEqual([retrying.status().state, retrying.status().lastError], ["degraded", "database down"]);
    assert.deepStrictEqual(await retrying.leaderboard(), []);
    assert.strictEqual(retrying.status().state, "ready");
}

async function accountRepeat(): Promise<void> {
    const store = memoryRepository();
    const ranked = createRanking({ repository: store.repository, migrations, config: rankingConfig({}) });
    await ranked.start();
    // Three rated duels on one account pair, each on a different pair of characters.
    for (const [index, winner, loser] of [[1, 40, 50], [2, 60, 70], [3, 80, 90]] as const) {
        assert.strictEqual((await ranked.record(accountDraft(`accounts-${index}`, winner, 7, loser, 8)))?.match.rated, true);
    }
    // A fourth character pair on the same accounts is unrated, even though no character pair repeated.
    const farmed = await ranked.record(accountDraft("accounts-4", 100, 7, 110, 8));
    assert.deepStrictEqual([farmed?.match.rated, farmed?.unrated], [false, "repeat"]);
    // A different account pair is still free to play.
    assert.strictEqual((await ranked.record(accountDraft("accounts-5", 120, 7, 130, 9)))?.match.rated, true);
}

async function earlyForfeits(): Promise<void> {
    const store = memoryRepository();
    const ranked = createRanking({ repository: store.repository, migrations, config: rankingConfig({}) });
    await ranked.start();
    const before = await ranked.record(draft("early-1", 1, 2, "forfeit", null));
    assert.deepStrictEqual([before?.match.rated, before?.unrated], [false, "early"]);
    const quick = await ranked.record(draft("early-2", 1, 2, "forfeit", 1000));
    assert.deepStrictEqual([quick?.match.rated, quick?.unrated], [false, "early"]);
    const earlyKo = await ranked.record(draft("early-3", 1, 2, "ko", null));
    assert.deepStrictEqual([earlyKo?.match.rated, earlyKo?.unrated], [false, "early"]);
    assert.strictEqual((await ranked.record(draft("early-4", 1, 2, "forfeit", 3000)))?.match.rated, true);
    assert.deepStrictEqual([ranked.status().rated, ranked.status().unrated], [1, 3]);
}

async function dailyCap(): Promise<void> {
    const store = memoryRepository();
    const ranked = createRanking({ repository: store.repository, migrations, config: rankingConfig({ repeatLimit: 0, dailyPairLimit: 3 }) });
    await ranked.start();
    for (const reference of ["day-1", "day-2", "day-3"]) {
        assert.strictEqual((await ranked.record(accountDraft(reference, 1, 7, 2, 8)))?.match.rated, true);
    }
    const capped = await ranked.record(accountDraft("day-4", 3, 7, 4, 8));
    assert.deepStrictEqual([capped?.match.rated, capped?.unrated], [false, "daily"]);
    store.repository.tick(61); // the rolling hour passed; the daily cap still holds
    assert.strictEqual((await ranked.record(accountDraft("day-5", 5, 7, 6, 8)))?.unrated, "daily");
    assert.strictEqual((await ranked.record(accountDraft("day-6", 7, 7, 8, 9)))?.match.rated, true, "another account pair is free");
}

async function repositoryTransaction(): Promise<void> {
    // A fake database that answers the repository's queries in order, to check the transaction's shape.
    const statements: string[] = [];
    const inserted: unknown[][] = [];
    const stored = new Map<string, Record<string, unknown>>();
    const rows = [
        { character_id: 10, rating: 1000, wins: 0, losses: 0, streak: 0, best_streak: 0 },
        { character_id: 20, rating: 1000, wins: 0, losses: 0, streak: 0, best_streak: 0 },
    ];
    const tx = {
        async single(sql: string, values: unknown[]) { statements.push(sql.split("\n")[0].trim()); return sql.includes("reference_id = ?") ? stored.get(String(values[0])) || null : null; },
        async query(sql: string) { statements.push(sql.trim().slice(0, 40)); return rows; },
        async scalar(sql: string) { statements.push(sql.trim().slice(0, 40)); return 0; },
        async update(sql: string, values: unknown[]) { statements.push(sql.trim().slice(0, 40)); if (sql.startsWith("INSERT IGNORE")) inserted.push(values); return 1; },
        async insert(sql: string, values: unknown[]) {
            statements.push(sql.trim().slice(0, 40));
            stored.set(String(values[0]), { id: 1, reference_id: values[0], winner_character_id: values[1], loser_character_id: values[2], winner_name: "Poppy", loser_name: "Natsai", reason: values[5], rated: values[6], winner_before: values[7], winner_after: values[8], loser_before: values[9], loser_after: values[10], created_at: "2026-11-16" });
            return 1;
        },
    };
    const database = { ...tx, transaction: async (work: (value: typeof tx) => unknown) => work(tx), migrate: async () => ({}) } as unknown as HmpMySQL;
    const repository = createRepository(database);
    const match = await repository.record(draft("s-1", 10, 20), 1000, 60, (winner, loser) => ({
        rated: true,
        winner: { ...winner, rating: 1024, wins: 1, streak: 1, bestStreak: 1 },
        loser: { ...loser, rating: 976, losses: 1, streak: -1 },
    }));
    assert.deepStrictEqual([match.rated, match.winner, match.loser], [true, { before: 1000, after: 1024, delta: 24 }, { before: 1000, after: 976, delta: -24 }]);
    assert.ok(statements.some((sql) => sql.startsWith("SELECT * FROM hmp_duel_ratings WHERE")), "both ratings are locked");
    assert.strictEqual(statements.filter((sql) => sql.startsWith("UPDATE hmp_duel_ratings")).length, 2);
    // Recorded once: a second finish of the same duel returns the stored match without touching ratings.
    statements.length = 0;
    const again = await repository.record(draft("s-1", 10, 20), 1000, 60, () => { throw new Error("not decided twice"); });
    assert.strictEqual(again.id, 1);
    assert.strictEqual(statements.length, 1);
    await repository.record(draft("s-2", 20, 10), 1000, 60, (winner, loser) => ({ rated: true, winner, loser }));
    assert.deepStrictEqual(inserted, [[10, 1000, 20, 1000], [10, 1000, 20, 1000]], "rating rows are inserted in id order in both roles");
}

async function repositoryAccountCount(): Promise<void> {
    // The repository counts both windows from indexed pair columns, without a join over match history.
    const calls: PairCounts[] = [];
    const queries: Array<[string, unknown[]]> = [];
    const inserts: unknown[][] = [];
    let stored: Record<string, unknown> | null = null;
    const tx = {
        async single(sql: string) { return sql.includes("reference_id = ?") ? stored : null; },
        async query() { return [{ character_id: 10, rating: 1000, wins: 0, losses: 0, streak: 0, best_streak: 0 }, { character_id: 20, rating: 1000, wins: 0, losses: 0, streak: 0, best_streak: 0 }]; },
        async scalar(sql: string, values: unknown[]) {
            queries.push([sql, values]);
            if (sql.includes("low_account_id")) return values[2] === 1440 ? 12 : 3;
            return values[2] === 1440 ? 13 : 0;
        },
        async update() { return 1; },
        async insert(_sql: string, values: unknown[]) {
            inserts.push(values);
            stored = { id: 1, reference_id: "s-3", winner_character_id: 10, loser_character_id: 20, winner_name: "Poppy", loser_name: "Natsai", reason: "forfeit", rated: 1, winner_before: 1000, winner_after: 1016, loser_before: 1000, loser_after: 984, created_at: "2026-11-27" };
            return 1;
        },
    };
    const database = { ...tx, transaction: async (work: (value: typeof tx) => unknown) => work(tx), migrate: async () => ({}) } as unknown as HmpMySQL;
    await createRepository(database).record(accountDraft("s-3", 10, 7, 20, 8), 1000, 60, (winner, loser, counts) => {
        calls.push(counts); return { rated: true, winner, loser };
    });
    assert.deepStrictEqual(calls, [{ recent: 0, recentAccount: 3, today: 13, todayAccount: 12 }]);
    assert.ok(queries.every(([sql]) => !sql.includes("LEAST") && !sql.includes("JOIN")), "counts fit the pair index");
    assert.ok(queries.some(([sql, values]) => sql.includes("low_account_id") && values[0] === 7 && values[1] === 8 && values[2] === 60));
    assert.ok(queries.some(([sql, values]) => sql.includes("low_account_id") && values[2] === 1440), "the daily count uses 24 hours");
    assert.deepStrictEqual(inserts[0].slice(11), [7, 8], "account ids are stored on the match row");
}

async function activeCharacters(): Promise<void> {
    // hmp-core soft-deletes: only active characters may hold a rating, take a rank or show a history.
    const statements: string[] = [];
    const database = {
        async single(sql: string) { statements.push(sql); return { character_id: 10, rating: 1000, wins: 1, losses: 0, streak: 1, best_streak: 1, character_name: "Poppy" }; },
        async scalar(sql: string) { statements.push(sql); return 0; },
        async query(sql: string) { statements.push(sql); return [{ character_id: 10, rating: 1000, wins: 1, losses: 0, streak: 1, best_streak: 1, character_name: "Poppy", id: 1, reference_id: "s-1", winner_character_id: 10, loser_character_id: 20, winner_name: "Poppy", loser_name: null, reason: "ko", rated: 1, winner_before: 1000, winner_after: 1016, loser_before: null, loser_after: null, created_at: "2026-11-27" }]; },
        async transaction(work: (value: unknown) => unknown) { return work(this); },
    } as unknown as HmpMySQL;
    const repository = createRepository(database);
    assert.ok(await repository.standing(10, 1));
    assert.strictEqual((await repository.leaderboard(5, 1)).length, 1);
    const history = await repository.history(10, 5);
    assert.strictEqual(history[0].loserCharacterId, null, "a soft-deleted opponent has no id");
    assert.strictEqual(history[0].loserName, "");
    assert.ok(statements.every((sql) => sql.includes("status = 'active'")), "standing, rank, top and history filter active characters");
}

async function duelResults(): Promise<void> {
    interface Player extends HmpDuelPlayer { area: string }
    const makePlayer = (id: number): Player => ({ id, nickname: `Player ${id}`, virtualWorld: 0, area: "Hogwarts", emit() {}, location() { return { areaId: this.area, regionId: "GreatHall" }; } });
    const players = [makePlayer(1), makePlayer(2), makePlayer(3)];
    const core = { characters: { active: (player: Player | number) => { const id = typeof player === "number" ? player : player.id; return { id: id * 10, accountId: id, slot: 1, name: `Character ${id}`, status: "active", createdAt: "", updatedAt: "", deletedAt: null }; } } };
    let sequence = 0;
    const activities = createActivityService<Player>({ core: core as never, config: { command: "activities", enableCommands: false, maxDefinitions: 10, maxSessions: 10, maxMetadataBytes: 1024, maxInvitations: 20, defaultInvitationTtlSeconds: 30, maximumInvitationTtlSeconds: 60, defaultLobbyTtlSeconds: 300, maximumLobbyTtlSeconds: 600, sweepIntervalSeconds: 30, enableTestActivity: false }, id: () => `id-${++sequence}` });
    const pvp = createPvpService({ defaultDecision: "deny", initialLethalMode: false, install: () => undefined, clearPolicy: () => undefined, vitals: () => null, applyMode: () => undefined });
    const timers: Array<() => void> = [];
    const finished: MatchDraft[] = [];
    let clock = 0;
    // Player 3 has no character loaded: their duels are fought but never rated.
    const characters = new Map([[1, { id: 10, name: "Poppy", accountId: 7 }], [2, { id: 20, name: "Natsai", accountId: 8 }]]);
    const duels = createDuelService<Player>({
        activities, pvp, player: (id) => players.find((entry) => entry.id === id) || null,
        pair: () => true, setRecovery() {}, emit() {}, notify() {},
        countdownSeconds: 3, invitationTtlSeconds: 30, koHp: 1, now: () => clock,
        setTimer: ((handler: () => void) => { timers.push(handler); return {} as NodeJS.Timeout; }), clearTimer() {},
        character: (id) => characters.get(id) || null,
        finished: (result) => { finished.push(result); },
    });
    // The countdown lasts three seconds of fake time, then the fight begins.
    const duel = async (a: Player, b: Player) => { await duels.challenge(a, b); await duels.accept(b); clock += 3000; timers.pop()!(); };

    await duel(players[0], players[1]);
    // A character switched mid-duel does not change who fought it.
    characters.set(1, { id: 99, name: "Someone else", accountId: 7 });
    await duels.defeated(players[1], players[0]);
    assert.strictEqual(finished.length, 1);
    assert.deepStrictEqual({ ...finished[0], reference: "", foughtMs: 0 }, { reference: "", foughtMs: 0, winner: { playerId: 1, characterId: 10, name: "Poppy", accountId: 7 }, loser: { playerId: 2, characterId: 20, name: "Natsai", accountId: 8 }, reason: "ko" });
    characters.set(1, { id: 10, name: "Poppy", accountId: 7 });

    // A forfeit and a disconnect name a winner; a declined challenge never began.
    await duel(players[0], players[1]);
    await duels.forfeit(players[0]);
    assert.deepStrictEqual([finished[1].winner.characterId, finished[1].loser.characterId, finished[1].reason], [20, 10, "forfeit"]);
    await duels.challenge(players[0], players[1]);
    await duels.decline(players[1]);
    assert.strictEqual(finished.length, 2);
    await duel(players[0], players[1]);
    await duels.disconnected(players[1]);
    assert.deepStrictEqual([finished[2].winner.characterId, finished[2].reason], [10, "disconnect"]);

    await duel(players[0], players[2]);
    await duels.defeated(players[2], players[0]);
    assert.strictEqual(finished.length, 3, "a duelist without a character leaves the duel unrated");

    // A forfeit during the countdown never reached the fight; a quick one has almost no fight time.
    await duels.challenge(players[0], players[1]);
    await duels.accept(players[1]);
    await duels.forfeit(players[0]);
    timers.pop(); // the cancelled countdown
    assert.strictEqual(finished.at(-1)!.foughtMs, null);
    await duel(players[0], players[1]);
    await duels.forfeit(players[0]);
    assert.strictEqual(finished.at(-1)!.foughtMs, 0);

    await duels.stop(); await activities.stop(); pvp.stop();
}

(async () => {
    elo();
    config();
    await ranking();
    await accountRepeat();
    await earlyForfeits();
    await dailyCap();
    await repositoryTransaction();
    await repositoryAccountCount();
    await activeCharacters();
    await duelResults();
    console.log("hmp-duels ranking tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

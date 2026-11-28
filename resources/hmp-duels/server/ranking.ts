import ratingModule = require("./rating");
import type { HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpDuelMatchRecord, HmpDuelRanking, HmpDuelRankingConfig, HmpDuelRankingStatus, HmpDuelStanding } from "../types";
import type { DuelRepository, MatchDecision, MatchDraft, PairCounts, RatingRow, RecordedDuel } from "./internal";

const { rate } = ratingModule;

interface RankingOptions {
    /** Null when ranking is off: then no database import is needed. */
    repository: DuelRepository | null;
    migrations: HmpMySQLMigration[];
    config: HmpDuelRankingConfig;
    now?: () => number;
}

function characterId(value: unknown): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("A character id is required"), { code: "HMP_DUELS_INVALID_CHARACTER" });
    return id;
}

function createRanking(options: RankingOptions): HmpDuelRanking & {
    start(): Promise<void>;
    record(draft: MatchDraft): Promise<RecordedDuel | null>;
} {
    const { repository, migrations, config } = options;
    const now = options.now || Date.now;
    const startedAt = now();
    let state: HmpDuelRankingStatus["state"] = config.enabled ? "starting" : "disabled";
    let startPromise: Promise<void> | null = null;
    let lastError = "";
    let rated = 0, unrated = 0;

    function start(): Promise<void> {
        if (!config.enabled) return Promise.resolve();
        if (startPromise) return startPromise;
        startPromise = store().migrate(migrations).then(() => { state = "ready"; lastError = ""; }).catch((error: unknown) => {
            state = "degraded";
            lastError = (error instanceof Error ? error.message : String(error)).slice(0, 191);
            startPromise = null;
            throw error;
        });
        return startPromise;
    }

    async function ready(): Promise<void> {
        if (!config.enabled) throw Object.assign(new Error("Duel ranking is turned off on this server"), { code: "HMP_DUELS_RANKING_DISABLED" });
        await start();
    }

    function store(): DuelRepository {
        if (!repository) throw Object.assign(new Error("Duel ranking is turned off on this server"), { code: "HMP_DUELS_RANKING_DISABLED" });
        return repository;
    }

    function after(row: RatingRow, rating: number, won: boolean): RatingRow {
        const streak = won ? Math.max(row.streak, 0) + 1 : Math.min(row.streak, 0) - 1;
        return {
            characterId: row.characterId,
            rating,
            wins: row.wins + (won ? 1 : 0),
            losses: row.losses + (won ? 0 : 1),
            streak,
            bestStreak: Math.max(row.bestStreak, streak),
        };
    }

    /** Records a finished duel; null when ranking is off or either side had no character. */
    async function record(draft: MatchDraft): Promise<RecordedDuel | null> {
        if (!config.enabled) return null;
        const winnerId = Number(draft.winner?.characterId), loserId = Number(draft.loser?.characterId);
        if (!Number.isSafeInteger(winnerId) || winnerId <= 0 || !Number.isSafeInteger(loserId) || loserId <= 0 || winnerId === loserId) return null;
        await ready();
        const ratedReason = config.ratedReasons.includes(draft.reason);
        let why: RecordedDuel["unrated"] = null;
        // A duel recorded before comes back without a decision; it counts once.
        let decided = false;
        const match = await store().record(draft, config.initialRating, config.repeatWindowMinutes, (winner, loser, counts: PairCounts): MatchDecision => {
            decided = true;
            if (!ratedReason) { why = "reason"; return { rated: false, why }; }
            // A duel ended before the fight, or in its first seconds by anything but a knock-out, is not a result worth rating.
            if (draft.foughtMs === null || (draft.reason !== "ko" && draft.foughtMs < config.minimumFightSeconds * 1000)) { why = "early"; return { rated: false, why }; }
            // Trading wins over and over would otherwise farm rating, including by rotating characters on the same accounts.
            if (config.repeatLimit > 0 && (counts.recent >= config.repeatLimit || counts.recentAccount >= config.repeatLimit)) { why = "repeat"; return { rated: false, why }; }
            // The rolling window lets a pair play again an hour later; the daily cap still bounds a day of traded wins.
            if (config.dailyPairLimit > 0 && (counts.today >= config.dailyPairLimit || counts.todayAccount >= config.dailyPairLimit)) { why = "daily"; return { rated: false, why }; }
            const change = rate({ rating: winner.rating, matches: winner.wins + winner.losses }, { rating: loser.rating, matches: loser.wins + loser.losses }, config);
            return { rated: true, winner: after(winner, change.winner.after, true), loser: after(loser, change.loser.after, false) };
        });
        if (decided) { if (match.rated) rated += 1; else unrated += 1; }
        if (!match.rated && !why) why = config.ratedReasons.includes(match.reason) ? "repeat" : "reason";
        return { match, unrated: match.rated ? null : why };
    }

    async function standing(id: number): Promise<HmpDuelStanding | null> {
        await ready();
        return store().standing(characterId(id), config.minimumMatches);
    }

    async function leaderboard(limit = config.leaderboardSize): Promise<HmpDuelStanding[]> {
        await ready();
        const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || config.leaderboardSize)));
        return store().leaderboard(size, config.minimumMatches);
    }

    async function history(id: number, limit = 10): Promise<HmpDuelMatchRecord[]> {
        await ready();
        return store().history(characterId(id), Math.max(1, Math.min(50, Math.floor(Number(limit) || 10))));
    }

    function status(): HmpDuelRankingStatus {
        return { state, lastError, rated, unrated, uptimeMs: now() - startedAt };
    }

    return Object.freeze({ start, record, standing, leaderboard, history, status, config: () => ({ ...config, ratedReasons: [...config.ratedReasons] }) });
}

export = { createRanking };

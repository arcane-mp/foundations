import ratingModule = require("./rating");
import type { HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpDuelMatchRecord, HmpDuelRanking, HmpDuelRankingConfig, HmpDuelRankingStatus, HmpDuelStanding } from "../types";
import type { DuelRepository, MatchDecision, MatchDraft, RatingRow, RecordedDuel } from "./internal";

const { rate } = ratingModule;

interface RankingOptions {
    repository: DuelRepository;
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
        startPromise = repository.migrate(migrations).then(() => { state = "ready"; lastError = ""; }).catch((error: unknown) => {
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
        const match = await repository.record(draft, config.initialRating, config.repeatWindowMinutes, (winner, loser, recentRated): MatchDecision => {
            decided = true;
            if (!ratedReason) { why = "reason"; return { rated: false, why }; }
            // Two players trading wins over and over would otherwise farm each other's rating.
            if (config.repeatLimit > 0 && recentRated >= config.repeatLimit) { why = "repeat"; return { rated: false, why }; }
            const change = rate({ rating: winner.rating, matches: winner.wins + winner.losses }, { rating: loser.rating, matches: loser.wins + loser.losses }, config);
            return { rated: true, winner: after(winner, change.winner.after, true), loser: after(loser, change.loser.after, false) };
        });
        if (decided) { if (match.rated) rated += 1; else unrated += 1; }
        if (!match.rated && !why) why = config.ratedReasons.includes(match.reason) ? "repeat" : "reason";
        return { match, unrated: match.rated ? null : why };
    }

    async function standing(id: number): Promise<HmpDuelStanding | null> {
        await ready();
        return repository.standing(characterId(id), config.minimumMatches);
    }

    async function leaderboard(limit = config.leaderboardSize): Promise<HmpDuelStanding[]> {
        await ready();
        const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || config.leaderboardSize)));
        return repository.leaderboard(size, config.minimumMatches);
    }

    async function history(id: number, limit = 10): Promise<HmpDuelMatchRecord[]> {
        await ready();
        return repository.history(characterId(id), Math.max(1, Math.min(50, Math.floor(Number(limit) || 10))));
    }

    function status(): HmpDuelRankingStatus {
        return { state, lastError, rated, unrated, uptimeMs: now() - startedAt };
    }

    return Object.freeze({ start, record, standing, leaderboard, history, status, config: () => ({ ...config, ratedReasons: [...config.ratedReasons] }) });
}

export = { createRanking };

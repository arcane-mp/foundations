import type { HmpDuelRankingConfig } from "../types";

/** What a rated duel does to each side's rating; pure, so the repository applies it inside its transaction. */
interface RatingInput { rating: number; matches: number }
interface RatingChange { before: number; after: number; delta: number }

const DEFAULT_RANKING: Readonly<HmpDuelRankingConfig> = Object.freeze({
    enabled: true,
    initialRating: 1000,
    kFactor: 32,
    provisionalKFactor: 48,
    provisionalMatches: 10,
    floor: 100,
    ratedReasons: Object.freeze(["ko", "forfeit", "disconnect"]) as unknown as string[],
    repeatLimit: 3,
    repeatWindowMinutes: 60,
    dailyPairLimit: 10,
    minimumFightSeconds: 3,
    leaderboardSize: 10,
    minimumMatches: 1,
});

const REASONS = new Set(["ko", "forfeit", "disconnect", "died"]);

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
    if (value === undefined || value === null) return fallback;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new RangeError(`hmp-duels ranking.${label} must be an integer between ${min} and ${max}`);
    return result;
}

/** Validates `ranking` from data/hmp-duels.json against the defaults; a bad value stops the resource, as other settings do. */
function rankingConfig(raw: unknown): HmpDuelRankingConfig {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<Record<keyof HmpDuelRankingConfig, unknown>> : {};
    const reasons = source.ratedReasons === undefined ? [...DEFAULT_RANKING.ratedReasons] : source.ratedReasons;
    if (!Array.isArray(reasons) || reasons.some((reason) => !REASONS.has(String(reason)))) {
        throw new TypeError(`hmp-duels ranking.ratedReasons must list only ${[...REASONS].join(", ")}`);
    }
    const config: HmpDuelRankingConfig = {
        enabled: source.enabled === undefined ? DEFAULT_RANKING.enabled : source.enabled === true,
        initialRating: integer(source.initialRating, DEFAULT_RANKING.initialRating, 100, 5000, "initialRating"),
        kFactor: integer(source.kFactor, DEFAULT_RANKING.kFactor, 1, 200, "kFactor"),
        provisionalKFactor: integer(source.provisionalKFactor, DEFAULT_RANKING.provisionalKFactor, 1, 200, "provisionalKFactor"),
        provisionalMatches: integer(source.provisionalMatches, DEFAULT_RANKING.provisionalMatches, 0, 100, "provisionalMatches"),
        floor: integer(source.floor, DEFAULT_RANKING.floor, 0, 5000, "floor"),
        ratedReasons: [...new Set(reasons.map(String))],
        repeatLimit: integer(source.repeatLimit, DEFAULT_RANKING.repeatLimit, 0, 1000, "repeatLimit"),
        repeatWindowMinutes: integer(source.repeatWindowMinutes, DEFAULT_RANKING.repeatWindowMinutes, 1, 10_080, "repeatWindowMinutes"),
        dailyPairLimit: integer(source.dailyPairLimit, DEFAULT_RANKING.dailyPairLimit, 0, 1000, "dailyPairLimit"),
        minimumFightSeconds: integer(source.minimumFightSeconds, DEFAULT_RANKING.minimumFightSeconds, 0, 60, "minimumFightSeconds"),
        leaderboardSize: integer(source.leaderboardSize, DEFAULT_RANKING.leaderboardSize, 1, 50, "leaderboardSize"),
        minimumMatches: integer(source.minimumMatches, DEFAULT_RANKING.minimumMatches, 0, 1000, "minimumMatches"),
    };
    if (config.floor > config.initialRating) throw new RangeError("hmp-duels ranking.floor must not exceed initialRating");
    return config;
}

/** The chance the first rating beats the second (Elo). */
function expectedScore(rating: number, opponent: number): number {
    return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/**
 * The Elo change of one duel. Each side moves by its own K: a player still in their provisional matches
 * moves faster. A win always gains at least one point and a loss never drops below the floor.
 */
function rate(winner: RatingInput, loser: RatingInput, config: Pick<HmpDuelRankingConfig, "kFactor" | "provisionalKFactor" | "provisionalMatches" | "floor">): { winner: RatingChange; loser: RatingChange } {
    const k = (side: RatingInput) => side.matches < config.provisionalMatches ? config.provisionalKFactor : config.kFactor;
    const winnerExpected = expectedScore(winner.rating, loser.rating);
    const gain = Math.max(1, Math.round(k(winner) * (1 - winnerExpected)));
    const loss = Math.max(0, Math.round(k(loser) * (1 - winnerExpected)));
    const loserAfter = Math.max(config.floor, loser.rating - loss);
    return {
        winner: { before: winner.rating, after: winner.rating + gain, delta: gain },
        loser: { before: loser.rating, after: loserAfter, delta: loserAfter - loser.rating },
    };
}

export = { DEFAULT_RANKING, rankingConfig, expectedScore, rate };

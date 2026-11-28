// TypeScript source.
import type { HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpDuelMatchRecord, HmpDuelStanding } from "../types";

/** One character's stored rating. */
export interface RatingRow {
    characterId: number;
    rating: number;
    wins: number;
    losses: number;
    /** Positive for consecutive wins, negative for consecutive losses. */
    streak: number;
    bestStreak: number;
}

/** A duelist as the duel began: their character is captured then, since a player who leaves takes it with them. */
export interface MatchSide {
    playerId: number;
    characterId: number;
    name: string;
    /** The character's account, when the host reports one; the repeat limit counts accounts too. */
    accountId?: number;
}

/** A finished duel handed to the ranking. */
export interface MatchDraft {
    /** The duel's activity session id; a duel finished twice is recorded once. */
    reference: string;
    winner: MatchSide;
    loser: MatchSide;
    reason: string;
    /** Milliseconds of actual fight, or null when the countdown never ended. */
    foughtMs: number | null;
}

/** The pair's rated duels, counted inside the rating transaction. */
export interface PairCounts {
    recent: number;
    recentAccount: number;
    today: number;
    todayAccount: number;
}

export type MatchDecision =
    | { rated: true; winner: RatingRow; loser: RatingRow }
    | { rated: false; why: "reason" | "early" | "repeat" | "daily" };

export interface DuelRepository {
    migrate(migrations: HmpMySQLMigration[]): Promise<void>;
    /** Locks both ratings, counts the pair's and accounts' rated duels, applies `decide` and stores the match, in one transaction. */
    record(draft: MatchDraft, initialRating: number, repeatWindowMinutes: number, decide: (winner: RatingRow, loser: RatingRow, counts: PairCounts) => MatchDecision): Promise<HmpDuelMatchRecord>;
    standing(characterId: number, minimumMatches: number): Promise<HmpDuelStanding | null>;
    leaderboard(limit: number, minimumMatches: number): Promise<HmpDuelStanding[]>;
    history(characterId: number, limit: number): Promise<HmpDuelMatchRecord[]>;
}

/** What the ranking made of a finished duel. */
export interface RecordedDuel {
    match: HmpDuelMatchRecord;
    /** Why the duel left the ratings alone: its reason, an early finish, the rolling limit or the daily limit. */
    unrated: "reason" | "early" | "repeat" | "daily" | null;
}

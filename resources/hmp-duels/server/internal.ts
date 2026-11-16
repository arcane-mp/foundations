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
}

/** A finished duel handed to the ranking. */
export interface MatchDraft {
    /** The duel's activity session id; a duel finished twice is recorded once. */
    reference: string;
    winner: MatchSide;
    loser: MatchSide;
    reason: string;
}

export type MatchDecision =
    | { rated: true; winner: RatingRow; loser: RatingRow }
    | { rated: false; why: "reason" | "repeat" };

export interface DuelRepository {
    migrate(migrations: HmpMySQLMigration[]): Promise<void>;
    /** Locks both ratings, counts the pair's recent rated duels, applies `decide` and stores the match, in one transaction. */
    record(draft: MatchDraft, initialRating: number, repeatWindowMinutes: number, decide: (winner: RatingRow, loser: RatingRow, recentRated: number) => MatchDecision): Promise<HmpDuelMatchRecord>;
    standing(characterId: number, minimumMatches: number): Promise<HmpDuelStanding | null>;
    leaderboard(limit: number, minimumMatches: number): Promise<HmpDuelStanding[]>;
    history(characterId: number, limit: number): Promise<HmpDuelMatchRecord[]>;
}

/** What the ranking made of a finished duel. */
export interface RecordedDuel {
    match: HmpDuelMatchRecord;
    /** Why the duel left the ratings alone: its reason is not rated, or the pair hit the repeat limit. */
    unrated: "reason" | "repeat" | null;
}

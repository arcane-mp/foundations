export interface HmpDuelPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    virtualWorld?: number;
    location?(): { areaId: string; regionId: string } | null;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
}

export interface HmpDuelChallenge { sessionId: string; invitationId: string; challengerId: number; targetId: number; expiresAt: string }
export interface HmpDuelsStatus { state: "ready" | "stopped"; pending: number; countdowns: number; live: number; uptimeMs: number }

export interface HmpDuels<P = HmpDuelPlayer> {
    challenge(challenger: P, target: P): Promise<HmpDuelChallenge>;
    accept(target: P): Promise<boolean>;
    decline(target: P, reason?: string): Promise<boolean>;
    cancel(challenger: P): Promise<boolean>;
    forfeit(player: P): Promise<boolean>;
    status(): HmpDuelsStatus;
}

/** `ranking` in data/hmp-duels.json. */
export interface HmpDuelRankingConfig {
    /** Off records nothing and refuses the ranking commands; on by default. */
    enabled: boolean;
    /** A character's rating before their first rated duel (default 1000). */
    initialRating: number;
    /** How far one duel moves an established rating (Elo K, default 32). */
    kFactor: number;
    /** How far one duel moves a rating during its first `provisionalMatches` duels (default 48). */
    provisionalKFactor: number;
    provisionalMatches: number;
    /** No loss takes a rating below this (default 100). */
    floor: number;
    /** How a duel must end to count: any of "ko", "forfeit", "disconnect", "died" (default the first three). */
    ratedReasons: string[];
    /** A pair's duels past this many rated ones within `repeatWindowMinutes` are recorded unrated; 0 never limits (default 3). */
    repeatLimit: number;
    repeatWindowMinutes: number;
    /** A pair's rated duels in 24 hours past this many are unrated, window or no window (default 10; 0 disables). */
    dailyPairLimit: number;
    /** A duel that ends any way but a knock-out within this many seconds of the fight starting is unrated (default 3). */
    minimumFightSeconds: number;
    /** How many characters `/duel top` lists (default 10, at most 50). */
    leaderboardSize: number;
    /** Rated duels a character plays before they take a rank (default 1). */
    minimumMatches: number;
}

export interface HmpDuelStanding {
    characterId: number;
    name: string;
    rating: number;
    wins: number;
    losses: number;
    matches: number;
    /** Positive for consecutive wins, negative for consecutive losses. */
    streak: number;
    bestStreak: number;
    /** 1 for the top rating, shared by ties; null before `minimumMatches`. */
    rank: number | null;
}

export interface HmpDuelRatingChange { before: number; after: number; delta: number }

export interface HmpDuelMatchRecord {
    id: number;
    /** The duel's activity session id. */
    reference: string;
    /** null once that character is soft-deleted; these ids, not the player ids, are the result. */
    winnerCharacterId: number | null;
    loserCharacterId: number | null;
    winnerName: string;
    loserName: string;
    reason: string;
    rated: boolean;
    /** Each side's rating change; null for an unrated duel. */
    winner: HmpDuelRatingChange | null;
    loser: HmpDuelRatingChange | null;
    createdAt: string | Date;
}

export interface HmpDuelRankingStatus {
    state: "disabled" | "starting" | "ready" | "degraded";
    lastError: string;
    /** Duels rated and recorded unrated since the resource started. */
    rated: number;
    unrated: number;
    uptimeMs: number;
}

/** The `ranking` export. Character ids are hmp-core's. */
export interface HmpDuelRanking {
    standing(characterId: number): Promise<HmpDuelStanding | null>;
    leaderboard(limit?: number): Promise<HmpDuelStanding[]>;
    history(characterId: number, limit?: number): Promise<HmpDuelMatchRecord[]>;
    status(): HmpDuelRankingStatus;
    config(): HmpDuelRankingConfig;
}

/** The payload of the server event `hmp:duels:rated`, raised once per recorded duel. */
export interface HmpDuelRatedEvent {
    match: HmpDuelMatchRecord;
    /** null once that player no longer holds the character; trust `match`'s character ids. */
    winnerPlayerId: number | null;
    loserPlayerId: number | null;
    unrated: "reason" | "early" | "repeat" | "daily" | null;
}

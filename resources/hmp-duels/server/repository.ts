import type { HmpMySQL, HmpMySQLMigration, HmpMySQLTransaction } from "../../hmp-mysql/types";
import type { HmpDuelMatchRecord, HmpDuelStanding } from "../types";
import type { DuelRepository, MatchDecision, MatchDraft, RatingRow } from "./internal";

interface RatingDbRow {
    character_id: number | string;
    character_name?: string;
    rating: number | string;
    wins: number | string;
    losses: number | string;
    streak: number | string;
    best_streak: number | string;
}

interface MatchDbRow {
    id: number | string;
    reference_id: string;
    winner_character_id: number | string | null;
    loser_character_id: number | string | null;
    winner_name: string | null;
    loser_name: string | null;
    reason: string;
    rated: number | string | boolean;
    winner_before: number | string | null;
    winner_after: number | string | null;
    loser_before: number | string | null;
    loser_after: number | string | null;
    created_at: string | Date;
}

function safeInteger(value: number | string, label: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the JavaScript safe integer range`);
    return result;
}

function nullableInteger(value: number | string | null, label: string): number | null {
    return value === null || value === undefined ? null : safeInteger(value, label);
}

function mapRating(row: RatingDbRow): RatingRow {
    return {
        characterId: safeInteger(row.character_id, "duel character id"),
        rating: safeInteger(row.rating, "duel rating"),
        wins: safeInteger(row.wins, "duel wins"),
        losses: safeInteger(row.losses, "duel losses"),
        streak: safeInteger(row.streak, "duel streak"),
        bestStreak: safeInteger(row.best_streak, "duel best streak"),
    };
}

function mapStanding(row: RatingDbRow, rank: number | null): HmpDuelStanding {
    const rating = mapRating(row);
    return { ...rating, name: String(row.character_name || ""), matches: rating.wins + rating.losses, rank };
}

function side(before: number | string | null, after: number | string | null, label: string) {
    const from = nullableInteger(before, `${label} rating before`);
    const to = nullableInteger(after, `${label} rating after`);
    return from === null || to === null ? null : { before: from, after: to, delta: to - from };
}

function mapMatch(row: MatchDbRow): HmpDuelMatchRecord {
    return {
        id: safeInteger(row.id, "duel match id"),
        reference: row.reference_id,
        winnerCharacterId: nullableInteger(row.winner_character_id, "duel winner id"),
        loserCharacterId: nullableInteger(row.loser_character_id, "duel loser id"),
        winnerName: String(row.winner_name || ""),
        loserName: String(row.loser_name || ""),
        reason: row.reason,
        rated: row.rated === true || Number(row.rated) === 1,
        winner: side(row.winner_before, row.winner_after, "winner"),
        loser: side(row.loser_before, row.loser_after, "loser"),
        createdAt: row.created_at,
    };
}

const MATCH_SELECT = `SELECT duel.*, winner_row.name AS winner_name, loser_row.name AS loser_name
    FROM hmp_duel_matches duel
    LEFT JOIN hmp_characters winner_row ON winner_row.id = duel.winner_character_id
    LEFT JOIN hmp_characters loser_row ON loser_row.id = duel.loser_character_id`;

// LIMIT is written into the statement, as the other Foundations repositories do, so it must be a small integer.
function limitOf(value: number): number {
    const limit = Math.floor(Number(value));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("A duel listing limit must be between 1 and 50");
    return limit;
}

function createRepository(database: HmpMySQL): DuelRepository {
    if (!database || typeof database.transaction !== "function") throw new TypeError("database API is required");

    async function matchByReference(tx: HmpMySQLTransaction, reference: string): Promise<HmpDuelMatchRecord | null> {
        const row = await tx.single<MatchDbRow>(`${MATCH_SELECT} WHERE duel.reference_id = ?`, [reference]);
        return row ? mapMatch(row) : null;
    }

    async function record(draft: MatchDraft, initialRating: number, repeatWindowMinutes: number, decide: (winner: RatingRow, loser: RatingRow, recentRated: number) => MatchDecision): Promise<HmpDuelMatchRecord> {
        return database.transaction(async (tx) => {
            // The activity session id is the reference, so a duel finished twice is recorded once.
            const existing = await matchByReference(tx, draft.reference);
            if (existing) return existing;
            const winnerId = draft.winner.characterId, loserId = draft.loser.characterId;
            await tx.update("INSERT IGNORE INTO hmp_duel_ratings (character_id, rating) VALUES (?, ?), (?, ?)", [winnerId, initialRating, loserId, initialRating]);
            // Both rows are locked in id order, so two duels sharing a character cannot deadlock each other.
            const rows = await tx.query<RatingDbRow[]>("SELECT * FROM hmp_duel_ratings WHERE character_id IN (?, ?) ORDER BY character_id FOR UPDATE", [winnerId, loserId]);
            const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [safeInteger(row.character_id, "duel character id"), mapRating(row)]));
            const winner = byId.get(winnerId), loser = byId.get(loserId);
            if (!winner || !loser) throw new Error("A duel rating row is missing");
            const low = Math.min(winnerId, loserId), high = Math.max(winnerId, loserId);
            const recentRated = Number(await tx.scalar(
                `SELECT COUNT(*) FROM hmp_duel_matches
                 WHERE low_character_id = ? AND high_character_id = ? AND rated = 1
                   AND created_at >= CURRENT_TIMESTAMP - INTERVAL ? MINUTE`,
                [low, high, repeatWindowMinutes],
            )) || 0;
            const decision = decide(winner, loser, recentRated);
            if (decision.rated) {
                for (const row of [decision.winner, decision.loser]) {
                    await tx.update(
                        "UPDATE hmp_duel_ratings SET rating = ?, wins = ?, losses = ?, streak = ?, best_streak = ? WHERE character_id = ?",
                        [row.rating, row.wins, row.losses, row.streak, row.bestStreak, row.characterId],
                    );
                }
            }
            await tx.insert(
                `INSERT INTO hmp_duel_matches
                    (reference_id, winner_character_id, loser_character_id, low_character_id, high_character_id, reason, rated,
                     winner_before, winner_after, loser_before, loser_after)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    draft.reference, winnerId, loserId, low, high, draft.reason, decision.rated ? 1 : 0,
                    decision.rated ? winner.rating : null, decision.rated ? decision.winner.rating : null,
                    decision.rated ? loser.rating : null, decision.rated ? decision.loser.rating : null,
                ],
            );
            const stored = await matchByReference(tx, draft.reference);
            if (!stored) throw new Error("The duel match was not stored");
            return stored;
        });
    }

    async function standing(characterId: number, minimumMatches: number): Promise<HmpDuelStanding | null> {
        const row = await database.single<RatingDbRow>(
            `SELECT rating_row.*, character_row.name AS character_name
             FROM hmp_duel_ratings rating_row
             JOIN hmp_characters character_row ON character_row.id = rating_row.character_id
             WHERE rating_row.character_id = ?`,
            [characterId],
        );
        if (!row) return null;
        const mapped = mapRating(row);
        if (mapped.wins + mapped.losses < minimumMatches || mapped.wins + mapped.losses === 0) return mapStanding(row, null);
        // Ties share a rank; a character ranks only once it has played the minimum.
        const above = Number(await database.scalar(
            "SELECT COUNT(*) FROM hmp_duel_ratings WHERE rating > ? AND wins + losses >= ? AND wins + losses > 0",
            [mapped.rating, minimumMatches],
        )) || 0;
        return mapStanding(row, above + 1);
    }

    async function leaderboard(limit: number, minimumMatches: number): Promise<HmpDuelStanding[]> {
        const rows = await database.query<RatingDbRow[]>(
            `SELECT rating_row.*, character_row.name AS character_name
             FROM hmp_duel_ratings rating_row
             JOIN hmp_characters character_row ON character_row.id = rating_row.character_id
             WHERE rating_row.wins + rating_row.losses >= ? AND rating_row.wins + rating_row.losses > 0
             ORDER BY rating_row.rating DESC, rating_row.wins DESC, rating_row.character_id ASC
             LIMIT ${limitOf(limit)}`,
            [minimumMatches],
        );
        let rank = 0, previous: number | null = null;
        return (Array.isArray(rows) ? rows : []).map((row, index) => {
            const rating = safeInteger(row.rating, "duel rating");
            if (rating !== previous) { rank = index + 1; previous = rating; }
            return mapStanding(row, rank);
        });
    }

    async function history(characterId: number, limit: number): Promise<HmpDuelMatchRecord[]> {
        const rows = await database.query<MatchDbRow[]>(
            `${MATCH_SELECT} WHERE duel.winner_character_id = ? OR duel.loser_character_id = ? ORDER BY duel.id DESC LIMIT ${limitOf(limit)}`,
            [characterId, characterId],
        );
        return (Array.isArray(rows) ? rows : []).map(mapMatch);
    }

    return {
        migrate: async (migrations: HmpMySQLMigration[]) => { await database.migrate("hmp-duels", migrations); },
        record,
        standing,
        leaderboard,
        history,
    };
}

export = { createRepository };

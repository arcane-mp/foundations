import type { HmpMySQLMigration, HmpMySQLTransaction } from "../../hmp-mysql/types";
import type { HmpManagedTalent, HmpProgressionProfile, HmpProgressionRewardTransaction } from "../types";
import type { Database, ProgressionRepository, RewardDraft, TalentMutation } from "./internal";

interface ProfileRow {
    character_id: number | string; experience_points: number | string; native_level: number | string;
    talent_points: number | string; revision: number | string; applied_revision: number | string;
    created_at: string | Date; updated_at: string | Date;
}
interface RewardRow {
    id: number | string; reference_id: string; character_id: number | string; operation: "add" | "set";
    amount: number | string; balance_before: number | string | null; balance_after: number | string | null;
    actor_character_id: number | string | null; source_resource: string; reason_text: string;
    metadata_json: string | null; status: "pending" | "completed" | "failed"; error_text: string;
    created_at: string | Date; completed_at: string | Date | null;
}
interface TalentRow {
    character_id: number | string; talent_id: string; talent_level: number | string; status: "owned" | "revoked";
    acquisition: "grant" | "purchase"; actor_character_id: number | string | null; source_resource: string;
    reason_text: string; created_at: string | Date; updated_at: string | Date;
}

function integer(value: number | string, label: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the JavaScript safe integer range`);
    return result;
}
function parseMetadata(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try { const value: unknown = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
    catch { return {}; }
}
function mapProfile(row: ProfileRow): HmpProgressionProfile {
    return {
        characterId: integer(row.character_id, "progression character id"),
        experiencePoints: integer(row.experience_points, "experience points"),
        level: integer(row.native_level, "native level"),
        talentPoints: integer(row.talent_points, "talent points"),
        revision: integer(row.revision, "progression revision"),
        appliedRevision: integer(row.applied_revision, "applied progression revision"),
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}
function mapReward(row: RewardRow): HmpProgressionRewardTransaction {
    return {
        id: integer(row.id, "progression reward id"), reference: row.reference_id,
        characterId: integer(row.character_id, "progression reward character id"), operation: row.operation,
        amount: integer(row.amount, "progression reward amount"),
        balanceBefore: row.balance_before === null ? null : integer(row.balance_before, "progression balance before"),
        balanceAfter: row.balance_after === null ? null : integer(row.balance_after, "progression balance after"),
        actorCharacterId: row.actor_character_id === null ? null : integer(row.actor_character_id, "progression actor id"),
        resource: row.source_resource, reason: row.reason_text || "", metadata: parseMetadata(row.metadata_json),
        status: row.status, error: row.error_text || "", createdAt: row.created_at, completedAt: row.completed_at,
    };
}
function mapTalent(row: TalentRow): HmpManagedTalent {
    return {
        characterId: integer(row.character_id, "talent character id"), talentId: row.talent_id,
        level: integer(row.talent_level, "talent level"), status: row.status, acquisition: row.acquisition,
        actorCharacterId: row.actor_character_id === null ? null : integer(row.actor_character_id, "talent actor id"),
        resource: row.source_resource, reason: row.reason_text || "", createdAt: row.created_at, updatedAt: row.updated_at,
    };
}

function createRepository(database: Database): ProgressionRepository {
    if (!database || typeof database.transaction !== "function") throw new TypeError("database API is required");

    async function ensureProfile(tx: HmpMySQLTransaction, characterId: number): Promise<void> {
        await tx.update("INSERT IGNORE INTO hmp_progression_profiles (character_id) VALUES (?)", [characterId]);
    }
    async function profile(characterId: number, tx: HmpMySQLTransaction = database, lock = false): Promise<HmpProgressionProfile> {
        await ensureProfile(tx, characterId);
        const row = await tx.single<ProfileRow>(`SELECT * FROM hmp_progression_profiles WHERE character_id = ?${lock ? " FOR UPDATE" : ""}`, [characterId]);
        if (!row) throw new Error(`progression profile for character ${characterId} could not be initialized`);
        return mapProfile(row);
    }
    async function reward(reference: string, tx: HmpMySQLTransaction = database, lock = false): Promise<HmpProgressionRewardTransaction | null> {
        const row = await tx.single<RewardRow>(`SELECT * FROM hmp_progression_rewards WHERE reference_id = ?${lock ? " FOR UPDATE" : ""}`, [reference]);
        return row ? mapReward(row) : null;
    }
    async function beginReward(draft: RewardDraft): Promise<{ created: boolean; transaction: HmpProgressionRewardTransaction }> {
        const created = (await database.update(
            `INSERT IGNORE INTO hmp_progression_rewards
                (reference_id, character_id, operation, amount, actor_character_id, source_resource, reason_text, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [draft.reference, draft.characterId, draft.operation, draft.amount, draft.actorCharacterId, draft.resource, draft.reason, JSON.stringify(draft.metadata)],
        )) > 0;
        const transaction = await reward(draft.reference);
        if (!transaction) throw new Error(`progression reward '${draft.reference}' was not found`);
        return { created, transaction };
    }
    async function applyReward(referenceId: string, maximumExperience: number): Promise<HmpProgressionRewardTransaction> {
        return database.transaction(async (tx) => {
            const transaction = await reward(referenceId, tx, true);
            if (!transaction) throw new Error(`progression reward '${referenceId}' was not found`);
            if (transaction.status === "completed") return transaction;
            if (transaction.status === "failed") throw new Error(`progression reward '${referenceId}' failed: ${transaction.error}`);
            const current = await profile(transaction.characterId, tx, true);
            const next = transaction.operation === "set" ? transaction.amount : current.experiencePoints + transaction.amount;
            if (!Number.isSafeInteger(next) || next < 0 || next > maximumExperience) throw new Error(`experience balance must remain between 0 and ${maximumExperience}`);
            await tx.update("UPDATE hmp_progression_profiles SET experience_points = ?, revision = revision + 1 WHERE character_id = ?", [next, transaction.characterId]);
            await tx.update("UPDATE hmp_progression_rewards SET status = 'completed', balance_before = ?, balance_after = ?, completed_at = CURRENT_TIMESTAMP WHERE reference_id = ?", [current.experiencePoints, next, referenceId]);
            return (await reward(referenceId, tx, true))!;
        });
    }
    async function failReward(referenceId: string, error: string): Promise<HmpProgressionRewardTransaction> {
        await database.update("UPDATE hmp_progression_rewards SET status = 'failed', error_text = ?, completed_at = CURRENT_TIMESTAMP WHERE reference_id = ? AND status = 'pending'", [String(error || "unknown error").slice(0, 191), referenceId]);
        const transaction = await reward(referenceId);
        if (!transaction) throw new Error(`progression reward '${referenceId}' was not found`);
        return transaction;
    }
    async function rewardHistory(characterId: number, limit: number): Promise<HmpProgressionRewardTransaction[]> {
        return (await database.query<RewardRow[]>(`SELECT * FROM hmp_progression_rewards WHERE character_id = ? ORDER BY id DESC LIMIT ${limit}`, [characterId])).map(mapReward);
    }
    async function pendingRewards(limit: number): Promise<HmpProgressionRewardTransaction[]> {
        return (await database.query<RewardRow[]>(`SELECT * FROM hmp_progression_rewards WHERE status = 'pending' ORDER BY id LIMIT ${limit}`)).map(mapReward);
    }
    async function acknowledge(characterId: number, revision: number, level: number, talentPoints: number): Promise<HmpProgressionProfile> {
        await database.update(
            "UPDATE hmp_progression_profiles SET native_level = ?, talent_points = ?, applied_revision = ? WHERE character_id = ? AND revision = ? AND applied_revision <= ?",
            [level, talentPoints, revision, characterId, revision, revision],
        );
        return profile(characterId);
    }
    async function talents(characterId: number, includeRevoked: boolean): Promise<HmpManagedTalent[]> {
        const rows = await database.query<TalentRow[]>(`SELECT * FROM hmp_progression_talents WHERE character_id = ?${includeRevoked ? "" : " AND status = 'owned'"} ORDER BY talent_id`, [characterId]);
        return rows.map(mapTalent);
    }
    async function talent(characterId: number, talentId: string, tx: HmpMySQLTransaction = database, lock = false): Promise<HmpManagedTalent | null> {
        const row = await tx.single<TalentRow>(`SELECT * FROM hmp_progression_talents WHERE character_id = ? AND talent_id = ?${lock ? " FOR UPDATE" : ""}`, [characterId, talentId]);
        return row ? mapTalent(row) : null;
    }
    async function writeTalent(tx: HmpMySQLTransaction, mutation: TalentMutation): Promise<void> {
        await tx.update(
            `INSERT INTO hmp_progression_talents
                (character_id, talent_id, talent_level, status, acquisition, actor_character_id, source_resource, reason_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE talent_level = VALUES(talent_level), status = VALUES(status), acquisition = VALUES(acquisition), actor_character_id = VALUES(actor_character_id), source_resource = VALUES(source_resource), reason_text = VALUES(reason_text)`,
            [mutation.characterId, mutation.talentId, mutation.level, mutation.status, mutation.acquisition, mutation.actorCharacterId, mutation.resource, mutation.reason],
        );
    }
    async function mutateTalent(mutation: TalentMutation): Promise<HmpManagedTalent> {
        return database.transaction(async (tx) => {
            await profile(mutation.characterId, tx, true);
            await writeTalent(tx, mutation);
            await tx.update("UPDATE hmp_progression_profiles SET revision = revision + 1 WHERE character_id = ?", [mutation.characterId]);
            return (await talent(mutation.characterId, mutation.talentId, tx, true))!;
        });
    }
    async function purchaseTalent(mutation: TalentMutation): Promise<HmpManagedTalent> {
        return database.transaction(async (tx) => {
            const existing = await talent(mutation.characterId, mutation.talentId, tx, true);
            if (existing?.status === "owned") return existing;
            const current = await profile(mutation.characterId, tx, true);
            if (current.talentPoints < 1) throw new Error("No Foundations talent points are available");
            await writeTalent(tx, { ...mutation, status: "owned", acquisition: "purchase" });
            await tx.update("UPDATE hmp_progression_profiles SET talent_points = talent_points - 1, revision = revision + 1 WHERE character_id = ?", [mutation.characterId]);
            return (await talent(mutation.characterId, mutation.talentId, tx, true))!;
        });
    }
    async function resetTalents(characterId: number, mutation: Omit<TalentMutation, "characterId" | "talentId" | "level" | "status" | "acquisition">): Promise<number> {
        return database.transaction(async (tx) => {
            await profile(characterId, tx, true);
            const changed = await tx.update(
                "UPDATE hmp_progression_talents SET status = 'revoked', actor_character_id = ?, source_resource = ?, reason_text = ? WHERE character_id = ? AND status = 'owned'",
                [mutation.actorCharacterId, mutation.resource, mutation.reason, characterId],
            );
            if (changed > 0) await tx.update("UPDATE hmp_progression_profiles SET revision = revision + 1 WHERE character_id = ?", [characterId]);
            return changed;
        });
    }
    async function setTalentPoints(characterId: number, points: number): Promise<HmpProgressionProfile> {
        return database.transaction(async (tx) => {
            const current = await profile(characterId, tx, true);
            if (current.talentPoints !== points) await tx.update("UPDATE hmp_progression_profiles SET talent_points = ?, revision = revision + 1 WHERE character_id = ?", [points, characterId]);
            return profile(characterId, tx, true);
        });
    }

    async function flooFlames(characterId: number): Promise<string[]> {
        const rows = await database.query<Array<{ destination_id: string }>>("SELECT destination_id FROM hmp_progression_floo_flames WHERE character_id = ? ORDER BY destination_id", [characterId]);
        return rows.map((row) => row.destination_id);
    }
    async function lightFlooFlames(characterId: number, ids: string[]): Promise<number> {
        if (!ids.length) return 0;
        return database.update(
            `INSERT IGNORE INTO hmp_progression_floo_flames (character_id, destination_id) VALUES ${ids.map(() => "(?, ?)").join(", ")}`,
            ids.flatMap((id) => [characterId, id]),
        );
    }
    async function dimFlooFlames(characterId: number, ids: string[]): Promise<number> {
        if (!ids.length) return 0;
        return database.update(`DELETE FROM hmp_progression_floo_flames WHERE character_id = ? AND destination_id IN (${ids.map(() => "?").join(", ")})`, [characterId, ...ids]);
    }

    async function fieldGuide(characterId: number): Promise<string | null> {
        const row = await database.single<{ snapshot_json: string }>("SELECT snapshot_json FROM hmp_progression_field_guides WHERE character_id = ?", [characterId]);
        return row ? row.snapshot_json : null;
    }
    async function saveFieldGuide(characterId: number, snapshotJson: string): Promise<void> {
        await database.update(
            "INSERT INTO hmp_progression_field_guides (character_id, snapshot_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE snapshot_json = VALUES(snapshot_json)",
            [characterId, snapshotJson],
        );
    }

    return Object.freeze({
        migrate: (migrations: HmpMySQLMigration[]) => database.migrate("hmp-progression", migrations),
        profile, reward, beginReward, applyReward, failReward, rewardHistory, pendingRewards, acknowledge,
        talents, talent, mutateTalent, purchaseTalent, resetTalents, setTalentPoints,
        flooFlames, lightFlooFlames, dimFlooFlames, fieldGuide, saveFieldGuide,
    });
}

export = { createRepository, mapProfile, mapReward, mapTalent };

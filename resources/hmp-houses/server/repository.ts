import normalizeModule = require("../shared/normalize");
import type { HmpMySQLMigration, HmpMySQLTransaction } from "../../hmp-mysql/types";
import type { HmpHouseId, HmpHouseMembership, HmpHouseMembershipAudit, HmpHousePointTransaction, HmpHouseStanding } from "../types";
import type { Database, HousesRepository, MembershipMutation, PointDraft, PointFilter } from "./internal";

const { house: normalizeHouse } = normalizeModule;

interface MembershipRow {
    character_id: number | string;
    character_name: string;
    house_id: string;
    assigned_by_character_id: number | string | null;
    source_resource: string;
    reason_text: string;
    created_at: string | Date;
    updated_at: string | Date;
}

interface MembershipAuditRow {
    id: number | string;
    character_id: number | string;
    from_house_id: string | null;
    to_house_id: string | null;
    actor_character_id: number | string | null;
    source_resource: string;
    reason_text: string;
    created_at: string | Date;
}

interface StandingRow { house_id: string; points: number | string; updated_at: string | Date }
interface PointRow {
    id: number | string;
    reference_id: string;
    house_id: string;
    amount: number | string;
    balance_after: number | string | null;
    actor_character_id: number | string | null;
    source_resource: string;
    reason_text: string;
    metadata_json: string | null;
    status: "pending" | "completed" | "failed";
    error_text: string;
    created_at: string | Date;
    completed_at: string | Date | null;
}

const MEMBERSHIP_SELECT = `SELECT membership.*, character_row.name AS character_name
    FROM hmp_house_memberships membership
    JOIN hmp_characters character_row ON character_row.id = membership.character_id`;

function safeInteger(value: number | string, label: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the JavaScript safe integer range`);
    return result;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
        const value: unknown = JSON.parse(raw);
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
}

function mapMembership(row: MembershipRow): HmpHouseMembership {
    return {
        characterId: safeInteger(row.character_id, "house character id"),
        characterName: row.character_name,
        house: normalizeHouse(row.house_id),
        assignedByCharacterId: row.assigned_by_character_id === null ? null : safeInteger(row.assigned_by_character_id, "house actor id"),
        resource: row.source_resource,
        reason: row.reason_text || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapMembershipAudit(row: MembershipAuditRow): HmpHouseMembershipAudit {
    return {
        id: safeInteger(row.id, "house membership audit id"),
        characterId: safeInteger(row.character_id, "house membership audit character id"),
        fromHouse: row.from_house_id ? normalizeHouse(row.from_house_id) : null,
        toHouse: row.to_house_id ? normalizeHouse(row.to_house_id) : null,
        actorCharacterId: row.actor_character_id === null ? null : safeInteger(row.actor_character_id, "house membership audit actor id"),
        resource: row.source_resource,
        reason: row.reason_text || "",
        createdAt: row.created_at,
    };
}

function mapStanding(row: StandingRow): HmpHouseStanding {
    return { house: normalizeHouse(row.house_id), points: safeInteger(row.points, "house points"), updatedAt: row.updated_at };
}

function mapPoint(row: PointRow): HmpHousePointTransaction {
    return {
        id: safeInteger(row.id, "house point transaction id"),
        reference: row.reference_id,
        house: normalizeHouse(row.house_id),
        amount: safeInteger(row.amount, "house point amount"),
        balanceAfter: row.balance_after === null ? null : safeInteger(row.balance_after, "house point balance"),
        actorCharacterId: row.actor_character_id === null ? null : safeInteger(row.actor_character_id, "house point actor id"),
        resource: row.source_resource,
        reason: row.reason_text || "",
        metadata: parseMetadata(row.metadata_json),
        status: row.status,
        error: row.error_text || "",
        createdAt: row.created_at,
        completedAt: row.completed_at,
    };
}

function createRepository(database: Database): HousesRepository {
    if (!database || typeof database.transaction !== "function") throw new TypeError("database API is required");

    async function membershipWith(tx: HmpMySQLTransaction, characterId: number, lock = false): Promise<HmpHouseMembership | null> {
        const row = await tx.single<MembershipRow>(`${MEMBERSHIP_SELECT} WHERE membership.character_id = ?${lock ? " FOR UPDATE" : ""}`, [characterId]);
        return row ? mapMembership(row) : null;
    }

    async function membership(characterId: number): Promise<HmpHouseMembership | null> {
        return membershipWith(database, characterId);
    }

    async function insertMembershipAudit(tx: HmpMySQLTransaction, characterId: number, fromHouse: HmpHouseId | null, toHouse: HmpHouseId | null, actorCharacterId: number | null, resource: string, reason: string): Promise<void> {
        await tx.insert(
            `INSERT INTO hmp_house_membership_audit
                (character_id, from_house_id, to_house_id, actor_character_id, source_resource, reason_text)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [characterId, fromHouse, toHouse, actorCharacterId, resource, reason],
        );
    }

    async function setMembership(mutation: MembershipMutation): Promise<{ membership: HmpHouseMembership; previousHouse: HmpHouseId | null }> {
        return database.transaction(async (tx) => {
            const existing = await membershipWith(tx, mutation.characterId, true);
            if (existing?.house === mutation.house) return { membership: existing, previousHouse: existing.house };
            await tx.update(
                `INSERT INTO hmp_house_memberships
                    (character_id, house_id, assigned_by_character_id, source_resource, reason_text)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE house_id = VALUES(house_id), assigned_by_character_id = VALUES(assigned_by_character_id), source_resource = VALUES(source_resource), reason_text = VALUES(reason_text)`,
                [mutation.characterId, mutation.house, mutation.actorCharacterId, mutation.resource, mutation.reason],
            );
            await insertMembershipAudit(tx, mutation.characterId, existing?.house || null, mutation.house, mutation.actorCharacterId, mutation.resource, mutation.reason);
            const result = await membershipWith(tx, mutation.characterId, true);
            if (!result) throw new Error("house membership could not be written");
            return { membership: result, previousHouse: existing?.house || null };
        });
    }

    async function clearMembership(characterId: number, actorCharacterId: number | null, resource: string, reason: string): Promise<HmpHouseId | null> {
        return database.transaction(async (tx) => {
            const existing = await membershipWith(tx, characterId, true);
            if (!existing) return null;
            await tx.update("DELETE FROM hmp_house_memberships WHERE character_id = ?", [characterId]);
            await insertMembershipAudit(tx, characterId, existing.house, null, actorCharacterId, resource, reason);
            return existing.house;
        });
    }

    async function members(house: HmpHouseId, limit: number): Promise<HmpHouseMembership[]> {
        const rows = await database.query<MembershipRow[]>(`${MEMBERSHIP_SELECT} WHERE membership.house_id = ? ORDER BY character_row.name, membership.character_id LIMIT ${limit}`, [house]);
        return rows.map(mapMembership);
    }

    async function membershipHistory(characterId: number, limit: number): Promise<HmpHouseMembershipAudit[]> {
        const rows = await database.query<MembershipAuditRow[]>("SELECT * FROM hmp_house_membership_audit WHERE character_id = ? ORDER BY id DESC LIMIT " + limit, [characterId]);
        return rows.map(mapMembershipAudit);
    }

    async function standing(house: HmpHouseId, tx: HmpMySQLTransaction = database, lock = false): Promise<HmpHouseStanding> {
        const row = await tx.single<StandingRow>(`SELECT * FROM hmp_house_standings WHERE house_id = ?${lock ? " FOR UPDATE" : ""}`, [house]);
        if (!row) throw new Error(`house standing '${house}' was not initialized`);
        return mapStanding(row);
    }

    async function standings(): Promise<HmpHouseStanding[]> {
        const rows = await database.query<StandingRow[]>("SELECT * FROM hmp_house_standings ORDER BY house_id");
        return rows.map(mapStanding);
    }

    async function pointTransaction(reference: string, tx: HmpMySQLTransaction = database, lock = false): Promise<HmpHousePointTransaction | null> {
        const row = await tx.single<PointRow>(`SELECT * FROM hmp_house_point_transactions WHERE reference_id = ?${lock ? " FOR UPDATE" : ""}`, [reference]);
        return row ? mapPoint(row) : null;
    }

    async function beginPoint(draft: PointDraft): Promise<{ created: boolean; transaction: HmpHousePointTransaction }> {
        const created = (await database.update(
            `INSERT IGNORE INTO hmp_house_point_transactions
                (reference_id, house_id, amount, actor_character_id, source_resource, reason_text, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [draft.reference, draft.house, draft.amount, draft.actorCharacterId, draft.resource, draft.reason, JSON.stringify(draft.metadata)],
        )) > 0;
        const transaction = await pointTransaction(draft.reference);
        if (!transaction) throw new Error(`house point transaction '${draft.reference}' was not found`);
        return { created, transaction };
    }

    async function applyPoint(reference: string, allowNegative: boolean): Promise<HmpHousePointTransaction> {
        return database.transaction(async (tx) => {
            const transaction = await pointTransaction(reference, tx, true);
            if (!transaction) throw new Error(`house point transaction '${reference}' was not found`);
            if (transaction.status === "completed") return transaction;
            if (transaction.status === "failed") throw new Error(`house point transaction '${reference}' failed: ${transaction.error}`);
            const current = await standing(transaction.house, tx, true);
            const next = current.points + transaction.amount;
            if (!Number.isSafeInteger(next)) throw new Error("house point balance would exceed the JavaScript safe integer range");
            if (!allowNegative && next < 0) throw new Error(`${transaction.house} cannot have a negative House Cup balance`);
            await tx.update("UPDATE hmp_house_standings SET points = ? WHERE house_id = ?", [next, transaction.house]);
            await tx.update("UPDATE hmp_house_point_transactions SET status = 'completed', balance_after = ?, completed_at = CURRENT_TIMESTAMP WHERE reference_id = ?", [next, reference]);
            return (await pointTransaction(reference, tx, true))!;
        });
    }

    async function failPoint(reference: string, error: string): Promise<HmpHousePointTransaction> {
        await database.update(
            "UPDATE hmp_house_point_transactions SET status = 'failed', error_text = ?, completed_at = CURRENT_TIMESTAMP WHERE reference_id = ? AND status = 'pending'",
            [String(error || "unknown error").slice(0, 191), reference],
        );
        const transaction = await pointTransaction(reference);
        if (!transaction) throw new Error(`house point transaction '${reference}' was not found`);
        return transaction;
    }

    function pointWhere(clauses: string[], values: Array<string | number>, house: HmpHouseId | undefined, filter: PointFilter): string {
        if (house) { clauses.push("house_id = ?"); values.push(house); }
        if (filter.resource) { clauses.push("source_resource = ?"); values.push(filter.resource); }
        // An age on the database's own clock: created_at is a TIMESTAMP read in the session's time zone,
        // which the driver's timezone option does not have to match.
        if (filter.ageSeconds !== undefined) { clauses.push("created_at >= CURRENT_TIMESTAMP - INTERVAL ? SECOND"); values.push(filter.ageSeconds); }
        return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    }

    async function pointHistory(house: HmpHouseId | undefined, limit: number, filter: PointFilter = {}): Promise<HmpHousePointTransaction[]> {
        const values: Array<string | number> = [];
        const rows = await database.query<PointRow[]>(`SELECT * FROM hmp_house_point_transactions${pointWhere([], values, house, filter)} ORDER BY id DESC LIMIT ${limit}`, values);
        return rows.map(mapPoint);
    }

    async function pointTotal(house: HmpHouseId, filter: PointFilter = {}): Promise<number> {
        const values: Array<string | number> = [];
        const total = await database.scalar<number | string>(`SELECT COALESCE(SUM(amount), 0) FROM hmp_house_point_transactions${pointWhere(["status <> 'failed'"], values, house, filter)}`, values);
        return safeInteger(total ?? 0, "house point total");
    }

    async function pendingPoints(limit: number): Promise<HmpHousePointTransaction[]> {
        const rows = await database.query<PointRow[]>(`SELECT * FROM hmp_house_point_transactions WHERE status = 'pending' ORDER BY id LIMIT ${limit}`);
        return rows.map(mapPoint);
    }

    return Object.freeze({
        migrate: (migrations: HmpMySQLMigration[]) => database.migrate("hmp-houses", migrations),
        membership, setMembership, clearMembership, members, membershipHistory,
        standing, standings, pointTransaction, beginPoint, applyPoint, failPoint, pointHistory, pointTotal, pendingPoints,
    });
}

export = { createRepository, mapMembership, mapMembershipAudit, mapStanding, mapPoint };

import type { HmpCoreCharacter } from "../hmp-core/types";

export type HmpHouseId = "gryffindor" | "hufflepuff" | "ravenclaw" | "slytherin";
export type HmpNativeHouse = "Gryffindor" | "Hufflepuff" | "Ravenclaw" | "Slytherin" | "Unaffiliated";

export interface HmpHousePlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    house?: HmpNativeHouse;
    /** Absent on a host older than `player.commonRooms`. */
    commonRooms?: Array<Exclude<HmpNativeHouse, "Unaffiliated">>;
    sendChat?(message: string): void;
}

export interface HmpHouseMembership {
    characterId: number;
    characterName: string;
    house: HmpHouseId;
    assignedByCharacterId: number | null;
    resource: string;
    reason: string;
    createdAt: string | Date;
    updatedAt: string | Date;
}

export interface HmpHouseMembershipAudit {
    id: number;
    characterId: number;
    fromHouse: HmpHouseId | null;
    toHouse: HmpHouseId | null;
    actorCharacterId: number | null;
    resource: string;
    reason: string;
    createdAt: string | Date;
}

export interface HmpHouseMutationOptions<P = HmpHousePlayer> {
    resource: string;
    actor?: P | number | null;
    reason?: string;
}

export interface HmpHouseMembershipApi<P = HmpHousePlayer> {
    get(target: P | number): Promise<HmpHouseMembership | null>;
    set(target: P | number, house: HmpHouseId, options: HmpHouseMutationOptions<P>): Promise<HmpHouseMembership>;
    clear(target: P | number, options: HmpHouseMutationOptions<P>): Promise<boolean>;
    members(house: HmpHouseId, limit?: number): Promise<HmpHouseMembership[]>;
    history(characterId: number, limit?: number): Promise<HmpHouseMembershipAudit[]>;
    sync(player: P): Promise<HmpHouseMembership | null>;
}

export interface HmpHouseStanding {
    house: HmpHouseId;
    points: number;
    updatedAt: string | Date;
}

export interface HmpHousePointTransaction {
    id: number;
    reference: string;
    house: HmpHouseId;
    amount: number;
    balanceAfter: number | null;
    actorCharacterId: number | null;
    resource: string;
    reason: string;
    metadata: Record<string, unknown>;
    status: "pending" | "completed" | "failed";
    error: string;
    createdAt: string | Date;
    completedAt: string | Date | null;
}

export interface HmpHousePointOptions<P = HmpHousePlayer> {
    reference: string;
    resource: string;
    actor?: P | number | null;
    reason?: string;
    metadata?: Record<string, unknown>;
}

export interface HmpHousePointsApi<P = HmpHousePlayer> {
    get(house: HmpHouseId): Promise<HmpHouseStanding>;
    standings(): Promise<HmpHouseStanding[]>;
    adjust(house: HmpHouseId, signedAmount: number, options: HmpHousePointOptions<P>): Promise<HmpHousePointTransaction>;
    award(house: HmpHouseId, amount: number, options: HmpHousePointOptions<P>): Promise<HmpHousePointTransaction>;
    deduct(house: HmpHouseId, amount: number, options: HmpHousePointOptions<P>): Promise<HmpHousePointTransaction>;
    transaction(reference: string): Promise<HmpHousePointTransaction | null>;
    history(house?: HmpHouseId, limit?: number): Promise<HmpHousePointTransaction[]>;
    pending(limit?: number): Promise<HmpHousePointTransaction[]>;
    recover(reference: string): Promise<HmpHousePointTransaction>;
}

/** Other houses' common rooms a character may enter besides their own, kept on the character. */
export interface HmpHouseCommonRoomsApi<P = HmpHousePlayer> {
    list(target: P | number): Promise<HmpHouseId[]>;
    grant(target: P | number, house: HmpHouseId): Promise<boolean>;
    revoke(target: P | number, house: HmpHouseId): Promise<boolean>;
    clear(target: P | number): Promise<number>;
    /** Applies the grants, or every common room for `commonRoomGroups`; null on a host without `player.commonRooms`. */
    sync(player: P): Promise<HmpHouseId[] | null>;
}

export interface HmpHousesStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    syncedPlayers: number;
    pendingTransactions: number;
    uptimeMs: number;
}

export interface HmpHouses<P = HmpHousePlayer> {
    membership: HmpHouseMembershipApi<P>;
    points: HmpHousePointsApi<P>;
    commonRooms: HmpHouseCommonRoomsApi<P>;
    status(): HmpHousesStatus;
}

export interface HmpHouseMembershipChangedEvent<P = HmpHousePlayer> {
    player: P | null;
    character: HmpCoreCharacter | null;
    membership: HmpHouseMembership | null;
    previousHouse: HmpHouseId | null;
}

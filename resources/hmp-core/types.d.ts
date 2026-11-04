export type HmpCoreTrust = "asserted" | "verified" | string;

export interface HmpCorePlayer {
    id: number;
    nickname?: string;
    steamId?: string;
    discordId?: string;
    hardwareId?: string;
    kick?(reason?: string): void;
}

export interface HmpCorePrincipal {
    provider: string;
    subject: string;
    trust: HmpCoreTrust;
}

export interface HmpCoreAccount {
    id: number;
    displayName: string;
    createdAt: string | Date;
    lastSeenAt: string | Date;
}

export interface HmpCoreCharacter {
    id: number;
    accountId: number;
    slot: number;
    name: string;
    status: "active" | "deleted" | string;
    createdAt: string | Date;
    updatedAt: string | Date;
    deletedAt: string | Date | null;
}

export interface HmpCoreSession<P extends HmpCorePlayer = HmpCorePlayer> {
    player: P;
    playerId: number;
    account: HmpCoreAccount;
    principal: HmpCorePrincipal;
    character: HmpCoreCharacter | null;
    connectedAt: string;
}

export interface HmpCoreIdentityProvider<P extends HmpCorePlayer = HmpCorePlayer> {
    name: string;
    /** Resource name, used to unregister the provider when that resource stops. */
    resource: string;
    /** Higher priorities resolve first. The built-in client-announced fallback is -1000. */
    priority?: number;
    trust?: HmpCoreTrust;
    resolve(player: P): HmpCorePrincipal | null | Promise<HmpCorePrincipal | null>;
}

export interface HmpCoreIdentityProviderInfo {
    name: string;
    resource: string;
    priority: number;
    trust: string;
}

export interface HmpCoreIdentityApi<P extends HmpCorePlayer = HmpCorePlayer> {
    register(provider: HmpCoreIdentityProvider<P>): () => boolean;
    unregister(name: string): boolean;
    list(): HmpCoreIdentityProviderInfo[];
    resolve(player: P): Promise<HmpCorePrincipal>;
}

export interface HmpCoreAccountsApi<P extends HmpCorePlayer = HmpCorePlayer> {
    getByPlayer(player: P | number): HmpCoreAccount | null;
    getById(accountId: number): Promise<HmpCoreAccount | null>;
    linkIdentity(accountId: number, principal: HmpCorePrincipal): Promise<boolean>;
}

export interface HmpCoreSessionsApi<P extends HmpCorePlayer = HmpCorePlayer> {
    get(player: P | number): HmpCoreSession<P> | null;
    all(): HmpCoreSession<P>[];
    isReady(player: P | number): boolean;
}

export interface HmpCoreCharactersApi<P extends HmpCorePlayer = HmpCorePlayer> {
    list(player: P | number): Promise<HmpCoreCharacter[]>;
    create(player: P | number, input: { name: string; slot?: number }): Promise<HmpCoreCharacter>;
    select(player: P | number, characterId: number): Promise<HmpCoreCharacter>;
    active(player: P | number): HmpCoreCharacter | null;
    unload(player: P | number): Promise<HmpCoreCharacter | null>;
    delete(player: P | number, characterId: number): Promise<boolean>;
    limit(): number;
}

export interface HmpCoreGroup {
    scope: "account" | "character";
    key: string;
    grade: number;
    metadata: Record<string, unknown>;
}

export interface HmpCoreGroupsApi<P extends HmpCorePlayer = HmpCorePlayer> {
    listAccount(accountId: number): Promise<HmpCoreGroup[]>;
    listCharacter(characterId: number): Promise<HmpCoreGroup[]>;
    effective(player: P | number): Promise<HmpCoreGroup[]>;
    has(player: P | number, key: string, minimumGrade?: number): Promise<boolean>;
    setAccount(accountId: number, key: string, grade: number, metadata?: Record<string, unknown>): Promise<HmpCoreGroup>;
    setCharacter(characterId: number, key: string, grade: number, metadata?: Record<string, unknown>): Promise<HmpCoreGroup>;
    removeAccount(accountId: number, key: string): Promise<boolean>;
    removeCharacter(characterId: number, key: string): Promise<boolean>;
}

export interface HmpCoreMetadataApi {
    getAccount<T = unknown>(accountId: number, key: string): Promise<T | undefined>;
    getCharacter<T = unknown>(characterId: number, key: string): Promise<T | undefined>;
    setAccount<T>(accountId: number, key: string, value: T): Promise<T>;
    setCharacter<T>(characterId: number, key: string, value: T): Promise<T>;
    deleteAccount(accountId: number, key: string): Promise<boolean>;
    deleteCharacter(characterId: number, key: string): Promise<boolean>;
}

/** A join a ticket redeemer is asked about, before the player takes a slot. Only `ticket` is not client-reported. */
export interface HmpCoreTicketConnection {
    /** The `ticket` of the `hogwartsmp://` link the player joined with; never empty when a redeemer is asked. */
    readonly ticket: string;
    readonly nickname: string;
    readonly steamId: string;
    readonly epicId: string;
    readonly discordId: string;
    readonly hardwareId: string;
    readonly ip: string;
}

export interface HmpCoreTicketRedeemer {
    name: string;
    /** Resource name, used to unregister the redeemer when that resource stops. */
    resource: string;
    /** Higher priorities are asked first. */
    priority?: number;
    /**
     * Any truthy value accepts the ticket and is kept as `HmpCoreTicket.result`, such as the account your site
     * issued it for; a falsy one, or a throw, leaves it to the next redeemer.
     */
    redeem(connection: HmpCoreTicketConnection): unknown;
}

export interface HmpCoreTicketRedeemerInfo {
    name: string;
    resource: string;
    priority: number;
}

/** A ticket a redeemer accepted for a player's join. */
export interface HmpCoreTicket {
    redeemer: string;
    /** What the redeemer returned. */
    result: unknown;
    /** True when the same join presented it again within `tickets.repeatSeconds` and the redeemers were not asked. */
    repeat: boolean;
}

export interface HmpCoreTicketsApi<P extends HmpCorePlayer = HmpCorePlayer> {
    register(redeemer: HmpCoreTicketRedeemer): () => boolean;
    unregister(name: string): boolean;
    list(): HmpCoreTicketRedeemerInfo[];
    /** The ticket this player's join was accepted with, from `playerConnect` until they leave; null when none was. */
    get(player: P | number): HmpCoreTicket | null;
    /** Whether joins without an accepted ticket are turned away: `tickets.required` on a host that passes tickets on. */
    required(): boolean;
}

export interface HmpCoreStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    sessions: number;
    identityProviders: number;
    uptimeMs: number;
}

export interface HmpCore<P extends HmpCorePlayer = HmpCorePlayer> {
    status(): HmpCoreStatus;
    identity: HmpCoreIdentityApi<P>;
    accounts: HmpCoreAccountsApi<P>;
    sessions: HmpCoreSessionsApi<P>;
    characters: HmpCoreCharactersApi<P>;
    groups: HmpCoreGroupsApi<P>;
    metadata: HmpCoreMetadataApi;
    tickets: HmpCoreTicketsApi<P>;
}

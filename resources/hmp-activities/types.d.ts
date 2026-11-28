import type { HmpCoreCharacter } from "../hmp-core/types";

export interface HmpActivityPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    virtualWorld?: number;
    location?(): { areaId: string; regionId: string } | null;
    sendChat?(message: string): void;
}

export type HmpActivityVisibility = "public" | "unlisted" | "private";
export type HmpActivityState = "forming" | "running" | "completed" | "cancelled";
export type HmpActivityScopeMode = "global" | "area" | "region" | "virtualWorld" | "areaAndVirtualWorld";
export type HmpActivityDisconnectPolicy = "cancel" | "remove";

export interface HmpActivityRoleDefinition {
    id: string;
    label: string;
    description?: string;
    min?: number;
    max: number;
}

export interface HmpActivityTeamDefinition {
    id: string;
    label: string;
    min?: number;
    max: number;
    roles?: ReadonlyArray<HmpActivityRoleDefinition>;
}

export interface HmpActivityParticipant {
    playerId: number;
    nickname: string;
    characterId: number | null;
    characterName: string | null;
    team: string | null;
    role: string | null;
    ready: boolean;
    joinedAt: string;
}

export interface HmpActivityScope {
    areaId?: string;
    regionId?: string;
    virtualWorld?: number;
}

export interface HmpActivityCompositionSlot {
    id: string;
    label: string;
    team: string | null;
    minimum: number;
    maximum: number;
    filled: number;
    open: number;
    satisfied: boolean;
}

export interface HmpActivitySession {
    id: string;
    activityId: string;
    activityLabel: string;
    ownerResource: string;
    state: HmpActivityState;
    visibility: HmpActivityVisibility;
    title: string;
    note: string;
    leaderPlayerId: number;
    minimumPlayers: number;
    maximumPlayers: number;
    requireReady: boolean;
    startable: boolean;
    participants: HmpActivityParticipant[];
    composition: HmpActivityCompositionSlot[];
    scope: HmpActivityScope;
    metadata: Record<string, unknown>;
    revision: number;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    startedAt: string | null;
    endedAt: string | null;
    endReason: string | null;
}

export interface HmpActivityGateContext<P = HmpActivityPlayer> {
    player: P;
    character: HmpCoreCharacter | null;
    session: HmpActivitySession | null;
    team: string | null;
    role: string | null;
    /** Resource that asked an owner API to start, when one supplied it. */
    resource?: string;
}

export interface HmpActivityLifecycleContext<P = HmpActivityPlayer> {
    session: HmpActivitySession;
    player?: P;
    reason?: string;
    result?: Record<string, unknown>;
}

export type HmpActivityGate = true | false | string | void;

export interface HmpActivityDefinition<P = HmpActivityPlayer> {
    id: string;
    resource: string;
    label: string;
    description?: string;
    minimumPlayers: number;
    maximumPlayers: number;
    roles?: ReadonlyArray<HmpActivityRoleDefinition>;
    teams?: ReadonlyArray<HmpActivityTeamDefinition>;
    requireReady?: boolean;
    requiresCharacter?: boolean;
    exclusive?: boolean;
    /** Running-session behavior. Forming lobbies always remove the disconnected member. */
    disconnectPolicy?: HmpActivityDisconnectPolicy;
    defaultVisibility?: HmpActivityVisibility;
    scope?: HmpActivityScopeMode;
    lobbyTtlSeconds?: number;
    canCreate?(context: HmpActivityGateContext<P>): HmpActivityGate | Promise<HmpActivityGate>;
    canJoin?(context: HmpActivityGateContext<P>): HmpActivityGate | Promise<HmpActivityGate>;
    canStart?(context: HmpActivityGateContext<P>): HmpActivityGate | Promise<HmpActivityGate>;
    onCreated?(context: HmpActivityLifecycleContext<P>): unknown;
    onJoined?(context: HmpActivityLifecycleContext<P>): unknown;
    onLeft?(context: HmpActivityLifecycleContext<P>): unknown;
    onStarted?(context: HmpActivityLifecycleContext<P>): unknown;
    onCompleted?(context: HmpActivityLifecycleContext<P>): unknown;
    onCancelled?(context: HmpActivityLifecycleContext<P>): unknown;
}

export interface HmpActivityDefinitionInfo {
    id: string;
    resource: string;
    label: string;
    description: string;
    minimumPlayers: number;
    maximumPlayers: number;
    roles: HmpActivityRoleDefinition[];
    teams: HmpActivityTeamDefinition[];
    requireReady: boolean;
    requiresCharacter: boolean;
    exclusive: boolean;
    disconnectPolicy: HmpActivityDisconnectPolicy;
    defaultVisibility: HmpActivityVisibility;
    scope: HmpActivityScopeMode;
    lobbyTtlSeconds: number;
}

export interface HmpActivityCreateInput {
    title?: string;
    note?: string;
    visibility?: HmpActivityVisibility;
    team?: string;
    role?: string;
    metadata?: Record<string, unknown>;
    lobbyTtlSeconds?: number;
}

export interface HmpActivityDiscoverFilter {
    activityId?: string;
    role?: string;
    team?: string;
    areaId?: string;
    regionId?: string;
    virtualWorld?: number;
    includeFull?: boolean;
}

export interface HmpActivityOwnerContext<P = HmpActivityPlayer> {
    resource?: string;
    actor?: P;
    reason?: string;
}

export type HmpActivityInvitationState = "pending" | "accepted" | "declined" | "cancelled" | "expired";

export interface HmpActivityInvitation {
    id: string;
    sessionId: string;
    activityId: string;
    fromPlayerId: number;
    fromNickname: string;
    toPlayerId: number;
    toNickname: string;
    team: string | null;
    role: string | null;
    message: string;
    state: HmpActivityInvitationState;
    createdAt: string;
    expiresAt: string;
    respondedAt: string | null;
}

export interface HmpActivityInvitationsApi<P = HmpActivityPlayer> {
    invite(sessionId: string, target: P, selection: { team?: string; role?: string; message?: string; ttlSeconds?: number }, context: HmpActivityOwnerContext<P>): Promise<HmpActivityInvitation>;
    accept(player: P, invitationId: string): Promise<HmpActivitySession>;
    decline(player: P, invitationId: string, reason?: string): Promise<HmpActivityInvitation>;
    cancel(invitationId: string, context: HmpActivityOwnerContext<P>): Promise<HmpActivityInvitation>;
    get(invitationId: string): HmpActivityInvitation | null;
    list(filter?: { sessionId?: string; playerId?: number; direction?: "incoming" | "outgoing" }): HmpActivityInvitation[];
}

export interface HmpActivityDefinitionsApi<P = HmpActivityPlayer> {
    register(definition: HmpActivityDefinition<P>): () => Promise<number>;
    unregister(id: string, resource: string): Promise<number>;
    clear(resource: string): Promise<number>;
    get(id: string): HmpActivityDefinitionInfo | null;
    list(resource?: string): HmpActivityDefinitionInfo[];
}

export interface HmpActivitySessionsApi<P = HmpActivityPlayer> {
    create(player: P, activityId: string, input?: HmpActivityCreateInput): Promise<HmpActivitySession>;
    join(player: P, sessionId: string, selection?: { team?: string; role?: string }): Promise<HmpActivitySession>;
    leave(player: P, sessionId: string, reason?: string): Promise<HmpActivitySession | null>;
    select(player: P, sessionId: string, selection: { team?: string | null; role?: string | null }): Promise<HmpActivitySession>;
    setReady(player: P, sessionId: string, ready: boolean): Promise<HmpActivitySession>;
    start(sessionId: string, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession>;
    complete(sessionId: string, result: Record<string, unknown> | undefined, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession>;
    cancel(sessionId: string, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession>;
    kick(sessionId: string, playerId: number, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession | null>;
    transferLeader(sessionId: string, playerId: number, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession>;
    get(sessionId: string): HmpActivitySession | null;
    list(filter?: { activityId?: string; state?: "forming" | "running"; playerId?: number }): HmpActivitySession[];
    forPlayer(player: P | number): HmpActivitySession[];
    discover(player?: P | null, filter?: HmpActivityDiscoverFilter): HmpActivitySession[];
}

export interface HmpActivitiesStatus {
    state: "ready" | "stopped";
    definitions: number;
    sessions: number;
    forming: number;
    running: number;
    participants: number;
    invitations: number;
    uptimeMs: number;
}

export interface HmpActivities<P = HmpActivityPlayer> {
    definitions: HmpActivityDefinitionsApi<P>;
    sessions: HmpActivitySessionsApi<P>;
    invitations: HmpActivityInvitationsApi<P>;
    status(): HmpActivitiesStatus;
}

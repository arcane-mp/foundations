import type { HmpCore } from "../../hmp-core/types";
import type {
    HmpActivities, HmpActivityDefinition, HmpActivityParticipant, HmpActivityPlayer, HmpActivitySession,
} from "../types";

export interface ActivityConfig {
    command: string;
    enableCommands: boolean;
    maxDefinitions: number;
    maxSessions: number;
    maxMetadataBytes: number;
    maxInvitations: number;
    defaultInvitationTtlSeconds: number;
    maximumInvitationTtlSeconds: number;
    defaultLobbyTtlSeconds: number;
    maximumLobbyTtlSeconds: number;
    sweepIntervalSeconds: number;
    enableTestActivity: boolean;
}

export interface ActivityDependencies<P extends HmpActivityPlayer> {
    core: HmpCore<P>;
    config: ActivityConfig;
    emit?(eventName: string, payload: unknown): unknown;
    warn?(message: string): void;
    now?: () => number;
    id?: () => string;
}

export interface InternalParticipant<P extends HmpActivityPlayer> extends HmpActivityParticipant { player: P }
export interface InternalSession<P extends HmpActivityPlayer> extends Omit<HmpActivitySession, "participants" | "composition" | "startable"> {
    participants: InternalParticipant<P>[];
}

export interface NormalizedDefinition<P extends HmpActivityPlayer> extends Required<Omit<HmpActivityDefinition<P>,
    "description" | "roles" | "teams" | "canCreate" | "canJoin" | "canStart" | "onCreated" | "onJoined" | "onLeft" | "onStarted" | "onCompleted" | "onCancelled">> {
    description: string;
    roles: NonNullable<HmpActivityDefinition<P>["roles"]>;
    teams: NonNullable<HmpActivityDefinition<P>["teams"]>;
    canCreate?: HmpActivityDefinition<P>["canCreate"];
    canJoin?: HmpActivityDefinition<P>["canJoin"];
    canStart?: HmpActivityDefinition<P>["canStart"];
    onCreated?: HmpActivityDefinition<P>["onCreated"];
    onJoined?: HmpActivityDefinition<P>["onJoined"];
    onLeft?: HmpActivityDefinition<P>["onLeft"];
    onStarted?: HmpActivityDefinition<P>["onStarted"];
    onCompleted?: HmpActivityDefinition<P>["onCompleted"];
    onCancelled?: HmpActivityDefinition<P>["onCancelled"];
}

export interface ActivityService<P extends HmpActivityPlayer> extends HmpActivities<P> {
    cleanup(resource: string): Promise<number>;
    disconnect(player: P): Promise<void>;
    sweep(): Promise<number>;
    stop(): Promise<void>;
}

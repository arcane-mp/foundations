import type {
    HmpNpcDisposition,
    HmpNpcFollowOptions,
    HmpNpcIdle,
    HmpNpcMoveOptions,
    HmpNpcMovementState,
    HmpNpcVector3,
    HmpNpcWaypoint,
} from "../types";

export interface NpcsConfig {
    maximumManagedNpcs: number;
    maximumPerResource: number;
}

export interface NativeNpc {
    readonly id: number;
    readonly enemyId: string;
    readonly disposition: HmpNpcDisposition;
    readonly alive: boolean;
    readonly ownerId?: number;
    readonly scale: number;
    readonly health: number;
    readonly maxHealth: number;
    setScale(scale: number): void;
    setMaxHealth(health: number): void;
    setHealth(health: number): void;
    destroy(): void;
    /** An older host takes the world alone and ignores `map`. */
    setVirtualWorld?(world: number, map?: string): void;
    // Movement: absent on a host before NPC paths.
    moveAlong?(waypoints: HmpNpcWaypoint[], options?: HmpNpcMoveOptions): boolean;
    moveTo?(x: number, y: number, z: number, options?: HmpNpcMoveOptions): boolean;
    stop?(): void;
    pause?(): void;
    resume?(): void;
    /** A host before follow reports no `targetId`. */
    readonly movement?: Omit<HmpNpcMovementState, "targetId"> & { targetId?: number };
    readonly waypoints?: HmpNpcWaypoint[];
    idle?: HmpNpcIdle;
    home?: HmpNpcVector3 | null;
    /** Absent on a host before NPC follow. */
    follow?(target: { id: number }, options?: HmpNpcFollowOptions): boolean;
}

/** `NPC.create`'s options form; a host before it throws a TypeError for it. */
export interface NativeNpcSpawnOptions extends HmpNpcVector3 {
    yaw?: number;
    disposition?: HmpNpcDisposition;
    preferredOwnerId?: number;
}

export interface NativeNpcs {
    /** The options form, or the deprecated positional one (x, y, z, ...) every host knows, which takes no yaw. */
    create(
        enemyId: string,
        at: NativeNpcSpawnOptions | number,
        y?: number,
        z?: number,
        disposition?: HmpNpcDisposition,
        preferredOwnerId?: number,
    ): NativeNpc | undefined;
}

export interface NpcsServiceOptions {
    config: NpcsConfig;
    native: NativeNpcs;
    /** Raises the `hmp:npcs:*` events other resources listen for. */
    emit?(eventName: string, payload: unknown): void;
    now?: () => number;
}

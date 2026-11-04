export type HmpNpcDisposition = "hostile" | "friendly";

export interface HmpNpcVector3 {
    x: number;
    y: number;
    z: number;
}

export interface HmpNpcCatalogEntry {
    id: string;
    label: string;
}

export interface HmpNpcSpawnInput {
    resource: string;
    enemyId: string;
    position: HmpNpcVector3;
    /** Heading in degrees it spawns facing, -360 to 360: 0 faces +X, 90 faces +Y. A host before HogwartsMP 1.11 ignores it. */
    yaw?: number;
    disposition?: HmpNpcDisposition;
    ownerId?: number;
    maxHealth?: number;
    scale?: number;
}

export interface HmpNpcSnapshot {
    id: number;
    enemyId: string;
    resource: string;
    disposition: HmpNpcDisposition;
    ownerId?: number;
    alive: boolean;
    health: number;
    maxHealth: number;
    scale: number;
}

/** A named speed: walk is the NPC family's calm wander, jog its combat move, sprint that move at 1.3 times. */
export type HmpNpcGait = "walk" | "jog" | "sprint";

/** What an NPC does while no path runs: the game's own wander where it spawned, hold at its home, or roam around it. */
export type HmpNpcIdle = "native" | "stand" | "wander";

/** One point of a path, at a player's origin height (as `player.position`). */
export interface HmpNpcWaypoint extends HmpNpcVector3 {
    /** Seconds to stand here on arrival, 0 to 3600. */
    wait?: number;
    /** The speed of the leg that arrives here. */
    gait?: HmpNpcGait;
}

export interface HmpNpcMoveOptions {
    /** The gait of legs whose waypoint names none; "walk" when omitted. */
    gait?: HmpNpcGait;
    /** Once to the end, back to point 0 and round again, or back and forth; "once" when omitted. */
    loop?: "once" | "loop" | "pingpong";
    /** How near a point counts as reached, 0 to 5000 cm; the game's own (about 50) when omitted. */
    radius?: number;
    /** The game's speed scale for every leg, 0.25 to 3; jog and sprint follow it, the calm walk keeps its stride. */
    speedScale?: number;
    /** The idle a "once" path ends in at its last point, which becomes its home; "stand" when omitted. */
    then?: HmpNpcIdle;
}

/** How `movement.follow` walks after its target, in the NPC's own gaits. */
export interface HmpNpcFollowOptions {
    /** "walk" when omitted, the calm wander, which in some families is slower than a walking player; jog keeps up. */
    gait?: HmpNpcGait;
    /** The game's speed scale, 0.25 to 3; jog and sprint follow it, the calm walk keeps its stride. */
    speedScale?: number;
    /** 100 to 3000 cm, default 200: it rests inside this and walks again once the target pulls 100 cm past it. */
    distanceCm?: number;
    /** Metres behind the target past which the server puts the NPC beside it, 0 to 100000; 0 never. Default 60. */
    teleportBeyond?: number;
    /** The idle it takes up where it stands once the follow ends, which becomes its home; "stand" when omitted. */
    then?: HmpNpcIdle;
}

/**
 * Why a path or follow ended: it finished, `stop()` or a death ended it, a new command replaced it, the game found no
 * way, or the followed entity left.
 */
export type HmpNpcMoveEndReason = "arrived" | "stopped" | "replaced" | "unreachable" | "targetGone";

export interface HmpNpcMovementState {
    /** "path" while one runs, waiting at a point and paused included; "follow" while it follows. */
    mode: "idle" | "path" | "follow";
    /** Index of the waypoint it heads for or waits at. */
    waypoint: number;
    /** How many waypoints the path has; 0 when idle. */
    waypoints: number;
    /** Laps a loop or pingpong has completed. */
    lap: number;
    /** Held by `pause()`, or by the NPC's own AI pause. */
    paused: boolean;
    /** The followed entity's id; 0 when it follows nothing. */
    targetId: number;
}

export interface HmpNpcMovement {
    state: HmpNpcMovementState;
    /** The running path's points as given, each gait resolved; empty when idle or following. */
    waypoints: HmpNpcWaypoint[];
    idle: HmpNpcIdle;
    /** Where the stand and wander idles keep it; null until set, until a "once" path arrives or a follow ends. */
    home: HmpNpcVector3 | null;
}

/** `hmp:npcs:waypoint`: a managed NPC reached `waypoints[index]`, before its wait. */
export interface HmpNpcWaypointEvent {
    npc: HmpNpcSnapshot;
    index: number;
    lap: number;
}

/** `hmp:npcs:moveEnded`: a managed NPC's path or follow ended. */
export interface HmpNpcMoveEndedEvent {
    npc: HmpNpcSnapshot;
    reason: HmpNpcMoveEndReason;
}

export interface HmpNpcStatus {
    state: "ready" | "stopped";
    managed: number;
    resources: Record<string, number>;
    catalogSize: number;
    maximumManagedNpcs: number;
    maximumPerResource: number;
}

export interface HmpNpcs {
    catalog: {
        get(id: string): HmpNpcCatalogEntry | null;
        has(id: string): boolean;
        list(): HmpNpcCatalogEntry[];
    };
    spawn(input: HmpNpcSpawnInput): HmpNpcSnapshot;
    destroy(id: number, resource: string): boolean;
    clear(resource: string): number;
    get(id: number): HmpNpcSnapshot | null;
    list(resource?: string): HmpNpcSnapshot[];
    status(): HmpNpcStatus;
    /**
     * Moves an NPC the resource spawned into a virtual world within a map (a `player.location().areaId`; "Overland"
     * or "" the shared map), where it meets the players in that world of that map. Left out, the map stays.
     */
    setVirtualWorld(id: number, resource: string, world: number, map?: string): boolean;
    /**
     * Paths for NPCs the calling resource spawned. Each call is false for an NPC another resource owns, a gone or dead
     * NPC, or a host without NPC movement, and throws on malformed input.
     */
    movement: {
        /** Walks 1 to 64 waypoints with the game's own pathfinding, replacing any running path. */
        along(id: number, resource: string, waypoints: ReadonlyArray<HmpNpcWaypoint>, options?: HmpNpcMoveOptions): boolean;
        /** `along` with one point. */
        to(id: number, resource: string, position: HmpNpcVector3, options?: HmpNpcMoveOptions): boolean;
        /**
         * Walks after a player, beast, NPC or Character (any other than this NPC) until `stop` or a new command,
         * replacing a running one, and ends "targetGone" when it leaves. Throws when the host finds no live target.
         */
        follow(id: number, resource: string, target: { id: number }, options?: HmpNpcFollowOptions): boolean;
        /** Ends the running path or follow as "stopped", leaving the NPC to its idle where it stands. */
        stop(id: number, resource: string): boolean;
        /** Holds the running path or follow where it is. */
        pause(id: number, resource: string): boolean;
        resume(id: number, resource: string): boolean;
        /** Sets what it does while no path or follow runs, at `home` when given (else where it stands, the first time). */
        setIdle(id: number, resource: string, idle: HmpNpcIdle, home?: HmpNpcVector3): boolean;
        /** Null for an NPC this service does not manage, or on a host without NPC movement. */
        get(id: number): HmpNpcMovement | null;
    };
}

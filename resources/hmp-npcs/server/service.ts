import { getCatalogEntry, hasCatalogEntry, listCatalogEntries } from "../shared/catalog";
import type {
    HmpNpcFollowOptions,
    HmpNpcIdle,
    HmpNpcMoveEndReason,
    HmpNpcMoveOptions,
    HmpNpcMovement,
    HmpNpcSnapshot,
    HmpNpcSpawnInput,
    HmpNpcStatus,
    HmpNpcVector3,
    HmpNpcWaypoint,
    HmpNpcs,
} from "../types";
import type { NativeNpc, NativeNpcSpawnOptions, NativeNpcs, NpcsServiceOptions } from "./internal";

interface ManagedNpc { resource: string; npc: NativeNpc }

interface NpcsService extends HmpNpcs {
    died(id: number): boolean;
    /** The host's npcWaypoint, forwarded as hmp:npcs:waypoint when this service manages the NPC. */
    waypoint(id: number, index: number, lap: number): boolean;
    /** The host's npcMoveEnded, forwarded as hmp:npcs:moveEnded when this service manages the NPC. */
    moveEnded(id: number, reason: HmpNpcMoveEndReason): boolean;
    stop(): void;
}

const GAITS = ["walk", "jog", "sprint"] as const;
const LOOPS = ["once", "loop", "pingpong"] as const;
const IDLES = ["native", "stand", "wander"] as const;
const MAXIMUM_WAYPOINTS = 64;

function resourceName(value: unknown): string {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
        throw new TypeError("NPC resource must be a non-empty resource name up to 64 characters");
    }
    return value;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new TypeError(`${label} must be a number from ${minimum} to ${maximum}`);
    }
    return parsed;
}

function integer(value: unknown, label: string, minimum: number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new TypeError(`${label} must be an integer of at least ${minimum}`);
    return parsed;
}

function vector(value: unknown, label: string): HmpNpcVector3 {
    if (!value || typeof value !== "object") throw new TypeError(`${label} must be an object`);
    const point = value as Record<string, unknown>;
    return {
        x: finite(point.x, `${label}.x`, -10_000_000, 10_000_000),
        y: finite(point.y, `${label}.y`, -10_000_000, 10_000_000),
        z: finite(point.z, `${label}.z`, -10_000_000, 10_000_000),
    };
}

function oneOf<T extends string>(value: unknown, label: string, choices: readonly T[]): T | undefined {
    if (value === undefined) return undefined;
    if (!choices.includes(value as T)) throw new TypeError(`${label} must be one of ${choices.join(", ")}`);
    return value as T;
}

function waypoint(value: unknown, index: number): HmpNpcWaypoint {
    const label = `NPC waypoint ${index}`;
    const point: HmpNpcWaypoint = vector(value, label);
    const raw = value as HmpNpcWaypoint;
    if (raw.wait !== undefined) point.wait = finite(raw.wait, `${label} wait`, 0, 3600);
    const gait = oneOf(raw.gait, `${label} gait`, GAITS);
    if (gait) point.gait = gait;
    return point;
}

function moveOptions(raw: HmpNpcMoveOptions | undefined): HmpNpcMoveOptions {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object") throw new TypeError("NPC move options must be an object");
    const options: HmpNpcMoveOptions = {};
    const gait = oneOf(raw.gait, "NPC move gait", GAITS);
    const loop = oneOf(raw.loop, "NPC move loop", LOOPS);
    const then = oneOf(raw.then, "NPC move then", IDLES);
    if (gait) options.gait = gait;
    if (loop) options.loop = loop;
    if (then) options.then = then;
    if (raw.radius !== undefined) options.radius = finite(raw.radius, "NPC move radius", 0, 5000);
    if (raw.speedScale !== undefined) options.speedScale = finite(raw.speedScale, "NPC move speedScale", 0.25, 3);
    return options;
}

function followOptions(raw: HmpNpcFollowOptions | undefined): HmpNpcFollowOptions {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object") throw new TypeError("NPC follow options must be an object");
    const options: HmpNpcFollowOptions = {};
    const gait = oneOf(raw.gait, "NPC follow gait", GAITS);
    const then = oneOf(raw.then, "NPC follow then", IDLES);
    if (gait) options.gait = gait;
    if (then) options.then = then;
    if (raw.speedScale !== undefined) options.speedScale = finite(raw.speedScale, "NPC follow speedScale", 0.25, 3);
    if (raw.distanceCm !== undefined) options.distanceCm = finite(raw.distanceCm, "NPC follow distanceCm", 100, 3000);
    if (raw.teleportBeyond !== undefined) options.teleportBeyond = finite(raw.teleportBeyond, "NPC follow teleportBeyond", 0, 100_000);
    return options;
}

/** The options form, which alone takes a yaw; a host before it throws a TypeError, and gets the positional form. */
function createNative(native: NativeNpcs, enemyId: string, at: NativeNpcSpawnOptions): NativeNpc | undefined {
    try {
        return native.create(enemyId, at);
    } catch (error) {
        // The input is validated, so a TypeError here is the host refusing the form.
        if ((error as Error | undefined)?.name !== "TypeError") throw error;
    }
    return native.create(enemyId, at.x, at.y, at.z, at.disposition, at.preferredOwnerId);
}

/** NPC paths arrived after HogwartsMP 1.9.2; an older host's handle has none of it. */
function movable(npc: NativeNpc): npc is NativeNpc & Required<Pick<NativeNpc, "moveAlong" | "moveTo" | "stop" | "pause" | "resume">> {
    return typeof npc.moveAlong === "function";
}

function snapshot(entry: ManagedNpc): HmpNpcSnapshot {
    const npc = entry.npc;
    return {
        id: npc.id,
        enemyId: npc.enemyId,
        resource: entry.resource,
        disposition: npc.disposition,
        ownerId: npc.ownerId,
        alive: npc.alive,
        health: npc.health,
        maxHealth: npc.maxHealth,
        scale: npc.scale,
    };
}

export function createNpcsService(options: NpcsServiceOptions): NpcsService {
    const { config, native, emit } = options;
    const managed = new Map<number, ManagedNpc>();
    let state: "ready" | "stopped" = "ready";

    function ensureReady(): void {
        if (state === "stopped") throw new Error("hmp-npcs is stopped");
    }

    function count(resource: string): number {
        let total = 0;
        for (const entry of managed.values()) if (entry.resource === resource) total += 1;
        return total;
    }

    function destroy(id: number, resource: string): boolean {
        ensureReady();
        const owner = resourceName(resource);
        const key = integer(id, "NPC id", 0);
        const entry = managed.get(key);
        if (!entry || entry.resource !== owner) return false;
        managed.delete(key);
        try { entry.npc.destroy(); } catch { /* Native actor may already be gone. */ }
        return true;
    }

    function clear(resource: string): number {
        ensureReady();
        const owner = resourceName(resource);
        const ids = [...managed].filter(([, entry]) => entry.resource === owner).map(([id]) => id);
        for (const id of ids) destroy(id, owner);
        return ids.length;
    }

    function setVirtualWorld(id: number, resource: string, world: number, map?: string): boolean {
        ensureReady();
        const owner = resourceName(resource);
        const key = integer(id, "NPC id", 0);
        const virtualWorld = integer(world, "NPC virtual world", 0);
        if (virtualWorld > 4_294_967_295) throw new TypeError("NPC virtual world must be at most 4294967295");
        if (map !== undefined && (typeof map !== "string" || map.length > 128)) throw new TypeError("NPC map must be an area id up to 128 characters");
        const entry = managed.get(key);
        if (!entry || entry.resource !== owner || typeof entry.npc.setVirtualWorld !== "function") return false;
        const npc = entry.npc as Required<Pick<NativeNpc, "setVirtualWorld">>;
        // Without a map, the call an older host's world-only setVirtualWorld knows.
        if (map === undefined) npc.setVirtualWorld(virtualWorld);
        else npc.setVirtualWorld(virtualWorld, map);
        return true;
    }

    /** The NPC, when `resource` owns it and the host can move it. */
    function owned(id: number, resource: string) {
        ensureReady();
        const owner = resourceName(resource);
        const entry = managed.get(integer(id, "NPC id", 0));
        return entry && entry.resource === owner && movable(entry.npc) ? entry.npc : null;
    }

    function along(id: number, resource: string, waypoints: ReadonlyArray<HmpNpcWaypoint>, options?: HmpNpcMoveOptions): boolean {
        if (!Array.isArray(waypoints) || waypoints.length < 1 || waypoints.length > MAXIMUM_WAYPOINTS) {
            throw new TypeError(`NPC path must have 1 to ${MAXIMUM_WAYPOINTS} waypoints`);
        }
        const points = waypoints.map(waypoint);
        const normalized = moveOptions(options);
        const npc = owned(id, resource);
        return npc ? npc.moveAlong(points, normalized) === true : false;
    }

    function forward(id: number, eventName: string, detail: Record<string, unknown>): boolean {
        const entry = managed.get(Number(id));
        if (state === "stopped" || !entry) return false;
        emit?.(eventName, { npc: snapshot(entry), ...detail });
        return true;
    }

    const movement = Object.freeze({
        along,
        to(id: number, resource: string, position: HmpNpcVector3, options?: HmpNpcMoveOptions): boolean {
            const point = vector(position, "NPC move position");
            const normalized = moveOptions(options);
            const npc = owned(id, resource);
            return npc ? npc.moveTo(point.x, point.y, point.z, normalized) === true : false;
        },
        follow(id: number, resource: string, target: { id: number }, options?: HmpNpcFollowOptions): boolean {
            if (!target || typeof target !== "object") throw new TypeError("NPC follow target must be an entity");
            const targetId = integer(target.id, "NPC follow target id", 1);
            if (targetId === Number(id)) throw new TypeError("An NPC cannot follow itself");
            const normalized = followOptions(options);
            const npc = owned(id, resource);
            // The host reads only the target's id; follow arrived after HogwartsMP 1.10.
            return npc && typeof npc.follow === "function" ? npc.follow({ id: targetId }, normalized) === true : false;
        },
        stop(id: number, resource: string): boolean {
            const npc = owned(id, resource);
            if (npc) npc.stop();
            return Boolean(npc);
        },
        pause(id: number, resource: string): boolean {
            const npc = owned(id, resource);
            if (npc) npc.pause();
            return Boolean(npc);
        },
        resume(id: number, resource: string): boolean {
            const npc = owned(id, resource);
            if (npc) npc.resume();
            return Boolean(npc);
        },
        setIdle(id: number, resource: string, idle: HmpNpcIdle, home?: HmpNpcVector3): boolean {
            const mode = oneOf(idle, "NPC idle", IDLES);
            if (!mode) throw new TypeError(`NPC idle must be one of ${IDLES.join(", ")}`);
            const at = home === undefined ? undefined : vector(home, "NPC home");
            const npc = owned(id, resource);
            if (!npc) return false;
            // Home first: a stand or wander with no home yet would take where the NPC stands.
            if (at) npc.home = at;
            npc.idle = mode;
            return true;
        },
        get(id: number): HmpNpcMovement | null {
            ensureReady();
            const npc = managed.get(integer(id, "NPC id", 0))?.npc;
            if (!npc || !movable(npc)) return null;
            const current = npc.movement;
            const home = npc.home;
            return {
                state: current
                    ? {
                        mode: current.mode,
                        waypoint: current.waypoint,
                        waypoints: current.waypoints,
                        lap: current.lap,
                        paused: current.paused,
                        targetId: Number(current.targetId) || 0,
                    }
                    : { mode: "idle", waypoint: 0, waypoints: 0, lap: 0, paused: false, targetId: 0 },
                waypoints: (npc.waypoints || []).map((point) => ({ ...point })),
                idle: npc.idle || "native",
                home: home ? { x: home.x, y: home.y, z: home.z } : null,
            };
        },
    });

    const catalog = Object.freeze({ get: getCatalogEntry, has: hasCatalogEntry, list: listCatalogEntries });

    return Object.freeze({
        catalog,
        spawn(input: HmpNpcSpawnInput): HmpNpcSnapshot {
            ensureReady();
            if (!input || typeof input !== "object") throw new TypeError("NPC spawn input must be an object");
            const resource = resourceName(input.resource);
            if (typeof input.enemyId !== "string" || !hasCatalogEntry(input.enemyId)) {
                throw new TypeError(`Unknown Framework enemy id '${String(input.enemyId)}'`);
            }
            if (managed.size >= config.maximumManagedNpcs) throw new Error("hmp-npcs managed NPC limit reached");
            if (count(resource) >= config.maximumPerResource) throw new Error(`hmp-npcs limit reached for '${resource}'`);
            const { x, y, z } = vector(input.position, "NPC position");
            const yaw = input.yaw === undefined ? undefined : finite(input.yaw, "NPC yaw", -360, 360);
            const disposition = input.disposition || "hostile";
            if (!(["hostile", "friendly"] as const).includes(disposition)) throw new TypeError("NPC disposition is invalid");
            const ownerId = input.ownerId === undefined ? undefined : integer(input.ownerId, "NPC ownerId", 0);
            const maxHealth = input.maxHealth === undefined ? undefined : finite(input.maxHealth, "NPC maxHealth", 1, 100_000_000);
            const scale = input.scale === undefined ? undefined : finite(input.scale, "NPC scale", 0.05, 100);
            const at: NativeNpcSpawnOptions = { x, y, z, disposition };
            if (yaw !== undefined) at.yaw = yaw;
            if (ownerId !== undefined) at.preferredOwnerId = ownerId;
            const npc = createNative(native, input.enemyId, at);
            if (!npc) throw new Error(`Framework could not spawn '${input.enemyId}'`);
            if (managed.has(npc.id)) {
                try { npc.destroy(); } catch { /* Best effort rollback. */ }
                throw new Error(`Framework returned duplicate NPC id ${npc.id}`);
            }
            try {
                if (maxHealth !== undefined) { npc.setMaxHealth(maxHealth); npc.setHealth(maxHealth); }
                if (scale !== undefined) npc.setScale(scale);
            } catch (error) {
                try { npc.destroy(); } catch { /* Best effort rollback. */ }
                throw error;
            }
            const entry = { resource, npc };
            managed.set(npc.id, entry);
            return snapshot(entry);
        },
        destroy,
        clear,
        get(id: number) {
            ensureReady();
            const entry = managed.get(integer(id, "NPC id", 0));
            return entry ? snapshot(entry) : null;
        },
        list(resource?: string) {
            ensureReady();
            const owner = resource === undefined ? undefined : resourceName(resource);
            return [...managed.values()].filter((entry) => !owner || entry.resource === owner).map(snapshot);
        },
        status(): HmpNpcStatus {
            const resources: Record<string, number> = {};
            for (const entry of managed.values()) resources[entry.resource] = (resources[entry.resource] || 0) + 1;
            return {
                state,
                managed: managed.size,
                resources,
                catalogSize: listCatalogEntries().length,
                maximumManagedNpcs: config.maximumManagedNpcs,
                maximumPerResource: config.maximumPerResource,
            };
        },
        setVirtualWorld,
        movement,
        died(id: number) { return managed.delete(id); },
        waypoint: (id: number, index: number, lap: number) => forward(id, "hmp:npcs:waypoint", { index, lap }),
        moveEnded: (id: number, reason: HmpNpcMoveEndReason) => forward(id, "hmp:npcs:moveEnded", { reason }),
        stop() {
            if (state === "stopped") return;
            for (const entry of managed.values()) {
                try { entry.npc.destroy(); } catch { /* Best effort shutdown. */ }
            }
            managed.clear();
            state = "stopped";
        },
    });
}

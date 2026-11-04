import assert = require("node:assert");
import { normalizeConfig } from "../server/config";
import { createNpcsService } from "../server/service";
import type { NativeNpc, NativeNpcSpawnOptions } from "../server/internal";
import type { HmpNpcDisposition, HmpNpcIdle } from "../types";

assert.deepStrictEqual(normalizeConfig({ maximumManagedNpcs: 8, maximumPerResource: 4 }), {
    maximumManagedNpcs: 8,
    maximumPerResource: 4,
});
assert.throws(() => normalizeConfig({ maximumManagedNpcs: 2, maximumPerResource: 3 }), /cannot exceed/);

let nextId = 1;
const destroyed: number[] = [];
const positional: unknown[][] = [];
// A HogwartsMP 1.10 host: NPC.create takes only the positional form and throws a TypeError for the options form.
const native = {
    create(enemyId: string, x: number | NativeNpcSpawnOptions, y?: number, z?: number, disposition: HmpNpcDisposition = "hostile", ownerId?: number) {
        if (typeof x !== "number") throw new TypeError("NPC.create(enemyId, x, y, z, disposition?, preferredOwnerId?)");
        positional.push([enemyId, x, y, z, disposition, ownerId]);
        const npc = {
            id: nextId++, enemyId, disposition, ownerId, alive: true, scale: 1, health: 100, maxHealth: 100,
            setScale(value: number) { this.scale = value; },
            setMaxHealth(value: number) { this.maxHealth = value; },
            setHealth(value: number) { this.health = value; },
            destroy() { destroyed.push(this.id); this.alive = false; },
        };
        return npc;
    },
};
const service = createNpcsService({ config: { maximumManagedNpcs: 3, maximumPerResource: 2 }, native });
assert.strictEqual(service.catalog.has("Goblin_Grunt"), true);
assert.strictEqual(service.catalog.list().length, 39);
assert.throws(() => service.spawn({ resource: "arena", enemyId: "Nope", position: { x: 0, y: 0, z: 0 } }), /Unknown/);
const first = service.spawn({ resource: "arena", enemyId: "Goblin_Grunt", position: { x: 1, y: 2, z: 3 }, maxHealth: 250, scale: 1.2 });
assert.deepStrictEqual({ id: first.id, health: first.health, maxHealth: first.maxHealth, scale: first.scale }, { id: 1, health: 250, maxHealth: 250, scale: 1.2 });
service.spawn({ resource: "arena", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } });
assert.throws(() => service.spawn({ resource: "arena", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } }), /limit reached/);
const other = service.spawn({ resource: "quest", enemyId: "Inferius", position: { x: 1, y: 2, z: 3 } });
assert.strictEqual(service.status().managed, 3);
assert.strictEqual(service.destroy(other.id, "arena"), false);
assert.strictEqual(service.died(first.id), true);
assert.strictEqual(service.clear("arena"), 1);
assert.deepStrictEqual(destroyed, [2]);
// An id that crosses a resource boundary as a string still finds the NPC; it must leave the registry too.
const loose = service.spawn({ resource: "quest", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } });
assert.strictEqual(service.destroy(String(loose.id) as unknown as number, "quest"), true);
assert.strictEqual(service.status().managed, 1);
assert.strictEqual(service.destroy(loose.id, "quest"), false);
service.stop();
assert.deepStrictEqual(destroyed, [2, 4, 3]);
assert.throws(() => service.catalog.list().push({ id: "x", label: "x" }) && service.spawn({ resource: "x", enemyId: "Wolf", position: { x: 0, y: 0, z: 0 } }), /stopped/);

// The options form carries a yaw; a 1.10 host refuses it with a TypeError and gets the positional form, without one.
const spawned: unknown[][] = [];
const current = createNpcsService({
    config: { maximumManagedNpcs: 4, maximumPerResource: 4 },
    native: { create(enemyId: string, at: NativeNpcSpawnOptions | number, ...rest: unknown[]) { spawned.push([enemyId, at, ...rest]); return native.create(enemyId, 0, 0, 0); } },
});
current.spawn({ resource: "camps", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 }, yaw: 90, disposition: "friendly", ownerId: 5 });
current.spawn({ resource: "camps", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } });
assert.deepStrictEqual(spawned, [
    ["Wolf", { x: 1, y: 2, z: 3, yaw: 90, disposition: "friendly", preferredOwnerId: 5 }],
    ["Wolf", { x: 1, y: 2, z: 3, disposition: "hostile" }],
]);
assert.throws(() => current.spawn({ resource: "camps", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 }, yaw: 720 }), /NPC yaw/);
assert.strictEqual(spawned.length, 2);
const before = positional.length;
const fallback = createNpcsService({ config: { maximumManagedNpcs: 4, maximumPerResource: 4 }, native });
fallback.spawn({ resource: "camps", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 }, yaw: 90, disposition: "friendly", ownerId: 5 });
assert.deepStrictEqual(positional.slice(before), [["Wolf", 1, 2, 3, "friendly", 5]]);
let attempts = 0;
const failing = createNpcsService({ config: { maximumManagedNpcs: 4, maximumPerResource: 4 }, native: { create() { attempts++; throw new Error("spawn path unavailable"); } } });
assert.throws(() => failing.spawn({ resource: "camps", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } }), /spawn path unavailable/);
assert.strictEqual(attempts, 1, "only a refused form falls back");

// Movement is the owner's alone, validated before the host sees it, and its events reach the owner by resource.
const moves: unknown[][] = [];
const events: Array<{ name: string; payload: { npc: { id: number; resource: string }; [key: string]: unknown } }> = [];
const walkers: Array<{ movement: NativeNpc["movement"] }> = [];
const walker = {
    create(enemyId: string, at: NativeNpcSpawnOptions | number) {
        const npc = native.create(enemyId, 0, 0, 0, typeof at === "object" ? at.disposition : undefined);
        const handle = Object.assign(npc, {
            idle: "native" as HmpNpcIdle,
            home: null as { x: number; y: number; z: number } | null,
            movement: { mode: "path", waypoint: 1, waypoints: 2, lap: 0, paused: false } as NativeNpc["movement"],
            waypoints: [{ x: 1, y: 2, z: 3, wait: 0, gait: "walk" as const }],
            moveAlong(...args: unknown[]) { moves.push(["along", ...args]); return true; },
            moveTo(...args: unknown[]) { moves.push(["to", ...args]); return true; },
            follow(...args: unknown[]) { moves.push(["follow", ...args]); return true; },
            stop() { moves.push(["stop"]); },
            pause() { moves.push(["pause"]); },
            resume() { moves.push(["resume"]); },
        });
        walkers.push(handle);
        return handle;
    },
};
const paths = createNpcsService({
    config: { maximumManagedNpcs: 8, maximumPerResource: 8 },
    native: walker,
    emit: (name, payload) => events.push({ name, payload: payload as never }),
});
const guard = paths.spawn({ resource: "patrols", enemyId: "Poacher_Grunt", position: { x: 0, y: 0, z: 0 }, disposition: "friendly" });
const route = [{ x: 100, y: 0, z: 90, wait: 5 }, { x: 900, y: 0, z: 90, gait: "jog" as const }];
assert.strictEqual(paths.movement.along(guard.id, "patrols", route, { loop: "pingpong", speedScale: 1.5 }), true);
assert.deepStrictEqual(moves.at(-1), ["along", route, { loop: "pingpong", speedScale: 1.5 }]);
assert.strictEqual(paths.movement.along(guard.id, "intruder", route), false, "another resource cannot steer it");
assert.strictEqual(moves.length, 1);
assert.throws(() => paths.movement.along(guard.id, "patrols", []), /1 to 64 waypoints/);
assert.throws(() => paths.movement.along(guard.id, "patrols", [{ x: 0, y: 0, z: Number.NaN }]), /waypoint 0\.z/);
assert.throws(() => paths.movement.along(guard.id, "patrols", [{ x: 0, y: 0, z: 0, gait: "crawl" as never }]), /gait must be one of/);
assert.throws(() => paths.movement.to(guard.id, "patrols", { x: 0, y: 0, z: 0 }, { speedScale: 9 }), /speedScale/);
assert.strictEqual(paths.movement.to(guard.id, "patrols", { x: 5, y: 6, z: 7 }, { then: "wander" }), true);
assert.deepStrictEqual(moves.at(-1), ["to", 5, 6, 7, { then: "wander" }]);
assert.deepStrictEqual([paths.movement.pause(guard.id, "patrols"), paths.movement.resume(guard.id, "patrols"), paths.movement.stop(guard.id, "patrols")], [true, true, true]);
assert.deepStrictEqual(moves.slice(-3), [["pause"], ["resume"], ["stop"]]);
assert.strictEqual(paths.movement.stop(guard.id, "intruder"), false);
assert.strictEqual(paths.movement.setIdle(guard.id, "patrols", "stand", { x: 1, y: 2, z: 3 }), true);
assert.deepStrictEqual(paths.movement.get(guard.id), {
    state: { mode: "path", waypoint: 1, waypoints: 2, lap: 0, paused: false, targetId: 0 },
    waypoints: [{ x: 1, y: 2, z: 3, wait: 0, gait: "walk" }],
    idle: "stand",
    home: { x: 1, y: 2, z: 3 },
});
assert.throws(() => paths.movement.setIdle(guard.id, "patrols", "sleep" as never), /idle must be one of/);
assert.strictEqual(paths.waypoint(guard.id, 1, 0), true);
assert.strictEqual(paths.moveEnded(guard.id, "replaced"), true);
assert.strictEqual(paths.moveEnded(guard.id, "targetGone"), true);
assert.deepStrictEqual(events.map((event) => [event.name, event.payload.npc.resource, event.payload.index ?? event.payload.reason]), [
    ["hmp:npcs:waypoint", "patrols", 1],
    ["hmp:npcs:moveEnded", "patrols", "replaced"],
    ["hmp:npcs:moveEnded", "patrols", "targetGone"],
]);
assert.strictEqual(paths.moveEnded(9999, "arrived"), false, "an NPC this service does not manage is not forwarded");
assert.strictEqual(events.length, 3);

// Follow: the owner's alone, validated, and the host is handed only the target's id.
const leader = { id: 77, nickname: "Poppy" };
assert.strictEqual(paths.movement.follow(guard.id, "patrols", leader, { gait: "jog", distanceCm: 300, teleportBeyond: 0, then: "wander" }), true);
assert.deepStrictEqual(moves.at(-1), ["follow", { id: 77 }, { gait: "jog", distanceCm: 300, teleportBeyond: 0, then: "wander" }]);
assert.strictEqual(paths.movement.follow(guard.id, "intruder", leader), false, "another resource cannot lead it");
assert.throws(() => paths.movement.follow(guard.id, "patrols", { id: guard.id }), /cannot follow itself/);
assert.throws(() => paths.movement.follow(guard.id, "patrols", null as never), /target must be an entity/);
assert.throws(() => paths.movement.follow(guard.id, "patrols", { id: 0 }), /target id/);
assert.throws(() => paths.movement.follow(guard.id, "patrols", leader, { distanceCm: 50 }), /distanceCm/);
assert.throws(() => paths.movement.follow(guard.id, "patrols", leader, { teleportBeyond: -1 }), /teleportBeyond/);
assert.throws(() => paths.movement.follow(guard.id, "patrols", leader, { gait: "fly" as never }), /gait must be one of/);
walkers[0].movement = { mode: "follow", waypoint: 0, waypoints: 0, lap: 0, paused: false, targetId: 77 };
assert.deepStrictEqual(paths.movement.get(guard.id)?.state, { mode: "follow", waypoint: 0, waypoints: 0, lap: 0, paused: false, targetId: 77 });
// A 1.10 host walks paths but has no follow.
const pathsOnly = createNpcsService({
    config: { maximumManagedNpcs: 2, maximumPerResource: 2 },
    native: { create: (enemyId: string) => Object.assign(native.create(enemyId, 0, 0, 0), { moveAlong: () => true }) },
});
const plodder = pathsOnly.spawn({ resource: "patrols", enemyId: "Wolf", position: { x: 0, y: 0, z: 0 } });
assert.strictEqual(pathsOnly.movement.follow(plodder.id, "patrols", leader), false);

// Virtual worlds: the owner's alone, with the map passed only when given.
const placed: unknown[][] = [];
const placing = createNpcsService({
    config: { maximumManagedNpcs: 2, maximumPerResource: 2 },
    native: { create: (...args: Parameters<typeof native.create>) => Object.assign(native.create(...args), { setVirtualWorld: (...place: unknown[]) => { placed.push(place); } }) },
});
const instanced = placing.spawn({ resource: "dungeons", enemyId: "Inferius", position: { x: 0, y: 0, z: 0 } });
assert.strictEqual(placing.setVirtualWorld(instanced.id, "dungeons", 7, "Dungeon_Crypt"), true);
assert.strictEqual(placing.setVirtualWorld(instanced.id, "dungeons", 8), true);
assert.deepStrictEqual(placed, [[7, "Dungeon_Crypt"], [8]]);
assert.strictEqual(placing.setVirtualWorld(instanced.id, "intruder", 9), false);
assert.throws(() => placing.setVirtualWorld(instanced.id, "dungeons", -1), /virtual world/);
assert.throws(() => placing.setVirtualWorld(instanced.id, "dungeons", 1, 5 as never), /NPC map/);
assert.strictEqual(placed.length, 2);

// A host before NPC paths: the handle has no moveAlong, so every call is a plain false.
const older = createNpcsService({ config: { maximumManagedNpcs: 2, maximumPerResource: 2 }, native });
const still = older.spawn({ resource: "patrols", enemyId: "Wolf", position: { x: 0, y: 0, z: 0 } });
assert.strictEqual(older.movement.along(still.id, "patrols", route), false);
assert.strictEqual(older.movement.follow(still.id, "patrols", leader), false);
assert.strictEqual(older.movement.setIdle(still.id, "patrols", "wander"), false);
assert.strictEqual(older.movement.get(still.id), null);

console.log("hmp-npcs tests passed");

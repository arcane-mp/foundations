# hmp-npcs

`hmp-npcs` is the Foundation-owned NPC boundary. It exposes the enemy identifiers verified against
the Framework catalog, validates spawn requests, tracks ownership by resource, and destroys a
resource's NPCs automatically when that resource stops.

## Configuration

Copy `examples/config/data/hmp-npcs.json` to `<server-root>/data/hmp-npcs.json` to override the
default limits. `maximumPerResource` may not exceed `maximumManagedNpcs`.

## Server API

```ts
const npcs = Imports.get("hmp-npcs");

const enemy = npcs.spawn({
  resource: "my-gamemode",
  enemyId: "Goblin_Grunt",
  position: { x: 100, y: 200, z: 300 },
  yaw: 90,
  disposition: "hostile",
  ownerId: player.id,
  maxHealth: 250,
  scale: 1.1
});

npcs.catalog.list();
npcs.get(enemy.id);
npcs.setVirtualWorld(enemy.id, "my-gamemode", instance, player.location().areaId);
npcs.destroy(enemy.id, "my-gamemode");
npcs.clear("my-gamemode");
```

`yaw` is the heading in degrees the NPC spawns facing, -360 to 360: 0 faces +X and 90 faces +Y. It
needs HogwartsMP `1.11` or newer for `NPC.create`'s options form. An older host refuses that form, so
`spawn` falls back to the positional one and the NPC faces 0, as before.

`setVirtualWorld(id, resource, world, map?)` moves an NPC the resource spawned into a virtual world
within a map, where it meets the players in that world of that map, so world 7 of a dungeon is one
instance of it. `map` is a `player.location().areaId` (`"Overland"` or `""` for the shared map); left
out, the NPC keeps its map. It is false for an NPC another resource spawned. An NPC spawned with an
`ownerId` starts in that player's world and map by itself on a host that combines them.

Placing an NPC in a map's world needs HogwartsMP `1.10` or newer, whose `setVirtualWorld` takes a map. An
older host ignores `map` and keeps the bare world number, so outside Overland the NPC never reaches
the players in that world.

Wave composition, encounter behavior, rewards, and boss rules belong to the consuming gamemode.
The catalog documents inert or encounter-dependent entries but does not hide them.

## Movement

A resource walks the NPCs it spawned along paths, with the game's own pathfinding and locomotion on
the client that runs each NPC:

```ts
const guard = npcs.spawn({ resource: "my-gamemode", enemyId: "Poacher_Grunt", position: gate, disposition: "friendly" });

npcs.movement.along(guard.id, "my-gamemode", [
  { x: 100, y: 200, z: 300, wait: 5 },
  { x: 900, y: 200, z: 300, wait: 5, gait: "jog" }
], { loop: "pingpong" });

npcs.movement.to(guard.id, "my-gamemode", { x: 100, y: 200, z: 300 }, { then: "stand" });
npcs.movement.pause(guard.id, "my-gamemode");
npcs.movement.resume(guard.id, "my-gamemode");
npcs.movement.stop(guard.id, "my-gamemode");
npcs.movement.setIdle(guard.id, "my-gamemode", "wander", { x: 100, y: 200, z: 300 });
npcs.movement.follow(guard.id, "my-gamemode", player, { gait: "jog", distanceCm: 300 });
npcs.movement.get(guard.id); // { state, waypoints, idle, home }; state.targetId names whom it follows
```

- Points are at a player's origin height, as `player.position`. A path has 1 to 64 points, each with
  an optional `wait` in seconds and the `gait` of the leg that arrives there. `loop` is `"once"` (the
  default), `"loop"` or `"pingpong"`; `radius` and `speedScale` tune arrival and speed.
- A new path replaces the running one. A fight the NPC gets into holds the path, which continues once
  it is calm again.
- A `"once"` path ends in its `then` idle (default `"stand"`) at its last point, which becomes its
  home. `setIdle` sets what it does while no path runs: `"native"` (the game's own wander where it
  spawned), `"stand"` (hold at its home) or `"wander"` (roam around it).
- `follow` walks the NPC after a player, beast, NPC or Character (any other than itself) until `stop`
  or a new command. It rests inside `distanceCm` (100 to 3000, default 200) and walks again once the
  target pulls 100 cm past it; `teleportBeyond` (metres, default 60, `0` never) puts it beside a
  target it falls that far behind. `gait`, `speedScale` and `then` work as for a path, and `then` is
  taken up where it stands once the follow ends. A fight holds it as it holds a path, and it ends
  `"targetGone"` when the target leaves. The followed player's own client runs the NPC.
- Every call takes the resource that spawned the NPC and is false for any other, for a gone or dead
  NPC, and on a host without NPC movement, where `get` is null. Malformed input throws a `TypeError`,
  and `follow` throws when the host finds no live target.

Movement needs HogwartsMP `1.10` or newer for `NPC.moveAlong`. On an older host every call is false and
the NPC keeps the game's own behaviour. `follow` needs HogwartsMP `1.11` or newer for `npc.follow`; on
an older host it is false and `state.targetId` is 0.

## Events

```ts
Events.on("hmp:npcs:waypoint", ({ npc, index, lap }) => {
  if (npc.resource !== "my-gamemode") return;
  // reached waypoints[index], before its wait; lap counts completed laps
});
Events.on("hmp:npcs:moveEnded", ({ npc, reason }) => {
  // reason: "arrived", "stopped", "replaced", "unreachable" or "targetGone"
});
```

They forward the host's `npcWaypoint` and `npcMoveEnded` for NPCs this service manages, each with the
NPC's snapshot, whose `resource` is its owner. `"replaced"` comes before the new path's events. A path
a death ends may not be forwarded, because `npcDied` removes the NPC from `hmp-npcs`; watch `npcDied`
for deaths.

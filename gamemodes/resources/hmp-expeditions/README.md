# hmp-expeditions

`hmp-expeditions` is a cooperative gamemode. A party gathers at an expedition's entrance and fights
through its stages in order: each stage is a place on the map with a pack of real Hogwarts Legacy
enemies, and the last stage can hold a boss. When the last stage is cleared, every fighter still near
the fight earns experience, and the fastest clear becomes the expedition's server record. If the whole
party falls at once, or the time runs out, the expedition fails.

Expeditions are built in game: an editor stands at the entrance, then at each fight, and names the
enemies for it.

## Flow

1. The leader stands on the expedition's map and runs `/expedition host <id>`. This opens a public
   `hmp-expeditions:run` activity lobby (up to `maxParty` fighters).
2. Others on that map run `/expedition join [leader]`.
3. The leader runs `/expedition start`. The party is gathered at the entrance and held there through a
   countdown.
4. Each stage spawns its enemies on a ring round its point. Each party member sees the stage as a ring
   on the ground (red for a boss), with a HUD for the stage, the foes left and the time left. Enemy
   count grows by `enemiesPerExtraFighter` of the pack for every fighter past the first, and a boss's
   health by `bossHealthPerExtraFighter`. The enemies' ownership rotates across the party, so they
   spread their aggro.
5. When the last enemy of a stage falls, the next stage spawns after `stageDelaySeconds`. When the last
   stage falls, the expedition is cleared.

A fighter who goes down (`playerDowned`, `playerDied`) is counted down until they are back up
(`playerDownedEnd`). A fighter who retires with `/expedition leave`, or disconnects, is out of the run.
The run fails when every fighter left is down at once (a wipe). It also fails after
`timeLimitSeconds`, and is abandoned when the last fighter leaves. Whenever a run ends, the enemies it
left standing are removed.

Enemy counts grow with the party but stop at `maxEnemiesPerStage` after scaling, and at the slots
currently free in `hmp-npcs` (`npcs.status()`). The boss is spawned first and keeps its slot when a pack
is cut. A run with a stage cut below `maxEnemiesPerStage` for lack of free slots still pays on a clear,
since the final fight keeps its boss and the reward cooldown still holds, but it cannot set the record:
its time came from a smaller pack. A stage that spawns fewer enemies than it ordered fails the run: no experience, no record. That
covers a boss the runtime catalog lacks and `hmp-npcs` running out of room; a stage that finds no free
slot at all fails the run as it starts. Concurrent runs share the
`hmp-npcs` limit for this resource, so keep the cap low when several run at once. A standing enemy that
vanishes without `npcDied` (for example, on an `hmp-npcs` restart) also fails the run instead of waiting
for the time limit; the standing enemies are checked every two seconds while a run lasts, since no event
fires when `hmp-npcs` goes. A missing enemy gets five seconds for its `npcDied` first: `hmp-npcs` forgets an enemy on its own
`npcDied`, so when several die at once (an area spell), the others read as gone before their deaths
arrive.

## Instances

Instancing is experimental. The player contract offers only an optional `virtualWorld`, and the run
depends on the host accepting writes to it.

With `instanced: true`, each run puts its party, and every enemy it spawns, in a virtual world of its
own (the first free one from `firstVirtualWorld`). Two parties can then run the same expedition at once
without meeting, and the open world never sees their fights. Each fighter gets their previous virtual
world back when they leave or the run ends.

Moving a player sets `player.virtualWorld` and reads it back. The fallback only catches a host that
throws from that write: a plain property read back always matches, so a host that silently ignores the
write leaves the players in world 7000+ with the enemies in world 0, and the run can only time out.
Instancing is off by default for that reason. When the host refuses to instance an enemy
(`setVirtualWorld` returns false or throws), the run destroys that enemy and fails at once.

## Commands

```text
/expedition list
/expedition host <expedition>
/expedition join [leader]
/expedition leave
/expedition start
/expedition stop
/expedition status
```

`/expedition stop` is for the leader who is still in the run: a leader who has left it can no longer
stop it. It cancels a lobby, or ends a run unpaid. A run that started also raises its
`hmp-expeditions:finished` event when the resource stops.

## Building expeditions in game

Members of the `editorGroup` group at `editorGrade` or above (`admin`, grade 1 by default):

```text
/expedition edit new <id> [label]                      start a draft; the entrance is where you stand
/expedition edit stage <enemy> [xN]... [boss <enemy> [health]]
                                                       add a fight where you stand
/expedition edit undo                                  remove the last stage
/expedition edit entrance [yaw]                        move the entrance to where you are
/expedition edit reward <xp>                           experience for a clear (default 500)
/expedition edit save | discard
/expedition edit delete <id>
/expedition edit enemies [text]                        search the hmp-npcs catalog
/expedition edit export <id>                           write it to the server log as JSON
```

For example, `/expedition edit stage Goblin_Melee x3 Spider_Small boss Troll_Forest 6000` adds a fight
with three goblins, a spider and a troll boss with 6000 health. Every enemy id is checked against the
`hmp-npcs` catalog. An expedition holds 1-12 stages of up to six kinds of enemy each.

Saved expeditions live in the `expeditions` system of `hmp-worldstate`, one key per stage, since a
value holds at most 256 characters. A stage too long for one value is refused with a request to split
it. Clear-time records live in `expedition-records`.

## Configuration

`data/hmp-expeditions.json`, or the file `HMP_EXPEDITIONS_CONFIG` names (all optional):

```json
{
  "command": "expedition",
  "editorGroup": "admin",
  "editorGrade": 1,
  "maxParty": 4,
  "lobbyTtlSeconds": 600,
  "countdownSeconds": 5,
  "timeLimitSeconds": 1800,
  "stageDelaySeconds": 4,
  "enemiesPerExtraFighter": 0.5,
  "bossHealthPerExtraFighter": 0.75,
  "maxEnemiesPerStage": 24,
  "rewardCooldownSeconds": 3600,
  "rewardRadius": 4000,
  "instanced": false,
  "firstVirtualWorld": 7000,
  "expeditions": {
    "forgotten-ruins": {
      "label": "Forgotten Ruins",
      "areaId": "Overland",
      "experience": 500,
      "entrance": { "x": 0, "y": 0, "z": 0, "yaw": 0 },
      "stages": [
        { "x": 1000, "y": 0, "z": 0, "enemies": [{ "id": "Goblin_Melee", "count": 3 }] },
        { "x": 2000, "y": 0, "z": 0, "enemies": [], "boss": { "id": "Troll_Forest", "health": 6000 } }
      ]
    }
  }
}
```

The coordinates above are placeholders. Build real expeditions in game and `export` them. The
resource logs a warning for an enemy id the runtime catalog lacks. Expeditions in the file are
read-only in game. `maxEnemiesPerStage` runs from 1 to 256 and defaults to 24; `hmp-npcs` allows 256
per resource and 512 in total, all shared with other gamemodes. Each stage also stops at the slots free
in `hmp-npcs` when it starts. `rewardCooldownSeconds` runs from 0 (no cooldown) to 86400; it is read
from `hmp-progression` reward history, so a server restart does not clear it. That history is bounded:
the check reads the character's newest 200 rewards from every resource (the most `hmp-progression`
returns), so a character paid more than 200 times elsewhere inside the cooldown is not held by it.
`rewardRadius` is in centimetres, from 500 to 100000, and defaults to 4000 (40 m): the pack spawns on a
6 m ring round the stage's point and chases the party, and a fighter casting at the boss from range is
still in the fight.

## Events

Every run that started raises the server event `hmp-expeditions:finished` once, with an
`HmpExpeditionFinished` payload (see `types.d.ts`). The payload holds the result (`cleared`, `wiped`,
`timeout`, `abandoned`, `stopped` or `failed`), stages cleared, enemies defeated, duration, whether it
set the record, and each participant with whether they were paid. The experience goes through
`hmp-progression` by the reference `hmp-expeditions:<session>:<character>`, so a retry never pays twice.
A character also waits `rewardCooldownSeconds` between clear payments, read from progression history;
a participant on cooldown is reported unpaid. Only fighters still within `rewardRadius` of the last
fight's point when it clears are paid, so an idle member left at the entrance earns nothing.

## Foundations integration

- `hmp-activities` owns the lobby, area scope and lifecycle.
- `hmp-npcs` spawns, places, owns and removes the enemies, and checks enemy ids against its catalog.
- `hmp-progression` pays the experience.
- `hmp-worldstate` stores expeditions and records.
- `hmp-core` owns characters and the editor group check.

## Development

```text
npm run typecheck -w hmp-expeditions
npm test -w hmp-expeditions
npm run build -w hmp-expeditions
npm run smoke -w hmp-expeditions
```

`server/run.ts` is a run's progress (stages, enemies left, who is down) and holds no timers.
`server/service.ts` runs expeditions on it. `server/store.ts` stores expeditions and records and builds
drafts. The tests clear, wipe, time out and instance whole runs through a real `hmp-activities` service
on a fake clock.

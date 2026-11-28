# hmp-racing

`hmp-racing` is a broom-racing gamemode. A host opens a race on a track, others join its lobby, and the
host starts it: everyone is placed on a grid, held through a countdown, and then flies a course of
checkpoints, lap after lap. The server samples every racer's position and judges each gate, so no client
reports its own progress. Finishers get a time and a place, and in a ranked run a shot at the track record.

Racers fly their own broom or mount; the race does not hand one out.

## Flow

1. The host stands on the track's map and runs `/race host <track>`. This opens a public
   `hmp-racing:race` activity lobby.
2. Others on that map run `/race join [host]` (the host's name is only needed when several races are
   open).
3. The host runs `/race start`. Racers are put two abreast on the grid behind the start, facing the
   track's heading, and held there while the countdown runs. Fast travel is off for them until the race
   ends.
4. At "Go!" the hold lifts. Each racer sees their next gate in gold, the one after it faint, and the
   finish line in green, with a HUD for place, lap, gate and time.
5. The first finisher starts a grace period (`finishGraceSeconds`) for the rest. The race ends when
   everyone is done, the grace period runs out, or the time limit (`timeLimitSeconds`) passes. Results
   go to every racer in chat.

A racer is out of the race when they:

- retire with `/race leave` (in a lobby this just leaves it);
- fall (`playerDied`);
- disconnect;
- break the speed limit twice in a row. The first sample over the limit leaves the last good position
  in place and passes no gates; the next sample is measured from it. A second fast sample disqualifies
  the racer for teleporting.

A Floo pick from the map is refused while a racer is in the race. On a host that cannot refuse it, a
jump cannot score a gate: the position stays unchecked, so the next sample still measures over the
limit. A sample that repeats the last position, as a stalled one does, is skipped without moving
the clock, so the catch-up after lag is measured over the whole stall. Holding still this way never
covers more ground than flying at the limit would have.

## Commands

```text
/race tracks
/race host <track>
/race join [host]
/race leave
/race start
/race stop
/race top [track]
/race status
```

`/race top` lists each track's record and your own best. `/race stop` is for the host: it cancels a
lobby, or ends a running race where it stands, and anyone still flying does not finish.

## Building tracks in game

Members of the `editorGroup` group at `editorGrade` or above (`admin`, grade 1 by default) build tracks
by flying them:

```text
/race edit new <id> [laps] [label]   start a draft; the grid is where you stand
/race edit start [yaw]               move the grid to where you are (yaw in degrees, 0 = +X)
/race edit point [radius m]          drop a gate where you are (default defaultRadiusCm)
/race edit undo                      remove the last gate
/race edit laps <n>                  set the lap count
/race edit save                      store the track
/race edit discard                   drop the draft
/race edit delete <id>               delete an in-game track and its record
/race edit export <id>               write a track to the server log as JSON for data/hmp-racing.json
```

The editor sees the draft's gates while they build it. A track needs 2-64 gates of 1-50 m radius. The
last gate of the last lap is the finish line. On a circuit, put the last gate near the start; a
point-to-point track has one lap.

Saved tracks live in the `racing-tracks` system of `hmp-worldstate` (MySQL, server-only). Since a
worldstate value holds at most 256 characters, each track is stored as one key per gate. Track records
live in `racing-records`. Each character's personal bests are in `hmp-core` metadata under
`hmp-racing:bests`. Editing a track keeps its record, and deleting it deletes its record.

## Configuration

The defaults live in `server/config.ts`. A server can override them with `data/hmp-racing.json`, or with
the file `HMP_RACING_CONFIG` names. A bad value stops the resource at startup with the field it
rejected.

```json
{
  "command": "race",
  "editorGroup": "admin",
  "editorGrade": 1,
  "maxRacers": 12,
  "minimumRacers": 2,
  "lobbyTtlSeconds": 600,
  "countdownSeconds": 5,
  "finishGraceSeconds": 60,
  "timeLimitSeconds": 900,
  "tickMs": 100,
  "maxSpeedCmPerSecond": 15000,
  "gridSpacingCm": 300,
  "defaultRadiusCm": 800,
  "gatesAhead": 2,
  "tracks": {
    "village-sprint": {
      "label": "Village Sprint",
      "laps": 2,
      "areaId": "Overland",
      "start": { "x": 0, "y": 0, "z": 0, "yaw": 90 },
      "checkpoints": [
        { "x": 0, "y": 5000, "z": 800, "radius": 800 },
        { "x": 4000, "y": 9000, "z": 1200 }
      ]
    }
  }
}
```

The coordinates above are placeholders. Author real tracks in game and `export` them. Tracks in the
file are read-only in game, and an in-game track cannot take the id of one in the file.

`minimumRacers` is how many racers must finish or still be flying at the end for the run to be ranked.
Someone who left or fell out does not count, so a rival who quits just after "Go!" leaves the run
unranked. A host may still start alone, but the event's `ranked` flag is false, so reward listeners
can skip the run, and only ranked runs set the track record. Set it to 1 to reward solo runs.

`maxSpeedCmPerSecond` must sit above the fastest a mount flies on your server, boosts included. The
default, 150 m/s, is well above a broom's top speed and well below a fast-travel jump. Set it to 0 to
turn the check off. A first sample over the limit keeps the last good position and credits no gates;
a repeated position does not move the clock, so a lag catch-up is measured over the whole stall,
while a jump stays over the limit and disqualifies the racer.

## Foundations integration

- `hmp-activities` owns the lobby, membership, area scope and lifecycle.
- `hmp-worldstate` persists tracks and records.
- `hmp-core` owns characters, personal bests and the editor group check.
- `hmp-lib` owns command routing, configuration loading and logging.
- The host's `player.hold`, `teleport` and `setFastTravelEnabled` place racers and keep the race fair;
  on a host without one of them, that part is skipped.

## Events

Every race that started raises the server event `hmp-racing:finished` once, with an `HmpRacingFinished`
payload (see `types.d.ts`). The payload holds the track, a `ranked` flag and, for each racer, their
place, time, lap times, status, and whether they set the track record or a personal best. Rewards
belong to a listener; check `ranked` to skip solo runs:

```js
Events.on("hmp-racing:finished", ({ ranked, results }) => {
    if (!ranked) return;
    const winner = results.find((result) => result.place === 1);
    // ...
});
```

## Development

From the repository root:

```text
npm run typecheck -w hmp-racing
npm test -w hmp-racing
npm run build -w hmp-racing
npm run smoke -w hmp-racing
```

`server/race.ts` is the race itself (gates, laps, places and the speed check) and holds no timers.
`server/service.ts` runs races on top of it. `server/tracks.ts` stores tracks and records, and
`server/editor.ts` builds drafts. The tests drive a whole race through a real `hmp-activities` service
on a fake clock.

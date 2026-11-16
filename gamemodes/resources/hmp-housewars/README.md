# hmp-housewars

`hmp-housewars` is a team PvP gamemode in which Hogwarts houses fight each other for the House Cup.
Players join a battle as their character's house, and the houses fight elimination rounds in an
arena. The first house to win most of the rounds takes the match and House Cup points through the
`hmp-houses` ledger.

Every fight is non-lethal. A knocked-out fighter kneels and is out until the next round, the same way
an `hmp-duels` loser kneels.

## Flow

1. The host runs `/housewars host [arena]`. Without an arena, the battle is fought on open ground
   around where the host stands (`defaultArenaRadiusCm` across). This opens a public
   `hmp-housewars:battle` activity lobby with one team per house.
2. Others on that map run `/housewars join [host]`. Each player joins as their character's house; a
   character without a house cannot join.
3. The host runs `/housewars start`. This needs fighters from at least two houses, at most
   `maxImbalance` apart in numbers.
4. Each round, every house is put in its own corner of the arena, facing the centre, and held there
   through a countdown. At "Fight!" fighters of different houses become hostile to each other, with
   lock-on aim and a kneel finish, whatever the server's own PvP rules say. Housemates can never hurt
   each other. Every fighter is held inside the arena's circle until the round ends.
5. A round ends when one house is left standing (by elimination, or by forfeit if the others leave).
   If the round's time runs out first, the house with the most fighters still up takes it, and a level
   count is a draw. Between rounds everyone heals.
6. The match ends when a house has won most of the `rounds`, when only one house has fighters left,
   or after the last round. The winner gets `housePoints.win` plus `housePoints.participation`, and
   every other house that fought gets `housePoints.participation`.

A fighter who falls to anything other than a rival (`playerDied`) is down for the round. A fighter who
retires with `/housewars leave` or disconnects is out of the match. The activity keeps a retired
fighter as a member until the match ends.

## Commands

```text
/housewars arenas
/housewars host [arena]
/housewars join [host]
/housewars leave
/housewars start
/housewars stop
/housewars status
/housewars cup
```

`/housewars stop` is for the host. It cancels a lobby, or ends a running match with no winner and no
points. `/housewars cup` shows the House Cup standings.

## PvP

The battle sets a host pair override (`Pvp.setPair`) for every two fighters: hostile across houses
while both are up in a live round, and peaceful otherwise (during countdowns, between rounds, and
once one is knocked out). It also registers an `hmp-pvp` rule at priority 900. That rule floors every
hit across houses at `koHp`, so the loser kneels instead of dying, and refuses any other hit between
two fighters of the battle. An `hmp-duels` pair (priority 1000) still answers for itself. When the
battle ends, every pair is cleared and the fighters return to the server's own rules.

When the host has no room for the battle's pairs, the start is cancelled and everyone is let go.

## Configuration

`data/hmp-housewars.json`, or the file `HMP_HOUSEWARS_CONFIG` names (all optional):

```json
{
  "command": "housewars",
  "rounds": 3,
  "roundSeconds": 180,
  "countdownSeconds": 5,
  "intermissionSeconds": 8,
  "maxPerHouse": 4,
  "maxImbalance": 1,
  "lobbyTtlSeconds": 600,
  "defaultArenaRadiusCm": 2500,
  "koHp": 1,
  "housePoints": { "win": 50, "participation": 10 },
  "arenas": {
    "courtyard": { "label": "Transfiguration Courtyard", "areaId": "Overland", "center": { "x": 0, "y": 0, "z": 0 }, "radius": 2500 }
  }
}
```

`rounds` must be odd. The arena coordinates above are placeholders; stand where you want the arena
and read your position from your admin tools. A bad value stops the resource at startup with the
field it rejected.

## Events

Every match that started raises the server event `hmp-housewars:finished` once, with an
`HmpHouseWarsFinished` payload (see `types.d.ts`). The payload holds the houses, the winner, the score,
each round's result, each fighter's knock-outs and rounds survived, and the House Cup points
awarded. Each award's ledger reference is `hmp-housewars:<session>:<house>`, so a retried award is
never paid twice.

## Foundations integration

- `hmp-activities` owns the lobby, the house teams, area scope and lifecycle.
- `hmp-houses` supplies each character's house and pays the House Cup points.
- `hmp-pvp` takes the battle's rule.
- `hmp-core` supplies characters.
- `hmp-lib` owns command routing, configuration and logging.

## Development

```text
npm run typecheck -w hmp-housewars
npm test -w hmp-housewars
npm run build -w hmp-housewars
npm run smoke -w hmp-housewars
```

`server/match.ts` is the score (rounds, who stands, who wins) and holds no timers.
`server/service.ts` runs battles on it. The tests fight a whole match through real `hmp-activities` and
`hmp-pvp` services on a fake clock.

# hmp-housewars

`hmp-housewars` is a team PvP gamemode in which Hogwarts houses fight each other for the House Cup.
Players join a battle as their character's house, and the houses fight elimination rounds in an
arena. The first house to win most of the rounds takes the match and House Cup points through the
`hmp-houses` ledger.

Every fight is non-lethal. A knocked-out fighter kneels and is out until the next round, the same way
an `hmp-duels` loser kneels.

## Flow

1. The host runs `/housewars host [arena]`. Without an arena, the battle is fought on open ground
   around where the host stands (`defaultArenaRadiusCm` radius). This opens a public
   `hmp-housewars:battle` activity lobby with one team per house.
2. Others on that map run `/housewars join [host]`. Each player joins as their character's house; a
   character without a house cannot join.
3. The host runs `/housewars start`. Only a lobby opened by `/housewars host` can start. Every
   participant's house is re-read from `hmp-houses`, so a team changed with `/activities role` cannot
   pass. The lobby is read again after the checks, and anyone who joined or changed team meanwhile is
   checked too, until nobody in it is unchecked; the match is built from that lobby. It is read once more
   after the start, so a fighter who leaves during either await is not sent into the match. `/activities start` is refused on a hosted lobby; use
   `/housewars start`. The houses must number at least two, at most `maxImbalance` apart.
4. Each round, every house is put in its own corner of the arena, facing the centre, snapped to the
   ground and held there through a countdown. At "Fight!" fighters of different houses become hostile to each other, with
   lock-on aim and a kneel finish, whatever the server's own PvP rules say. Housemates can never hurt
   each other. Every fighter is held inside the arena's circle until the round ends.
5. A round ends when one house is left standing (by elimination, or by forfeit if the others leave).
   If the round's time runs out first, the house with the most fighters still up takes it, and a level
   count is a draw. Health recovery is on only for the `intermissionSeconds` between rounds; during a
   round fighters keep the health they have.
6. The match ends when a house has won most of the `rounds`, when only one house has fighters left,
   or after the last round. The winner gets `housePoints.win` plus `housePoints.participation`, and
   every other house that still has a fighter in the match at the end gets `housePoints.participation`;
   a house whose fighters all left gets nothing. Points are paid only after a round
   that ran `minPayoutRoundSeconds` or had KOs by `minPayoutKillers` different fighters, so a quick
   single knock-out, a fall, or a match of forfeits alone pays nobody. A match pays nobody if any
   character who fought in it, including one who left, fought in a match this gamemode paid within the
   last `housePointsCooldownSeconds`. The ledger rows record the characters (and player ids) of their
   match, so swapping one alt, reconnecting under a new player id or a restart does not reset it. A house
   can receive at most `housePointsDailyCap` points per day from this gamemode. Cooldowns and the daily
   total come from the `hmp-houses` ledger, so they survive a restart. The daily total is the ledger's
   own sum of this gamemode's rows for the house since local midnight (`points.total`), so other
   resources' rows on a busy day cannot push earlier payouts out of the count.

A fighter who falls to anything other than a rival (`playerDied`) is down for the round, and stands up
when released. A fighter who retires with `/housewars leave` or disconnects is out of the match and stood
up; the battle's PvP rule no longer treats them as a fighter. The match keeps them on its record with
`left: true`, so the finished event still lists them and their house beside the score. The activity keeps a
retired fighter as a member until the match ends.

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
two fighters of the battle. It vetoes a hit when only one side is a fighter, so outsiders cannot hit
fighters and fighters cannot hit bystanders. An `hmp-duels` pair (priority 1000) still answers for
itself. When the battle ends, every pair is cleared and the fighters return to the server's own
rules.

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
  "maxPerHouse": 2,
  "maxImbalance": 1,
  "lobbyTtlSeconds": 600,
  "defaultArenaRadiusCm": 2500,
  "koHp": 1,
  "housePoints": { "win": 50, "participation": 10 },
  "minPayoutRoundSeconds": 30,
  "minPayoutKillers": 2,
  "housePointsCooldownSeconds": 300,
  "housePointsDailyCap": 200,
  "arenas": {
    "courtyard": { "label": "Transfiguration Courtyard", "areaId": "Overland", "center": { "x": 0, "y": 0, "z": 0 }, "radius": 2500 }
  }
}
```

`rounds` must be odd. The arena coordinates above are placeholders; stand where you want the arena
and read your position from your admin tools. A bad value stops the resource at startup with the
field it rejected.

## Events

Every match that started raises the server event `hmp-housewars:finished` once, including when the
resource stops or the activity is cancelled from outside; those events have `stopped: true` and no
winner. The payload holds the houses, the winner, the score,
each round's result, each fighter's knock-outs and rounds survived (fighters who left are included with
`left: true`, and every house in `score` is in `houses`), and the House Cup points
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

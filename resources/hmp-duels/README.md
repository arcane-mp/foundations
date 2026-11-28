# hmp-duels

`hmp-duels` is Foundations's consensual, non-lethal one-on-one wizard duel resource. A challenge is a
private `hmp-activities` invitation; accepting creates an exclusive two-player session scoped to the
same game area and virtual world. Its `hmp-pvp` rule governs only that agreed pair, leaving other PvP
resources to own their own matches or zones.

An accepted duel is a host pair override (`Pvp.setPair`): peaceful through the countdown, then hostile
with lock-on and a kneel finish, whatever the server's own PvP rules say. The host decides who may hurt
whom for both clients, and natural health recovery is held off for the fight. When the duel ends the
override is cleared and the two return to the server's own rules.

The duel rule has higher priority than `hmp-pvp`'s open-world lethal fallback, so participants remain
floored and kneel-finished even while staff have lethal mode on for everyone else. Each hit is floored at
`koHp` on the victim's live health. The victim's own client kneels on the finishing hit and the host
reports it as `pvpDefeat`, which ends the duel; nothing trusts the server's possibly stale vitals report.
The client only presents the countdown, the opponent's health meter and the result, and holds dodge
off when the duel's rule says so.

The loser's kneel lasts as long as the server's PvP rules say (`kneelSeconds`, 4 s by default) and ends
by itself. On a server whose rules hold kneels (`kneelSeconds: 0`, down until `player.endKneel`), the duel
stands its loser up 4 s after the knock-out, or at once if `hmp-duels` stops first. This needs HogwartsMP
`1.10` or newer for `kneelSeconds` and `player.endKneel`; an older host's kneel always ends by itself.

`cosmeticGear: true` in `data/hmp-duels.json` (default `false`) makes both duelists' worn gear cosmetic
for the duel: from the countdown on, its Offense, Defense and Cooldown and its traits count for nothing,
as if neither wore any. However the duel ends (a knock-out, a forfeit, a death, a disconnect or
`hmp-duels` stopping), each player gets back the gear rules they had before it. This needs HogwartsMP
`1.10` or newer for `player.setGearStatMultiplier` and `player.setGearTraits`; an older host ignores the
option and worn gear counts as usual.

`dodge: false` (default `true`) keeps both duelists from dodging for the duel: from the countdown on, the
dodge button does nothing, covering the roll, the combat dodge and the Swift dash. Each duelist's client
takes it as `hmp-duels`'s own hold, so holds other resources take are left alone, and however the duel
ends each player can dodge again. This needs HogwartsMP `1.11` or newer for `LocalPlayer.setDodgeEnabled`;
on an older host duelists can still dodge, and each client logs one warning.

Commands (a player id takes a `#`, as in `/duel #5`):

```text
/duel <#playerId|exact nickname>
/duel accept
/duel decline
/duel cancel
/duel forfeit
/duel status
/duel rank [#playerId|nickname]
/duel top
/duel history [#playerId|nickname]
```

`rank`, `top` and `history` share one bucket of five queries per player in five seconds, so a player
cannot spam database reads from chat.

## Ranking

Every duel that began and has a winner is recorded against both duelists' characters, and the ones that
end the configured ways after the fight starts move an Elo rating. The characters are captured as the
countdown starts, so a duelist who leaves or switches character mid-duel still answers for that duel.
Ratings live in `hmp_duel_ratings` and every recorded duel in `hmp_duel_matches`, both created by
`hmp-duels`'s own migration. hmp-core soft-deletes characters: a deleted character keeps its row, but
drops out of `rank`, `top` and `history`, while its opponent's history keeps the duel.

- A character starts at `initialRating` (1000). Even ratings move by half of K; an upset moves more than
  an expected win, a win always gains at least one point, and no loss takes a rating below `floor`.
- During a character's first `provisionalMatches` duels it moves by `provisionalKFactor` (48), then by
  `kFactor` (32). Each side uses its own K.
- Only the endings in `ratedReasons` count: a knock-out, a forfeit or a disconnect by default. A duel
  that ends another way (`died`, unless listed) is kept in the history, unrated. A duel finished before
  the countdown ends is unrated, as is a forfeit within `minimumFightSeconds` (3 s) of the fight
  starting; quick forfeits cannot buy a free win.
- Two characters who duel each other more than `repeatLimit` rated times within `repeatWindowMinutes`
  play the rest unrated. The same count applies to the two accounts, stored as low and high account ids
  on the match row, so rotating characters does not reset it. `repeatLimit: 0` turns this off. The limit
  is a rolling window: after `repeatWindowMinutes` the pair can rate duels again.
- `dailyPairLimit` caps rated duels for one pair at 10 in 24 hours, character pair and account pair
  alike, so a pair cannot trade 72 wins a day by waiting out each hour. `dailyPairLimit: 0` turns it off.
- A character takes a rank after `minimumMatches` rated duels; ties share a rank. Only active characters
  appear in `rank`, `top` and `history`.
- A duelist without a loaded character fights as before, and the duel is not recorded.

After each recorded duel both duelists see their new rating (or why it was unrated), and the server raises
`hmp:duels:rated` with the match, both player ids and the reason it was left unrated, if it was. A player id
is nulled once that player no longer holds the character that fought: trust the match's character ids.

```js
Events.on("hmp:duels:rated", ({ match, winnerPlayerId, unrated }) => { /* ... */ });
```

The `ranking` export reads the same data for other resources:

```js
const ranking = Imports.get("hmp-duels").ranking;
await ranking.standing(characterId); // { rating, wins, losses, streak, bestStreak, rank, ... }
await ranking.leaderboard(10);
await ranking.history(characterId, 5);
```

`ranking` in `data/hmp-duels.json` (all optional):

```json
{
  "ranking": {
    "enabled": true,
    "initialRating": 1000,
    "kFactor": 32,
    "provisionalKFactor": 48,
    "provisionalMatches": 10,
    "floor": 100,
    "ratedReasons": ["ko", "forfeit", "disconnect"],
    "repeatLimit": 3,
    "repeatWindowMinutes": 60,
    "dailyPairLimit": 10,
    "minimumFightSeconds": 3,
    "leaderboardSize": 10,
    "minimumMatches": 1
  }
}
```

`enabled: false` records nothing, creates no tables, imports no `hmp-mysql` at runtime and answers the
ranking commands with an error. The resource manifest still declares `hmp-mysql` as a dependency, as
`hmp-core` and the rest of the pack do, so a database is required to load this pack. A value out of range
stops the resource at startup, as `hmp-duels`'s other settings do.

Challenge consent uses `hmp-ui`, whose bundled Arcanum renderer remains the default and whose external
renderer contract lets server owners replace the presentation. Input focus and control ownership are
therefore handled by `hmp-ui`/`hmp-lib`, not by duel-specific browser code.

The activity session owns exclusivity, invitation expiry, location compatibility, and disconnect
cleanup. This prevents one challenger from reserving several opponents or an old acceptance from
overwriting a newer duel pair.

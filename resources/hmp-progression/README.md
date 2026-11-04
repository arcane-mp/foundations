# hmp-progression

`hmp-progression` owns character-scoped experience, the last game-confirmed level, talent points,
Foundations-managed talents, and a replay-safe reward ledger. MySQL is authoritative; the client
reconciler applies an absolute snapshot through Hogwarts Legacy's native progression and talent APIs.

The resource does not accept unsolicited client XP. A modified client can still alter its local
single-player simulation, but it cannot award itself durable Foundations XP or invent a managed talent.
Native level and talent-point reports are accepted only for the exact character, revision, and XP
snapshot the server issued. Server gameplay should use this resource's profile for gates.

### Known limitation: kill experience does not persist

The host pays NPC kill rewards on the killer's client (the NPC `rewardPolicy`: the game's own kill reward
and any flat `experience`). The server is not told the amount, so nothing reaches this resource's ledger:
the experience appears in game, and the next synchronization (reconnect, character switch, or any
progression change) sets it back to the stored total. Field Guide knowledge and kill-challenge progress
from the same kills are unaffected. Award durable kill experience from a server resource with
`progression.add` on `npcDied` until the host reports kill rewards to scripts.

## Exports

`Imports.get("hmp-progression")` exposes:

- `progression.get(target)` — get or initialize a character profile.
- `progression.add(target, signedPoints, options)` — atomically adjust XP.
- `progression.set(target, points, options)` — atomically set absolute XP.
- `progression.setLevel(onlinePlayer, level, options)` — resolve that save's native level boundary and
  set XP to it.
- `progression.transaction(reference)`, `history`, `pending`, and `recover` — inspect/recover rewards.
- `progression.sync(player)` — resend the complete native snapshot.
- `talents.list(target, includeRevoked?)` — list Foundations-managed talent state.
- `talents.grant`, `purchase`, `revoke`, and `reset` — manage durable talent entitlements.
- `talents.setPoints(target, points, options)` — set the canonical unspent point pool.
- `flooFlames.list(target)` — a character's saved Floo flames, by FastTravelLocations id.
- `flooFlames.set(target, ids, lit?)` — light Floo flames for a character, or dim them with `false`; saved,
  and applied in game at once while the character is online. Resolves to its lit flames. Both reject
  while `flooFlames` is off.
- `status()` — readiness and reconciliation diagnostics.

Every XP mutation requires a stable `reference` and `resource`. Repeating the same operation with the
same reference returns its original transaction; reusing it for different input is rejected.

```ts
const { progression } = Imports.get("hmp-progression");

await progression.add(player, 250, {
    reference: `dungeon:${runId}:character:${characterId}`,
    resource: "rp-dungeons",
    reason: "completed dungeon",
    metadata: { dungeonId },
});
```

`talents.purchase` asks the player's native tree to validate the talent's prerequisites, then records
the entitlement and spends exactly one Foundations talent point. `talents.grant` is the administrative
path: it deliberately ignores native purchase gates and costs no point. Revocations are retained as
tombstones so a talent cannot return from the local save on reconnect.

## Floo flames

`flooFlames` (default `true`) keeps the Floo flames each character lights. Every connection starts from
the game's own flames, so a fresh character has none lit. A flame the player finds by standing at it is
saved for the selected character (`hmp_progression_floo_flames`), and when that character loads, its saved
flames are lit again once the player's world settles. Choosing another character in the same connection
dims the flames lit for the earlier one, so they never cross characters. A flame found with no character
selected is not saved. It needs HogwartsMP `1.11` or newer for `player.setFastTravelUnlocked`; an older
host logs a warning once and keeps no flames.

## Field Guide

`fieldGuide` (default `true`) keeps each character's Field Guide: its collections (pages, traits, beasts
and the rest), challenge progress and locks, and the world state that keeps a collected page collected.
The game holds it on the client, so the server keeps one snapshot per character
(`hmp_progression_field_guides`):

- When a character loads, the client waits for the game's Field Guide and restores the saved snapshot
  the way a save load does: nothing is collected, counted, paid or granted again.
- A character with nothing saved keeps what the game holds if it is the first one loaded in the
  connection. A later one starts with a clean Field Guide, so progress never passes between characters.
- Once the client confirms the restore, it gathers changes for two seconds and sends one snapshot, which
  the server stores for the selected character only. The snapshot is client input: the server checks its
  shape and refuses one over 512 KiB.
- A restore that fails keeps the saved snapshot, and nothing is saved until the character loads again.

The restore lands in a world that is already loaded: the Field Guide is right at once, but Revelio pages
and map icons show the restored state after the next map load, such as entering or leaving a dungeon.
Changes from the last two seconds before a disconnect or character switch are not saved. It needs
HogwartsMP `1.11` or newer for `FieldGuide` on the client; an older host logs a warning once and keeps no
Field Guide progress.

## Events

- `hmp:progression:changed` after a canonical XP or talent-point mutation.
- `hmp:progression:synchronized` after the game acknowledges the current absolute snapshot.
- `hmp:progression:talentChanged` after a managed grant, purchase, or revocation.
- `hmp:progression:talentsReset` after managed talents are reset.

## Closed-test command

`/progression status|talents|buy|add|set|level|grant|revoke|points|reset`

Status, managed talents, and buying for oneself are player-accessible. All other mutations require a
configured admin group. Disable the command after testing and use resource exports from gameplay and
administration resources in production.

# hmp-loot

`hmp-loot` replaces the game's own world loot with loot the server places: chests opened with F, moonstone
deposits broken with a spell, and foragables picked up with F. Each lootable is either taken once per
**character** or once in total (**shared**), comes back after its respawn time, and remembers who took it
across reconnects and restarts.

The Framework's `Lootables` builtin does the engine work — spawning the game's own Blueprint on every
client, stocking it, checking each take against what that player sees and adopting the items into the
player's inventory. `hmp-loot` owns the policy: which `hmp-core` character took what, when it respawns, and
what each character is offered when it loads.

It can also hand the game's own Overland moonstone deposits and foragables to the server (`gameLoot`):
each spot the game spawns becomes one copy for everyone instead of every player's own, emptied by a take
until it restocks. HogwartsMP runs the spots; `hmp-loot` picks the policy and tunes their respawn and yield.

The server build must carry the `Lootables` builtin and `World.suppressLoot`. Older builds log an error at
startup and place nothing.

## Configuration

Copy `examples/config/data/hmp-loot.json` to `<server-root>/data/hmp-loot.json`:

```json
{
  "command": "loot",
  "enableCommands": true,
  "adminGroups": [{ "key": "admin", "minimumGrade": 1 }],
  "suppressGameLoot": { "chests": true, "moonstones": true, "foragables": true, "pouches": true },
  "gameLoot": { "moonstones": "server", "foragables": "server" },
  "lootSpots": {
    "mode": "shared",
    "respawnSeconds": 4320,
    "kinds": { "foragables": { "respawnSeconds": 1800 }, "Moonstone_L": { "yield": [3, 5] } }
  },
  "lootables": [
    {
      "key": "courtyard-chest",
      "kind": "chest",
      "position": { "x": 366934, "y": -461327, "z": -82700 },
      "yaw": 180,
      "items": [{ "itemId": "Moonstone", "count": 5 }, { "itemId": "Back_002_Common" }],
      "scope": "shared",
      "respawnSeconds": 3600
    },
    {
      "key": "courtyard-eggs",
      "kind": "foragable",
      "position": { "x": 366934, "y": -461527, "z": -82700 },
      "items": [{ "itemId": "AshwinderEggs", "count": 3 }],
      "scope": "character",
      "respawnSeconds": 1800
    }
  ]
}
```

- `suppressGameLoot` switches the game's own chests, moonstones, foragables and coin pouches off
  (`World.suppressLoot`) while the resource runs, and back on when it stops. Families left out, or `false`,
  keep the game's loot. `pouches` needs HogwartsMP `1.9` or newer.
  The Overland spawns go from areas that load after startup, so a client that joins sees none.
- `gameLoot` picks who spawns the game's own Overland moonstone deposits and foragables while the resource
  runs: `"native"` (each player's game, with their own copy of every spawn), `"suppressed"` (nobody) or
  `"server"` (one copy of each of the game's spots for everyone, streamed to players within 150 m). A family
  `gameLoot` names wins over `suppressGameLoot`; one it leaves out follows `suppressGameLoot` (`true` is
  `"suppressed"`). `"native"`, the default, leaves the family as the resource found it. On stop, each family
  it changed goes back to the policy it found, so another resource's server spots are left running. It needs
  HogwartsMP `1.11` or newer for `World.setLootPolicy`; on an older host `"server"` logs a warning and the
  family follows `suppressGameLoot`.
- A take from a server spot goes into the taker's game inventory as a lootable's does, so `hmp-inventory`
  saves it with the character's other game items. Spot takes are not recorded: the host keeps which spots
  are empty for the server's run, and a server restart restocks them all.
- `lootSpots` tunes the server spots. `mode`: `"shared"` (the host's default) empties a spot for everyone,
  `"perPlayer"` for the taker only. `respawnSeconds`: 0 to 604800; the host's default, 4320, is three in-game
  days at the default time scale. `yield`: how many of its item a spot holds when it restocks, a whole number
  or `[min, max]` from 1 to 1000; the game's own count by default. `kinds` sets the last two per family
  (`moonstones`, `foragables`) or per kind (`Moonstone_S`, `Moonstone_M`, `Moonstone_L`, `AshwinderEgg_Nest`,
  `Horklump`, `LacewingFly`, `LeapingToadstool`, `LeechForagable`); a kind wins over its family, and both
  over the values for every kind. A kind the host does not list is logged and skipped, and anything left
  out keeps the host's setting. Settings last for the server's run. It needs HogwartsMP `1.11` or newer for
  `LootSpots`; an older host logs a warning and ignores it.
- `key` names a lootable for good: takes are recorded against it, so renaming one forgets who looted it.
- `kind` is `chest`, `moonstone` or `foragable`; `model` (a Blueprint class path) is optional and
  defaults to a Hogwarts chest, the small moonstone deposit, or the foragable the game uses for the item.
- `items` are `InventoryCatalog` ids. Moonstones and foragables hold plain items only (no gear), and a
  foragable holds one stack. A lootable the builtin refuses is logged and listed as not placed.
- `scope: "character"` (the default): every character may take it once until it respawns. A player is
  offered nothing before a character loads. `scope: "shared"`: the first taker empties it for everyone.
- `respawnSeconds`: seconds from the take until it is back. Leave it out for loot that never comes back.
- A lootable counts as taken from the first item out of it. Whatever is left stays with the taker until it
  respawns.

`HMP_LOOT_CONFIG`, `HMP_LOOT_COMMAND` and `HMP_LOOT_COMMANDS` override the file path, command name and
command enablement. Restart the server after changing the file.

## Commands

`/loot` is gated by `adminGroups` (effective `hmp-core` groups):

| Command | Effect |
|---|---|
| `/loot status` | resource state, placed lootables and live takes |
| `/loot list` | every configured lootable: kind, scope, respawn, whether it is taken or failed to place |
| `/loot reset <key> [characterId]` | end one character's take, or every take of the lootable, so it is back now |

## Server API

```ts
const loot = Imports.get("hmp-loot");

loot.lootables.list();                       // definitions with their Lootables id and shared take
loot.lootables.get("courtyard-chest");
loot.lootables.record("courtyard-eggs", 42); // a character's live take, or null
loot.lootables.reset("courtyard-eggs", 42);  // or reset(key) for every take
loot.lootables.onTaken((take) => {
    // { key, characterId, accountId, takenAt, respawnAt, player, items }
});
loot.status();                               // also suppressedGameLoot and the gameLoot policy it set
```

## Events

```ts
Events.on("hmp:loot:spotTaken", ({ player, characterId, accountId, spotId, kind, family, items }) => {
    // A take from one of the game's own spots under "server"; the items are already the player's.
    // kind: "Moonstone_L", "Horklump", ...; family: "moonstones" or "foragables".
});
```

`HmpLootSpotTake` in `types.d.ts` describes the payload. It is raised for every server spot take while
`hmp-loot` runs, whichever resource set the policy; `characterId` is null for a player without a character.

## Database

One table, `hmp_loot_takes`, keyed by `(lootable_key, character_id)`; a shared take uses character id `0`.
Times are epoch milliseconds. Expired rows are deleted as they expire and at startup; rows of a lootable no
longer in the config are kept, so adding it back remembers its takes.

# hmp-emotes

`hmp-emotes` is Foundations's server-curated emote system. It migrates the proven HogwartsMP animation
browser and native playback paths while replacing legacy roles and storage with Foundations groups,
account metadata, MySQL overrides, command routing, rate limits, and input ownership.

HogwartsMP provides two synchronized playback lanes:

- AnimSequence clips use `LocalPlayer.playClip()` and replicate as durable state, so a held sitting pose
  remains visible to players who stream in later.
- Able abilities use `LocalPlayer.playAbility()` and replicate as transient animation edges.

The native layer also replays supported prop and sound notifies, supplies the preview figure, and owns
exact world placement. Foundations owns names, permissions, favorites, persistence, commands, and UI.

## Configuration

Copy `examples/config/data/hmp-emotes.json` to the server's `data` directory. Aliases may be a path or
an object containing `path`, `kind`, and `channel`:

```json
{
  "aliases": {
    "wave": {
      "path": "/Game/Pawn/Student/Abilities/PartialBody/Waving/ABL_Waving.ABL_Waving_C",
      "kind": "ability",
      "channel": "PartialBody"
    }
  }
}
```

Normal players see only server-allowed rows by default. Members of an `editorGroups` entry see the
complete 11,361-entry candidate catalog and can check or uncheck the server-allowed box beside each
favorite star. Allowing a row generates a stable command alias; right-click remains available when an
editor wants to rename that alias. The **Server alias** cell is also directly clickable: entering a name
creates or renames the shared `/e <name>` command, and clearing it removes that row from curated mode.
Set `allowAll` to `true` if every player should receive and use the
complete discovery browser instead:

```json
{
  "allowAll": true
}
```

Temporary `hmp-admin` bootstrap access is intentionally not a durable `hmp-core` group. To use emote
curation during closed testing, assign yourself an `editorGroups` group such as account group `admin`
grade 1 from the admin menu. With `allowAll` enabled, every row is policy-allowed and the per-row
curation boxes are read-only until the server returns to curated mode.

Alias precedence is deterministic:

```text
configuration → runtime resource registration → persistent database override
```

A database tombstone hides a configured or registered name without modifying its source. Live edits are
stored in `hmp_emote_aliases` with the editor's account ID and update time. Favorites are account-scoped
under the `hmp-emotes:favorites` core metadata key and capped to keep event payloads below the Framework
limit.

Environment overrides are `HMP_EMOTES_CONFIG`, `HMP_EMOTES_COMMAND`, `HMP_EMOTES_ENABLED`,
`HMP_EMOTES_ALLOW_ALL`, and `HMP_EMOTES_UI_URL`. `HMP_EMOTES_BROWSE_UNALIASED` and the equivalent
configuration property remain accepted as compatibility names for `allowAll`.

## Player activities

The host also plays the game's own pastimes on a player, each with a companion it animates: a kite on
its rope, fireworks from the wand, a rain cloud overhead, a Golden Snitch, the One Man Band, a Howler, a
living book and a self-shuffling deck of cards. Every player sees them, including players who arrive later.
These are not `hmp-activities` lobbies; they are emotes with a companion, so `hmp-emotes` offers them.

| Activity | Variants |
|---|---|
| `kite` | `gryffindor`, `hufflepuff`, `ravenclaw`, `slytherin`, `kelpie`, `occamy`, `phoenix`, `swoopingevil` (default: the player's house) |
| `fireworks` | none |
| `raincloud` | `rain`, `snow` (default: snow in winter) |
| `snitch` | none |
| `band` | none |
| `howler` | `female`, `male` (default: either); it bursts and ends itself once it has had its say |
| `livingbook` | `fireflies`, `snow`, `leaves`, `runes`, `constellations`, `ghost`, `storm`, `pranks`, `dragons` |
| `cards` | none |

Players start one with `/e <activity> [variant]` or from the menu's Activities tab, and end it with
`/e stop`, the tab's Finish, walking away or playing an emote. An emote alias with an activity's name wins
over the activity. The `activities` config lists the ones offered, all eight by default; `[]` offers none:

```json
{
  "activities": ["kite", "fireworks", "snitch"]
}
```

Player activities need HogwartsMP `1.11` or newer for `player.startActivity` and
`LocalPlayer.startActivity`. On an older host none are offered or started, the command says what it
needs, and the server logs one warning.

## Commands

- `/e <name>`, `/emote <name>` plays a named emote.
- `/e <activity> [variant]` starts a player activity, such as `/e kite ravenclaw`.
- `/e m`, `/emote menu`, or `/emotemenu` opens the picker.
- `/e c`, `/emote stop` releases the current emote, activity and any placement anchor.
- `/emotes` lists server-curated names and the activities offered.
- `/playability` is an editor-only diagnostic.

## Server API

- `emotes.list/get/play/stop`
- `aliases.register/unregister/list/get/set/allow/deny/hide/clearPath`
- `favorites.list/toggle`
- `ui.open/close/sync`
- `activities.list/start/finish/get`
- `status()`

Runtime registrations require a `resource` owner and are removed when that resource stops. Database
overrides intentionally remain because they represent server-owner curation.

## Replaceable UI

Arcanum is the default renderer. Set `ui.url` to another resource URL or HTTPS URL to replace the entire
picker. The client validates and announces contract `hmp.emotes.ui/v1`.

Native-to-page events are `configure`, `em:focus`, `em:favs`, `em:aliases`, `em:activities`, and `em:dump`.
Page-to-native events are `ready`, `play`, `stop`, `preview`, `previewTune`, `previewDump`, `previewToggle`,
`place`, `favToggle`, `aliasSet`, `activity`, `activityFinish`, and `close`. A replacement that ignores
`em:activities` simply offers no activities. A replacement may ship its own curated catalog instead of the large
discovery asset file.

Placement suppresses pawn input while preserving camera look and anchors the character after committing.
Every stop, cancellation, resource shutdown, and startup recovery path releases that state so a player is
not stranded in a pose.

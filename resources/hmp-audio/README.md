# hmp-audio

`hmp-audio` is the shared Wwise playback service for Foundations resources. It keeps the native
HogwartsMP audio capabilities—game events, positional attenuation, attached playback, automatic bank
discovery, authored stop events, and custom banks—while adding ownership, aliases, audience helpers,
limits, diagnostics, and cleanup across resource reloads.

A sound is a Wwise event name. Hogwarts Legacy ships roughly 6,300 of them, such as
`UI_Menu_Select`, `accio_cast`, and `Amb3D_Storm_ThunderClaps_Play`. An alias is only a convenient
server-defined name for one of those events.

## Server playback

Declare `hmp-audio` as a resource dependency, import it, and identify the calling resource:

```ts
import type { HmpAudioServer } from "../../hmp-audio/types";

const Audio = Imports.get<HmpAudioServer<Player>>("hmp-audio");
const owner = { resource: "hmp-brewing", id: "cauldron-12" };

const handle = Audio.sounds.playAt(
    owner,
    "brewdone",
    { x: cauldron.x, y: cauldron.y, z: cauldron.z },
    { range: 12_000 },
);

if (handle) Audio.sounds.stop(owner, handle);
```

Available server scopes are:

- `playAt(owner, event, position, options)` — spatialized at a fixed point and delivered within range;
- `playOnPlayer(owner, player, event, options)` — attached to the player's body and heard nearby;
- `playForPlayer(owner, player, event, options)` — private at one player's listener;
- `playForPlayers(owner, players, event, options)` — private at each member of an explicit audience;
- `playForAll(owner, event, options)` — non-positional at every player's listener.

Every successful play returns a Foundations handle. Only its owner can stop it. Calling
`sounds.release(owner)` stops that owner's live sounds; when a resource stops, hmp-audio does this for
every scope belonging to that resource automatically.

`range` is measured in centimetres and defaults to 10,000 (100 m). It controls delivery; the event's
own Wwise attenuation still controls volume. `range: 0` asks the native server API to deliver to all
connected players.

## Held sounds and duration

The native runtime knows authored play/stop pairs from the game's soundbanks. For example,
`accio_cast` maps to `accio_release`. hmp-audio retains those handles until they are explicitly stopped:

```ts
const handle = Audio.sounds.playOnPlayer(owner, player, "accio");
// Later: posts accio_release and stops the playing id.
Audio.sounds.stop(owner, handle!);
```

Give a sound a duration to let each receiving client end it without another server round trip:

```ts
Audio.sounds.playAt(owner, "accio", position, { duration: 5 });
```

One-shot handles are forgotten after `oneShotHandleMs` (60 seconds by default). Known sustains remain
tracked. For a custom sustain whose bank does not expose a known terminator, pass `held: true` so its
handle remains available until stop or resource cleanup. `held` is a Foundations bookkeeping option
and is not forwarded to the native runtime.

## Aliases and discovery

Aliases come from `data/hmp-audio.json` and are synchronized to clients. Raw event names always work:

```ts
Audio.catalog.resolve("click");            // UI_Menu_Select
Audio.catalog.bankFor("accio");            // Spells_Accio_AKB
Audio.catalog.stopEventFor("accio");        // accio_release
Audio.catalog.list("menu");
```

Gameplay resources may register aliases dynamically. Alias ownership is exclusive so two resources
cannot silently redefine the same name, and registrations disappear when their owner stops:

```ts
const unregister = Audio.catalog.register(
    { resource: "hmp-dueling", id: "catalog" },
    { roundstart: "Dueling_Round_Start_Play" },
);
```

## Custom soundbanks

Custom banks must already be distributed to clients under
`Phoenix/Content/WwiseAudio/Windows/<Bank>.bnk`. Leases prevent one resource from unloading a bank
that another resource still uses:

```ts
Audio.banks.acquire({ resource: "hmp-dueling" }, "MyServerBank");
Audio.sounds.playForAll({ resource: "hmp-dueling" }, "MyTheme_Play", {
    bank: "MyServerBank",
    held: true,
});
```

The native `bank` play option loads before posting, but explicit `banks.acquire` is recommended for
preloading and custom content. The final owner release unloads the bank. Resource shutdown releases
all of that resource's leases.

## Client-local playback

Client resources import `HmpAudioClient`. This is appropriate for menu feedback or a sound whose
decision is entirely local:

```ts
const Audio = Imports.get<HmpAudioClient>("hmp-audio");
const owner = { resource: "hmp-wardrobe", id: "menu" };

Audio.sounds.play(owner, "click");
Audio.sounds.playAt(owner, "Custom_Preview_Play", previewPosition, { bank: "WardrobeBank" });
```

Client and server expose the same `catalog`, `banks`, `status`, ownership, stop, release, get, and list
concepts. Server handles and client-local handles are separate and cannot stop one another.

## The game's own dialogue

`dialogue` mutes the game's own spoken lines on every client, by who says them
(`Audio.setDialoguePolicy`): `player` (each client's own character: spell incantations, mount and
exploration remarks, its grunts), `players` (other players' bodies), `npcs` (NPCs from `NPC.create`),
`characters` (Characters from `Character.create`), `world` (the game's own people, such as townsfolk,
students, vendors and ghosts, and lines posted at a spot) and `floo` (the Floo Network's announcer). Each
takes `true` (every line), `"nonverbal"` (only the grunts, breaths, laughs and gasps) or `false` (none). A
muted line never starts: no sound, no subtitle, no lip movement. Players who join later get it too.

```json
"dialogue": { "world": false, "floo": false, "player": "nonverbal" }
```

The default `{}` leaves every speaker to the host, where every line plays. hmp-audio writes only the
speakers it names: it applies them at start and hands each back to what the host had when it stops.
Gameplay resources hold speakers through the `dialogue` export, owner-scoped like sounds and bank leases:

```ts
Audio.dialogue.set({ resource: "hmp-dueling" }, { world: false });
Audio.dialogue.current(); // { ..., world: false, floo: true }
Audio.dialogue.release({ resource: "hmp-dueling" });
```

A speaker takes its most recent hold, then the configured `dialogue`, then what the host had. A hold is
dropped when its resource stops; a further `set` by the same owner merges into it. An unknown speaker or
mode throws. It needs HogwartsMP `1.11` or newer for `Audio.setDialoguePolicy`; on an older host a
configured `dialogue` logs a warning, `current()` is `null`, `set` returns `false`, and every line plays.

## Configuration and closed-test command

Copy `examples/config/data/hmp-audio.json` to the server's `data` directory. Supported fields are:

- `aliases` — shorthand to Wwise-event mappings;
- `defaultRange` — default positional delivery range in centimetres;
- `maxActivePerOwner` — guard against an owner leaking handles;
- `oneShotHandleMs` — how long a one-shot remains stoppable and visible to diagnostics;
- `enableCommands` and `command` — enable the self-scoped `/audio` test command;
- `dialogue` — the game's own spoken lines, by who says them (see above).

`/audio list`, `/audio play <event> [range]`, `/audio local <event>`, `/audio stop <handle>`, and
`/audio status` only inspect or play sounds for the caller. The resource deliberately does not ship a
public server-wide sound, bank, or stop-all command.

Environment overrides are `HMP_AUDIO_CONFIG`, `HMP_AUDIO_RANGE`, `HMP_AUDIO_MAX_ACTIVE`,
`HMP_AUDIO_HANDLE_MS`, `HMP_AUDIO_COMMANDS`, and `HMP_AUDIO_COMMAND`.

## Deliberate v1 exclusions

The native music priority stack, global RTPCs, global states, and engine-wide stop-all remain outside
the Foundations contract. The current native music stack cannot restore the game's score, and a music
event name can only be pushed once per client session. RTPC and state writes likewise cannot restore
the previous owner's value. Those operations remain available through the low-level native `Audio`
builtin for specialized resources that knowingly accept those global side effects.

Positional sounds use temporary Wwise game objects. Stopping their playing id works, but an
object-scoped authored terminator may not reach that temporary object; player-attached and private
sounds have stable game objects.

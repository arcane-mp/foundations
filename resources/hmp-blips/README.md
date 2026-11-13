# hmp-blips

`hmp-blips` is Foundations's authoritative registry for Hogwarts Legacy map, minimap, HUD-compass,
search-area, and remote-player markers. Gameplay resources register intent on the server; this
resource owns the shared native `Blips` keyspace, resolves audiences, and keeps every client converged.

It replaces the mod repository's production `blips` resource. Do not migrate or load `blips-dev` on
a production server; its style probes and internal dumps remain development tooling.

## World markers and search circles

Declare `hmp-blips`, then upsert a marker with an owning resource and stable id:

```ts
import type { HmpBlipsServer } from "../../hmp-blips/types";

const Blips = Imports.get<HmpBlipsServer<Player>>("hmp-blips");

await Blips.markers.upsert({
    resource: "hmp-shops",
    id: "ollivanders",
    kind: "marker",
    position: { x, y, z },
    icon: "UI_T_MiniMap_Waypoint",
    label: "Ollivanders",
    ttl: 0,
    areaId: "Hogsmeade",
});
```

The native key becomes `hmp:<resource>:<id>`, so two resources may use the same local id without
colliding. Upserting the same resource/id moves or restyles the existing marker and restarts its TTL.
Only its owner can remove it:

```ts
Blips.markers.remove("ollivanders", "hmp-shops");
```

When the owning resource stops, all of its markers and player groups are removed automatically.

Search circles use the same API. Their radius is in **metres**; world positions remain centimetres:

```ts
await Blips.markers.upsert({
    resource: "hmp-dispatch",
    id: `trace:${caseId}`,
    kind: "circle",
    position: lastKnownPosition,
    radius: 120,
    ttl: 300,
    audience: { groups: [{ key: "job:auror" }] },
    areaId: lastKnownArea,
});

Blips.markers.pulse(`trace:${caseId}`, "hmp-dispatch");
```

Markers support `icon`, `label`, `showOnHud`, and `showDistance`. An icon must name a safe native
compass style; the Framework rejects types without a `UI_DT_CompassStyles` row because the game
otherwise dereferences a missing style and crashes.

## TTL and replay

TTL is measured in seconds. Omitting it uses `defaultTtl` (600 seconds by default), while zero requests
a permanent marker. `maxTtl` can clamp every request—including permanence—to a hard ceiling.

Expiry occurs on the server and issues an ordinary removal. A late joiner receives only currently
live markers they are allowed to see. TTL is a leak backstop, not the primary lifecycle: remove a
marker as soon as the owning event ends.

## Audiences

An omitted audience means every connected player. Audiences may also be player/id iterables, resolver
functions, or declarative selectors:

```ts
audience: {
    groups: [
        { key: "job:auror", minimumGrade: 1 },
        { key: "dispatch" },
    ],
    groupMode: "any",
    areaId: "Hogwarts",
    regionId: "SouthWing",
    virtualWorld: 0,
    where: async (player) => isOnDuty(player),
}
```

Group requirements use hmp-core's effective account/character groups, including groups projected by
hmp-jobs. Resolvers and predicates are evaluated again for updates and replay, once per refresh however
many players are watching. hmp-core's group answers are kept between refreshes until hmp-core reports
a group change, a character being selected or unloaded, or a session starting or ending, or 30 seconds
pass. If a resolver, predicate, or group lookup throws or gives no answer within 5 seconds, it resolves
to nobody—scoped markers never fail open—without holding up the other markers and groups, and a failed
group lookup is asked again at the next refresh.

Top-level `areaId`, `regionId`, and `virtualWorld` scope the marker itself. This is recommended for
every coordinate-based marker: identical numbers do not identify the same place across game areas.
`playerLocationChanged`, `hmp:groups:changed`, `hmp:jobs:duty`, character selection and unload, and
sessions starting and ending automatically refresh audiences. A location, group, character or session
change refreshes the markers of the player it is about, and a duty change everyone's. Call
`markers.sync()` after another application-specific resolver changes, or when an audience depends on
other players' groups or locations.

## Player tracking groups

Player groups independently define subjects (whose icons exist) and audience (who sees them):

```ts
await Blips.players.track({
    resource: "hmp-jobs",
    id: "on-duty-aurors",
    subjects: {
        groups: [{ key: "job:auror" }],
        where: (player) => Jobs.duty.isOnDuty(player, "auror"),
    },
    audience: { groups: [{ key: "job:auror" }] },
    color: [0.2, 0.5, 1.0, 1.0],
    priority: 20,
    sameArea: true,
    sameVirtualWorld: true,
});
```

Presence is the union of every matching group. Color is selected separately from the highest-priority
group that supplies one, so a colorless party group can add someone without removing their Auror
color. Equal priorities keep the earlier incumbent.

`sameArea`, `sameRegion`, and `sameVirtualWorld` compare each subject with each viewer. A subject is
never shown to themselves.

With `showAllPlayers: true` (the compatibility default), native remote-player blips remain visible and
groups only recolor them. Set it to false for the GTA-RP shape where only registered party/job groups
appear. This hides an icon, not network state; it is not a stealth or security mechanism.

Call `players.refresh()` when a custom subject/audience predicate changes. Connect, disconnect,
location, hmp-core group and character, and hmp-jobs duty changes refresh automatically: the events of
the next 200 ms are gathered into one refresh, which runs after the handlers that raised them. A client
is sent its view only when it changed, or in full when its blips resync.

## Map waypoints

The waypoint a player drops on the game's own map is theirs, not a marker. Each client reports it to the
server as it is placed, moved or lifted, so a resource can read it and hear about it:

```ts
Blips.waypoints.get(player); // { x, y, z, target, areaId } | null

Events.on("hmp:blips:waypoint", ({ player, waypoint, previous }) => {
    // waypoint is null once it is lifted
});
```

`x`, `y`, `z` are world centimetres. Dropped on a map icon, the waypoint sits on it and `target` is the
icon's beacon name (`"FT_HW_GreatHall"`); on open ground `target` is null and `z` is near the terrain,
not on it, so trace down before standing anyone there. `areaId` is the map the player was in when they
placed it. A waypoint is forgotten when its player leaves.

A resource can share a player's waypoint with chosen players. The share is a marker owned by its
resource and id, so the usual audiences, ownership and cleanup apply:

```ts
await Blips.waypoints.share({
    resource: "hmp-party",
    id: `party:${partyId}:${leader.id}`,
    player: leader,
    audience: members,
    label: "Leader",
});
Blips.waypoints.unshare(`party:${partyId}:${leader.id}`, "hmp-party");
```

The marker follows the waypoint while it moves, goes while it is lifted and comes back when the player
drops another, scoped to the waypoint's map. It never shows to the sharer, who has the game's own. It
defaults to the game's waypoint icon and the sharer's nickname, asks for permanence (so `maxTtl` still
clamps it), and ends with `unshare`, `waypoints.clear(resource)`, the owning resource stopping or the
sharer leaving. Call `markers.sync()` after the audience changes, as for any marker. Nothing is shared
unless a resource asks.

Waypoints need HogwartsMP `1.10` or newer for `Blips.waypoint`. On an older host clients report none, so
`waypoints.get()` is null and a share shows nothing.

## The game's own map icons

`nativeIcons` in the config hides the game's own icons (shops, Floo Flames, collectibles, quests...) on the
map and the minimap, and retitles their tooltips, for every player:

```json
"nativeIcons": {
    "hide": ["treasurechest", "demiguise"],
    "labels": {
        "HM_JPippensPotions": { "title": "Apothecary", "description": "Run by the Potions club." }
    }
}
```

A `hide` entry is a category, such as `"fasttravel"` or `"locationshogsmeade"`, or else one icon's id; case
doesn't matter, and icons that stream in later are hidden too. An id rule beats a category rule. `labels`
gives an icon id a new tooltip `title`; `description` replaces the game's, `""` hides it and leaving it out
keeps it. The client's `MapIcons.categories()` and `MapIcons.list()` name every category and icon.

Each client applies it as `hmp-blips`'s own rules when it joins, and they go when `hmp-blips` stops. Script
markers are never affected. Nothing is hidden or retitled by default.

The game's own icons need HogwartsMP `1.11` or newer for `MapIcons`. An older host leaves them as they are,
and each client logs one warning when the config asks for something.

## Configuration

Copy `examples/config/data/hmp-blips.json` into the server's `data` directory. It controls:

- `defaultTtl`, `maxTtl`, and `maxMarkersPerResource`;
- `showAllPlayers`, `houseTint`, `playerBlipScale`, and `hideBaseIcon`;
- `nativeIcons` for the game's own map icons;
- `enableCommands` and `command` for the private closed-test command.

Environment overrides are `HMP_BLIPS_CONFIG`, `HMP_BLIPS_DEFAULT_TTL`, `HMP_BLIPS_MAX_TTL`,
`HMP_BLIPS_MAX_MARKERS`, `HMP_BLIPS_SHOW_ALL`, `HMP_BLIPS_HOUSE_TINT`,
`HMP_BLIPS_PLAYER_SCALE`, `HMP_BLIPS_HIDE_BASE`, `HMP_BLIPS_COMMANDS`, and `HMP_BLIPS_COMMAND`.

## Closed-test commands

The bundled command only creates private markers at the caller's current location:

```text
/blips status
/blips list
/blips marker [ttl]
/blips circle [radiusMetres] [ttl]
/blips pulse
/blips remove
/blips waypoint
```

`/blips waypoint` replies with the caller's map waypoint as the server has it.

Style dumps, memory probes, global recoloring, and other `blips-dev` commands are deliberately absent.

## Client ownership

The client bundle is intentionally a mirror rather than a public write API. It applies full replay,
incremental set/remove, pulse, player visibility, and color messages to the native `Blips` builtin and
the `nativeIcons` config to `MapIcons`, and reports the player's own map waypoint back.
On shutdown it clears script markers, drops its native icon rules and labels, and restores normal
all-player tracking, house tint, scale, and base-icon visibility so hot reload cannot strand stale UI state.

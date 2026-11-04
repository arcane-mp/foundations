# hmp-houses

`hmp-houses` is Foundations's character-scoped Hogwarts house and House Cup service. It keeps durable
membership and point history in MySQL, projects membership into `hmp-core` groups, and applies the
selected character's house through the mod's native `player.house` property.

## Membership

```ts
const Houses = Imports.get("hmp-houses");

await Houses.membership.set(player, "gryffindor", {
    resource: "hmp-sorting",
    actor: player,
    reason: "Sorting ceremony",
});

const membership = await Houses.membership.get(player);
await Houses.membership.clear(player, {
    resource: "hmp-admin",
    actor: administrator,
    reason: "Correcting an invalid assignment",
});
```

Membership belongs to the active character, not the account or network player. On character load the
service:

1. reads the authoritative `hmp_house_memberships` row;
2. maintains exactly one projected group such as `house:gryffindor`;
3. assigns native `player.house`, causing Hogwarts Legacy to rebuild house-aware robes and crests.

A character without an assignment is synchronized as native `Unaffiliated`, preventing one character's
house from leaking across a character switch. Clearing membership removes every Foundations-owned
`house:*` projection. Other resources should normally check `hmp-core` groups rather than importing
this resource just for access control.

Every actual transition is written to `hmp_house_membership_audit`. Reassigning the same house is an
idempotent no-op and does not manufacture another audit row.

## House Cup points

Every consequential caller supplies a stable reference:

```ts
const transaction = await Houses.points.award("gryffindor", 25, {
    reference: `quidditch:${match.id}:winner:gryffindor`,
    resource: "hmp-quidditch",
    actor: referee,
    reason: "Won the fixture",
    metadata: { matchId: match.id },
});
```

`award` accepts a positive amount, `deduct` accepts a positive amount and records it as negative, and
`adjust` accepts an explicitly signed amount. The reference is globally unique. Repeating the same
operation returns its completed transaction without changing the standing twice; reusing the reference
for a different house, amount, actor, or resource is rejected.

The ledger records a pending row before applying its standing update. Applying the balance and completing
the transaction occur in one MySQL transaction. A process interruption between those phases leaves a
visible pending row that `points.recover(reference)` can safely finish. Rejected operations are marked
failed rather than remaining capable of applying unexpectedly later.

```ts
await Houses.points.standings();
await Houses.points.get("ravenclaw");
await Houses.points.history("ravenclaw", 50);
await Houses.points.pending(50);
```

`allowNegativePoints` controls whether deductions may take a house below zero. JavaScript safe-integer
limits are enforced even though MySQL can store larger values.

## Common rooms

A character may enter other houses' common rooms besides their own, for staff or guests. The entrance
opens for them as it would for a member of that house, with the game's own animation; their house, robes
and respawn stay as they are. Grants belong to the character, are kept in its `hmp-core` metadata, and are
applied whenever the character loads:

```ts
await Houses.commonRooms.grant(player, "slytherin");   // or a character id
await Houses.commonRooms.revoke(player, "slytherin");
await Houses.commonRooms.list(player);                 // ["ravenclaw"]
await Houses.commonRooms.clear(player);
```

`commonRoomGroups` gives members of any listed `hmp-core` group every common room:

```json
{ "commonRoomGroups": [{ "key": "staff", "minimumGrade": 1 }] }
```

It is empty by default, so nobody enters another house's common room. A change to one of those groups
reaches online players at once. An entrance decides as someone walks up to it, so a player already in the
doorway sees a change the next time they step up. Other players still see that entrance closed. Unloading
the character or stopping `hmp-houses` takes the access back.

Common-room access needs HogwartsMP `1.11` or newer for `player.commonRooms`. On an older host grants are
still kept, but nobody gets in, and `hmp-houses` logs a warning the first time someone would have.

## Great Hall banners

`greatHallBanners` hangs one house's banners at the head of the Great Hall for every player:

- `"game"`, the default, leaves the banners to the game;
- `"none"` takes them down;
- a house, such as `"ravenclaw"`, hangs that house's;
- `"leader"` hangs the House Cup leader's when `hmp-houses` starts and again whenever points change. A tie
  at the top, which includes no house having any points yet, keeps the banners already hanging.

A change unfurls the new house's banners in place. Stopping `hmp-houses` hands the banners back to the
game. The banners need HogwartsMP `1.11` or newer for `World.setGreatHallBanners`; on an older host the
setting does nothing and `hmp-houses` logs a warning at startup.

## Events

- `hmp:houses:changed` follows a successful membership transition and includes the online player when
  available, active character, new membership, and previous house.
- `hmp:houses:points` follows a newly completed or recovered point transaction and includes the updated
  standing.
- Projected membership also produces the ordinary `hmp:groups:changed` events from `hmp-core`.

## Exports

- `membership.get/set/clear/members/history/sync`
- `points.get/standings/adjust/award/deduct/transaction/history/pending/recover`
- `commonRooms.list/grant/revoke/clear/sync`
- `status`

## Closed-testing commands

Everyone may inspect their assignment and current standings:

```text
/house
/house <me|nick|#id>
/points
/points history [house|all] [limit]
```

Members of a configured `adminGroups` entry may mutate them:

```text
/house <me|nick|#id> <gryffindor|hufflepuff|ravenclaw|slytherin|clear>
/points <house> <signedAmount> [reference]
/points recover <reference>
```

The optional reference on the command is useful for intentionally replaying the same closed-test
operation. Production gameplay resources should always construct a deterministic reference from their
own event or match ID.

Sorting ceremonies, house-specific missions, Quidditch rules, dormitory gender, and bespoke House Cup
presentation are intentionally outside this resource. They consume its APIs and projected groups.

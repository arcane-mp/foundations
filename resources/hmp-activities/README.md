# hmp-activities

`hmp-activities` is Foundations's reusable server-side lobby and session layer. Gameplay resources
register activity types; this resource owns public discovery, group membership, role or team capacity,
ready checks, targeted invitations, leader handoff, expiry, disconnect cleanup, and
start/finish/cancel transitions.

It does not own dungeon objectives, Quidditch rules, duel damage, matchmaking ratings, teleporting,
instances, rewards, or an opinionated UI. Those remain with the gameplay resource. Session state is
deliberately ephemeral; the activity owner persists scores or history when it completes a session.

## Dungeon LFG example

A future `hmp-dungeon-lfg` resource can define the composition it needs without putting dungeon
knowledge in Foundations:

```ts
const Activities = Imports.get("hmp-activities");

Activities.definitions.register({
    id: "dungeon:ruins",
    resource: "hmp-dungeon-lfg",
    label: "Ruins expedition",
    minimumPlayers: 3,
    maximumPlayers: 5,
    requireReady: true,
    disconnectPolicy: "remove",
    scope: "areaAndVirtualWorld",
    roles: [
        { id: "healer", label: "Healer", min: 1, max: 1 },
        { id: "caster", label: "Caster", min: 1, max: 2 },
        { id: "fighter", label: "Fighter", min: 1, max: 2 },
    ],
    async canJoin({ player, role }) {
        // Check level, spell kits, dungeon lockouts, or another gameplay-owned rule here.
        return role === "healer" && !await canHeal(player)
            ? "Equip an approved healing kit before taking the healer role."
            : true;
    },
    onStarted({ session }) {
        beginDungeonInstance(session);
    },
});
```

Create and discover a group:

```ts
const group = await Activities.sessions.create(player, "dungeon:ruins", {
    title: "First clear — new players welcome",
    role: "caster",
    metadata: { difficulty: "normal" },
});

const needsHealer = Activities.sessions.discover(player, {
    activityId: "dungeon:ruins",
    role: "healer",
});

await Activities.sessions.join(healer, needsHealer[0].id, { role: "healer" });
await Activities.sessions.setReady(healer, group.id, true);
await Activities.sessions.start(group.id, { actor: groupLeader });
```

Leaders and owning resources can also send a session-bound invitation. Acceptance reruns every join
check against current state, so an expired invitation cannot bypass a full role, character rule,
exclusive activity, or changed location:

```ts
const invitation = await Activities.invitations.invite(group.id, healer, {
    role: "healer",
    message: "We need one healer for the ruins.",
}, { actor: groupLeader });

await Activities.invitations.accept(healer, invitation.id);
```

When the gameplay resource reaches a terminal result, it closes and removes the ephemeral session:

```ts
await Activities.sessions.complete(group.id, { result: "victory", elapsedMs }, {
    resource: "hmp-dungeon-lfg",
    reason: "final encounter completed",
});
```

The `resource` owner context is a trusted server-resource boundary, not a client credential. Never
accept that field from a client payload.

## Definitions and composition

An activity may use one flat role list, or teams with optional role lists. It cannot use both. Flat
roles fit dungeon parties; teams fit Quidditch and structured duels. Minimums determine whether a
session is `startable`, while maximums prevent joins and role changes from overfilling a slot.

Definitions default to requiring an active character, requiring every participant to ready up, and
being exclusive with any other exclusive activity. Each behavior is configurable per definition.
`public` sessions appear in discovery; `unlisted` and `private` sessions remain addressable by trusted
server code but do not appear there.

Scopes capture the creator's authoritative `Player.location()` and/or virtual world. Use `area`,
`region`, `virtualWorld`, or `areaAndVirtualWorld` when a listing should not join players across
incompatible game coordinate spaces. Use `global` for activities that deliberately span them.

## Lifecycle

Sessions move from `forming` to `running`, then to `completed` or `cancelled`. Terminal sessions are
returned to the caller and emitted in their terminal event, then removed from active memory. Forming
lobbies expire; running sessions do not. If the leader leaves a forming group, the earliest remaining
member becomes leader. A running disconnect cancels the session by default so the gameplay owner can
perform safe cleanup through `onCancelled`. Set `disconnectPolicy: "remove"` when the activity can
continue short-handed; `onLeft` then receives the disconnect and the owner decides whether to continue,
backfill through its own rules, or cancel.

Registration is owner-scoped. Stopping a gameplay resource unregisters its definitions and cancels
their sessions. The disposer returned by `definitions.register()` provides the same cleanup explicitly.

Owner hooks receive snapshots and should start or clean up gameplay state. `canCreate`, `canJoin` and
`canStart` are awaited gates; return `false` or a player-facing string to deny the action. `canStart`
runs after the player, role, team and readiness checks pass. Its `player` is the actor who asked, or the
leader when an owner API starts the session without one, and its `resource` is the resource the owner
context named, so a gameplay resource can refuse `/activities start` and still start the session through
its own `sessions.start(id, { resource })`. A denied start leaves the session forming. Lifecycle hooks are
best-effort notifications and errors are logged without rolling back an already committed session
transition.

Server events mirror transitions:

- `hmp:activities:created`
- `hmp:activities:joined`
- `hmp:activities:left`
- `hmp:activities:updated`
- `hmp:activities:started`
- `hmp:activities:completed`
- `hmp:activities:cancelled`
- `hmp:activities:invitation:created`
- `hmp:activities:invitation:accepted`
- `hmp:activities:invitation:declined`
- `hmp:activities:invitation:cancelled`
- `hmp:activities:invitation:expired`

Each event carries `{ session, ...context }`. The complete event may carry the owner's bounded JSON
result. Custom LFG or tournament UIs should consume server-authored snapshots rather than recreating
membership or role-capacity rules on the client.

## Closed-testing command

Set `enableTestActivity` in `data/hmp-activities.json` to register the non-gameplay
`foundations:test-party` definition. It requires a healer, caster, and at least two total players.

```text
/activities definitions
/activities list
/activities create foundations:test-party healer
/activities join <short-id> caster
/activities ready [short-id]
/activities start [short-id]
/activities cancel [short-id]
```

Also available: `mine`, `leave`, `role`, `unready`, and `status`. Disable the example definition after
closed testing; production gameplay resources should register the real activities.

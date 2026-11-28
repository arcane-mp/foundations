import assert = require("node:assert");
import serviceModule = require("../server/service");
import type { HmpActivityPlayer } from "../types";

const { createActivityService, HmpActivityError } = serviceModule;

interface TestPlayer extends HmpActivityPlayer { area: string }
function player(id: number, area = "Hogwarts"): TestPlayer {
    return { id, nickname: `Player ${id}`, virtualWorld: 0, area, location() { return { areaId: this.area, regionId: "GreatHall" }; } };
}

async function run(): Promise<void> {
    let time = 1_000_000;
    let serial = 0;
    const characters = new Map<number, { id: number; accountId: number; slot: number; name: string; status: string; createdAt: string; updatedAt: string; deletedAt: null }>();
    for (let id = 1; id <= 8; id++) characters.set(id, { id: id * 10, accountId: id, slot: 1, name: `Character ${id}`, status: "active", createdAt: "", updatedAt: "", deletedAt: null });
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const service = createActivityService<TestPlayer>({
        core: { characters: { active: (candidate: TestPlayer | number) => characters.get(typeof candidate === "number" ? candidate : candidate.id) || null } } as never,
        config: { command: "activities", enableCommands: true, maxDefinitions: 10, maxSessions: 10, maxMetadataBytes: 1024, maxInvitations: 20, defaultInvitationTtlSeconds: 30, maximumInvitationTtlSeconds: 60, defaultLobbyTtlSeconds: 300, maximumLobbyTtlSeconds: 600, sweepIntervalSeconds: 30, enableTestActivity: false },
        now: () => time, id: () => `session-${++serial}`, emit: (name, payload) => emitted.push({ name, payload }),
    });
    const lifecycle: string[] = [];
    const dispose = service.definitions.register({
        id: "dungeon:lfg", resource: "hmp-dungeon", label: "Dungeon group", minimumPlayers: 3, maximumPlayers: 5,
        scope: "areaAndVirtualWorld", requireReady: true, disconnectPolicy: "remove",
        roles: [
            { id: "healer", label: "Healer", min: 1, max: 1 },
            { id: "caster", label: "Caster", min: 1, max: 2 },
            { id: "fighter", label: "Fighter", min: 1, max: 2 },
        ],
        canJoin: ({ player: candidate, role }) => candidate.id === 8 ? "Player 8 lacks the required level" : role ? true : false,
        onStarted: () => lifecycle.push("started"), onCompleted: () => lifecycle.push("completed"),
    });
    assert.strictEqual(service.definitions.list().length, 1);
    const leader = player(1);
    const created = await service.sessions.create(leader, "dungeon:lfg", { role: "healer", title: "Lower Hogsfield Ruins", metadata: { difficulty: "normal" } });
    assert.strictEqual(created.scope.areaId, "Hogwarts");
    assert.strictEqual(created.scope.virtualWorld, 0);
    assert.strictEqual(created.startable, false);
    assert.strictEqual(service.sessions.discover(player(2), { role: "caster" }).length, 1);
    await assert.rejects(service.sessions.join(player(2, "Overland"), created.id, { role: "caster" }), /game area/);
    const caster = player(2);
    const invitation = await service.invitations.invite(created.id, caster, { role: "caster", message: "Need a caster" }, { actor: leader });
    assert.strictEqual(service.invitations.list({ playerId: caster.id, direction: "incoming" }).length, 1);
    await service.invitations.accept(caster, invitation.id);
    assert.strictEqual(service.invitations.get(invitation.id), null);
    await assert.rejects(service.sessions.join(player(3), created.id, { role: "healer" }), (error: unknown) => error instanceof HmpActivityError && error.code === "HMP_ACTIVITY_ROLE_FULL");
    const fighter = player(3);
    await service.sessions.join(fighter, created.id, { role: "fighter" });
    await assert.rejects(service.sessions.join(player(8), created.id, { role: "caster" }), /required level/);
    await Promise.all([service.sessions.setReady(leader, created.id, true), service.sessions.setReady(caster, created.id, true), service.sessions.setReady(fighter, created.id, true)]);
    assert.strictEqual(service.sessions.get(created.id)?.startable, true);
    await assert.rejects(service.sessions.start(created.id, { actor: caster }), /Only the activity owner or group leader/);
    const running = await service.sessions.start(created.id, { actor: leader });
    assert.strictEqual(running.state, "running");
    assert.strictEqual(lifecycle[0], "started");
    const completed = await service.sessions.complete(created.id, { score: 100 }, { resource: "hmp-dungeon", reason: "boss defeated" });
    assert.strictEqual(completed.state, "completed");
    assert.strictEqual(service.sessions.get(created.id), null);
    assert.strictEqual(lifecycle[1], "completed");

    const resilient = await service.sessions.create(leader, "dungeon:lfg", { role: "healer" });
    await service.sessions.join(caster, resilient.id, { role: "caster" });
    await service.sessions.join(fighter, resilient.id, { role: "fighter" });
    await service.sessions.setReady(leader, resilient.id, true);
    await service.sessions.setReady(caster, resilient.id, true);
    await service.sessions.setReady(fighter, resilient.id, true);
    await service.sessions.start(resilient.id, { actor: leader });
    await service.disconnect(fighter);
    assert.strictEqual(service.sessions.get(resilient.id)?.state, "running");
    assert.strictEqual(service.sessions.get(resilient.id)?.participants.length, 2);
    await service.sessions.cancel(resilient.id, { resource: "hmp-dungeon", reason: "party abandoned" });

    const transferable = await service.sessions.create(leader, "dungeon:lfg", { role: "healer" });
    await service.sessions.join(caster, transferable.id, { role: "caster" });
    const afterLeave = await service.sessions.leave(leader, transferable.id);
    assert.strictEqual(afterLeave?.leaderPlayerId, caster.id);
    await service.disconnect(caster);
    assert.strictEqual(service.sessions.get(transferable.id), null);

    const expiring = await service.sessions.create(leader, "dungeon:lfg", { role: "healer", lobbyTtlSeconds: 30 });
    time += 31_000;
    assert.strictEqual(await service.sweep(), 1);
    assert.strictEqual(service.sessions.get(expiring.id), null);

    const starts: Array<{ player: number; resource?: string }> = [];
    const disposeGated = service.definitions.register({
        id: "duel:ranked", resource: "hmp-ranked", label: "Ranked duel", minimumPlayers: 2, maximumPlayers: 2, requireReady: false,
        canStart: ({ player: starter, session, resource }) => {
            starts.push({ player: starter.id, resource });
            return resource === "hmp-ranked" || `Start ${session?.title} from the duel menu`;
        },
    });
    const ranked = await service.sessions.create(leader, "duel:ranked", { title: "Ranked bout" });
    await assert.rejects(service.sessions.start(ranked.id, { actor: leader }), /not satisfied/);
    assert.strictEqual(starts.length, 0, "canStart runs only after the session's own requirements pass");
    await service.sessions.join(caster, ranked.id);
    await assert.rejects(service.sessions.start(ranked.id, { actor: leader }), (error: unknown) => error instanceof HmpActivityError && error.code === "HMP_ACTIVITY_DENIED" && /Start Ranked bout from the duel menu/.test(error.message));
    assert.strictEqual(service.sessions.get(ranked.id)?.state, "forming", "a denied start leaves the lobby forming");
    assert.strictEqual((await service.sessions.start(ranked.id, { resource: "hmp-ranked" })).state, "running");
    assert.deepStrictEqual(starts, [{ player: leader.id, resource: undefined }, { player: leader.id, resource: "hmp-ranked" }], "the leader stands in for an owner start without an actor");
    await service.sessions.cancel(ranked.id, { resource: "hmp-ranked", reason: "test over" });
    await disposeGated();
    assert.ok(emitted.some((entry) => entry.name === "hmp:activities:started"));
    assert.ok(emitted.some((entry) => entry.name === "hmp:activities:completed"));
    assert.strictEqual(await dispose(), 0);
    assert.strictEqual(service.definitions.list().length, 0);
    await service.stop();
    assert.strictEqual(service.status().state, "stopped");
}

run().then(() => console.log("hmp-activities tests passed"));

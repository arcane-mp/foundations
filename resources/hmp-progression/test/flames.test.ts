import assert = require("node:assert/strict");
import flamesModule = require("../server/flames");
import type { Player, ProgressionRepository } from "../server/internal";

const { createFlooFlames } = flamesModule;
type Call = [ids: string[], lit: boolean];

function makePlayer(id: number, native = true): Player & { calls: Call[] } {
    const calls: Call[] = [];
    const player = { id, nickname: `Player ${id}`, emit() {}, calls } as unknown as Player & { calls: Call[] };
    if (native) player.setFastTravelUnlocked = (ids: string | string[], lit = true) => { calls.push([Array.isArray(ids) ? [...ids] : [ids], lit]); return 1; };
    return player;
}

function harness(options: { enabled?: boolean } = {}) {
    const stored = new Map<number, Map<string, string>>();
    const active = new Map<Player, number | null>();
    const warnings: string[] = [];
    const flames = (id: number) => { if (!stored.has(id)) stored.set(id, new Map()); return stored.get(id)!; };
    const repository: Pick<ProgressionRepository, "flooFlames" | "lightFlooFlames" | "dimFlooFlames"> = {
        flooFlames: async (id) => [...flames(id).values()].sort(),
        lightFlooFlames: async (id, ids) => { ids.forEach((flame) => flames(id).set(flame.toLowerCase(), flame)); return ids.length; },
        dimFlooFlames: async (id, ids) => { ids.forEach((flame) => flames(id).delete(flame.toLowerCase())); return ids.length; },
    };
    const character = (id: number) => ({ id, accountId: 1, slot: 1, name: `Character ${id}` });
    const core = {
        characters: { active: (player: Player) => { const id = active.get(player); return id ? character(id) : null; } },
        sessions: { all: () => [...active].filter(([, id]) => id).map(([player, id]) => ({ player, character: character(id!) })) },
    };
    const service = createFlooFlames({
        repository, core: core as never, enabled: options.enabled !== false, ready: async () => {},
        logger: { info() {}, warn(message: string) { warnings.push(message); }, error() {} } as never,
    });
    return { service, stored, active, warnings, flames };
}

async function newHost(): Promise<void> {
    const { service, active, warnings, flames } = harness();
    const player = makePlayer(7);
    flames(42).set("ft_hw_boathouse", "FT_HW_Boathouse");
    flames(43).set("ft_hw_boathouse", "FT_HW_Boathouse");
    flames(43).set("ft_hw_centraltower", "FT_HW_CentralTower");

    active.set(player, 42);
    await service.characterLoaded(player);
    assert.deepEqual(player.calls, [[["FT_HW_Boathouse"], true]], "a loaded character's flames are lit again");

    await service.unlocked(player, { destinationId: "FT_Hogsmeade_North" });
    await service.unlocked(player, { destinationId: "FT_HW Boathouse; DROP" });
    await service.unlocked(player, null);
    assert.deepEqual([...flames(42).values()].sort(), ["FT_HW_Boathouse", "FT_Hogsmeade_North"], "a found flame is saved, a malformed report is not");

    player.calls.length = 0;
    active.set(player, 43);
    await service.characterLoaded(player);
    assert.deepEqual(player.calls, [[["FT_Hogsmeade_North"], false], [["FT_HW_Boathouse", "FT_HW_CentralTower"], true]],
        "switching characters dims only the earlier character's own flames");

    // A flame found with no character selected is saved nowhere, and dimmed for the next character.
    active.set(player, null);
    await service.unlocked(player, { destinationId: "FT_HW_Viaduct" });
    assert.equal([...allFlames(flames)].includes("FT_HW_Viaduct"), false);
    player.calls.length = 0;
    active.set(player, 42);
    await service.characterLoaded(player);
    assert.deepEqual(player.calls, [[["FT_HW_CentralTower", "FT_HW_Viaduct"], false], [["FT_HW_Boathouse", "FT_Hogsmeade_North"], true]]);

    // A load overtaken by another selection changes nothing.
    player.calls.length = 0;
    const overtaken = service.characterLoaded(player);
    active.set(player, 44);
    await overtaken;
    assert.deepEqual(player.calls, []);

    // A new connection starts from the game's own flames.
    service.disconnect(player);
    active.set(player, 43);
    await service.characterLoaded(player);
    assert.deepEqual(player.calls, [[["FT_HW_Boathouse", "FT_HW_CentralTower"], true]]);

    assert.deepEqual(await service.api.list(42), ["FT_HW_Boathouse", "FT_Hogsmeade_North"]);
    player.calls.length = 0;
    assert.deepEqual(await service.api.set(player, ["FT_HW_Viaduct", "ft_hw_viaduct"]), ["FT_HW_Boathouse", "FT_HW_CentralTower", "FT_HW_Viaduct"]);
    assert.deepEqual(player.calls, [[["FT_HW_Viaduct"], true]], "set lights an online character's flames at once, once each");
    assert.deepEqual(await service.api.set(43, "FT_HW_Boathouse", false), ["FT_HW_CentralTower", "FT_HW_Viaduct"]);
    assert.deepEqual(player.calls.at(-1), [["FT_HW_Boathouse"], false]);
    player.calls.length = 0;
    await service.api.set(42, "FT_HW_Boathouse", false);
    assert.deepEqual(player.calls, [], "an offline character is only saved");
    await assert.rejects(service.api.set(43, "../etc"), /Floo flame id/);
    await assert.rejects(service.api.set(43, []), /1 to 128/);
    await assert.rejects(service.api.set(43, "FT_HW_Viaduct", "yes" as never), /lit must be a boolean/);
    await assert.rejects(service.api.list(makePlayer(8)), /Select a character/);

    const disconnected = makePlayer(9);
    disconnected.setFastTravelUnlocked = () => { throw new Error("Player is not connected"); };
    active.set(disconnected, 42);
    await service.characterLoaded(disconnected);
    assert.ok(warnings.some((message) => message.includes("Player is not connected")), "a refused light is logged, not thrown");
}

function allFlames(flames: (id: number) => Map<string, string>): string[] {
    return [42, 43, 44].flatMap((id) => [...flames(id).values()]);
}

async function olderHost(): Promise<void> {
    const { service, active, warnings, flames } = harness();
    const first = makePlayer(1, false);
    const second = makePlayer(2, false);
    flames(42).set("ft_hw_boathouse", "FT_HW_Boathouse");
    active.set(first, 42);
    active.set(second, 43);
    await service.characterLoaded(first);
    await service.characterLoaded(second);
    assert.equal(warnings.filter((message) => message.includes("HogwartsMP 1.11")).length, 1, "an older host is reported once");
    assert.deepEqual(await service.api.set(first, "FT_HW_CentralTower"), ["FT_HW_Boathouse", "FT_HW_CentralTower"], "the export still saves");
}

async function disabled(): Promise<void> {
    const { service, active, warnings, flames } = harness({ enabled: false });
    const player = makePlayer(1);
    flames(42).set("ft_hw_boathouse", "FT_HW_Boathouse");
    active.set(player, 42);
    await service.characterLoaded(player);
    await service.unlocked(player, { destinationId: "FT_HW_CentralTower" });
    assert.deepEqual(player.calls, []);
    assert.deepEqual([...flames(42).values()], ["FT_HW_Boathouse"]);
    assert.deepEqual(warnings, []);
    await assert.rejects(service.api.list(42), /flooFlames is off/);
    await assert.rejects(service.api.set(42, "FT_HW_CentralTower"), /flooFlames is off/);
}

async function run(): Promise<void> {
    await newHost();
    await olderHost();
    await disabled();
    console.log("hmp-progression Floo flame tests passed");
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });

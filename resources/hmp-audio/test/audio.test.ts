import assert = require("node:assert");
import serverModule = require("../server/service");
import clientModule = require("../client/service");
import dialogueModule = require("../server/dialogue");
import type { HmpAudioDialoguePolicy, HmpAudioPlayer } from "../types";

const { createAudioService } = serverModule;
const { normalizeDialogue } = dialogueModule;
const { createAudioClient } = clientModule;

function run(): void {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const timers: Array<() => void> = [];
    let nativeSequence = 100;
    const native = {
        playSoundAt: (...args: unknown[]) => { calls.push({ name: "at", args }); return ++nativeSequence; },
        playSoundOnPlayer: (...args: unknown[]) => { calls.push({ name: "on", args }); return ++nativeSequence; },
        playSoundForPlayer: (...args: unknown[]) => { calls.push({ name: "private", args }); return ++nativeSequence; },
        playSoundForAll: (...args: unknown[]) => { calls.push({ name: "all", args }); return ++nativeSequence; },
        stopSound: (...args: unknown[]) => { calls.push({ name: "stop", args }); return true; },
        stopEventFor: (event: string) => event === "accio_cast" ? "accio_release" : "",
        bankFor: (event: string) => event === "accio_cast" ? "Spells_Accio_AKB" : "",
        loadBank: (...args: unknown[]) => { calls.push({ name: "load", args }); },
        unloadBank: (...args: unknown[]) => { calls.push({ name: "unload", args }); },
    };
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const service = createAudioService<HmpAudioPlayer>({
        native,
        config: {
            aliases: { click: "UI_Menu_Select", accio: "accio_cast" },
            defaultRange: 12_000,
            maxActivePerOwner: 8,
            oneShotHandleMs: 5000,
            enableCommands: false,
            command: "audio",
            dialogue: {},
        },
        events: { emit: (name, payload) => emitted.push({ name, payload }) },
        now: () => 1000,
        setTimer: (handler) => { timers.push(handler); return timers.length as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: () => undefined,
    });
    const owner = { resource: "hmp-test", id: "main" };
    const other = { resource: "hmp-other", id: "main" };
    const player: HmpAudioPlayer = { id: 7, nickname: "Tester", position: { x: 1, y: 2, z: 3 } };

    assert.strictEqual(service.catalog.resolve("CLICK"), "UI_Menu_Select");
    assert.strictEqual(service.catalog.bankFor("accio"), "Spells_Accio_AKB");
    const point = service.sounds.playAt(owner, "click", { x: 1, y: 2, z: 3 });
    assert.ok(point);
    assert.deepStrictEqual(calls.find((call) => call.name === "at")?.args, ["UI_Menu_Select", 1, 2, 3, { range: 12_000 }]);
    assert.strictEqual(service.sounds.get(point!)?.scope, "position");
    assert.strictEqual(service.sounds.stop(other, point!), false);
    assert.strictEqual(service.sounds.stop(owner, point!), true);
    assert.strictEqual(calls.filter((call) => call.name === "stop").length, 1);

    const held = service.sounds.playOnPlayer(owner, player, "accio");
    assert.ok(held);
    assert.strictEqual(service.sounds.get(held!)?.held, true);
    const privateHandle = service.sounds.playForPlayer(owner, player, "click", { duration: 2 });
    assert.ok(privateHandle);
    assert.strictEqual(service.sounds.get(privateHandle!)?.duration, 2);
    const audience = service.sounds.playForPlayers(owner, [player, player], "click");
    assert.ok(audience);
    assert.deepStrictEqual(service.sounds.get(audience!)?.targetPlayerIds, [7]);
    assert.strictEqual(service.sounds.get(audience!)?.nativeCount, 1);

    timers.at(-1)?.();
    assert.strictEqual(service.sounds.get(audience!), null);
    assert.ok(service.sounds.get(held!));
    assert.ok(emitted.some((entry) => entry.name === "hmp:audio:played"));

    assert.strictEqual(service.banks.acquire(owner, "MyCustomBank"), true);
    assert.strictEqual(service.banks.acquire(owner, "mycustombank"), false);
    assert.strictEqual(service.banks.acquire(other, "MYCUSTOMBANK"), true);
    assert.strictEqual(calls.filter((call) => call.name === "load").length, 1);
    assert.strictEqual(service.banks.release(owner, "MyCustomBank"), true);
    assert.strictEqual(calls.filter((call) => call.name === "unload").length, 0);
    assert.strictEqual(service.banks.release(other, "MyCustomBank"), true);
    assert.strictEqual(calls.filter((call) => call.name === "unload").length, 1);

    const dispose = service.catalog.register(owner, { bell: "UI_Menu_Open" });
    assert.strictEqual(service.catalog.resolve("bell"), "UI_Menu_Open");
    assert.throws(() => service.catalog.register(other, { bell: "UI_Menu_Close" }), /already owned/);
    assert.strictEqual(dispose(), true);
    assert.strictEqual(service.catalog.resolve("bell"), "bell");

    service.sounds.playForAll(owner, "click", { held: true });
    const stoppedByCleanup = service.cleanup("hmp-test");
    assert.ok(stoppedByCleanup >= 2);
    assert.strictEqual(service.sounds.list(owner).length, 0);

    const clientCalls: Array<{ name: string; args: unknown[] }> = [];
    let localSequence = 200;
    const client = createAudioClient({
        native: {
            playSound: (...args: unknown[]) => { clientCalls.push({ name: "play", args }); return ++localSequence; },
            playSoundAt: (...args: unknown[]) => { clientCalls.push({ name: "at", args }); return ++localSequence; },
            stopSound: (...args: unknown[]) => { clientCalls.push({ name: "stop", args }); return true; },
            stopEventFor: (event: string) => event === "accio_cast" ? "accio_release" : "",
            bankFor: () => "",
            loadBank: (...args: unknown[]) => { clientCalls.push({ name: "load", args }); return true; },
            unloadBank: (...args: unknown[]) => { clientCalls.push({ name: "unload", args }); return true; },
        },
        setTimer: (handler) => { timers.push(handler); return timers.length as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: () => undefined,
    });
    assert.strictEqual(client.applyCatalog(JSON.stringify({ aliases: { wand: "Custom_Wand_Play" } })), true);
    assert.strictEqual(client.catalog.resolve("wand"), "Custom_Wand_Play");
    assert.strictEqual(client.catalog.resolve("click"), "click");
    const local = client.sounds.play(owner, "wand", { bank: "MyBank", held: true });
    assert.ok(local);
    assert.strictEqual(clientCalls.filter((call) => call.name === "load").length, 1);
    assert.strictEqual(client.sounds.stop(other, local!), false);
    assert.strictEqual(client.sounds.stop(owner, local!), true);
    client.cleanup("hmp-test");
    assert.strictEqual(clientCalls.filter((call) => call.name === "unload").length, 1);
    client.stop();

    // HogwartsMP 1.10 has no Audio.setDialoguePolicy: there is no policy to read, and a hold changes nothing.
    assert.strictEqual(service.dialogue.current(), null);
    assert.strictEqual(service.dialogue.set(owner, { world: false }), false);
    assert.throws(() => service.dialogue.set(owner, { crowd: false } as never), /unknown speaker 'crowd'/);
    service.stop();

    assert.deepStrictEqual(normalizeDialogue({ floo: false, player: "nonverbal", world: undefined }, "dialogue"), { floo: false, player: "nonverbal" });
    assert.throws(() => normalizeDialogue({ npcs: "off" }, "hmp-audio dialogue"), /hmp-audio dialogue\.npcs must be true, false or "nonverbal"/);
    assert.throws(() => normalizeDialogue([], "hmp-audio dialogue"), /must be an object/);

    // The policy is one world setting: hmp-audio writes only what its config and holds name, and hands each
    // speaker back to the host's own once nothing here names it.
    const host: HmpAudioDialoguePolicy = { player: true, players: true, npcs: true, characters: true, world: true, floo: true };
    const writes: Array<Partial<HmpAudioDialoguePolicy>> = [];
    const speaking = createAudioService<HmpAudioPlayer>({
        native: {
            ...native,
            get dialoguePolicy() { return { ...host }; },
            setDialoguePolicy: (patch: Partial<HmpAudioDialoguePolicy>) => { writes.push(patch); Object.assign(host, patch); return true; },
        },
        config: { aliases: { click: "UI_Menu_Select" }, defaultRange: 1, maxActivePerOwner: 1, oneShotHandleMs: 1000, enableCommands: false, command: "audio", dialogue: { floo: false } },
    });
    assert.deepStrictEqual(writes.splice(0), [{ floo: false }], "the configured speakers are applied at start");
    host.player = "nonverbal"; // another resource's own call
    assert.strictEqual(speaking.dialogue.set(owner, { world: false }), true);
    assert.strictEqual(speaking.dialogue.set(other, { world: "nonverbal" }), true);
    assert.strictEqual(host.world, "nonverbal", "a speaker takes its most recent hold");
    assert.strictEqual(speaking.dialogue.release(other), true);
    assert.strictEqual(speaking.dialogue.release(other), false);
    assert.strictEqual(host.world, false);
    assert.strictEqual(speaking.dialogue.set(owner, { floo: true }), true);
    assert.deepStrictEqual([host.world, host.floo], [false, true], "a hold merges, over the config");
    assert.strictEqual(speaking.cleanup("hmp-test"), 1);
    assert.deepStrictEqual([host.world, host.floo], [true, false], "a stopped owner's speakers go back to the config or the host's own");
    assert.ok(writes.every((patch) => !("player" in patch)), "a speaker nothing here names is left alone");
    assert.deepStrictEqual(speaking.dialogue.current(), { ...host });
    writes.length = 0;
    speaking.stop();
    assert.deepStrictEqual(writes, [{ floo: true }], "stopping hands the configured speakers back");
    assert.strictEqual(host.player, "nonverbal");
}

run();
console.log("hmp-audio tests passed");

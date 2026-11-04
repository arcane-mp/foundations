import catalogModule = require("../shared/catalog");
import banksModule = require("../shared/banks");
import normalizeModule = require("../shared/normalize");
import dialogueModule = require("./dialogue");
import type {
    HmpAudioOwner,
    HmpAudioPlayback,
    HmpAudioPlayer,
    HmpAudioPlayOptions,
    HmpAudioPosition,
    HmpAudioServer,
    HmpAudioScope,
} from "../types";
import type { AudioConfig, AudioEvents, NativeServerAudio } from "./internal";

const { createCatalog } = catalogModule;
const { createBankRegistry } = banksModule;
const { createDialogueRegistry } = dialogueModule;
const { owner: normalizeOwner, options: normalizeOptions, player: normalizePlayer, position: normalizePosition } = normalizeModule;

interface ServiceDependencies<P extends HmpAudioPlayer> {
    native: NativeServerAudio<P>;
    config: AudioConfig;
    events?: AudioEvents;
    now?: () => number;
    setTimer?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    onCatalogChange?(): void;
}

interface PlaybackRecord extends HmpAudioPlayback {
    ownerKey: string;
    nativeIds: number[];
    timer?: ReturnType<typeof setTimeout>;
}

function createAudioService<P extends HmpAudioPlayer>(dependencies: ServiceDependencies<P>): HmpAudioServer<P> & {
    cleanup(resource: string): number;
    stop(): void;
    catalogCount(): number;
} {
    const { native, config } = dependencies;
    const now = dependencies.now || Date.now;
    const setTimer = dependencies.setTimer || setTimeout;
    const clearTimer = dependencies.clearTimer || clearTimeout;
    const startedAt = now();
    const playbacks = new Map<string, PlaybackRecord>();
    let sequence = 0;
    let stopped = false;
    const catalogRegistry = createCatalog(config.aliases, {
        bankFor: native.bankFor.bind(native),
        stopEventFor: native.stopEventFor.bind(native),
        onChange: dependencies.onCatalogChange,
    });
    const bankRegistry = createBankRegistry({ load: native.loadBank.bind(native), unload: native.unloadBank.bind(native) });
    const dialogueRegistry = createDialogueRegistry(native, config.dialogue);

    function publicPlayback(record: PlaybackRecord): HmpAudioPlayback {
        const { ownerKey: _ownerKey, nativeIds, timer: _timer, ...playback } = record;
        return { ...playback, owner: { ...playback.owner }, targetPlayerIds: [...playback.targetPlayerIds], position: playback.position ? { ...playback.position } : undefined, nativeCount: nativeIds.length };
    }

    function activeFor(ownerKey: string): number {
        let count = 0;
        for (const record of playbacks.values()) if (record.ownerKey === ownerKey) count++;
        return count;
    }

    function nativeOptions(options: HmpAudioPlayOptions, positional: boolean): Omit<HmpAudioPlayOptions, "held"> {
        const { held: _held, range, ...rest } = options;
        return positional && range !== undefined ? { ...rest, range } : rest;
    }

    function finalize(record: PlaybackRecord, stopNative: boolean): boolean {
        if (playbacks.get(record.handle) !== record) return false;
        playbacks.delete(record.handle);
        if (record.timer) clearTimer(record.timer);
        if (stopNative) for (const nativeId of record.nativeIds) native.stopSound(nativeId);
        dependencies.events?.emit("hmp:audio:stopped", { playback: publicPlayback(record), explicit: stopNative });
        return true;
    }

    function register(
        rawOwner: HmpAudioOwner,
        aliasOrEvent: string,
        scope: HmpAudioScope,
        rawOptions: HmpAudioPlayOptions | undefined,
        positional: boolean,
        nativeIds: number[],
        details: { targetPlayerIds?: number[]; position?: HmpAudioPosition } = {},
    ): string | null {
        const owner = normalizeOwner(rawOwner);
        if (stopped) throw new Error("hmp-audio is stopped");
        if (activeFor(owner.key) >= config.maxActivePerOwner) throw new Error(`audio owner '${owner.key}' reached its ${config.maxActivePerOwner} active-sound limit`);
        const options = normalizeOptions(rawOptions, positional);
        const accepted = nativeIds.map(Number).filter((id) => Number.isFinite(id) && id > 0);
        if (!accepted.length) return null;
        const event = catalogRegistry.api.resolve(aliasOrEvent);
        const knownTerminator = options.autoStop === false ? "" : String(options.stopEvent || native.stopEventFor(event) || "");
        const held = options.duration === undefined && (options.held === true || Boolean(knownTerminator));
        const handle = `hmpaud:${(++sequence).toString(36)}`;
        const record: PlaybackRecord = {
            handle,
            owner: { resource: owner.resource, id: owner.id },
            ownerKey: owner.key,
            event,
            scope,
            startedAt: now(),
            targetPlayerIds: [...(details.targetPlayerIds || [])],
            position: details.position ? { ...details.position } : undefined,
            nativeIds: accepted,
            nativeCount: accepted.length,
            held,
            duration: options.duration,
            bank: options.bank,
        };
        playbacks.set(handle, record);
        if (options.duration !== undefined) record.timer = setTimer(() => finalize(record, false), Math.ceil(options.duration * 1000) + 1000);
        else if (!held) record.timer = setTimer(() => finalize(record, false), config.oneShotHandleMs);
        dependencies.events?.emit("hmp:audio:played", publicPlayback(record));
        return handle;
    }

    function prepare(rawOwner: HmpAudioOwner, aliasOrEvent: string, rawOptions: HmpAudioPlayOptions | undefined, positional: boolean) {
        const owner = normalizeOwner(rawOwner);
        if (stopped) throw new Error("hmp-audio is stopped");
        if (activeFor(owner.key) >= config.maxActivePerOwner) throw new Error(`audio owner '${owner.key}' reached its ${config.maxActivePerOwner} active-sound limit`);
        const event = catalogRegistry.api.resolve(aliasOrEvent);
        const options = normalizeOptions(rawOptions, positional);
        if (positional && options.range === undefined) options.range = config.defaultRange;
        return { owner, event, options };
    }

    function playAt(rawOwner: HmpAudioOwner, aliasOrEvent: string, rawPosition: HmpAudioPosition, rawOptions?: HmpAudioPlayOptions): string | null {
        const prepared = prepare(rawOwner, aliasOrEvent, rawOptions, true);
        const position = normalizePosition(rawPosition);
        const id = native.playSoundAt(prepared.event, position.x, position.y, position.z, nativeOptions(prepared.options, true));
        return register(prepared.owner, prepared.event, "position", prepared.options, true, [id], { position });
    }

    function playOnPlayer(rawOwner: HmpAudioOwner, rawPlayer: P, aliasOrEvent: string, rawOptions?: HmpAudioPlayOptions): string | null {
        const prepared = prepare(rawOwner, aliasOrEvent, rawOptions, true);
        const player = normalizePlayer(rawPlayer);
        const id = native.playSoundOnPlayer(player, prepared.event, nativeOptions(prepared.options, true));
        return register(prepared.owner, prepared.event, "player", prepared.options, true, [id], { targetPlayerIds: [Number(player.id)] });
    }

    function playForPlayer(rawOwner: HmpAudioOwner, rawPlayer: P, aliasOrEvent: string, rawOptions?: HmpAudioPlayOptions): string | null {
        const prepared = prepare(rawOwner, aliasOrEvent, rawOptions, false);
        const player = normalizePlayer(rawPlayer);
        const id = native.playSoundForPlayer(player, prepared.event, nativeOptions(prepared.options, false));
        return register(prepared.owner, prepared.event, "private", prepared.options, false, [id], { targetPlayerIds: [Number(player.id)] });
    }

    function playForPlayers(rawOwner: HmpAudioOwner, rawPlayers: Iterable<P>, aliasOrEvent: string, rawOptions?: HmpAudioPlayOptions): string | null {
        const prepared = prepare(rawOwner, aliasOrEvent, rawOptions, false);
        if (!rawPlayers || typeof rawPlayers[Symbol.iterator] !== "function") throw new TypeError("audio audience must be iterable");
        const players = new Map<number, P>();
        for (const rawPlayer of rawPlayers) {
            const player = normalizePlayer(rawPlayer);
            players.set(Number(player.id), player);
        }
        const ids = [...players.values()].map((player) => native.playSoundForPlayer(player, prepared.event, nativeOptions(prepared.options, false)));
        return register(prepared.owner, prepared.event, "audience", prepared.options, false, ids, { targetPlayerIds: [...players.keys()] });
    }

    function playForAll(rawOwner: HmpAudioOwner, aliasOrEvent: string, rawOptions?: HmpAudioPlayOptions): string | null {
        const prepared = prepare(rawOwner, aliasOrEvent, rawOptions, false);
        const id = native.playSoundForAll(prepared.event, nativeOptions(prepared.options, false));
        return register(prepared.owner, prepared.event, "all", prepared.options, false, [id]);
    }

    function stop(rawOwner: HmpAudioOwner, handle: string): boolean {
        const owner = normalizeOwner(rawOwner);
        const record = playbacks.get(String(handle || ""));
        return Boolean(record && record.ownerKey === owner.key && finalize(record, true));
    }

    function release(rawOwner: HmpAudioOwner): number {
        const owner = normalizeOwner(rawOwner);
        let released = 0;
        for (const record of [...playbacks.values()]) if (record.ownerKey === owner.key && finalize(record, true)) released++;
        return released;
    }

    function cleanupSounds(resource: string): number {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let released = 0;
        for (const record of [...playbacks.values()]) if (record.owner.resource === normalized && finalize(record, true)) released++;
        return released;
    }

    function cleanup(resource: string): number {
        return cleanupSounds(resource) + bankRegistry.cleanup(resource) + catalogRegistry.cleanup(resource) + dialogueRegistry.cleanup(resource);
    }

    function get(handle: string): HmpAudioPlayback | null {
        const record = playbacks.get(String(handle || ""));
        return record ? publicPlayback(record) : null;
    }

    function list(rawOwner?: HmpAudioOwner): HmpAudioPlayback[] {
        const owner = rawOwner ? normalizeOwner(rawOwner) : null;
        return [...playbacks.values()]
            .filter((record) => !owner || record.ownerKey === owner.key)
            .sort((left, right) => left.startedAt - right.startedAt)
            .map(publicPlayback);
    }

    function stopService(): void {
        if (stopped) return;
        stopped = true;
        for (const record of [...playbacks.values()]) finalize(record, true);
        bankRegistry.stop();
        dialogueRegistry.stop();
    }

    const sounds = Object.freeze({ playAt, playOnPlayer, playForPlayer, playForPlayers, playForAll, stop, release, cleanup: cleanupSounds, get, list });
    return {
        sounds,
        catalog: catalogRegistry.api,
        banks: bankRegistry.api,
        dialogue: dialogueRegistry.api,
        status: () => ({
            state: stopped ? "stopped" : "ready",
            activeSounds: playbacks.size,
            owners: new Set([...playbacks.values()].map((record) => record.ownerKey)).size,
            aliases: catalogRegistry.count(),
            banks: bankRegistry.count(),
            uptimeMs: Math.max(0, now() - startedAt),
        }),
        cleanup,
        stop: stopService,
        catalogCount: catalogRegistry.count,
    };
}

export = { createAudioService };

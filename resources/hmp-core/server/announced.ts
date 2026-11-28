import type { AnnouncedField, AnnouncedIdentities, Player } from "./internal";

/**
 * Client identifiers a join announces (`playerConnecting`) but that older hosts do not carry on the
 * player object taking the slot. The Epic Games account ID is one; hosts that carry it on the player
 * themselves do not need this bridge (see hmp-core/README.md for the host versions).
 */
const ANNOUNCED_FIELDS: readonly AnnouncedField[] = Object.freeze(["epicId"]);

interface AnnouncedOptions {
    now?: () => number;
}

interface PendingEntry {
    readonly identities: AnnouncedIdentities;
    readonly expiresAt: number;
}

// A queue can hold a join for a while before the player takes a slot (as hmp-core tickets).
const PENDING_MS = 15 * 60_000;
// Joins that never take a slot must not grow the map without bound.
const MAX_PENDING = 1024;

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function createAnnounced(options: AnnouncedOptions = {}) {
    const now = options.now || Date.now;
    const pending = new Map<string, PendingEntry>();
    const byPlayer = new Map<number, AnnouncedIdentities>();

    function key(nickname: unknown, hardwareId: unknown, ip: unknown): string {
        return JSON.stringify([text(nickname), text(hardwareId), text(ip)]);
    }

    function sweep(at: number): void {
        for (const [entryKey, entry] of pending) {
            if (entry.expiresAt <= at) pending.delete(entryKey);
        }
    }

    /** Remembers the latest join's identifiers until a player with its nickname, hardware ID and IP connects. */
    function remember(connection: Partial<Record<"nickname" | "hardwareId" | "ip" | AnnouncedField, unknown>>): boolean {
        const at = now();
        sweep(at);
        const identities: Partial<Record<AnnouncedField, string>> = {};
        for (const field of ANNOUNCED_FIELDS) {
            const value = text(connection[field]);
            if (value) identities[field] = value;
        }
        const entryKey = key(connection.nickname, connection.hardwareId, connection.ip);
        if (!Object.keys(identities).length) {
            // A join with no announced ID supersedes a stale one with the same key (a rejected ticket or queue drop).
            pending.delete(entryKey);
            return false;
        }
        // A retry that never takes a slot replaces the earlier join; one key holds only its latest entry.
        // Map keys keep insertion order; a new key evicts the oldest one at the cap.
        if (!pending.has(entryKey) && pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
        pending.set(entryKey, { identities: Object.freeze(identities), expiresAt: at + PENDING_MS });
        return true;
    }

    /** Hands the identifiers its join announced to the player who took the slot. */
    function attach(player: Player): AnnouncedIdentities | null {
        const ip = typeof player.getIP === "function" ? player.getIP() : player.ip;
        const entryKey = key(player.nickname, player.hardwareId, ip);
        const entry = pending.get(entryKey);
        pending.delete(entryKey);
        if (!entry || entry.expiresAt <= now()) return null;
        byPlayer.set(Number(player.id), entry.identities);
        return entry.identities;
    }

    function detach(player: Player | number): boolean {
        return byPlayer.delete(Number(player && typeof player === "object" ? player.id : player));
    }

    function get(player: Player | number): AnnouncedIdentities | null {
        return byPlayer.get(Number(player && typeof player === "object" ? player.id : player)) || null;
    }

    return { remember, attach, detach, get };
}

export = { createAnnounced, ANNOUNCED_FIELDS, MAX_PENDING };

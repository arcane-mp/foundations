import type { AnnouncedField, AnnouncedIdentities, Player } from "./internal";

/**
 * Client identifiers the host announces with a join (`playerConnecting`) but does not carry on the player
 * object that takes the slot. The Epic Games account ID is one: an Epic copy of the game announces it,
 * and without it an Epic player is known only by hardware ID.
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

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function createAnnounced(options: AnnouncedOptions = {}) {
    const now = options.now || Date.now;
    const pending = new Map<string, PendingEntry[]>();
    const byPlayer = new Map<number, AnnouncedIdentities>();

    function key(nickname: unknown, hardwareId: unknown, ip: unknown): string {
        return JSON.stringify([text(nickname), text(hardwareId), text(ip)]);
    }

    function sweep(at: number): void {
        for (const [entryKey, list] of pending) {
            const live = list.filter((entry) => entry.expiresAt > at);
            if (live.length) pending.set(entryKey, live);
            else pending.delete(entryKey);
        }
    }

    /** Remembers the identifiers a join announced until a player with its nickname, hardware ID and IP connects. */
    function remember(connection: Partial<Record<"nickname" | "hardwareId" | "ip" | AnnouncedField, unknown>>): boolean {
        const at = now();
        sweep(at);
        const identities: Partial<Record<AnnouncedField, string>> = {};
        for (const field of ANNOUNCED_FIELDS) {
            const value = text(connection[field]);
            if (value) identities[field] = value;
        }
        if (!Object.keys(identities).length) return false;
        const entryKey = key(connection.nickname, connection.hardwareId, connection.ip);
        pending.set(entryKey, [...(pending.get(entryKey) || []), { identities: Object.freeze(identities), expiresAt: at + PENDING_MS }]);
        return true;
    }

    /** Hands the identifiers its join announced to the player who took the slot. */
    function attach(player: Player): AnnouncedIdentities | null {
        const ip = typeof player.getIP === "function" ? player.getIP() : player.ip;
        const entryKey = key(player.nickname, player.hardwareId, ip);
        const list = pending.get(entryKey);
        const entry = list?.shift();
        if (list && !list.length) pending.delete(entryKey);
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

export = { createAnnounced, ANNOUNCED_FIELDS };

import type { HmpCoreTicket, HmpCoreTicketConnection, HmpCoreTicketRedeemer, HmpCoreTicketRedeemerInfo } from "../types";
import type { CoreTicketsConfig, Player } from "./internal";

interface TicketOptions {
    config: CoreTicketsConfig;
    /** Whether the host passes a launch link's ticket on; false leaves `required` unenforced. */
    supported: boolean;
    logger: { warn(message: string): unknown };
    now?: () => number;
}

interface RedeemerEntry extends HmpCoreTicketRedeemerInfo {
    redeem: HmpCoreTicketRedeemer["redeem"];
}

// A queue can hold a join for a while before the player takes a slot.
const PENDING_MS = 15 * 60_000;
const NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function hostAtLeast(version: unknown, major: number, minor: number): boolean {
    const match = /^(\d+)\.(\d+)/.exec(text(version).trim());
    if (!match) return false;
    return Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor);
}

function createTickets(options: TicketOptions) {
    const { config, supported, logger } = options;
    const now = options.now || Date.now;
    const redeemers = new Map<string, RedeemerEntry>();
    const pending = new Map<string, Array<HmpCoreTicket & { expiresAt: number }>>();
    const repeats = new Map<string, HmpCoreTicket & { expiresAt: number }>();
    const byPlayer = new Map<number, HmpCoreTicket>();
    let warnedNoRedeemer = false;

    function register(definition: HmpCoreTicketRedeemer): () => boolean {
        if (!definition || typeof definition.redeem !== "function") throw new TypeError("ticket redeemer redeem must be a function");
        const name = String(definition.name ?? "").trim().toLowerCase();
        if (!NAME.test(name)) throw new TypeError("ticket redeemer name must be 1-64 lowercase letters, numbers, dots, colons, underscores or hyphens");
        if (redeemers.has(name)) throw Object.assign(new Error(`Ticket redeemer ${name} is already registered`), { code: "HMP_CORE_REDEEMER_EXISTS" });
        const entry: RedeemerEntry = Object.freeze({
            name,
            resource: String(definition.resource || "unknown"),
            priority: Number.isFinite(Number(definition.priority)) ? Number(definition.priority) : 0,
            redeem: definition.redeem,
        });
        redeemers.set(name, entry);
        return () => redeemers.get(name) === entry && redeemers.delete(name);
    }

    function unregister(name: string): boolean {
        return redeemers.delete(String(name ?? "").trim().toLowerCase());
    }

    function removeForResource(resource: string): number {
        let removed = 0;
        for (const [name, entry] of redeemers) if (entry.resource === resource && redeemers.delete(name)) removed++;
        return removed;
    }

    function sweep(at: number): void {
        for (const [key, entry] of repeats) if (entry.expiresAt <= at) repeats.delete(key);
        for (const [key, list] of pending) {
            const live = list.filter((entry) => entry.expiresAt > at);
            if (live.length) pending.set(key, live);
            else pending.delete(key);
        }
    }

    function playerKey(nickname: unknown, hardwareId: unknown, ip: unknown): string {
        return JSON.stringify([text(nickname), text(hardwareId), text(ip)]);
    }

    async function redeem(details: HmpCoreTicketConnection): Promise<HmpCoreTicket | null> {
        const ordered = [...redeemers.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
        for (const entry of ordered) {
            try {
                const result = await entry.redeem(details);
                if (result) return { redeemer: entry.name, result, repeat: false };
            } catch (error) {
                logger.warn(`[hmp-core] ticket redeemer ${entry.name} failed for ${details.nickname || "a joining player"}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return null;
    }

    async function connecting(connection: HogwartsMpPendingConnection): Promise<HmpCoreTicket | null> {
        const enforce = config.required && supported;
        if (!redeemers.size && !enforce) return null;
        const at = now();
        sweep(at);
        const details: HmpCoreTicketConnection = Object.freeze({
            ticket: text(connection.ticket),
            nickname: text(connection.nickname),
            steamId: text(connection.steamId),
            epicId: text(connection.epicId),
            discordId: text(connection.discordId),
            hardwareId: text(connection.hardwareId),
            ip: text(connection.ip),
        });
        let accepted: HmpCoreTicket | null = null;
        if (details.ticket) {
            // The game's mod-sync restart and the join dialog's Try again present the same ticket again.
            const repeatKey = JSON.stringify([details.ticket, details.hardwareId, details.ip]);
            const previous = repeats.get(repeatKey);
            accepted = previous ? { redeemer: previous.redeemer, result: previous.result, repeat: true } : await redeem(details);
            if (accepted && !previous && config.repeatSeconds > 0) repeats.set(repeatKey, { ...accepted, expiresAt: at + config.repeatSeconds * 1000 });
        }
        if (accepted) {
            const key = playerKey(details.nickname, details.hardwareId, details.ip);
            pending.set(key, [...(pending.get(key) || []), { ...accepted, expiresAt: at + PENDING_MS }]);
            return accepted;
        }
        if (enforce) {
            if (!redeemers.size && !warnedNoRedeemer) {
                logger.warn("[hmp-core] tickets.required is on but no resource registered a ticket redeemer; every join is turned away");
                warnedNoRedeemer = true;
            }
            connection.reject(config.rejectMessage);
        }
        return null;
    }

    /** Hands the ticket its join was accepted with to the player who took the slot. */
    function attach(player: Player): HmpCoreTicket | null {
        const id = Number(player.id);
        const ip = typeof player.getIP === "function" ? player.getIP() : player.ip;
        const key = playerKey(player.nickname, player.hardwareId, ip);
        const list = pending.get(key);
        const entry = list?.shift();
        if (list && !list.length) pending.delete(key);
        if (!entry || entry.expiresAt <= now()) return null;
        const ticket: HmpCoreTicket = Object.freeze({ redeemer: entry.redeemer, result: entry.result, repeat: entry.repeat });
        byPlayer.set(id, ticket);
        return ticket;
    }

    function detach(player: Player | number): boolean {
        return byPlayer.delete(Number(player && typeof player === "object" ? player.id : player));
    }

    function get(player: Player | number): HmpCoreTicket | null {
        return byPlayer.get(Number(player && typeof player === "object" ? player.id : player)) || null;
    }

    const api = Object.freeze({
        register,
        unregister,
        list: (): HmpCoreTicketRedeemerInfo[] => [...redeemers.values()].map(({ redeem: _, ...entry }) => entry),
        get,
        required: () => config.required && supported,
    });
    return { api, connecting, attach, detach, removeForResource };
}

export = { createTickets, hostAtLeast };

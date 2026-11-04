export type HmpEmoteKind = "pose" | "ability";
export type HmpEmoteChannel = "FullBody" | "PartialBody";
/** The game's own pastimes the host plays on a player, each with a companion it animates (`player.startActivity`). */
export type HmpEmoteActivityId = "kite" | "fireworks" | "raincloud" | "snitch" | "band" | "howler" | "livingbook" | "cards";

export interface HmpEmotePlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
    /** Missing on a host before HogwartsMP 1.11. */
    startActivity?(id: string, variant?: string): void;
    finishActivity?(): void;
    getActivity?(): { id: string; variant: string } | null;
}

export interface HmpEmoteDefinition {
    name: string;
    path: string;
    kind: HmpEmoteKind;
    channel: HmpEmoteChannel;
    /** Resource-owned registrations are removed automatically when that resource stops. */
    resource?: string;
}

export type HmpEmoteCandidate = Pick<HmpEmoteDefinition, "path" | "kind" | "channel">;

export interface HmpEmoteAliasRecord extends HmpEmoteDefinition {
    source: "config" | "resource" | "database";
    hidden?: boolean;
    updatedByAccountId?: number | null;
    updatedAt?: string | Date | null;
}

export interface HmpEmotesApi<P = HmpEmotePlayer> {
    list(): HmpEmoteDefinition[];
    get(name: string): HmpEmoteDefinition | null;
    play(player: P, name: string): Promise<boolean>;
    stop(player: P): boolean;
}

export interface HmpEmoteAliasesApi<P = HmpEmotePlayer> {
    register(definition: HmpEmoteDefinition): () => boolean;
    unregister(name: string, resource?: string): boolean;
    list(): HmpEmoteAliasRecord[];
    get(name: string): HmpEmoteAliasRecord | null;
    set(actor: P, definition: HmpEmoteDefinition): Promise<HmpEmoteAliasRecord>;
    /** Allow a discovered asset using a stable generated command alias. */
    allow(actor: P, definition: HmpEmoteCandidate): Promise<HmpEmoteAliasRecord>;
    /** Remove every server alias for a discovered asset. */
    deny(actor: P, path: string): Promise<number>;
    hide(actor: P, name: string): Promise<boolean>;
    clearPath(actor: P, path: string): Promise<number>;
}

export interface HmpEmoteFavoritesApi<P = HmpEmotePlayer> {
    list(player: P): Promise<string[]>;
    toggle(player: P, path: string): Promise<string[]>;
}

/** A player activity and the variants it takes; none means the host picks. Not an `hmp-activities` lobby. */
export interface HmpEmoteActivity {
    id: HmpEmoteActivityId;
    variants: string[];
}

export interface HmpEmoteActivitiesApi<P = HmpEmotePlayer> {
    /** The activities this server offers, from the `activities` config. */
    list(): HmpEmoteActivity[];
    /** Starts one on the player, replacing one under way; false when it is not offered, the variant is unknown or the host has none. */
    start(player: P, id: string, variant?: string): boolean;
    /** Ends the player's activity, its companion leaving and the outro playing; false on a host without activities. */
    finish(player: P): boolean;
    /** The player's activity as their client last reported it, or null. */
    get(player: P): { id: string; variant: string } | null;
}

export interface HmpEmoteUiApi<P = HmpEmotePlayer> {
    open(player: P): Promise<boolean>;
    close(player: P): boolean;
    sync(player: P): Promise<boolean>;
}

export interface HmpEmotesStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    aliases: number;
    configuredAliases: number;
    registeredAliases: number;
    persistedOverrides: number;
    readyClients: number;
    openMenus: number;
    uptimeMs: number;
}

export interface HmpEmotesServer<P = HmpEmotePlayer> {
    emotes: HmpEmotesApi<P>;
    aliases: HmpEmoteAliasesApi<P>;
    favorites: HmpEmoteFavoritesApi<P>;
    ui: HmpEmoteUiApi<P>;
    activities: HmpEmoteActivitiesApi<P>;
    status(): HmpEmotesStatus;
}

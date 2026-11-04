import type { HmpCore } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootPlayer, HmpLootPolicy, HmpLootRecord, HmpLootServer, HmpLootSpotFamily, HmpLootSpotYield } from "../types";

export type LootSpotMode = "shared" | "perPlayer";

export interface LootSpotSettings {
    respawnSeconds?: number;
    yield?: HmpLootSpotYield;
}

/** LootSpots settings; null leaves the host's. */
export interface LootSpotConfig {
    mode: LootSpotMode | null;
    respawnSeconds: number | null;
    yield: HmpLootSpotYield | null;
    /** By kind or family; a family's go first, so a kind of it overrides them. */
    kinds: Record<string, LootSpotSettings>;
}

export interface LootConfig {
    command: string;
    enableCommands: boolean;
    adminGroups: Array<{ key: string; minimumGrade?: number }>;
    /** true switches that family of the game's own loot off for as long as the resource runs. */
    suppressGameLoot: HmpLootFamilies;
    /** Each family's policy for as long as the resource runs; null follows suppressGameLoot. */
    gameLoot: Record<HmpLootSpotFamily, HmpLootPolicy | null>;
    lootSpots: LootSpotConfig;
    lootables: HmpLootDefinition[];
    /** How often expired takes are swept, in milliseconds. */
    sweepMs: number;
}

/** The Framework's server-side Lootables builtin, as far as this resource uses it. */
export interface NativeLootables<P> {
    place(kind: string, x: number, y: number, z: number, yaw: number,
        options: { items: HmpLootItem[]; locked?: boolean; mode: "shared" | "perPlayer"; model?: string }): number;
    setItems(id: number, items: HmpLootItem[]): boolean;
    setView(id: number, player: P, view: { items?: HmpLootItem[]; locked?: boolean } | null): boolean;
    remove(id: number): boolean;
}

/** The Framework's World builtin's loot switch; lootPolicy and setLootPolicy are HogwartsMP 1.11 or newer. */
export interface NativeWorldLoot {
    readonly lootSuppressed: HmpLootFamilies;
    suppressLoot(families: Partial<HmpLootFamilies>): boolean;
    readonly lootPolicy?: Record<HmpLootSpotFamily, HmpLootPolicy>;
    setLootPolicy?(policy: Partial<Record<HmpLootSpotFamily, HmpLootPolicy>>): boolean;
}

/** The Framework's LootSpots builtin (HogwartsMP 1.11 or newer), as far as this resource uses it. */
export interface NativeLootSpots {
    readonly mode: LootSpotMode;
    get(id: string): { kind: string; family: HmpLootSpotFamily } | null;
    getKinds(): Array<{ kind: string; family: HmpLootSpotFamily }>;
    setMode(mode: LootSpotMode): boolean;
    setRespawnSeconds(seconds: number, kind?: string): boolean;
    setYield(count: HmpLootSpotYield, kind?: string): boolean;
}

export type Database = Pick<HmpMySQL, "query" | "update" | "migrate"> & Partial<Pick<HmpMySQL, "ready">>;

export interface LootRepository {
    start(migrations: HmpMySQLMigration[]): Promise<void>;
    loadAll(): Promise<HmpLootRecord[]>;
    put(record: HmpLootRecord): Promise<void>;
    remove(key: string, characterId: number | null): Promise<void>;
}

export interface LootDependencies<P extends HmpLootPlayer> {
    config: LootConfig;
    lootables: NativeLootables<P>;
    world: NativeWorldLoot;
    /** Null on a host without LootSpots. */
    spots?: NativeLootSpots | null;
    repository: LootRepository;
    migrations: HmpMySQLMigration[];
    core: Pick<HmpCore<P>, "characters" | "accounts">;
    players(): P[];
    logger?: Pick<HmpLogger, "warn" | "info">;
    emit?: (eventName: string, payload: unknown) => void;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => () => void;
}

export interface LootService<P extends HmpLootPlayer> extends HmpLootServer<P> {
    /** Migrates, loads the takes, sets the game's loot policy and places every lootable; once. */
    ready(): Promise<void>;
    /** A Lootables take, from the lootableTaken event. */
    taken(player: P, lootableId: number, items: HmpLootItem[]): Promise<void>;
    /** A LootSpots take, from the lootSpotTaken event; raised as hmp:loot:spotTaken. */
    spotTaken(player: P, spotId: string, items: HmpLootItem[]): void;
    /** What this player's current character may take; call when a character loads or unloads. */
    sync(player: P): void;
    stop(): void;
}

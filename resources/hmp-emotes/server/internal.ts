import type { HmpCore } from "../../hmp-core/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpEmoteActivityId, HmpEmoteAliasRecord, HmpEmoteDefinition, HmpEmotePlayer, HmpEmotesServer } from "../types";

export interface EmoteConfig {
    command: string;
    enabled: boolean;
    allowAll: boolean;
    /** Pre-0.1 compatibility name; normalized into allowAll. */
    browseUnaliased?: boolean;
    maxFavorites: number;
    maxAliases: number;
    editorGroups: Array<{ key: string; minimumGrade?: number }>;
    ui: { url: string };
    aliases: Record<string, string | Partial<HmpEmoteDefinition>>;
    /** The player activities offered through /emote and the menu; [] offers none. */
    activities: HmpEmoteActivityId[];
}

export interface PersistedAlias extends HmpEmoteAliasRecord {
    source: "database";
    hidden: boolean;
}

export interface EmoteRepository {
    start(migrations: HmpMySQLMigration[]): Promise<void>;
    list(): Promise<PersistedAlias[]>;
    put(record: { name: string; path: string | null; kind: string; channel: string; hidden: boolean; actorAccountId: number | null }): Promise<void>;
}

export interface EmoteDependencies<P extends HmpEmotePlayer> {
    database: HmpMySQL;
    repository: EmoteRepository;
    core: HmpCore<P>;
    config: EmoteConfig;
    migrations: HmpMySQLMigration[];
    players(): P[];
    events: { emit(name: string, ...args: unknown[]): unknown };
    warn?(message: string): void;
    now?: () => number;
}

export interface EmoteService<P extends HmpEmotePlayer> extends HmpEmotesServer<P> {
    ready(): Promise<boolean>;
    onClientReady(player: P): Promise<boolean>;
    aliasRequest(player: P): Promise<boolean>;
    favoriteRequest(player: P): Promise<boolean>;
    removeForResource(resource: string): number;
    disconnect(player: P): void;
    stop(): void;
}

export type Database = HmpMySQL;

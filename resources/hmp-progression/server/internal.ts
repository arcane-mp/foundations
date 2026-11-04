import type { HmpCore } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration, HmpMySQLTransaction } from "../../hmp-mysql/types";
import type {
    HmpFlooFlamesApi,
    HmpManagedTalent,
    HmpProgression,
    HmpProgressionOperation,
    HmpProgressionPlayer,
    HmpProgressionProfile,
    HmpProgressionRewardTransaction,
    HmpTalentAcquisition,
} from "../types";

export type Player = HogwartsMpPlayer & HmpProgressionPlayer;
export type Core = HmpCore<Player>;
export type Database = HmpMySQL;
export type Logger = Pick<HmpLogger, "info" | "warn" | "error">;

export interface ProgressionConfig {
    enableCommands: boolean;
    command: string;
    adminGroups: Array<{ key: string; minimumGrade: number }>;
    maximumExperience: number;
    maximumTalentPoints: number;
    nativeRequestTimeoutMs: number;
    /** Keep each character's lit Floo flames and light them again when it loads. */
    flooFlames: boolean;
    /** Keep each character's Field Guide collections and challenges and restore them when it loads. */
    fieldGuide: boolean;
}

export interface RewardDraft {
    reference: string;
    characterId: number;
    operation: HmpProgressionOperation;
    amount: number;
    actorCharacterId: number | null;
    resource: string;
    reason: string;
    metadata: Record<string, unknown>;
}

export interface TalentMutation {
    characterId: number;
    talentId: string;
    level: number;
    status: "owned" | "revoked";
    acquisition: HmpTalentAcquisition;
    actorCharacterId: number | null;
    resource: string;
    reason: string;
}

export interface ProgressionRepository {
    migrate(migrations: HmpMySQLMigration[]): Promise<unknown>;
    profile(characterId: number, tx?: HmpMySQLTransaction, lock?: boolean): Promise<HmpProgressionProfile>;
    reward(reference: string, tx?: HmpMySQLTransaction, lock?: boolean): Promise<HmpProgressionRewardTransaction | null>;
    beginReward(draft: RewardDraft): Promise<{ created: boolean; transaction: HmpProgressionRewardTransaction }>;
    applyReward(reference: string, maximumExperience: number): Promise<HmpProgressionRewardTransaction>;
    failReward(reference: string, error: string): Promise<HmpProgressionRewardTransaction>;
    rewardHistory(characterId: number, limit: number): Promise<HmpProgressionRewardTransaction[]>;
    pendingRewards(limit: number): Promise<HmpProgressionRewardTransaction[]>;
    acknowledge(characterId: number, revision: number, level: number, talentPoints: number): Promise<HmpProgressionProfile>;
    talents(characterId: number, includeRevoked: boolean): Promise<HmpManagedTalent[]>;
    talent(characterId: number, talentId: string, tx?: HmpMySQLTransaction, lock?: boolean): Promise<HmpManagedTalent | null>;
    mutateTalent(mutation: TalentMutation): Promise<HmpManagedTalent>;
    purchaseTalent(mutation: TalentMutation): Promise<HmpManagedTalent>;
    resetTalents(characterId: number, mutation: Omit<TalentMutation, "characterId" | "talentId" | "level" | "status" | "acquisition">): Promise<number>;
    setTalentPoints(characterId: number, points: number): Promise<HmpProgressionProfile>;
    flooFlames(characterId: number): Promise<string[]>;
    lightFlooFlames(characterId: number, ids: string[]): Promise<number>;
    dimFlooFlames(characterId: number, ids: string[]): Promise<number>;
    fieldGuide(characterId: number): Promise<string | null>;
    saveFieldGuide(characterId: number, snapshotJson: string): Promise<void>;
}

export interface ProgressionDependencies {
    repository: ProgressionRepository;
    core: Core;
    events: { emit(eventName: string, ...args: unknown[]): unknown };
    logger: Logger;
    config: ProgressionConfig;
    migrations: HmpMySQLMigration[];
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}

export interface ProgressionService extends Omit<HmpProgression<Player>, "flooFlames"> {
    start(): Promise<void>;
    characterLoaded(player: Player): Promise<void>;
    worldReady(player: Player): Promise<void>;
    nativeReport(player: Player, payload: unknown): Promise<void>;
    nativeResult(player: Player, payload: unknown): Promise<void>;
    disconnect(player: Player): boolean;
    stop(): Promise<void>;
}

export interface FlooFlameDependencies {
    repository: Pick<ProgressionRepository, "flooFlames" | "lightFlooFlames" | "dimFlooFlames">;
    core: Core;
    logger: Logger;
    enabled: boolean;
    /** Resolves once the schema is migrated. */
    ready(): Promise<void>;
}

export interface FlooFlames {
    api: HmpFlooFlamesApi<Player>;
    characterLoaded(player: Player): Promise<void>;
    unlocked(player: Player, unlock: unknown): Promise<void>;
    disconnect(player: Player): void;
}

export interface FieldGuideDependencies {
    repository: Pick<ProgressionRepository, "fieldGuide" | "saveFieldGuide">;
    core: Core;
    logger: Logger;
    enabled: boolean;
    /** Resolves once the schema is migrated. */
    ready(): Promise<void>;
}

export interface FieldGuideSync {
    characterLoaded(player: Player): Promise<void>;
    characterUnloaded(player: Player): void;
    worldReady(player: Player): void;
    /** The client's restore (or adoption) result. */
    result(player: Player, payload: unknown): void;
    save(player: Player, payload: unknown): void;
    disconnect(player: Player): void;
    /** Resolves once every accepted save is written. */
    idle(): Promise<void>;
}

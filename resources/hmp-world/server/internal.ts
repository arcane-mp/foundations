import type {
    HmpWorldDateConfig,
    HmpWorldEnvironmentConfig,
    HmpWorldPlayer,
    HmpWorldPolicy,
    HmpWorldPopulationType,
    HmpWorldSeason,
} from "../types";

export interface WorldConfig {
    environment: HmpWorldEnvironmentConfig;
    policy: HmpWorldPolicy;
}

export interface NativeWorld {
    readonly weather: string;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
    readonly day: number;
    readonly month: number;
    readonly year: number;
    readonly season: 0 | 1 | 2 | 3;
    readonly timeScale: number;
    readonly revision: number;
    setWeather(name: string): boolean;
    setTime(hour: number, minute: number, second?: number): boolean;
    setDate(day: number, month: number, year?: number): boolean;
    setSeason(season: number): boolean;
    setTimeScale(minutesPerSecond: number): boolean;
    setEncounterPolicy(policy: "suppressed" | "server"): boolean;
    /** Players block each other's movement on every client. Absent on a host older than player collision. */
    setPlayerCollision?(on: boolean): boolean;
}

export interface WorldEvents<P extends HmpWorldPlayer> {
    emitAllClients(eventName: string, payload?: unknown): void;
}

export interface WorldServiceOptions<P extends HmpWorldPlayer> {
    config: WorldConfig;
    native: NativeWorld;
    events: WorldEvents<P>;
    players(): P[];
    now?: () => number;
}

export const SEASONS: Readonly<Record<Exclude<HmpWorldSeason, number>, 0 | 1 | 2 | 3>> = Object.freeze({
    spring: 0,
    summer: 1,
    autumn: 2,
    winter: 3,
});

// The host's PopulationType: a client's World.setPopulationExclusions throws on any other.
export const POPULATION_TYPES: ReadonlySet<string> = new Set<HmpWorldPopulationType>([
    "vendors", "students", "townsfolk",
    "AmbientPortrait", "CentaurCharacter", "DarkWizardCharacter", "Enforcer", "Extra", "Fence", "Ghost",
    "GoblinCharacter", "HouseElf", "Howler", "MarketingOnlyCharacter", "OLI_Townie", "OtherCharacter",
    "OtherNonCharacter", "Pacifist", "Player", "PlayerFightClubAlly", "PortraitCharacter", "Prefect", "Professor",
    "Professor_BattleOfHogwartsA", "Professor_BattleOfHogwartsB", "Professor_BattleOfHogwartsC",
    "Professor_BattleOfHogwartsD", "SortingHatCharacter", "Staff", "StatueBustCharacter", "Student",
    "Student_DuelAdversary1", "Student_DuelAdversary2", "Student_DuelAdversary3", "Student_SelfDefense",
    "StudentFightClubOpponent", "T3Authority", "T3AzkabanPrisoner", "T3DarkWizard", "T3Ghost", "T3HouseElf",
    "T3Student", "T3Townsperson", "T3Worker", "T3YoungChild", "T3YoungStudent", "T4DarkWizard", "T4Goblin",
    "T4Student", "T4Townsperson", "Townsperson", "Vendor",
]);

export type { HmpWorldDateConfig };

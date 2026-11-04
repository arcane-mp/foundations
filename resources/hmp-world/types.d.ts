export type HmpWorldSeason = "spring" | "summer" | "autumn" | "winter" | 0 | 1 | 2 | 3;

export interface HmpWorldTimeConfig {
    hour: number;
    minute: number;
    second: number;
    scale: number;
}

export interface HmpWorldDateConfig {
    day: number;
    month: number;
    /** Zero preserves Hogwarts Legacy's native year. */
    year: number;
}

export interface HmpWorldEnvironmentConfig {
    weather: string;
    time: HmpWorldTimeConfig;
    date: HmpWorldDateConfig;
    season: HmpWorldSeason;
}

/**
 * Who spawns the Overland's enemy camps and roaming world events: nobody (`suppressed`), or the server as NPCs
 * every player shares (`server`). A host newer than 1.9.2 also keeps quest and dungeon spawners shut under
 * both; 1.9 through 1.9.2 leaves them to the game, which spawns them on one client alone.
 */
export type HmpWorldEncounters = "suppressed" | "server";

/**
 * An NPC kind `population.exclusions.types` can name (host `PopulationType`): one of the game's character subtypes,
 * or a group. `students` and `townsfolk` bundle that kind's named, crowd and Tier-4 subtypes; `vendors` is every
 * shopkeeper.
 */
export type HmpWorldPopulationType =
    | "vendors" | "students" | "townsfolk"
    | "AmbientPortrait" | "CentaurCharacter" | "DarkWizardCharacter" | "Enforcer" | "Extra" | "Fence" | "Ghost"
    | "GoblinCharacter" | "HouseElf" | "Howler" | "MarketingOnlyCharacter" | "OLI_Townie" | "OtherCharacter"
    | "OtherNonCharacter" | "Pacifist" | "Player" | "PlayerFightClubAlly" | "PortraitCharacter" | "Prefect" | "Professor"
    | "Professor_BattleOfHogwartsA" | "Professor_BattleOfHogwartsB" | "Professor_BattleOfHogwartsC"
    | "Professor_BattleOfHogwartsD" | "SortingHatCharacter" | "Staff" | "StatueBustCharacter" | "Student"
    | "Student_DuelAdversary1" | "Student_DuelAdversary2" | "Student_DuelAdversary3" | "Student_SelfDefense"
    | "StudentFightClubOpponent" | "T3Authority" | "T3AzkabanPrisoner" | "T3DarkWizard" | "T3Ghost" | "T3HouseElf"
    | "T3Student" | "T3Townsperson" | "T3Worker" | "T3YoungChild" | "T3YoungStudent" | "T4DarkWizard" | "T4Goblin"
    | "T4Student" | "T4Townsperson" | "Townsperson" | "Vendor";

/** The scheduled NPCs each client keeps out of the world, with ambient population on or off. */
export interface HmpWorldPopulationExclusions {
    /** Scheduled-entity names, e.g. `GerboldOllivander`. */
    names: string[];
    types: HmpWorldPopulationType[];
}

export interface HmpWorldPopulationPolicy {
    /** Share of the ambient crowd each client lets out, 0 (none) to 1 (the game's own) (`World.setPopulationDensity`). */
    density: number;
    /** Applied by each client (`World.setPopulationExclusions`). */
    exclusions: HmpWorldPopulationExclusions;
}

export interface HmpWorldPolicy {
    /** Destroy native mount boundary volumes, including Hogsmeade's no-fly zone. */
    removeBoundaryVolumes: boolean;
    /** Restore Hogwarts Legacy's ambient student and seat-filler population. */
    ambientPopulation: boolean;
    /** Applied by the server for every client (`World.setEncounterPolicy`); clients are not sent it. */
    encounters: HmpWorldEncounters;
    /** Players block each other's movement, applied by the server for every client (`World.setPlayerCollision`). */
    playerCollision: boolean;
    /** Let players fast travel from their own map, applied by the server to each player (`player.setFastTravelEnabled`). */
    fastTravel: boolean;
    /** Carry each player's health over map loads, applied by the server to each player (`player.setKeepHealthOnTravel`). */
    keepHealthOnTravel: boolean;
    /** Let players jump, applied by each client as hmp-world's own hold (`LocalPlayer.setJumpEnabled`). */
    jump: boolean;
    /** Let players sprint, applied by each client as hmp-world's own hold (`LocalPlayer.setSprintEnabled`). */
    sprint: boolean;
    /** Thin the ambient crowd and keep NPCs out of it, applied by each client; left at the game's own while default. */
    population: HmpWorldPopulationPolicy;
}

/** What `policy.set` takes: `population` merges its keys, and `exclusions` replaces both lists. */
export type HmpWorldPolicyPatch = Partial<Omit<HmpWorldPolicy, "population">> & {
    population?: { density?: number; exclusions?: Partial<HmpWorldPopulationExclusions> };
};

/** The part of the policy each client applies itself. */
export type HmpWorldClientPolicy = Pick<HmpWorldPolicy, "removeBoundaryVolumes" | "ambientPopulation" | "jump" | "sprint" | "population">;

export interface HmpWorldEnvironmentState {
    weather: string;
    hour: number;
    minute: number;
    second: number;
    day: number;
    month: number;
    year: number;
    season: 0 | 1 | 2 | 3;
    timeScale: number;
    revision: number;
}

export interface HmpWorldEnvironmentApi {
    baseline(): Readonly<HmpWorldEnvironmentConfig>;
    state(): HmpWorldEnvironmentState | null;
    reset(): HmpWorldEnvironmentState | null;
    setWeather(weather: string): boolean;
    setTime(hour: number, minute: number, second?: number): boolean;
    setDate(day: number, month: number, year?: number): boolean;
    setSeason(season: HmpWorldSeason): boolean;
    setTimeScale(scale: number): boolean;
}

export interface HmpWorldPolicyApi<P = HmpWorldPlayer> {
    baseline(): Readonly<HmpWorldPolicy>;
    current(): Readonly<HmpWorldPolicy>;
    set(patch: HmpWorldPolicyPatch): Readonly<HmpWorldPolicy>;
    reset(): Readonly<HmpWorldPolicy>;
    sync(player?: P): number;
}

export interface HmpWorldStatus {
    state: "ready" | "stopped";
    environment: HmpWorldEnvironmentState | null;
    policy: Readonly<HmpWorldPolicy>;
    readyClients: number;
    uptimeMs: number;
}

export interface HmpWorldPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    emit(eventName: string, payload?: unknown): void;
    /** Absent on a host older than the fast-travel gate. */
    setFastTravelEnabled?(on: boolean): void;
    /** Absent on a host older than keeping health over map loads. */
    setKeepHealthOnTravel?(on: boolean): void;
}

export interface HmpWorld<P = HmpWorldPlayer> {
    environment: HmpWorldEnvironmentApi;
    policy: HmpWorldPolicyApi<P>;
    status(): HmpWorldStatus;
}

export interface HmpWorldClientPolicyApi {
    current(): Readonly<HmpWorldClientPolicy> | null;
    /** Reapply the most recent server-authored policy after a temporary client-side override. */
    restore(): boolean;
}

export interface HmpWorldClientStatus {
    state: "ready" | "stopped";
    policy: Readonly<HmpWorldClientPolicy> | null;
    boundaryVolumesChanged: number;
}

export interface HmpWorldClient {
    policy: HmpWorldClientPolicyApi;
    status(): HmpWorldClientStatus;
}

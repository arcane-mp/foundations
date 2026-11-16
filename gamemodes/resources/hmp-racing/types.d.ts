export interface HmpRacingVector3 {
    x: number;
    y: number;
    z: number;
}

/** A gate a racer flies through: a sphere of `radius` cm around a point. */
export interface HmpRacingCheckpoint extends HmpRacingVector3 {
    radius: number;
}

export interface HmpRacingTrack {
    /** 1-32 lowercase letters, numbers, hyphens or underscores. */
    id: string;
    label: string;
    /** Times round the checkpoints; a point-to-point track has 1. */
    laps: number;
    /** The map the track is on (`player.location().areaId`), "Overland" for the open world. */
    areaId: string;
    /** Where the grid forms, and the way it faces in degrees (0 faces +X, 90 faces +Y). */
    start: HmpRacingVector3 & { yaw: number };
    /** In order; a lap passes every one, and the last checkpoint of the last lap is the finish line. */
    checkpoints: HmpRacingCheckpoint[];
    /** "config" for data/hmp-racing.json, "world" for one authored in game with /race edit. */
    source: "config" | "world";
}

export interface HmpRacingResult {
    playerId: number;
    nickname: string;
    characterId: number | null;
    characterName: string | null;
    /** 1 for the winner; null for a racer who did not finish. */
    place: number | null;
    /** Race time in milliseconds, from the start signal; null without a finish. */
    timeMs: number | null;
    /** Each lap's time in milliseconds, in order. */
    lapsMs: number[];
    status: "finished" | "dnf" | "disqualified" | "left";
    /** Why a racer was disqualified ("teleport", "fastTravel"); empty otherwise. */
    reason: string;
    /** A new best time for the track on the server, or for this character. */
    trackRecord: boolean;
    personalBest: boolean;
}

/** Payload of the server `hmp-racing:finished` event, raised once for every race that started. */
export interface HmpRacingFinished {
    activitySessionId: string;
    track: string;
    trackLabel: string;
    laps: number;
    /** In finishing order, then the racers who did not finish. */
    results: HmpRacingResult[];
    /** True when the race ran out its time limit or was stopped before every racer was done. */
    cut: boolean;
    finishedAt: string;
}

/** A track's best time on the server, as `/race top` lists it. */
export interface HmpRacingRecord {
    track: string;
    timeMs: number;
    characterId: number | null;
    name: string;
    at: string;
}

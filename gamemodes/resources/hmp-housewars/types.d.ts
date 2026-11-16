export type HmpHouseWarsHouse = "gryffindor" | "hufflepuff" | "ravenclaw" | "slytherin";

export interface HmpHouseWarsVector3 {
    x: number;
    y: number;
    z: number;
}

/** A place to fight: a circle the fighters are held inside, on one map. */
export interface HmpHouseWarsArena {
    id: string;
    label: string;
    areaId: string;
    center: HmpHouseWarsVector3;
    /** Fighters are held within this many cm of the centre for the whole match. */
    radius: number;
}

export interface HmpHouseWarsFighter {
    playerId: number;
    nickname: string;
    characterId: number | null;
    characterName: string | null;
    house: HmpHouseWarsHouse;
    /** Opponents this fighter knocked out over the match. */
    knockouts: number;
    /** Rounds this fighter was still standing at the end of. */
    survived: number;
}

export interface HmpHouseWarsRoundResult {
    round: number;
    /** null for a drawn round. */
    winner: HmpHouseWarsHouse | null;
    reason: "elimination" | "time" | "forfeit";
    durationMs: number;
}

/** Payload of the server `hmp-housewars:finished` event, raised once for every match that started. */
export interface HmpHouseWarsFinished {
    activitySessionId: string;
    arena: string;
    houses: HmpHouseWarsHouse[];
    /** null when the match ended level or was stopped. */
    winner: HmpHouseWarsHouse | null;
    score: Partial<Record<HmpHouseWarsHouse, number>>;
    rounds: HmpHouseWarsRoundResult[];
    fighters: HmpHouseWarsFighter[];
    /** House Cup points each house received, by the hmp-houses ledger's reference `hmp-housewars:<session>:<house>`. */
    housePoints: Partial<Record<HmpHouseWarsHouse, number>>;
    stopped: boolean;
    finishedAt: string;
}

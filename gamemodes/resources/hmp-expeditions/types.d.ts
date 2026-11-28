export interface HmpExpeditionVector3 {
    x: number;
    y: number;
    z: number;
}

export interface HmpExpeditionEnemy {
    /** An `hmp-npcs` catalog id. */
    id: string;
    count: number;
}

/** One fight of an expedition: a place the party must reach, and the enemies waiting there. */
export interface HmpExpeditionStage extends HmpExpeditionVector3 {
    enemies: HmpExpeditionEnemy[];
    /** A boss: one enemy with a health pool of its own, scaled up for every fighter past the first. */
    boss: { id: string; health: number } | null;
}

export interface HmpExpedition {
    /** 1-32 lowercase letters, numbers, hyphens or underscores. */
    id: string;
    label: string;
    areaId: string;
    /** Where the party gathers at the start, facing `yaw` degrees. */
    entrance: HmpExpeditionVector3 & { yaw: number };
    /** In order; clearing the last one completes the expedition. */
    stages: HmpExpeditionStage[];
    /** Experience through hmp-progression for each fighter who sees it through; 0 gives none. */
    experience: number;
    /** "config" for data/hmp-expeditions.json, "world" for one built in game with /expedition edit. */
    source: "config" | "world";
}

export interface HmpExpeditionParticipant {
    playerId: number;
    nickname: string;
    characterId: number | null;
    characterName: string | null;
    /** Whether they were paid the expedition's experience. */
    rewarded: boolean;
}

/** Payload of the server `hmp-expeditions:finished` event, raised once for every run that started. */
export interface HmpExpeditionFinished {
    activitySessionId: string;
    expedition: string;
    label: string;
    result: "cleared" | "wiped" | "timeout" | "abandoned" | "stopped" | "failed";
    /** Stages cleared, of `stages`. */
    cleared: number;
    stages: number;
    defeated: number;
    durationMs: number;
    /** A new fastest clear on the server. */
    record: boolean;
    participants: HmpExpeditionParticipant[];
    finishedAt: string;
}

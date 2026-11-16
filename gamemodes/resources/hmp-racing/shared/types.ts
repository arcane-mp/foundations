import type { HmpRacingCheckpoint } from "../types";

/** Server -> client `hmp-racing:hud`. */
export type HudState =
    | { active: false }
    | {
        active: true;
        track: string;
        phase: "countdown" | "racing" | "finished" | "out";
        /** 1-based place among the racers still in. */
        place: number;
        racers: number;
        lap: number;
        laps: number;
        /** Checkpoints passed this lap, of `checkpoints`. */
        checkpoint: number;
        checkpoints: number;
        /** Race time when the server sent this; the client counts on from it. */
        elapsedMs: number;
        /** The last lap's time, or 0 before the first lap ends. */
        lastLapMs: number;
        /** The track's server record, or 0 without one. */
        recordMs: number;
    };

/** Server -> client `hmp-racing:gates`: the checkpoints to draw, the next first. */
export interface GateState {
    gates: Array<HmpRacingCheckpoint & { kind: "next" | "later" | "finish" }>;
}

/** Server -> client `hmp-racing:countdown`. */
export interface CountdownState {
    seconds: number;
    track: string;
}

export function formatTime(ms: number): string {
    const total = Math.max(0, Math.round(ms));
    const minutes = Math.floor(total / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const millis = total % 1000;
    return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

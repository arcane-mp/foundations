import type { HmpHouseWarsHouse } from "../types";

/** Server -> client `hmp-housewars:hud`. */
export type HudState =
    | { active: false }
    | {
        active: true;
        arena: string;
        phase: "lobby" | "countdown" | "fighting" | "intermission" | "over";
        round: number;
        rounds: number;
        /** Your house. */
        house: HmpHouseWarsHouse;
        /** Whether you are still up this round. */
        standing: boolean;
        houses: Array<{ house: HmpHouseWarsHouse; wins: number; standing: number; fighters: number }>;
        /** Milliseconds left in the phase when the server sent this; 0 when it has no clock. */
        remainingMs: number;
    };

/** Server -> client `hmp-housewars:countdown`. */
export interface CountdownState {
    seconds: number;
    round: number;
}

export const HOUSE_LABELS: Readonly<Record<HmpHouseWarsHouse, string>> = Object.freeze({
    gryffindor: "Gryffindor",
    hufflepuff: "Hufflepuff",
    ravenclaw: "Ravenclaw",
    slytherin: "Slytherin",
});

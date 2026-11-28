/** Server -> client `hmp-expeditions:hud`. */
export type HudState =
    | { active: false }
    | {
        active: true;
        expedition: string;
        phase: "countdown" | "running";
        stage: number;
        stages: number;
        /** Enemies of the current stage still standing. */
        remaining: number;
        boss: boolean;
        /** Time left when the server sent this; the client counts down from it. */
        remainingMs: number;
        recordMs: number;
    };

/** Server -> client `hmp-expeditions:objective`: where the current fight is. */
export type ObjectiveState = { active: false } | { active: true; x: number; y: number; z: number; boss: boolean };

export function formatTime(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

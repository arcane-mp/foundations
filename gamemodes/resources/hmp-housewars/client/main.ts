import type { HmpHouseWarsHouse } from "../types";
import type { CountdownState, HudState } from "../shared/types";

const RESOURCE = "hmp-housewars";
const HUD_URL = "fw://resources/hmp-housewars/dist/hud.html";
const HOUSES = ["gryffindor", "hufflepuff", "ravenclaw", "slytherin"];
const PHASES = ["lobby", "countdown", "fighting", "intermission", "over"];

let hudView = -1;
let hudState: HudState = { active: false };
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function record(value: unknown): Record<string, unknown> | null {
    if (typeof value === "string") {
        try { return record(JSON.parse(value)); } catch { return null; }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseHud(value: unknown): HudState {
    const source = record(value);
    if (!source || source.active !== true || !HOUSES.includes(String(source.house))) return { active: false };
    const houses = (Array.isArray(source.houses) ? source.houses : []).flatMap((entry) => {
        const row = record(entry);
        return row && HOUSES.includes(String(row.house))
            ? [{ house: row.house as HmpHouseWarsHouse, wins: finite(row.wins), standing: finite(row.standing), fighters: finite(row.fighters) }]
            : [];
    });
    return {
        active: true, arena: String(source.arena || ""),
        phase: (PHASES.includes(String(source.phase)) ? source.phase : "lobby") as "lobby",
        round: finite(source.round), rounds: finite(source.rounds, 3), house: source.house as HmpHouseWarsHouse,
        standing: source.standing === true, houses, remainingMs: finite(source.remainingMs),
    };
}

function renderHud(): void {
    if (hudView >= 0) Web.emit(hudView, "hud:update", hudState);
}

function openHud(): void {
    if (hudView >= 0) return;
    hudView = Web.createView(HUD_URL, { visible: false });
    if (hudView < 0) return;
    Web.on(hudView, "ready", renderHud);
    Web.showView(hudView);
}

function closeHud(): void {
    if (hudView < 0) return;
    Web.hideView(hudView);
    Web.destroyView(hudView);
    hudView = -1;
}

function stopCountdown(): void {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
}

Events.on(`${RESOURCE}:countdown`, (value: unknown) => {
    const source = record(value) as Partial<CountdownState> | null;
    let remaining = Math.max(1, Math.round(finite(source?.seconds, 5)));
    stopCountdown();
    Game.notify(`Round ${finite(source?.round, 1)} in ${remaining}…`);
    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { stopCountdown(); Game.notify("Fight!"); }
        else Game.notify(String(remaining));
    }, 1000);
});

Events.on(`${RESOURCE}:hud`, (value: unknown) => {
    hudState = parseHud(value);
    if (hudState.active) { openHud(); renderHud(); }
    else { stopCountdown(); closeHud(); }
});

Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    stopCountdown();
    closeHud();
});

console.log("[hmp-housewars] client ready");

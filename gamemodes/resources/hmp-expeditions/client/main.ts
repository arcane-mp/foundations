import type { HudState } from "../shared/types";

const RESOURCE = "hmp-expeditions";
const HUD_URL = "fw://resources/hmp-expeditions/dist/hud.html";
const MARKER = "hmp-expeditions:objective";

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
    if (!source || source.active !== true) return { active: false };
    return {
        active: true, expedition: String(source.expedition || ""), phase: source.phase === "countdown" ? "countdown" : "running",
        stage: finite(source.stage, 1), stages: finite(source.stages, 1), remaining: finite(source.remaining), boss: source.boss === true,
        remainingMs: finite(source.remainingMs), recordMs: finite(source.recordMs),
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

function clearMarker(): void {
    try { Shapes.destroy(MARKER); } catch (_) { /* gone */ }
}

Events.on(`${RESOURCE}:countdown`, (value: unknown) => {
    const source = record(value);
    let remaining = Math.max(1, Math.round(finite(source?.seconds, 5)));
    stopCountdown();
    Game.notify(`${String(source?.expedition || "Expedition")} sets off in ${remaining}…`);
    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { stopCountdown(); Game.notify("Onward!"); }
        else Game.notify(String(remaining));
    }, 1000);
});

// The current fight's place: a wide ring on the ground, red for a boss.
Events.on(`${RESOURCE}:objective`, (value: unknown) => {
    const source = record(value);
    if (!source || source.active !== true) { clearMarker(); return; }
    const color = source.boss === true ? { r: 230, g: 70, b: 60, a: 255 } : { r: 255, g: 200, b: 60, a: 255 };
    try {
        Shapes.create(MARKER, {
            type: "ring", center: { x: finite(source.x), y: finite(source.y), z: finite(source.z) }, radius: 900, thickness: 18,
            color, fill: { ...color, a: 30 }, ground: true,
        });
    } catch (error) { console.warn(`[hmp-expeditions] could not draw the objective: ${error instanceof Error ? error.message : String(error)}`); }
});

Events.on(`${RESOURCE}:hud`, (value: unknown) => {
    hudState = parseHud(value);
    if (hudState.active) { openHud(); renderHud(); }
    else { stopCountdown(); closeHud(); clearMarker(); }
});

Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    stopCountdown();
    clearMarker();
    closeHud();
});

console.log("[hmp-expeditions] client ready");

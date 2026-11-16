import type { CountdownState, GateState, HudState } from "../shared/types";

const RESOURCE = "hmp-racing";
const HUD_URL = "fw://resources/hmp-racing/dist/hud.html";
const GATE_KEY = "hmp-racing:gate:";

let hudView = -1;
let hudState: HudState = { active: false };
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let gateKeys: string[] = [];

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
    const phase = ["countdown", "racing", "finished", "out"].includes(String(source.phase)) ? source.phase as "racing" : "racing";
    return {
        active: true, track: String(source.track || ""), phase,
        place: finite(source.place), racers: finite(source.racers), lap: finite(source.lap, 1), laps: finite(source.laps, 1),
        checkpoint: finite(source.checkpoint), checkpoints: finite(source.checkpoints), elapsedMs: finite(source.elapsedMs),
        lastLapMs: finite(source.lastLapMs), recordMs: finite(source.recordMs),
    };
}

// Gates are client-only shapes: the next one gold, the ones after faint, the finish green.
const COLORS = {
    next: { outline: { r: 255, g: 200, b: 60, a: 255 }, fill: { r: 255, g: 200, b: 60, a: 40 } },
    later: { outline: { r: 255, g: 255, b: 255, a: 140 }, fill: null },
    finish: { outline: { r: 90, g: 230, b: 120, a: 255 }, fill: { r: 90, g: 230, b: 120, a: 50 } },
} as const;

function clearGates(): void {
    for (const key of gateKeys) { try { Shapes.destroy(key); } catch (_) { /* gone */ } }
    gateKeys = [];
}

function drawGates(value: unknown): void {
    clearGates();
    const source = record(value);
    const gates = Array.isArray(source?.gates) ? source!.gates as GateState["gates"] : [];
    gates.forEach((gate, index) => {
        const kind = gate.kind === "finish" || gate.kind === "later" ? gate.kind : "next";
        const key = `${GATE_KEY}${index}`;
        try {
            Shapes.create(key, {
                type: "sphere", center: { x: finite(gate.x), y: finite(gate.y), z: finite(gate.z) }, radius: finite(gate.radius, 800),
                thickness: kind === "later" ? 6 : 12, color: COLORS[kind].outline, fill: COLORS[kind].fill,
            });
            gateKeys.push(key);
        } catch (error) { console.warn(`[hmp-racing] could not draw a gate: ${error instanceof Error ? error.message : String(error)}`); }
    });
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
    Game.notify(`${String(source?.track || "Race")}: ${remaining}…`);
    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { stopCountdown(); Game.notify("Go!"); }
        else Game.notify(String(remaining));
    }, 1000);
});

Events.on(`${RESOURCE}:hud`, (value: unknown) => {
    hudState = parseHud(value);
    if (hudState.active) { openHud(); renderHud(); }
    else { stopCountdown(); closeHud(); }
});

Events.on(`${RESOURCE}:gates`, drawGates);

Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    stopCountdown();
    clearGates();
    closeHud();
});

console.log("[hmp-racing] client ready");

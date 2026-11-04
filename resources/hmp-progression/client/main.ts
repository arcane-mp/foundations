import fieldGuideModule = require("./fieldguide");

const { createFieldGuideClient } = fieldGuideModule;

interface SyncTalent { id: string; level: number; status: "owned" | "revoked" }
interface ClientStatus {
    state: "waiting" | "ready" | "degraded" | "stopped";
    revision: number;
    lastError: string;
}

const status: ClientStatus = { state: "waiting", revision: 0, lastError: "" };

function object(payload: unknown): Record<string, unknown> | null {
    if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { return null; }
    }
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
}

function report(payload: Record<string, unknown>): void {
    Events.emitServer("hmp-progression:native-report", JSON.stringify(payload));
}

function applySync(rawPayload: unknown): void {
    const payload = object(rawPayload);
    if (!payload) return;
    const characterId = Number(payload.characterId);
    const revision = Number(payload.revision);
    const targetPoints = Number(payload.experiencePoints);
    const targetTalentPoints = Number(payload.talentPoints);
    const talents = Array.isArray(payload.talents) ? payload.talents as SyncTalent[] : [];
    try {
        const progression = Progression.setPoints(targetPoints, {
            preserveTalentPoints: payload.preserveTalentPoints !== false,
            source: "HogwartsMP",
            detail: `Foundations revision ${revision}`,
        });
        if (!progression?.accepted) throw new Error("the game rejected the experience snapshot");
        if (!Talents.available()) throw new Error("the talent tree is not ready");

        for (const talent of talents.filter((entry) => entry.status === "revoked")) {
            if (Talents.has(talent.id)) Talents.remove(talent.id);
        }
        for (const talent of talents.filter((entry) => entry.status === "owned")) {
            if (!Talents.has(talent.id) && !Talents.grant(talent.id)) throw new Error(`the game refused talent '${talent.id}'`);
            if (talent.level > 1 && Talents.getLevel(talent.id) !== talent.level && !Talents.setLevel(talent.id, talent.level)) throw new Error(`the game refused level ${talent.level} for talent '${talent.id}'`);
        }
        const difference = targetTalentPoints - Talents.getPoints();
        if (difference !== 0 && !Talents.addPoints(difference)) throw new Error("the game refused the talent point reconciliation");

        status.state = "ready";
        status.revision = revision;
        status.lastError = "";
        report({ characterId, revision, experiencePoints: Progression.getPoints(), level: Progression.getLevel(), talentPoints: Talents.getPoints() });
    } catch (error) {
        status.state = "degraded";
        status.lastError = error instanceof Error ? error.message : String(error);
        console.warn(`[hmp-progression] synchronization failed: ${status.lastError}`);
    }
}

function handleRequest(rawPayload: unknown): void {
    const payload = object(rawPayload);
    if (!payload) return;
    const requestId = String(payload.requestId || "");
    const operation = String(payload.operation || "");
    let ok = false;
    let detail = "";
    let extra: Record<string, unknown> = {};
    try {
        if (operation === "levelBounds") {
            const bounds = Progression.getLevelBounds(Number(payload.level));
            ok = bounds !== null;
            extra = { bounds };
            if (!ok) detail = "the requested level has no experience bounds";
        } else if (operation === "purchase") {
            if (!Talents.available()) throw new Error("the talent tree is not ready");
            const id = String(payload.talentId || "");
            ok = Talents.has(id) || Talents.purchase(id);
            detail = ok ? (Talents.has(id) ? "purchased" : "accepted") : `refused (${Talents.getState(id) || "unknown"})`;
            extra = { talentId: id, talentPoints: Talents.getPoints(), talentLevel: Talents.getLevel(id) };
        } else if (operation === "remove") {
            const id = String(payload.talentId || "");
            ok = !Talents.has(id) || Talents.remove(id);
            extra = { talentId: id };
        } else {
            detail = `unknown native operation '${operation}'`;
        }
    } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
    }
    Events.emitServer("hmp-progression:native-result", JSON.stringify({ requestId, operation, ok, detail, ...extra }));
}

// A host without FieldGuide answers the server's restore as unsupported.
const fieldGuide = createFieldGuideClient({
    native: typeof FieldGuide === "undefined" || !FieldGuide || typeof FieldGuide.restore !== "function" ? null : FieldGuide,
    emitServer: (eventName, payload) => { Events.emitServer(eventName, payload); },
    setTimer: (handler, delay) => setTimeout(handler, delay),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    warn: (message) => console.warn(`[hmp-progression] ${message}`),
});

Exports.register("clientStatus", () => ({ ...status, fieldGuide: fieldGuide.state() }));
Events.on("hmp-progression:sync", applySync);
Events.on("hmp-progression:request", handleRequest);
Events.on("hmp-progression:field-guide", fieldGuide.receive);
Events.on("fieldGuideCollectionChanged", () => fieldGuide.changed());
Events.on("fieldGuideChallengeChanged", () => fieldGuide.changed());
Events.on("resourceStop", (name?: string) => {
    if (name && name !== "hmp-progression") return;
    status.state = "stopped";
    fieldGuide.stop();
});

console.info("[hmp-progression] client progression and talent reconciler ready");

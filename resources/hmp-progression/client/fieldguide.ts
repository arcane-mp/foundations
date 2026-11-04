import fieldGuideModule = require("../shared/fieldguide");

const { maximumSnapshotBytes, utf8Length } = fieldGuideModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

type Timer = unknown;
type NativeFieldGuide = Pick<typeof FieldGuide, "ready" | "snapshot" | "restore">;

type FieldGuideClientState = "waiting" | "restoring" | "watching" | "failed" | "unsupported";

interface FieldGuideClientDependencies {
    /** The host's FieldGuide; null on a host without it. */
    native: NativeFieldGuide | null;
    emitServer(eventName: string, payload: string): void;
    setTimer(handler: () => void, delay: number): Timer;
    clearTimer(timer: Timer): void;
    warn(message: string): void;
    now?: () => number;
    readyTimeoutMs?: number;
    pollMs?: number;
    /** How long changes gather before one snapshot is sent. */
    batchMs?: number;
}

interface Load { characterId: number; token: number }

function createFieldGuideClient(dependencies: FieldGuideClientDependencies) {
    const { native, emitServer, setTimer, clearTimer, warn } = dependencies;
    const now = dependencies.now || Date.now;
    const readyTimeoutMs = dependencies.readyTimeoutMs ?? 120_000;
    const pollMs = dependencies.pollMs ?? 500;
    const batchMs = dependencies.batchMs ?? 2_000;
    let state: FieldGuideClientState = "waiting";
    let load: Load | null = null;
    let poll: Timer | null = null;
    let batch: Timer | null = null;

    function cancel(): void {
        if (poll !== null) clearTimer(poll);
        if (batch !== null) clearTimer(batch);
        poll = batch = null;
    }
    function acknowledge(current: Load, outcome: Record<string, unknown>): void {
        emitServer("hmp-progression:field-guide-result", JSON.stringify({ characterId: current.characterId, token: current.token, ...outcome }));
    }

    function send(): void {
        batch = null;
        if (state !== "watching" || !load || !native) return;
        let snapshot: HogwartsMpFieldGuideSnapshot | null = null;
        try { snapshot = native.snapshot(); }
        catch (error) { warn(`Field Guide snapshot failed: ${messageOf(error)}`); }
        if (!snapshot) { changed(); return; }
        const payload = JSON.stringify({ characterId: load.characterId, token: load.token, snapshot });
        if (utf8Length(payload) > maximumSnapshotBytes) {
            warn(`Field Guide snapshot is larger than ${maximumSnapshotBytes} bytes; not saved`);
            return;
        }
        emitServer("hmp-progression:field-guide-save", payload);
    }

    function changed(): void {
        if (state === "watching" && batch === null) batch = setTimer(send, batchMs);
    }

    function apply(current: Load, restore: boolean, snapshot: HogwartsMpFieldGuideSnapshot | null): void {
        if (!restore) {
            state = "watching";
            acknowledge(current, { ok: true, adopted: true });
            send();
            return;
        }
        let outcome: HogwartsMpFieldGuideRestoreResult;
        try { outcome = native!.restore(snapshot); }
        catch (error) { outcome = { ok: false, reason: messageOf(error), mismatches: [], needsTravel: false }; }
        const reason = typeof outcome?.reason === "string" && outcome.reason ? outcome.reason : outcome ? "" : "no restore result";
        state = reason ? "failed" : "watching";
        acknowledge(current, {
            ok: outcome?.ok === true, ...(reason ? { reason } : {}),
            mismatches: Array.isArray(outcome?.mismatches) ? outcome.mismatches.slice(0, 20) : [], needsTravel: outcome?.needsTravel === true,
        });
        if (reason) warn(`Field Guide restore failed: ${reason}`);
        // A reset leaves nothing stored yet, so the clean state is saved now.
        else if (snapshot === null) send();
    }

    function receive(raw: unknown): void {
        let message = raw;
        if (typeof message === "string") {
            try { message = JSON.parse(message); } catch { return; }
        }
        if (!message || typeof message !== "object") return;
        const { characterId, token, restore, snapshot } = message as { characterId?: unknown; token?: unknown; restore?: unknown; snapshot?: unknown };
        if (!Number.isSafeInteger(characterId) || !Number.isSafeInteger(token) || load?.token === token) return;
        cancel();
        const current: Load = load = { characterId: characterId as number, token: token as number };
        if (!native) {
            state = "unsupported";
            acknowledge(current, { ok: false, unsupported: true });
            return;
        }
        state = "restoring";
        const started = now();
        const attempt = (): void => {
            poll = null;
            if (load !== current) return;
            let ready = false;
            try { ready = native.ready() === true; } catch { /* not yet */ }
            if (ready) {
                apply(current, restore === true, restore === true && snapshot && typeof snapshot === "object" ? snapshot as HogwartsMpFieldGuideSnapshot : null);
                return;
            }
            if (now() - started < readyTimeoutMs) { poll = setTimer(attempt, pollMs); return; }
            state = "failed";
            acknowledge(current, { ok: false, reason: "the Field Guide did not become ready" });
            warn("Field Guide did not become ready; it is not restored or saved this time");
        };
        attempt();
    }

    function stop(): void {
        cancel();
        load = null;
        state = "waiting";
    }

    return { receive, changed, stop, state: (): FieldGuideClientState => state };
}

export = { createFieldGuideClient };

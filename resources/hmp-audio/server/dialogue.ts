import normalizeModule = require("../shared/normalize");
import type { HmpAudioDialogueApi, HmpAudioDialogueMode, HmpAudioDialoguePolicy, HmpAudioOwner } from "../types";
import type { NativeDialogue } from "./internal";

const { owner: normalizeOwner } = normalizeModule;

type Speaker = keyof HmpAudioDialoguePolicy;

const SPEAKERS: readonly Speaker[] = ["player", "players", "npcs", "characters", "world", "floo"];

interface Hold {
    owner: Required<HmpAudioOwner>;
    patch: Partial<HmpAudioDialoguePolicy>;
    sequence: number;
}

function normalizeDialogue(raw: unknown, label: string): Partial<HmpAudioDialoguePolicy> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${label} must be an object`);
    const patch: Partial<HmpAudioDialoguePolicy> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!SPEAKERS.includes(key as Speaker)) throw new TypeError(`${label} has unknown speaker '${key}'`);
        if (value === undefined) continue;
        if (value !== true && value !== false && value !== "nonverbal") throw new TypeError(`${label}.${key} must be true, false or "nonverbal"`);
        patch[key as Speaker] = value;
    }
    return patch;
}

// The policy is one setting on the world, so hmp-audio writes only the speakers its config or a hold names,
// and hands each back to what the host had once nothing here names it.
function createDialogueRegistry(native: NativeDialogue, baseline: Partial<HmpAudioDialoguePolicy>) {
    const supported = typeof native.setDialoguePolicy === "function";
    const holds = new Map<string, Hold>();
    const original = new Map<Speaker, HmpAudioDialogueMode>();
    let sequence = 0;

    function wanted(): Partial<HmpAudioDialoguePolicy> {
        const result = { ...baseline };
        for (const hold of [...holds.values()].sort((left, right) => left.sequence - right.sequence)) Object.assign(result, hold.patch);
        return result;
    }

    function apply(want: Partial<HmpAudioDialoguePolicy>): boolean {
        if (!supported) return false;
        const before = native.dialoguePolicy;
        const patch: Partial<HmpAudioDialoguePolicy> = {};
        for (const speaker of SPEAKERS) {
            const mode = want[speaker];
            if (mode !== undefined) {
                if (!original.has(speaker)) original.set(speaker, before?.[speaker] ?? true);
                patch[speaker] = mode;
            }
            else if (original.has(speaker)) {
                patch[speaker] = original.get(speaker);
                original.delete(speaker);
            }
        }
        return !Object.keys(patch).length || native.setDialoguePolicy!(patch);
    }

    function current(): HmpAudioDialoguePolicy | null {
        const policy = supported ? native.dialoguePolicy : undefined;
        return policy ? Object.fromEntries(SPEAKERS.map((speaker) => [speaker, policy[speaker]])) as unknown as HmpAudioDialoguePolicy : null;
    }

    function set(rawOwner: HmpAudioOwner, rawPatch: Partial<HmpAudioDialoguePolicy>): boolean {
        const owner = normalizeOwner(rawOwner);
        const patch = normalizeDialogue(rawPatch, "audio dialogue policy");
        if (!supported) return false;
        const previous = holds.get(owner.key);
        holds.set(owner.key, { owner: { resource: owner.resource, id: owner.id }, patch: { ...previous?.patch, ...patch }, sequence: ++sequence });
        return apply(wanted());
    }

    function release(rawOwner: HmpAudioOwner): boolean {
        const owner = normalizeOwner(rawOwner);
        if (!holds.delete(owner.key)) return false;
        apply(wanted());
        return true;
    }

    function cleanup(resource: string): number {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let released = 0;
        for (const [key, hold] of [...holds]) if (hold.owner.resource === normalized && holds.delete(key)) released++;
        if (released) apply(wanted());
        return released;
    }

    function stop(): void {
        holds.clear();
        apply({});
    }

    if (Object.keys(baseline).length) apply(wanted());
    const api: HmpAudioDialogueApi = Object.freeze({ current, set, release });
    return { api, cleanup, stop };
}

export = { createDialogueRegistry, normalizeDialogue };

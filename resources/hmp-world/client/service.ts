import type { HmpWorldClientPolicy, HmpWorldPopulationPolicy, HmpWorldPopulationType } from "../types";

interface NativeWorld {
    setBoundaryPolicy(remove: boolean): number;
    setAmbientPopulation(enabled: boolean): boolean;
    /** Absent on a host older than population density and exclusions. */
    setPopulationDensity?(density: number): number;
    setPopulationExclusions?(exclusions: { names?: string[]; types?: string[] }): unknown;
}

// Absent on a host older than per-resource jump and sprint holds.
interface NativePlayer {
    setJumpEnabled?(enabled: boolean): void;
    setSprintEnabled?(enabled: boolean): void;
}

interface ClientOptions {
    native: NativeWorld;
    player: NativePlayer;
    emitReady(): void;
    warn?(message: string): void;
}

function stringList(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}

function parsePopulation(raw: unknown): HmpWorldPopulationPolicy | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const exclusions = value.exclusions as Record<string, unknown> | null;
    if (typeof value.density !== "number" || !(value.density >= 0 && value.density <= 1) || !exclusions || typeof exclusions !== "object") return null;
    const names = stringList(exclusions.names);
    const types = stringList(exclusions.types);
    if (!names || !types) return null;
    return { density: value.density, exclusions: { names, types: types as HmpWorldPopulationType[] } };
}

function parsePolicy(raw: unknown): HmpWorldClientPolicy | null {
    let value: unknown = raw;
    if (typeof value === "string") {
        try { value = JSON.parse(value); }
        catch (_) { return null; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const policy = value as Record<string, unknown>;
    if (typeof policy.removeBoundaryVolumes !== "boolean" || typeof policy.ambientPopulation !== "boolean") return null;
    if (typeof policy.jump !== "boolean" || typeof policy.sprint !== "boolean") return null;
    const population = parsePopulation(policy.population);
    if (!population) return null;
    return {
        removeBoundaryVolumes: policy.removeBoundaryVolumes,
        ambientPopulation: policy.ambientPopulation,
        jump: policy.jump,
        sprint: policy.sprint,
        population,
    };
}

function clonePolicy(value: HmpWorldClientPolicy): HmpWorldClientPolicy {
    const { density, exclusions } = value.population;
    return { ...value, population: { density, exclusions: { names: [...exclusions.names], types: [...exclusions.types] } } };
}

function isGamePopulation(value: HmpWorldPopulationPolicy): boolean {
    return value.density === 1 && !value.exclusions.names.length && !value.exclusions.types.length;
}

function createWorldClient(options: ClientOptions) {
    const { native, player } = options;
    let state: "ready" | "stopped" = "ready";
    let currentPolicy: HmpWorldClientPolicy | null = null;
    let boundaryVolumesChanged = 0;
    let populationHeld = false;
    let warnedPopulation = false;

    // Density and exclusions are the client's, not a hold of hmp-world's, so they are written only to apply
    // a policy other than the game's or to hand one back: a resource that sets its own keeps it otherwise.
    function applyPopulation(next: HmpWorldPopulationPolicy): void {
        const configured = !isGamePopulation(next);
        if (!configured && !populationHeld) return;
        if (typeof native.setPopulationDensity !== "function" || typeof native.setPopulationExclusions !== "function") {
            if (!warnedPopulation) options.warn?.("policy.population needs a HogwartsMP host with World.setPopulationDensity; this host ignores it");
            warnedPopulation = true;
            return;
        }
        native.setPopulationDensity(next.density);
        native.setPopulationExclusions({ names: [...next.exclusions.names], types: [...next.exclusions.types] });
        populationHeld = configured;
    }

    function apply(raw: unknown): boolean {
        if (state === "stopped") return false;
        const next = parsePolicy(raw);
        if (!next) return false;
        boundaryVolumesChanged = native.setBoundaryPolicy(next.removeBoundaryVolumes);
        native.setAmbientPopulation(next.ambientPopulation);
        // Only hmp-world's own hold: another resource's stays, and the host drops ours when hmp-world stops.
        player.setJumpEnabled?.(next.jump);
        player.setSprintEnabled?.(next.sprint);
        applyPopulation(next.population);
        currentPolicy = next;
        return true;
    }

    function restore(): boolean {
        return currentPolicy ? apply(currentPolicy) : false;
    }

    function stop(): void {
        if (state === "stopped") return;
        if (populationHeld) applyPopulation({ density: 1, exclusions: { names: [], types: [] } });
        state = "stopped";
        currentPolicy = null;
    }

    const client = Object.freeze({
        apply,
        stop,
        policy: Object.freeze({ current: () => currentPolicy ? clonePolicy(currentPolicy) : null, restore }),
        status: () => ({ state, policy: currentPolicy ? clonePolicy(currentPolicy) : null, boundaryVolumesChanged }),
    });
    options.emitReady();
    return client;
}

export = { createWorldClient, parsePolicy };

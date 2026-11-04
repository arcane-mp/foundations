import type { HmpHouseId, HmpNativeHouse } from "../types";

const HOUSES = Object.freeze(["gryffindor", "hufflepuff", "ravenclaw", "slytherin"] as const);
const HOUSE_SET = new Set<string>(HOUSES);
const NATIVE: Record<HmpHouseId, Exclude<HmpNativeHouse, "Unaffiliated">> = Object.freeze({
    gryffindor: "Gryffindor",
    hufflepuff: "Hufflepuff",
    ravenclaw: "Ravenclaw",
    slytherin: "Slytherin",
});

function house(value: unknown): HmpHouseId {
    const normalized = String(value || "").trim().toLowerCase();
    if (!HOUSE_SET.has(normalized)) throw new TypeError(`house must be one of ${HOUSES.join(", ")}`);
    return normalized as HmpHouseId;
}

function nativeHouse(value: HmpHouseId): Exclude<HmpNativeHouse, "Unaffiliated">;
function nativeHouse(value: HmpHouseId | null): HmpNativeHouse;
function nativeHouse(value: HmpHouseId | null): HmpNativeHouse {
    return value ? NATIVE[value] : "Unaffiliated";
}

function clean(value: unknown, label: string, maximum: number): string {
    const result = String(value || "").trim();
    if (!result || result.length > maximum) throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
    return result;
}

function positiveId(value: unknown, label: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive integer`);
    return result;
}

function limit(value: unknown, fallback = 50): number {
    const result = Number(value);
    return Number.isSafeInteger(result) ? Math.max(1, Math.min(200, result)) : fallback;
}

function signedAmount(value: unknown): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result === 0) throw new TypeError("house point amount must be a non-zero safe integer");
    return result;
}

function metadata(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("house point metadata must be an object");
    const encoded = JSON.stringify(value);
    if (encoded.length > 16_384) throw new TypeError("house point metadata is too large");
    return JSON.parse(encoded) as Record<string, unknown>;
}

export = { HOUSES, house, nativeHouse, clean, positiveId, limit, signedAmount, metadata };

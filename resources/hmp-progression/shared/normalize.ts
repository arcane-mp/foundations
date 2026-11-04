function clean(value: unknown, label: string, maximum = 96): string {
    const result = String(value || "").trim();
    if (!result || result.length > maximum) throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
    return result;
}

function positiveId(value: unknown, label: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive safe integer`);
    return result;
}

function nonNegative(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new TypeError(`${label} must be a non-negative safe integer no greater than ${maximum}`);
    return result;
}

function signed(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result === 0 || Math.abs(result) > maximum) throw new TypeError(`${label} must be a non-zero safe integer between ${-maximum} and ${maximum}`);
    return result;
}

function limit(value: unknown, fallback = 50): number {
    const result = Number(value);
    return Number.isSafeInteger(result) && result > 0 ? Math.min(result, 200) : fallback;
}

function reference(value: unknown): string {
    const result = clean(value, "progression reference", 96);
    if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new TypeError("progression reference may contain only letters, numbers, dot, underscore, colon, and dash");
    return result;
}

function talentId(value: unknown): string {
    const result = clean(value, "talent id", 128);
    if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new TypeError("talent id contains unsupported characters");
    return result;
}

function flameId(value: unknown): string {
    const result = clean(typeof value === "string" ? value : "", "Floo flame id", 64);
    if (!/^[A-Za-z0-9_]+$/.test(result)) throw new TypeError("Floo flame id may contain only letters, numbers, and underscore");
    return result;
}

function metadata(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("metadata must be an object");
    const encoded = JSON.stringify(value);
    if (encoded.length > 16_384) throw new TypeError("metadata must serialize to at most 16384 characters");
    return JSON.parse(encoded) as Record<string, unknown>;
}

export = { clean, positiveId, nonNegative, signed, limit, reference, talentId, flameId, metadata };

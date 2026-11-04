/** The most UTF-8 bytes a Field Guide snapshot's JSON may hold; bigger ones are refused. */
const maximumSnapshotBytes = 512 * 1024;
const maximumEntries = 10_000;
const states = ["Unknown", "Known", "Obtained"] as const;

type Entry = Record<string, unknown>;

function utf8Length(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index++; }
        else bytes += 3;
    }
    return bytes;
}

function object(value: unknown, label: string): Entry {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    return value as Entry;
}
function text(value: unknown, label: string, maximum = 256): string {
    if (typeof value !== "string" || value.length > maximum) throw new TypeError(`${label} must be a string of at most ${maximum} characters`);
    return value;
}
function integer(value: unknown, label: string, minimum = Number.MIN_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer no less than ${minimum}`);
    return value;
}
function flag(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
    return value;
}
function list<T>(value: unknown, label: string, read: (entry: unknown, label: string) => T): T[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    if (value.length > maximumEntries) throw new TypeError(`${label} holds more than ${maximumEntries} entries`);
    return value.map((entry, index) => read(entry, `${label}[${index}]`));
}

/** Checks a client's snapshot shape and rebuilds it from the known fields only; throws a TypeError naming the bad field. */
function normalizeSnapshot(value: unknown): HogwartsMpFieldGuideSnapshot {
    const snapshot = object(value, "Field Guide snapshot");
    if (snapshot.version !== 1) throw new TypeError("Field Guide snapshot version must be 1");
    const pages = object(snapshot.pages, "pages");
    return {
        version: 1,
        collections: list(snapshot.collections, "collections", (raw, label) => {
            const entry = object(raw, label);
            const state = entry.state as HogwartsMpFieldGuideCollectionItem["state"];
            if (!states.includes(state)) throw new TypeError(`${label}.state must be Unknown, Known or Obtained`);
            if (typeof entry.updated !== "number" || !Number.isFinite(entry.updated)) throw new TypeError(`${label}.updated must be a number`);
            return {
                id: text(entry.id, `${label}.id`), category: text(entry.category, `${label}.category`),
                subcategory: text(entry.subcategory, `${label}.subcategory`), state, updated: entry.updated,
            };
        }),
        challenges: list(snapshot.challenges, "challenges", (raw, label) => {
            const entry = object(raw, label);
            return {
                id: text(entry.id, `${label}.id`), instances: integer(entry.instances, `${label}.instances`, 0),
                goal: integer(entry.goal, `${label}.goal`, 0), complete: flag(entry.complete, `${label}.complete`),
                counted: list(entry.counted, `${label}.counted`, (member, memberLabel) => text(member, memberLabel)),
                unclaimedRewards: integer(entry.unclaimedRewards, `${label}.unclaimedRewards`, 0),
            };
        }),
        locks: list(snapshot.locks, "locks", (raw, label) => {
            const entry = object(raw, label);
            return { id: text(entry.id, `${label}.id`), unlocked: flag(entry.unlocked, `${label}.unlocked`) };
        }),
        pages: {
            investigated: list(pages.investigated, "pages.investigated", (raw, label) => {
                const entry = object(raw, label);
                return { id: text(entry.id, `${label}.id`), count: integer(entry.count, `${label}.count`, 0) };
            }),
            beacons: list(pages.beacons, "pages.beacons", (raw, label) => {
                const entry = object(raw, label);
                return { id: text(entry.id, `${label}.id`), state: integer(entry.state, `${label}.state`) };
            }),
            keys: list(pages.keys, "pages.keys", (raw, label) => {
                const entry = object(raw, label);
                return { name: text(entry.name, `${label}.name`), value: text(entry.value, `${label}.value`, 4096) };
            }),
        },
    };
}

export = { maximumSnapshotBytes, utf8Length, normalizeSnapshot };

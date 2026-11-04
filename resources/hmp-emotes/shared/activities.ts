import type { HmpEmoteActivity, HmpEmoteActivityId } from "../types";

// The host's player activities and their variants. The server has no listActivities to read them from.
const ACTIVITIES: readonly HmpEmoteActivity[] = [
    { id: "kite", variants: ["gryffindor", "hufflepuff", "ravenclaw", "slytherin", "kelpie", "occamy", "phoenix", "swoopingevil"] },
    { id: "fireworks", variants: [] },
    { id: "raincloud", variants: ["rain", "snow"] },
    { id: "snitch", variants: [] },
    { id: "band", variants: [] },
    { id: "howler", variants: ["female", "male"] },
    { id: "livingbook", variants: ["fireflies", "snow", "leaves", "runes", "constellations", "ghost", "storm", "pranks", "dragons"] },
    { id: "cards", variants: [] },
];

const ACTIVITY_IDS = ACTIVITIES.map((entry) => entry.id);

function activityOf(value: unknown): HmpEmoteActivity | null {
    const id = String(value ?? "").trim().toLowerCase();
    return ACTIVITIES.find((entry) => entry.id === id) || null;
}

function activityIds(value: unknown): HmpEmoteActivityId[] {
    if (!Array.isArray(value)) throw new TypeError("hmp-emotes activities must be an array of activity ids");
    const ids: HmpEmoteActivityId[] = [];
    for (const entry of value) {
        const activity = activityOf(entry);
        if (!activity) throw new TypeError(`hmp-emotes activity '${String(entry)}' is not one of ${ACTIVITY_IDS.join(", ")}`);
        if (!ids.includes(activity.id)) ids.push(activity.id);
    }
    return ids;
}

export = { ACTIVITIES, ACTIVITY_IDS, activityOf, activityIds };

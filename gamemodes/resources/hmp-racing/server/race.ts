import type { HmpRacingCheckpoint, HmpRacingTrack, HmpRacingVector3 } from "../types";

export interface Racer {
    playerId: number;
    nickname: string;
    characterId: number | null;
    characterName: string | null;
}

export type RacerStatus = "racing" | "finished" | "disqualified" | "left";

export interface RacerState extends Racer {
    status: RacerStatus;
    /** Checkpoints passed since the start, across laps. */
    passed: number;
    lapsMs: number[];
    finishMs: number | null;
    /** Place among finishers, from 1. */
    place: number | null;
    reason: string;
    last: HmpRacingVector3 | null;
    lastAt: number;
    lapStartMs: number;
}

export type RaceEvent =
    | { type: "checkpoint"; playerId: number; lap: number; checkpoint: number }
    | { type: "lap"; playerId: number; lap: number; lapMs: number }
    | { type: "finish"; playerId: number; place: number; timeMs: number }
    | { type: "disqualified"; playerId: number; reason: string };

export interface RaceRules {
    /** Faster than this between two samples is a teleport, in cm a second; 0 never checks. */
    maxSpeedCmPerSecond: number;
}

function distanceSquared(a: HmpRacingVector3, b: HmpRacingVector3): number {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

/**
 * Whether the path from `from` to `to` came within the gate. A broom covers metres between two samples, so the
 * segment is tested, not only where the racer ended up.
 */
export function crossed(from: HmpRacingVector3 | null, to: HmpRacingVector3, gate: HmpRacingCheckpoint): boolean {
    const radiusSquared = gate.radius * gate.radius;
    if (distanceSquared(to, gate) <= radiusSquared) return true;
    if (!from) return false;
    const sx = to.x - from.x, sy = to.y - from.y, sz = to.z - from.z;
    const lengthSquared = sx * sx + sy * sy + sz * sz;
    if (lengthSquared === 0) return false;
    const t = Math.max(0, Math.min(1, ((gate.x - from.x) * sx + (gate.y - from.y) * sy + (gate.z - from.z) * sz) / lengthSquared));
    return distanceSquared({ x: from.x + sx * t, y: from.y + sy * t, z: from.z + sz * t }, gate) <= radiusSquared;
}

function finite(position: HmpRacingVector3 | null | undefined): position is HmpRacingVector3 {
    return !!position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

/** One race's progress, fed with each racer's position; it holds no timers and reads no clock of its own. */
export class Race {
    readonly track: HmpRacingTrack;
    readonly startedAt: number;
    private readonly rules: RaceRules;
    private readonly racers = new Map<number, RacerState>();
    private finishers = 0;

    constructor(track: HmpRacingTrack, racers: Racer[], startedAt: number, rules: RaceRules) {
        if (!track.checkpoints.length) throw new Error(`Track ${track.id} has no checkpoints`);
        this.track = track;
        this.startedAt = startedAt;
        this.rules = rules;
        for (const racer of racers) {
            this.racers.set(racer.playerId, {
                ...racer, status: "racing", passed: 0, lapsMs: [], finishMs: null, place: null, reason: "", last: null, lastAt: startedAt, lapStartMs: 0,
            });
        }
    }

    get totalCheckpoints(): number { return this.track.checkpoints.length * this.track.laps; }

    get(playerId: number): RacerState | null { return this.racers.get(playerId) || null; }

    list(): RacerState[] { return [...this.racers.values()]; }

    /** The gate a racer flies for next, or null once they are done. */
    nextGate(playerId: number): { index: number; gate: HmpRacingCheckpoint } | null {
        const racer = this.racers.get(playerId);
        if (!racer || racer.status !== "racing") return null;
        const index = racer.passed % this.track.checkpoints.length;
        return { index, gate: this.track.checkpoints[index] };
    }

    /** The racer's lap (from 1) and checkpoints passed in it. */
    lapOf(playerId: number): { lap: number; checkpoint: number } {
        const racer = this.racers.get(playerId);
        const count = this.track.checkpoints.length;
        if (!racer) return { lap: 1, checkpoint: 0 };
        if (racer.status === "finished") return { lap: this.track.laps, checkpoint: count };
        return { lap: Math.min(this.track.laps, Math.floor(racer.passed / count) + 1), checkpoint: racer.passed % count };
    }

    /** Takes a racer's position at `at`; returns what it made happen, in order. */
    update(playerId: number, position: HmpRacingVector3 | null | undefined, at: number): RaceEvent[] {
        const racer = this.racers.get(playerId);
        if (!racer || racer.status !== "racing" || !finite(position)) return [];
        const events: RaceEvent[] = [];
        const from = racer.last;
        const seconds = (at - racer.lastAt) / 1000;
        if (from && this.rules.maxSpeedCmPerSecond > 0 && seconds > 0
            && Math.sqrt(distanceSquared(from, position)) / seconds > this.rules.maxSpeedCmPerSecond) {
            return this.disqualify(playerId, "teleport");
        }
        racer.last = { x: position.x, y: position.y, z: position.z };
        racer.lastAt = at;
        const count = this.track.checkpoints.length;
        // One sample may cross two close gates; each must still be passed in order.
        let segmentStart = from;
        while (racer.status === "racing") {
            const gate = this.track.checkpoints[racer.passed % count];
            if (!crossed(segmentStart, position, gate)) break;
            segmentStart = null;
            racer.passed += 1;
            const elapsed = Math.max(0, at - this.startedAt);
            const lapDone = racer.passed % count === 0;
            if (!lapDone) {
                events.push({ type: "checkpoint", playerId, lap: Math.floor(racer.passed / count) + 1, checkpoint: racer.passed % count });
                continue;
            }
            const lapMs = elapsed - racer.lapStartMs;
            racer.lapsMs.push(lapMs);
            racer.lapStartMs = elapsed;
            const lap = racer.passed / count;
            events.push({ type: "lap", playerId, lap, lapMs });
            if (racer.passed >= this.totalCheckpoints) {
                this.finishers += 1;
                racer.status = "finished";
                racer.finishMs = elapsed;
                racer.place = this.finishers;
                events.push({ type: "finish", playerId, place: racer.place, timeMs: elapsed });
            }
        }
        return events;
    }

    disqualify(playerId: number, reason: string): RaceEvent[] {
        const racer = this.racers.get(playerId);
        if (!racer || racer.status !== "racing") return [];
        racer.status = "disqualified";
        racer.reason = reason;
        return [{ type: "disqualified", playerId, reason }];
    }

    leave(playerId: number): boolean {
        const racer = this.racers.get(playerId);
        if (!racer || racer.status !== "racing") return false;
        racer.status = "left";
        return true;
    }

    /** Whether anyone is still racing. */
    get running(): boolean { return this.list().some((racer) => racer.status === "racing"); }

    get firstFinishMs(): number | null {
        const times = this.list().map((racer) => racer.finishMs).filter((value): value is number => value !== null);
        return times.length ? Math.min(...times) : null;
    }

    /**
     * Everyone in race order: finishers by place, then racers still flying by progress and how near their next gate
     * is, then the disqualified and those who left.
     */
    standings(): RacerState[] {
        const rank = (racer: RacerState) => racer.status === "finished" ? 0 : racer.status === "racing" ? 1 : racer.status === "disqualified" ? 2 : 3;
        const toNext = (racer: RacerState) => {
            const next = this.nextGate(racer.playerId);
            return next && racer.last ? distanceSquared(racer.last, next.gate) : Number.POSITIVE_INFINITY;
        };
        return this.list().sort((a, b) => rank(a) - rank(b)
            || (a.place ?? 0) - (b.place ?? 0)
            || b.passed - a.passed
            || toNext(a) - toNext(b)
            || a.playerId - b.playerId);
    }

    /** A racer's place among everyone not out of the race, from 1. */
    placeOf(playerId: number): number {
        const order = this.standings().filter((racer) => racer.status === "finished" || racer.status === "racing");
        const index = order.findIndex((racer) => racer.playerId === playerId);
        return index < 0 ? order.length : index + 1;
    }
}

/** Grid slots behind the start, two abreast, `spacing` cm apart, facing `yaw`. */
export function gridSlot(start: HmpRacingVector3 & { yaw: number }, index: number, spacing: number): HmpRacingVector3 {
    const radians = (start.yaw * Math.PI) / 180;
    const forward = { x: Math.cos(radians), y: Math.sin(radians) };
    const right = { x: -forward.y, y: forward.x };
    const row = Math.floor(index / 2);
    const side = index % 2 === 0 ? -0.5 : 0.5;
    return {
        x: start.x - forward.x * row * spacing + right.x * side * spacing,
        y: start.y - forward.y * row * spacing + right.y * side * spacing,
        z: start.z,
    };
}

import type { HmpHouseWarsFighter, HmpHouseWarsHouse, HmpHouseWarsRoundResult } from "../types";

export const HOUSES: readonly HmpHouseWarsHouse[] = Object.freeze(["gryffindor", "hufflepuff", "ravenclaw", "slytherin"]);

export interface FighterInput {
    playerId: number;
    nickname: string;
    characterId: number | null;
    characterName: string | null;
    house: HmpHouseWarsHouse;
}

/**
 * One house battle's score: fighters by house, who still stands this round, round wins. It holds no timers
 * and talks to no host; the service drives it.
 */
export class Match {
    readonly fighters = new Map<number, HmpHouseWarsFighter>();
    readonly rounds: HmpHouseWarsRoundResult[] = [];
    readonly score = new Map<HmpHouseWarsHouse, number>();
    /** Round wins a house needs to take the match. */
    readonly winsNeeded: number;
    private readonly maxRounds: number;
    private standing = new Set<number>();
    private gone = new Set<number>();
    private roundStartedAt = 0;
    round = 0;
    live = false;

    constructor(fighters: FighterInput[], maxRounds: number) {
        if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds % 2 === 0) throw new RangeError("A match is an odd number of rounds");
        for (const fighter of fighters) this.fighters.set(fighter.playerId, { ...fighter, knockouts: 0, survived: 0 });
        if (this.houses().length < 2) throw new Error("A house battle needs fighters from at least two houses");
        this.maxRounds = maxRounds;
        this.winsNeeded = Math.ceil(maxRounds / 2);
        for (const house of this.houses()) this.score.set(house, 0);
    }

    /** Houses that brought fighters, in the game's order. */
    houses(): HmpHouseWarsHouse[] {
        const present = new Set([...this.fighters.values()].map((fighter) => fighter.house));
        return HOUSES.filter((house) => present.has(house));
    }

    houseOf(playerId: number): HmpHouseWarsHouse | null {
        return this.fighters.get(playerId)?.house ?? null;
    }

    /** Fighters still in the match, not gone for good. */
    active(): HmpHouseWarsFighter[] {
        return [...this.fighters.values()].filter((fighter) => !this.gone.has(fighter.playerId));
    }

    isStanding(playerId: number): boolean {
        return this.live && this.standing.has(playerId);
    }

    standingBy(house: HmpHouseWarsHouse): number {
        return [...this.standing].filter((id) => this.fighters.get(id)?.house === house).length;
    }

    /** Whether two fighters are on opposite sides of a live round, so one may hurt the other. */
    hostile(a: number, b: number): boolean {
        const left = this.fighters.get(a), right = this.fighters.get(b);
        return !!left && !!right && left.house !== right.house && this.isStanding(a) && this.isStanding(b);
    }

    startRound(at: number): number {
        if (this.over) throw new Error("The match is over");
        this.round += 1;
        this.live = true;
        this.roundStartedAt = at;
        this.standing = new Set(this.active().map((fighter) => fighter.playerId));
        return this.round;
    }

    /** Houses with fighters standing. */
    private standingHouses(): HmpHouseWarsHouse[] {
        return this.houses().filter((house) => this.standingBy(house) > 0);
    }

    /** A knock-out: the victim is down for the round. Returns the round's result once one house is left. */
    knockout(victimId: number, byId: number | null, at: number): HmpHouseWarsRoundResult | null {
        if (!this.live || !this.standing.has(victimId)) return null;
        if (byId !== null && !this.hostile(byId, victimId)) return null;
        this.standing.delete(victimId);
        const by = byId === null ? null : this.fighters.get(byId);
        if (by) by.knockouts += 1;
        return this.settle(at, "elimination");
    }

    /** A fighter left the match for good (disconnect or retirement). */
    leave(playerId: number, at: number): HmpHouseWarsRoundResult | null {
        if (!this.fighters.has(playerId) || this.gone.has(playerId)) return null;
        this.gone.add(playerId);
        if (!this.live) return null;
        this.standing.delete(playerId);
        return this.settle(at, "forfeit");
    }

    /** The round's time ran out: the house with the most fighters standing takes it; level is a draw. */
    timeUp(at: number): HmpHouseWarsRoundResult | null {
        if (!this.live) return null;
        const counts = this.standingHouses().map((house) => [house, this.standingBy(house)] as const).sort((a, b) => b[1] - a[1]);
        const winner = counts.length && (counts.length === 1 || counts[0][1] > counts[1][1]) ? counts[0][0] : null;
        return this.close(winner, "time", at);
    }

    private settle(at: number, reason: "elimination" | "forfeit"): HmpHouseWarsRoundResult | null {
        const houses = this.standingHouses();
        if (houses.length > 1) return null;
        return this.close(houses[0] ?? null, reason, at);
    }

    private close(winner: HmpHouseWarsHouse | null, reason: HmpHouseWarsRoundResult["reason"], at: number): HmpHouseWarsRoundResult {
        this.live = false;
        for (const id of this.standing) { const fighter = this.fighters.get(id); if (fighter) fighter.survived += 1; }
        if (winner) this.score.set(winner, (this.score.get(winner) || 0) + 1);
        const result: HmpHouseWarsRoundResult = { round: this.round, winner, reason, durationMs: Math.max(0, at - this.roundStartedAt) };
        this.rounds.push(result);
        return result;
    }

    /** Houses that still have fighters to send into a round. */
    contenders(): HmpHouseWarsHouse[] {
        const present = new Set(this.active().map((fighter) => fighter.house));
        return this.houses().filter((house) => present.has(house));
    }

    /** The match winner: the first to the wins needed, the last house with fighters, or the leader after the last round. */
    get winner(): HmpHouseWarsHouse | null {
        for (const [house, wins] of this.score) if (wins >= this.winsNeeded) return house;
        const contenders = this.contenders();
        if (contenders.length === 1 && this.rounds.length) return contenders[0];
        if (this.rounds.length >= this.maxRounds) {
            const ordered = [...this.score.entries()].sort((a, b) => b[1] - a[1]);
            return ordered.length && (ordered.length === 1 || ordered[0][1] > ordered[1][1]) ? ordered[0][0] : null;
        }
        return null;
    }

    get over(): boolean {
        if (this.live) return false;
        return this.winner !== null || this.rounds.length >= this.maxRounds || this.contenders().length < 2;
    }

    scoreRecord(): Partial<Record<HmpHouseWarsHouse, number>> {
        return Object.fromEntries(this.score) as Partial<Record<HmpHouseWarsHouse, number>>;
    }
}

/** Each house's corner of the arena: evenly round the centre at `spread` of the radius, each fighter beside the last. */
export function spawnPoint(center: { x: number; y: number; z: number }, radius: number, houseIndex: number, houseCount: number, slot: number): { x: number; y: number; z: number; yaw: number } {
    const angle = (houseIndex / Math.max(2, houseCount)) * Math.PI * 2;
    const distance = radius * 0.7;
    const base = { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance };
    // Side by side across the line to the centre, 250 cm apart, alternating sides.
    const across = { x: -Math.sin(angle), y: Math.cos(angle) };
    const offset = (slot % 2 === 0 ? 1 : -1) * Math.ceil(slot / 2) * 250;
    const yaw = ((Math.atan2(center.y - base.y, center.x - base.x) * 180) / Math.PI + 360) % 360;
    return { x: base.x + across.x * offset, y: base.y + across.y * offset, z: center.z, yaw };
}

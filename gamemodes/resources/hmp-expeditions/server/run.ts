import type { HmpExpedition, HmpExpeditionStage } from "../types";

export interface Scaling {
    /** Each fighter past the first adds this share of a stage's enemies (rounded). */
    enemiesPerExtraFighter: number;
    /** Each fighter past the first adds this share of a boss's health. */
    bossHealthPerExtraFighter: number;
}

export interface SpawnOrder {
    enemyId: string;
    boss: boolean;
    /** Only a boss names its health; everything else keeps the game's own. */
    maxHealth?: number;
}

/**
 * One expedition run's progress: the stage, the enemies it is waiting on, who is down. It holds no timers and
 * spawns nothing itself; the service turns its orders into NPCs and feeds their deaths back.
 */
export class Run {
    readonly expedition: HmpExpedition;
    readonly startedAt: number;
    readonly party = new Set<number>();
    private readonly scaling: Scaling;
    private readonly down = new Set<number>();
    private readonly alive = new Set<number>();
    stage = -1;
    defeated = 0;
    result: "cleared" | "wiped" | "timeout" | "abandoned" | "stopped" | null = null;

    constructor(expedition: HmpExpedition, party: number[], startedAt: number, scaling: Scaling) {
        if (!expedition.stages.length) throw new Error(`Expedition ${expedition.id} has no stages`);
        if (!party.length) throw new Error("An expedition needs a party");
        this.expedition = expedition;
        this.startedAt = startedAt;
        this.scaling = scaling;
        for (const id of party) this.party.add(id);
    }

    get current(): HmpExpeditionStage | null {
        return this.stage >= 0 && this.stage < this.expedition.stages.length ? this.expedition.stages[this.stage] : null;
    }

    get remaining(): number { return this.alive.size; }

    get cleared(): number { return this.result === "cleared" ? this.expedition.stages.length : Math.max(0, this.stage); }

    /** Moves on to the next stage and says what to spawn there, scaled to the party still in. */
    advance(): SpawnOrder[] {
        if (this.result) throw new Error("The run is over");
        if (this.alive.size) throw new Error("The stage still has enemies standing");
        this.stage += 1;
        const stage = this.current;
        if (!stage) throw new Error("No stage left");
        const extra = Math.max(0, this.party.size - 1);
        const orders: SpawnOrder[] = [];
        for (const enemy of stage.enemies) {
            const count = enemy.count + Math.round(enemy.count * this.scaling.enemiesPerExtraFighter * extra);
            for (let index = 0; index < count; index++) orders.push({ enemyId: enemy.id, boss: false });
        }
        if (stage.boss) {
            orders.push({ enemyId: stage.boss.id, boss: true, maxHealth: Math.round(stage.boss.health * (1 + this.scaling.bossHealthPerExtraFighter * extra)) });
        }
        return orders;
    }

    /** An NPC the service spawned for the current stage. */
    spawned(npcId: number): void {
        this.alive.add(npcId);
    }

    /** An NPC died; true when it was the stage's last. */
    killed(npcId: number): boolean {
        if (!this.alive.delete(npcId)) return false;
        this.defeated += 1;
        return this.alive.size === 0;
    }

    /** The NPC ids still standing, for cleanup. */
    standing(): number[] { return [...this.alive]; }

    /** Hands over the NPCs still standing and forgets them, so each is cleaned up once. */
    takeStanding(): number[] {
        const ids = [...this.alive];
        this.alive.clear();
        return ids;
    }

    get onLastStage(): boolean { return this.stage === this.expedition.stages.length - 1; }

    /** A fighter went down; true when it was the last of the party still up. */
    downed(playerId: number): boolean {
        if (!this.party.has(playerId)) return false;
        this.down.add(playerId);
        return [...this.party].every((id) => this.down.has(id));
    }

    revived(playerId: number): void { this.down.delete(playerId); }

    /** A fighter left for good; true when nobody is left. */
    leave(playerId: number): boolean {
        this.party.delete(playerId);
        this.down.delete(playerId);
        return this.party.size === 0;
    }

    /** Whether every fighter left is down. */
    get wiped(): boolean { return this.party.size > 0 && [...this.party].every((id) => this.down.has(id)); }

    finish(result: NonNullable<Run["result"]>): void {
        if (!this.result) this.result = result;
    }
}

/** Spreads a stage's spawns on a ring round its point, so a pack does not stack in one spot. */
export function spawnRing(center: { x: number; y: number; z: number }, index: number, count: number, radius = 600): { x: number; y: number; z: number; yaw: number } {
    if (count <= 1) return { ...center, yaw: 0 };
    const angle = (index / count) * Math.PI * 2;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    // Each faces outward, towards a party arriving from any side.
    return { x, y, z: center.z, yaw: ((angle * 180) / Math.PI) % 360 };
}

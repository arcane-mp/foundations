import normalizeModule = require("../shared/normalize");
import type {
    HmpBlipAudience,
    HmpBlipMarkerDefinition,
    HmpBlipMarkerInfo,
    HmpBlipOwner,
    HmpBlipPlayer,
    HmpBlipPlayerGroupDefinition,
    HmpBlipPlayerGroupInfo,
    HmpBlipPlayerReference,
    HmpBlipSelector,
    HmpBlipsServer,
    HmpBlipWaypoint,
    HmpBlipWaypointShareDefinition,
    HmpBlipWaypointShareInfo,
} from "../types";
import type { BlipCore, BlipEvents, BlipLogger, BlipsConfig } from "./internal";

const { marker: normalizeMarker, owner: normalizeOwner, playerGroup: normalizePlayerGroup } = normalizeModule;

interface ServiceDependencies<P extends HmpBlipPlayer> {
    core: BlipCore<P>;
    config: BlipsConfig;
    players(): P[];
    events: BlipEvents;
    logger: BlipLogger;
    now?: () => number;
    setTimer?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type NormalizedMarker<P extends HmpBlipPlayer> = HmpBlipMarkerDefinition<P> & { key: string; ttl: number; icon: string; label: string; showOnHud: boolean; showDistance: boolean };
type NormalizedPlayerGroup<P extends HmpBlipPlayer> = HmpBlipPlayerGroupDefinition<P> & { key: string; color: [number, number, number, number] | null; priority: number; sameArea: boolean; sameRegion: boolean; sameVirtualWorld: boolean };

interface MarkerRecord<P extends HmpBlipPlayer> {
    definition: NormalizedMarker<P>;
    viewers: Set<number>;
    expiresAt: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    publishToken: number;
    /** A player the audience never includes: a waypoint share's own sharer. */
    exclude?: number;
}

interface PlayerGroupRecord<P extends HmpBlipPlayer> {
    definition: NormalizedPlayerGroup<P>;
}

interface WaypointShareRecord<P extends HmpBlipPlayer> extends HmpBlipOwner {
    key: string;
    /** The marker it shows, at the sharer's waypoint. */
    marker: HmpBlipMarkerDefinition<P>;
    playerId: number;
}

/**
 * One resolution of who is connected, where they are and who each audience holds, shared by everything a refresh
 * works out. Each viewer used to resolve every selector again, which cost a refresh O(N²) player lookups and group
 * queries at N players.
 */
interface Pass<P extends HmpBlipPlayer> {
    players: P[];
    byId: Map<number, P>;
    locations: Map<number, HogwartsMpPlayerLocation | null>;
    sources: Map<unknown, Promise<P[]>>;
    selectors: Map<unknown, Promise<P[]>>;
}

interface ResolvedPlayerGroup<P extends HmpBlipPlayer> {
    definition: NormalizedPlayerGroup<P>;
    audience: Set<number>;
    subjects: P[];
}

/** Event-driven work: the views of everyone, the markers of everyone or of some players, and full syncs. */
interface BlipWork {
    views?: boolean;
    markers?: boolean | number;
    sync?: number;
}

const WAYPOINT_ICON = "UI_T_MiniMap_Waypoint";
/** How long a burst of events is gathered into one pass. */
const REFRESH_DELAY_MS = 200;
/** How long an hmp-core group answer is kept when no group, duty or character change says otherwise. */
const MEMBERSHIP_TTL_MS = 30_000;
/** How long passes wait on the same group lookup before asking hmp-core again. */
const PENDING_LOOKUP_MS = 5_000;

function createBlipsService<P extends HmpBlipPlayer>(dependencies: ServiceDependencies<P>): HmpBlipsServer<P> & {
    cleanup(resource: string): Promise<number>;
    syncPlayer(player: P): Promise<number>;
    /** A client's `hmp-blips:waypoint` report of its player's own map waypoint. */
    reportWaypoint(player: P, payload: unknown): Promise<boolean>;
    /** The player left: their waypoint and its shares go. */
    disconnect(player: P): void;
    /** Run this work in one pass a moment from now, with whatever else is asked for before then. */
    schedule(work: BlipWork): void;
    /** Drop the kept hmp-core group answers, of one player or of everyone. */
    forgetGroups(playerId?: number): void;
    stop(): void;
} {
    const { core, config, events, logger } = dependencies;
    const now = dependencies.now || Date.now;
    const setTimer = dependencies.setTimer || setTimeout;
    const clearTimer = dependencies.clearTimer || clearTimeout;
    const startedAt = now();
    const markers = new Map<string, MarkerRecord<P>>();
    const playerGroups = new Map<string, PlayerGroupRecord<P>>();
    // Tokens come from one counter, so a token never repeats for a reused player id.
    let tokenCounter = 0;
    const playerViewTokens = new Map<number, number>();
    const playerReplayTokens = new Map<number, number>();
    // The view each client was last sent, as sent: a view that has not changed is not sent again.
    const sentViews = new Map<number, string>();
    const memberships = new Map<string, { at: number; value: Promise<boolean>; settled: boolean }>();
    const waypoints = new Map<number, HmpBlipWaypoint>();
    const waypointShares = new Map<string, WaypointShareRecord<P>>();
    let pending: { views: boolean; markers: boolean; markerPlayers: Set<number>; syncs: Set<number> } | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let flushing: Promise<void> = Promise.resolve();
    let stopped = false;

    function connectedPlayers(): P[] {
        return dependencies.players().filter((player) => player?.connected !== false && Number.isSafeInteger(Number(player?.id)));
    }

    function connectedById(): Map<number, P> {
        return new Map(connectedPlayers().map((player) => [Number(player.id), player]));
    }

    function playerById(id: unknown): P | null {
        const value = Number(id);
        if (!Number.isSafeInteger(value)) return null;
        return connectedPlayers().find((player) => Number(player.id) === value) || null;
    }

    function beginPass(): Pass<P> {
        const players = connectedPlayers();
        return { players, byId: new Map(players.map((player) => [Number(player.id), player])), locations: new Map(), sources: new Map(), selectors: new Map() };
    }

    function emit(player: P, name: string, payload: unknown): boolean {
        return send(player, name, JSON.stringify(payload));
    }

    function send(player: P, name: string, json: string): boolean {
        try { player.emit(name, json); return true; }
        catch (_) { return false; }
    }

    function location(player: P): HogwartsMpPlayerLocation | null {
        if (typeof player.location !== "function") return null;
        try { return player.location(); }
        catch (_) { return null; }
    }

    function locate(player: P, pass: Pass<P>): HogwartsMpPlayerLocation | null {
        const id = Number(player.id);
        if (!pass.locations.has(id)) pass.locations.set(id, location(player));
        return pass.locations.get(id) ?? null;
    }

    function sameText(left: string | undefined, right: string | undefined): boolean {
        return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
    }

    function iterable(value: unknown): value is Iterable<unknown> {
        return Boolean(value && typeof value !== "string" && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function");
    }

    function hasGroup(player: P, key: string, minimumGrade: number): Promise<boolean> {
        const cacheKey = `${Number(player.id)}\u0000${key}\u0000${minimumGrade}`;
        const cached = memberships.get(cacheKey);
        // A lookup still on its way is shared only briefly, so one that never answers holds up few passes.
        if (cached && now() - cached.at < (cached.settled ? MEMBERSHIP_TTL_MS : PENDING_LOOKUP_MS)) return cached.value;
        let value: Promise<boolean>;
        try { value = Promise.resolve(core.groups.has(player, key, minimumGrade)); }
        catch (error) { value = Promise.reject(error); }
        const entry = { at: now(), value, settled: false };
        memberships.set(cacheKey, entry);
        // A failed lookup is not kept: the next pass asks again.
        value.then(() => { entry.settled = true; }, () => { if (memberships.get(cacheKey) === entry) memberships.delete(cacheKey); });
        return value;
    }

    function forgetGroups(playerId?: number): void {
        if (playerId === undefined) { memberships.clear(); return; }
        const prefix = `${Number(playerId)}\u0000`;
        for (const key of [...memberships.keys()]) if (key.startsWith(prefix)) memberships.delete(key);
    }

    async function resolveSource(source: unknown, label: string, pass: Pass<P>): Promise<P[]> {
        if (source === undefined || source === null || source === "all") return pass.players;
        let value = source;
        if (typeof source === "function") {
            try { value = await source(); }
            catch (error) { logger.warn(`[hmp-blips] ${label} resolver failed closed`, error); return []; }
        }
        if (!iterable(value)) return [];
        const result = new Map<number, P>();
        for (const entry of value) {
            const player = pass.byId.get(Number(typeof entry === "object" && entry ? (entry as { id?: unknown }).id : entry));
            if (player) result.set(Number(player.id), player);
        }
        return [...result.values()];
    }

    function sourcePlayers(source: unknown, label: string, pass: Pass<P>): Promise<P[]> {
        let resolved = pass.sources.get(source);
        if (!resolved) {
            resolved = resolveSource(source, label, pass);
            pass.sources.set(source, resolved);
        }
        return resolved;
    }

    function selectorObject(value: unknown): value is HmpBlipSelector<P> {
        return Boolean(value && typeof value === "object" && !Array.isArray(value) && !iterable(value));
    }

    // `only` narrows the candidates to one player before any group or predicate is asked about the others.
    async function resolveSelector(selector: HmpBlipAudience<P> | undefined, label: string, pass: Pass<P>, only?: number): Promise<P[]> {
        const restrict = (players: P[]) => only === undefined ? players : players.filter((player) => Number(player.id) === only);
        if (!selectorObject(selector)) return restrict(await sourcePlayers(selector, label, pass));
        if (!["players", "groups", "groupMode", "areaId", "regionId", "virtualWorld", "where"].some((key) => key in selector)) return [];
        let candidates = restrict(await sourcePlayers(selector.players, label, pass));
        const groups = Array.isArray(selector.groups) ? selector.groups : [];
        if (groups.length) {
            const checked = await Promise.all(candidates.map(async (player) => {
                try {
                    const matches = await Promise.all(groups.map((group) => hasGroup(player, String(group.key || "").toLowerCase(), Number(group.minimumGrade || 0))));
                    return selector.groupMode === "all" ? matches.every(Boolean) : matches.some(Boolean);
                } catch (error) {
                    logger.warn(`[hmp-blips] ${label} group resolution failed closed for #${player.id}`, error);
                    return false;
                }
            }));
            candidates = candidates.filter((_, index) => checked[index]);
        }
        if (selector.areaId || selector.regionId) candidates = candidates.filter((player) => {
            const current = locate(player, pass);
            if (!current) return false;
            if (selector.areaId && !sameText(selector.areaId, current.areaId)) return false;
            return !selector.regionId || sameText(selector.regionId, current.regionId);
        });
        if (selector.virtualWorld !== undefined) candidates = candidates.filter((player) => Number(player.virtualWorld || 0) === Number(selector.virtualWorld));
        if (selector.where) {
            const filtered: P[] = [];
            for (const player of candidates) {
                try { if (await selector.where(player)) filtered.push(player); }
                catch (error) { logger.warn(`[hmp-blips] ${label} predicate failed closed for #${player.id}`, error); }
            }
            candidates = filtered;
        }
        return candidates;
    }

    function selectorPlayers(selector: HmpBlipAudience<P> | undefined, label: string, pass: Pass<P>, only?: number): Promise<P[]> {
        if (only !== undefined) return resolveSelector(selector, label, pass, only);
        let resolved = pass.selectors.get(selector);
        if (!resolved) {
            resolved = resolveSelector(selector, label, pass);
            pass.selectors.set(selector, resolved);
        }
        return resolved;
    }

    function resolveTtl(value: unknown): number {
        const raw = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : config.defaultTtl;
        const requested = raw === 0 ? 0 : Math.min(raw, 2_000_000);
        if (config.maxTtl > 0) return requested === 0 ? config.maxTtl : Math.min(requested, config.maxTtl);
        return requested;
    }

    function markerInfo(record: MarkerRecord<P>): HmpBlipMarkerInfo {
        const value = record.definition;
        return {
            resource: value.resource,
            id: value.id,
            key: value.key,
            kind: value.kind,
            position: { ...value.position },
            radius: value.radius,
            icon: value.icon,
            label: value.label,
            showOnHud: value.showOnHud,
            showDistance: value.showDistance,
            ttl: value.ttl,
            expiresAt: record.expiresAt,
            scoped: value.audience !== undefined || value.areaId !== undefined || value.regionId !== undefined || value.virtualWorld !== undefined,
            areaId: value.areaId,
            regionId: value.regionId,
            virtualWorld: value.virtualWorld,
        };
    }

    function wireMarker(record: MarkerRecord<P>) {
        const value = record.definition;
        return {
            key: value.key,
            kind: value.kind,
            x: value.position.x,
            y: value.position.y,
            z: value.position.z,
            radius: value.radius,
            icon: value.icon,
            label: value.label,
            showOnHud: value.showOnHud,
            showDistance: value.showDistance,
        };
    }

    async function markerViewers(record: MarkerRecord<P>, pass: Pass<P>, only?: number): Promise<P[]> {
        let viewers = await selectorPlayers(record.definition.audience, `marker '${record.definition.key}' audience`, pass, only);
        const value = record.definition;
        if (value.areaId || value.regionId) viewers = viewers.filter((player) => {
            const current = locate(player, pass);
            if (!current) return false;
            if (value.areaId && !sameText(value.areaId, current.areaId)) return false;
            return !value.regionId || sameText(value.regionId, current.regionId);
        });
        if (value.virtualWorld !== undefined) viewers = viewers.filter((player) => Number(player.virtualWorld || 0) === value.virtualWorld);
        if (record.exclude !== undefined) viewers = viewers.filter((player) => Number(player.id) !== record.exclude);
        return viewers;
    }

    async function publishMarker(record: MarkerRecord<P>): Promise<boolean> {
        const token = ++record.publishToken;
        const viewers = await markerViewers(record, beginPass());
        if (stopped || markers.get(record.definition.key) !== record || record.publishToken !== token) return false;
        const next = new Set(viewers.map((player) => Number(player.id)));
        const live = connectedById();
        for (const oldId of record.viewers) if (!next.has(oldId)) {
            const player = live.get(oldId);
            if (player) emit(player, "hmp-blips:remove", { key: record.definition.key });
        }
        const payload = JSON.stringify(wireMarker(record));
        for (const player of viewers) send(player, "hmp-blips:set", payload);
        record.viewers = next;
        return true;
    }

    function disarm(record: MarkerRecord<P>): void {
        if (record.timer) clearTimer(record.timer);
        record.timer = null;
    }

    function removeMarker(rawId: string, rawResource: string): boolean {
        const identity = normalizeOwner({ id: rawId, resource: rawResource });
        const record = markers.get(identity.key);
        if (!record) return false;
        markers.delete(identity.key);
        disarm(record);
        events.emitAllClients("hmp-blips:remove", JSON.stringify({ key: identity.key }));
        return true;
    }

    async function putMarker(raw: HmpBlipMarkerDefinition<P>, exclude?: number): Promise<HmpBlipMarkerInfo> {
        if (stopped) throw new Error("hmp-blips is stopped");
        const definition = normalizeMarker(raw, resolveTtl) as NormalizedMarker<P>;
        const existing = markers.get(definition.key);
        if (!existing) {
            const owned = [...markers.values()].filter((record) => record.definition.resource === definition.resource).length;
            if (owned >= config.maxMarkersPerResource) throw new Error(`blip resource '${definition.resource}' reached its ${config.maxMarkersPerResource} marker limit`);
        } else disarm(existing);
        const record: MarkerRecord<P> = {
            definition,
            viewers: existing?.viewers || new Set<number>(),
            expiresAt: definition.ttl > 0 ? now() + definition.ttl * 1000 : null,
            timer: null,
            publishToken: existing?.publishToken || 0,
            exclude,
        };
        markers.set(definition.key, record);
        if (definition.ttl > 0) record.timer = setTimer(() => removeMarker(definition.id, definition.resource), Math.ceil(definition.ttl * 1000));
        await publishMarker(record);
        return markerInfo(record);
    }

    function upsertMarker(raw: HmpBlipMarkerDefinition<P>): Promise<HmpBlipMarkerInfo> {
        return putMarker(raw);
    }

    function clearMarkers(resource: string): number {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let removed = 0;
        for (const record of [...markers.values()]) if (record.definition.resource === normalized && removeMarker(record.definition.id, normalized)) removed++;
        return removed;
    }

    function getMarker(id: string, resource: string): HmpBlipMarkerInfo | null {
        const record = markers.get(normalizeOwner({ id, resource }).key);
        return record ? markerInfo(record) : null;
    }

    function listMarkers(resource?: string): HmpBlipMarkerInfo[] {
        const normalized = resource ? normalizeOwner({ resource, id: "list" }).resource : "";
        return [...markers.values()]
            .filter((record) => !normalized || record.definition.resource === normalized)
            .map(markerInfo)
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    function pulseMarker(id: string, resource: string, pulse = true): boolean {
        const record = markers.get(normalizeOwner({ id, resource }).key);
        if (!record || record.definition.kind !== "circle") return false;
        const live = connectedById();
        for (const viewerId of record.viewers) {
            const player = live.get(viewerId);
            if (player) emit(player, "hmp-blips:pulse", { key: record.definition.key, pulse: pulse !== false });
        }
        return true;
    }

    function playerGroupInfo(record: PlayerGroupRecord<P>): HmpBlipPlayerGroupInfo {
        const value = record.definition;
        return {
            resource: value.resource,
            id: value.id,
            key: value.key,
            color: value.color ? [value.color[0], value.color[1], value.color[2], value.color[3]] : null,
            priority: value.priority,
            scopedSubjects: value.subjects !== undefined,
            scopedAudience: value.audience !== undefined,
            sameArea: value.sameArea,
            sameRegion: value.sameRegion,
            sameVirtualWorld: value.sameVirtualWorld,
        };
    }

    function sharesContext(viewer: P, subject: P, definition: NormalizedPlayerGroup<P>, pass: Pass<P>): boolean {
        if (definition.sameVirtualWorld && Number(viewer.virtualWorld || 0) !== Number(subject.virtualWorld || 0)) return false;
        if (!definition.sameArea) return true;
        const viewerLocation = locate(viewer, pass);
        const subjectLocation = locate(subject, pass);
        if (!viewerLocation || !subjectLocation || !sameText(viewerLocation.areaId, subjectLocation.areaId)) return false;
        return !definition.sameRegion || sameText(viewerLocation.regionId, subjectLocation.regionId);
    }

    // Groups resolve in parallel, but the result keeps their order: an equal priority keeps the earlier group's color.
    // A group that cannot be resolved shows nobody, as a scoped marker does, and leaves the other groups alone.
    function resolvePlayerGroups(pass: Pass<P>): Promise<ResolvedPlayerGroup<P>[]> {
        return Promise.all([...playerGroups.values()].map(async ({ definition }) => {
            try {
                const [audience, subjects] = await Promise.all([
                    selectorPlayers(definition.audience, `player group '${definition.key}' audience`, pass),
                    selectorPlayers(definition.subjects, `player group '${definition.key}' subjects`, pass),
                ]);
                return { definition, audience: new Set(audience.map((player) => Number(player.id))), subjects };
            } catch (error) {
                logger.warn(`[hmp-blips] player group '${definition.key}' failed closed`, error);
                return { definition, audience: new Set<number>(), subjects: [] };
            }
        }));
    }

    function playerView(viewer: P, groups: ResolvedPlayerGroup<P>[], pass: Pass<P>) {
        const viewerId = Number(viewer.id);
        const visible = new Set<number>();
        const colors = new Map<number, { color: [number, number, number, number]; priority: number }>();
        for (const { definition, audience, subjects } of groups) {
            if (!audience.has(viewerId)) continue;
            for (const subject of subjects) {
                const subjectId = Number(subject.id);
                if (subjectId === viewerId || !sharesContext(viewer, subject, definition, pass)) continue;
                visible.add(subjectId);
                if (!definition.color) continue;
                const previous = colors.get(subjectId);
                if (!previous || definition.priority > previous.priority) colors.set(subjectId, { color: definition.color, priority: definition.priority });
            }
        }
        return {
            all: config.showAllPlayers,
            // In order, so the same view is always the same text.
            visible: [...visible].sort((left, right) => left - right),
            colors: Object.fromEntries([...colors].map(([id, value]) => [id, value.color])),
            houseTint: config.houseTint,
            scale: config.playerBlipScale,
            hideBaseIcon: config.hideBaseIcon,
        };
    }

    function present(pass: Pass<P>, ids?: Set<number>): P[] {
        return ids ? [...ids].map((id) => pass.byId.get(id)).filter((player): player is P => Boolean(player)) : pass.players;
    }

    /** Work out the views of `targets` (everyone when left out) and send each client the one it does not have yet. */
    async function refreshViews(targets?: Set<number>): Promise<number> {
        // The snapshot is taken with the tokens, so the refresh that wins a player is always the one with the newest data.
        const pass = beginPass();
        const viewers = present(pass, targets);
        const tokens = new Map<number, number>();
        for (const viewer of viewers) {
            const token = ++tokenCounter;
            playerViewTokens.set(Number(viewer.id), token);
            tokens.set(Number(viewer.id), token);
        }
        if (!viewers.length) return 0;
        const groups = await resolvePlayerGroups(pass);
        if (stopped) return 0;
        const live = connectedById();
        let current = 0;
        for (const viewer of viewers) {
            const id = Number(viewer.id);
            // A later refresh of this player superseded this one, or the player left meanwhile.
            if (playerViewTokens.get(id) !== tokens.get(id) || !live.has(id)) continue;
            const json = JSON.stringify(playerView(viewer, groups, pass));
            if (sentViews.get(id) === json) { current++; continue; }
            if (send(viewer, "hmp-blips:players", json)) { sentViews.set(id, json); current++; }
        }
        return current;
    }

    function refreshPlayers(player?: P): Promise<number> {
        return refreshViews(player ? new Set([Number(player.id)]) : undefined);
    }

    async function trackPlayers(raw: HmpBlipPlayerGroupDefinition<P>): Promise<HmpBlipPlayerGroupInfo> {
        if (stopped) throw new Error("hmp-blips is stopped");
        const definition = normalizePlayerGroup(raw) as NormalizedPlayerGroup<P>;
        const record = { definition };
        playerGroups.set(definition.key, record);
        await refreshPlayers();
        return playerGroupInfo(record);
    }

    async function untrackPlayers(id: string, resource: string): Promise<boolean> {
        const key = normalizeOwner({ id, resource }).key;
        if (!playerGroups.delete(key)) return false;
        await refreshPlayers();
        return true;
    }

    async function clearPlayerGroups(resource: string): Promise<number> {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let removed = 0;
        for (const [key, record] of [...playerGroups]) if (record.definition.resource === normalized) {
            playerGroups.delete(key);
            removed++;
        }
        if (removed) await refreshPlayers();
        return removed;
    }

    function getPlayerGroup(id: string, resource: string): HmpBlipPlayerGroupInfo | null {
        const record = playerGroups.get(normalizeOwner({ id, resource }).key);
        return record ? playerGroupInfo(record) : null;
    }

    function listPlayerGroups(resource?: string): HmpBlipPlayerGroupInfo[] {
        const normalized = resource ? normalizeOwner({ resource, id: "list" }).resource : "";
        return [...playerGroups.values()]
            .filter((record) => !normalized || record.definition.resource === normalized)
            .map(playerGroupInfo)
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    /** Replay to each of `ids` (everyone when left out) the markers it may see, and say how many each was sent. */
    async function replayMarkers(ids?: Set<number>): Promise<Map<number, number>> {
        const pass = beginPass();
        const targets = present(pass, ids);
        const replayed = new Map<number, number>();
        const tokens = new Map<number, number>();
        for (const target of targets) {
            const token = ++tokenCounter;
            playerReplayTokens.set(Number(target.id), token);
            tokens.set(Number(target.id), token);
        }
        if (!targets.length) return replayed;
        const records = [...markers.values()];
        // For everyone, each audience resolves once; for a few players, only those players are asked about. A marker
        // whose audience cannot be resolved is shown to nobody and leaves the others alone.
        const allowed = await Promise.all(records.map(async (record) => {
            try {
                if (!ids) return new Set((await markerViewers(record, pass)).map((player) => Number(player.id)));
                const allowedIds = new Set<number>();
                for (const target of targets) if ((await markerViewers(record, pass, Number(target.id))).length) allowedIds.add(Number(target.id));
                return allowedIds;
            } catch (error) {
                logger.warn(`[hmp-blips] marker '${record.definition.key}' audience failed closed`, error);
                return new Set<number>();
            }
        }));
        if (stopped) return replayed;
        const live = connectedById();
        for (const target of targets) {
            const id = Number(target.id);
            if (playerReplayTokens.get(id) !== tokens.get(id) || !live.has(id)) continue;
            const visible: unknown[] = [];
            records.forEach((record, index) => {
                if (markers.get(record.definition.key) !== record) return;
                if (allowed[index].has(id)) { visible.push(wireMarker(record)); record.viewers.add(id); }
                else record.viewers.delete(id);
            });
            emit(target, "hmp-blips:replay", { blips: visible });
            replayed.set(id, visible.length);
        }
        return replayed;
    }

    /** Everything a client needs from scratch: its markers (unless just replayed), its view and the native icon rules. */
    async function syncPlayers(ids: Set<number>, replay = true): Promise<number> {
        // The client may hold none of what it was sent, so its view goes again, from this refresh or one that overtakes it.
        for (const id of ids) sentViews.delete(id);
        const replayed = replay ? await replayMarkers(ids) : new Map<number, number>();
        await refreshViews(ids);
        if (stopped) return 0;
        const live = connectedById();
        let count = 0;
        for (const id of ids) {
            const target = live.get(id);
            if (!target) continue;
            emit(target, "hmp-blips:native-icons", config.nativeIcons);
            count += replayed.get(id) || 0;
        }
        return count;
    }

    function syncPlayer(player: P): Promise<number> {
        return syncPlayers(new Set([Number(player.id)]));
    }

    async function syncMarkers(player?: P): Promise<number> {
        if (player) { await replayMarkers(new Set([Number(player.id)])); return 1; }
        return (await replayMarkers()).size;
    }

    async function flush(): Promise<void> {
        const work = pending;
        pending = null;
        if (!work || stopped) return;
        // Each step stands alone: one that fails does not keep the others from the clients.
        const step = async (label: string, task: () => Promise<unknown>) => {
            try { await task(); }
            catch (error) { logger.warn(`[hmp-blips] could not ${label}`, error); }
        };
        if (work.markers) await step("replay markers", () => replayMarkers());
        else {
            const ids = new Set([...work.markerPlayers].filter((id) => !work.syncs.has(id)));
            if (ids.size) await step("replay markers", () => replayMarkers(ids));
        }
        if (work.syncs.size) await step("sync clients", () => syncPlayers(work.syncs, !work.markers));
        if (work.views) await step("refresh player views", () => refreshViews());
    }

    function schedule(work: BlipWork): void {
        if (stopped) return;
        pending ||= { views: false, markers: false, markerPlayers: new Set(), syncs: new Set() };
        if (work.views) pending.views = true;
        if (work.markers === true) pending.markers = true;
        else if (typeof work.markers === "number" && Number.isSafeInteger(work.markers)) pending.markerPlayers.add(work.markers);
        if (typeof work.sync === "number" && Number.isSafeInteger(work.sync)) {
            pending.syncs.add(work.sync);
            sentViews.delete(work.sync);
        }
        if (!pendingTimer) pendingTimer = setTimer(() => {
            pendingTimer = null;
            // One pass at a time, so an earlier one never lands after a later one.
            flushing = flushing.then(flush);
        }, REFRESH_DELAY_MS);
    }

    // A client's report is { waypoint: { x, y, z, target } | null }; undefined for anything else.
    function reportedWaypoint(payload: unknown): HmpBlipWaypoint | null | undefined {
        let value = payload;
        if (typeof payload === "string") {
            try { value = JSON.parse(payload); }
            catch (_) { return undefined; }
        }
        if (!value || typeof value !== "object" || !("waypoint" in value)) return undefined;
        const raw = (value as { waypoint: unknown }).waypoint;
        if (raw === null) return null;
        if (!raw || typeof raw !== "object") return undefined;
        const { x, y, z, target } = raw as Record<string, unknown>;
        const point = { x: Number(x), y: Number(y), z: Number(z) };
        if (![point.x, point.y, point.z].every(Number.isFinite)) return undefined;
        const name = typeof target === "string" ? target.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : "";
        return { ...point, target: name || null };
    }

    function sameWaypoint(left: HmpBlipWaypoint | null, right: HmpBlipWaypoint | null): boolean {
        if (!left || !right) return left === right;
        return left.x === right.x && left.y === right.y && left.z === right.z && left.target === right.target && left.areaId === right.areaId;
    }

    function getWaypoint(player: HmpBlipPlayerReference<P>): HmpBlipWaypoint | null {
        const waypoint = waypoints.get(Number(typeof player === "object" && player ? player.id : player));
        return waypoint ? { ...waypoint } : null;
    }

    function waypointShareInfo(share: WaypointShareRecord<P>): HmpBlipWaypointShareInfo {
        return { resource: share.resource, id: share.id, key: share.key, playerId: share.playerId, shown: waypoints.has(share.playerId) };
    }

    async function showWaypointShare(share: WaypointShareRecord<P>): Promise<void> {
        const waypoint = waypoints.get(share.playerId);
        if (!waypoint) { removeMarker(share.id, share.resource); return; }
        // The sharer has the game's own waypoint already.
        await putMarker({ ...share.marker, position: { x: waypoint.x, y: waypoint.y, z: waypoint.z }, areaId: waypoint.areaId }, share.playerId);
    }

    async function reportWaypoint(player: P, payload: unknown): Promise<boolean> {
        const id = Number(player.id);
        let waypoint = reportedWaypoint(payload);
        if (stopped || waypoint === undefined || !playerById(id)) return false;
        // Its coordinates belong to the map the player placed it in.
        const areaId = waypoint ? location(player)?.areaId : undefined;
        if (waypoint && areaId) waypoint = { ...waypoint, areaId };
        const previous = getWaypoint(id);
        if (sameWaypoint(waypoint, previous)) return false;
        if (waypoint) waypoints.set(id, waypoint);
        else waypoints.delete(id);
        events.emit("hmp:blips:waypoint", { player, waypoint: getWaypoint(id), previous });
        for (const share of [...waypointShares.values()]) {
            if (share.playerId !== id) continue;
            try { await showWaypointShare(share); }
            catch (error) { logger.warn(`[hmp-blips] waypoint share '${share.key}' could not follow #${id}`, error); }
        }
        return true;
    }

    async function shareWaypoint(raw: HmpBlipWaypointShareDefinition<P>): Promise<HmpBlipWaypointShareInfo> {
        if (stopped) throw new Error("hmp-blips is stopped");
        const identity = normalizeOwner(raw);
        const player = playerById(typeof raw.player === "object" && raw.player ? raw.player.id : raw.player);
        if (!player) throw new TypeError("waypoint share player must be connected");
        if (raw.audience === undefined) throw new TypeError("waypoint share audience is required");
        const marker: HmpBlipMarkerDefinition<P> = {
            resource: identity.resource,
            id: identity.id,
            kind: "marker",
            position: { x: 0, y: 0, z: 0 },
            icon: raw.icon ?? WAYPOINT_ICON,
            label: raw.label ?? player.nickname,
            showOnHud: raw.showOnHud,
            showDistance: raw.showDistance,
            ttl: 0,
            audience: raw.audience,
        };
        normalizeMarker(marker, resolveTtl);
        const share: WaypointShareRecord<P> = { ...identity, marker, playerId: Number(player.id) };
        waypointShares.set(identity.key, share);
        try { await showWaypointShare(share); }
        catch (error) {
            unshareWaypoint(identity.id, identity.resource);
            throw error;
        }
        return waypointShareInfo(share);
    }

    function unshareWaypoint(id: string, resource: string): boolean {
        const share = waypointShares.get(normalizeOwner({ id, resource }).key);
        if (!share) return false;
        waypointShares.delete(share.key);
        removeMarker(share.id, share.resource);
        return true;
    }

    function clearWaypointShares(resource: string): number {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let removed = 0;
        for (const share of [...waypointShares.values()]) if (share.resource === normalized && unshareWaypoint(share.id, share.resource)) removed++;
        return removed;
    }

    function listWaypointShares(resource?: string): HmpBlipWaypointShareInfo[] {
        const normalized = resource ? normalizeOwner({ resource, id: "list" }).resource : "";
        return [...waypointShares.values()]
            .filter((share) => !normalized || share.resource === normalized)
            .map(waypointShareInfo)
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    function disconnect(player: P): void {
        const id = Number(player.id);
        waypoints.delete(id);
        for (const share of [...waypointShares.values()]) if (share.playerId === id) unshareWaypoint(share.id, share.resource);
        sentViews.delete(id);
        playerViewTokens.delete(id);
        playerReplayTokens.delete(id);
        forgetGroups(id);
    }

    async function cleanup(resource: string): Promise<number> {
        const removedMarkers = clearMarkers(resource);
        const removedGroups = await clearPlayerGroups(resource);
        clearWaypointShares(resource); // their markers went with the resource's own
        return removedMarkers + removedGroups;
    }

    function stopService(): void {
        if (stopped) return;
        stopped = true;
        if (pendingTimer) clearTimer(pendingTimer);
        pendingTimer = null;
        pending = null;
        for (const record of markers.values()) disarm(record);
        markers.clear();
        playerGroups.clear();
        waypoints.clear();
        waypointShares.clear();
        sentViews.clear();
        memberships.clear();
        events.emitAllClients("hmp-blips:clear", "{}");
        events.emitAllClients("hmp-blips:players", JSON.stringify({ all: true, visible: [], colors: {}, houseTint: true, scale: 1, hideBaseIcon: false }));
        events.emitAllClients("hmp-blips:native-icons", JSON.stringify({ hide: [], labels: {} }));
    }

    const markerApi = Object.freeze({ upsert: upsertMarker, remove: removeMarker, clear: clearMarkers, get: getMarker, list: listMarkers, pulse: pulseMarker, sync: syncMarkers });
    const playerApi = Object.freeze({ track: trackPlayers, untrack: untrackPlayers, clear: clearPlayerGroups, get: getPlayerGroup, list: listPlayerGroups, refresh: refreshPlayers });
    const waypointApi = Object.freeze({ get: getWaypoint, share: shareWaypoint, unshare: unshareWaypoint, clear: clearWaypointShares, list: listWaypointShares });
    return {
        markers: markerApi,
        players: playerApi,
        waypoints: waypointApi,
        status: () => ({
            state: stopped ? "stopped" : "ready",
            markers: markers.size,
            playerGroups: playerGroups.size,
            expiringMarkers: [...markers.values()].filter((record) => record.expiresAt !== null).length,
            waypoints: waypoints.size,
            waypointShares: waypointShares.size,
            showAllPlayers: config.showAllPlayers,
            uptimeMs: Math.max(0, now() - startedAt),
        }),
        cleanup,
        syncPlayer,
        reportWaypoint,
        disconnect,
        schedule,
        forgetGroups,
        stop: stopService,
    };
}

export = { createBlipsService };

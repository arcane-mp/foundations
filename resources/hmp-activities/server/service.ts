import { randomUUID } from "node:crypto";
import normalizeModule = require("../shared/normalize");
import type {
    HmpActivityCompositionSlot, HmpActivityCreateInput, HmpActivityDefinitionInfo, HmpActivityDiscoverFilter,
    HmpActivityGate, HmpActivityInvitation, HmpActivityOwnerContext, HmpActivityParticipant, HmpActivityPlayer, HmpActivitySession,
} from "../types";
import type { ActivityDependencies, ActivityService, InternalParticipant, InternalSession, NormalizedDefinition } from "./internal";

const { normalizeDefinition, cleanText, cleanId, boundedInteger } = normalizeModule;

class HmpActivityError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = "HmpActivityError"; }
}

function fail(code: string, message: string): never { throw new HmpActivityError(code, message); }
const same = (left: unknown, right: unknown) => String(left || "").toLowerCase() === String(right || "").toLowerCase();

function createActivityService<P extends HmpActivityPlayer>(dependencies: ActivityDependencies<P>): ActivityService<P> {
    const { core, config } = dependencies;
    const now = dependencies.now || Date.now;
    const makeId = dependencies.id || randomUUID;
    const startedAt = now();
    const definitions = new Map<string, NormalizedDefinition<P>>();
    const records = new Map<string, InternalSession<P>>();
    const invitationRecords = new Map<string, HmpActivityInvitation>();
    let stopped = false;
    let queue: Promise<unknown> = Promise.resolve();

    function serialized<T>(operation: () => Promise<T> | T): Promise<T> {
        const pending = queue.then(operation, operation);
        queue = pending.then(() => undefined, () => undefined);
        return pending;
    }

    function ensureReady(): void { if (stopped) fail("HMP_ACTIVITY_STOPPED", "hmp-activities is stopped"); }

    function metadata(raw: unknown, label = "metadata"): Record<string, unknown> {
        if (raw === undefined) return {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${label} must be an object`);
        let encoded: string;
        try { encoded = JSON.stringify(raw); }
        catch (_) { throw new TypeError(`${label} must be JSON-serializable`); }
        if (Buffer.byteLength(encoded, "utf8") > config.maxMetadataBytes) throw new TypeError(`${label} exceeds ${config.maxMetadataBytes} bytes`);
        return JSON.parse(encoded) as Record<string, unknown>;
    }

    function definitionInfo(definition: NormalizedDefinition<P>): HmpActivityDefinitionInfo {
        return {
            id: definition.id, resource: definition.resource, label: definition.label, description: definition.description,
            minimumPlayers: definition.minimumPlayers, maximumPlayers: definition.maximumPlayers,
            roles: definition.roles.map((role) => ({ ...role })),
            teams: definition.teams.map((team) => ({ ...team, roles: team.roles?.map((role) => ({ ...role })) || [] })),
            requireReady: definition.requireReady, requiresCharacter: definition.requiresCharacter,
            exclusive: definition.exclusive, disconnectPolicy: definition.disconnectPolicy,
            defaultVisibility: definition.defaultVisibility,
            scope: definition.scope, lobbyTtlSeconds: definition.lobbyTtlSeconds,
        };
    }

    function composition(record: InternalSession<P>, definition: NormalizedDefinition<P>): HmpActivityCompositionSlot[] {
        if (definition.roles.length) return definition.roles.map((role) => {
            const filled = record.participants.filter((participant) => participant.role === role.id).length;
            return { id: role.id, label: role.label, team: null, minimum: role.min || 0, maximum: role.max, filled, open: Math.max(0, role.max - filled), satisfied: filled >= (role.min || 0) };
        });
        const result: HmpActivityCompositionSlot[] = [];
        for (const team of definition.teams) {
            const teamPlayers = record.participants.filter((participant) => participant.team === team.id);
            if (team.roles?.length) for (const role of team.roles) {
                const filled = teamPlayers.filter((participant) => participant.role === role.id).length;
                result.push({ id: role.id, label: role.label, team: team.id, minimum: role.min || 0, maximum: role.max, filled, open: Math.max(0, role.max - filled), satisfied: filled >= (role.min || 0) });
            }
        }
        return result;
    }

    function isStartable(record: InternalSession<P>, definition: NormalizedDefinition<P>): boolean {
        if (record.state !== "forming" || record.participants.length < definition.minimumPlayers || record.participants.length > definition.maximumPlayers) return false;
        if (definition.requireReady && record.participants.some((participant) => !participant.ready)) return false;
        if (composition(record, definition).some((slot) => !slot.satisfied)) return false;
        return definition.teams.every((team) => record.participants.filter((participant) => participant.team === team.id).length >= (team.min || 0));
    }

    function snapshot(record: InternalSession<P>): HmpActivitySession {
        const definition = definitions.get(record.activityId);
        if (!definition) throw new Error(`Missing activity definition '${record.activityId}'`);
        return {
            ...record,
            participants: record.participants.map(({ player: _player, ...participant }) => ({ ...participant })),
            metadata: metadata(record.metadata), scope: { ...record.scope },
            composition: composition(record, definition), startable: isStartable(record, definition),
        };
    }

    function emit(name: string, session: HmpActivitySession, extra: Record<string, unknown> = {}): void {
        dependencies.emit?.(name, { session, ...extra });
    }

    function invitationSnapshot(invitation: HmpActivityInvitation): HmpActivityInvitation { return { ...invitation }; }
    function settleInvitation(invitation: HmpActivityInvitation, state: "declined" | "cancelled" | "expired", reason: string): HmpActivityInvitation {
        invitation.state = state;
        invitation.respondedAt = new Date(now()).toISOString();
        invitationRecords.delete(invitation.id);
        const final = invitationSnapshot(invitation);
        dependencies.emit?.(`hmp:activities:invitation:${state}`, { invitation: final, reason });
        return final;
    }

    function cancelSessionInvitations(sessionId: string, reason: string): void {
        for (const invitation of [...invitationRecords.values()]) if (invitation.sessionId === sessionId) settleInvitation(invitation, "cancelled", reason);
    }

    function safeHook(name: string, hook: (() => unknown) | undefined): void {
        if (!hook) return;
        try { void Promise.resolve(hook()).catch((error) => dependencies.warn?.(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)); }
        catch (error) { dependencies.warn?.(`${name} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }

    async function gate(result: HmpActivityGate | Promise<HmpActivityGate>, fallback: string): Promise<void> {
        const resolved = await result;
        if (resolved === false) fail("HMP_ACTIVITY_DENIED", fallback);
        if (typeof resolved === "string" && resolved.trim()) fail("HMP_ACTIVITY_DENIED", resolved.trim());
    }

    function findRecord(rawId: string): InternalSession<P> {
        const record = records.get(String(rawId));
        if (!record) fail("HMP_ACTIVITY_SESSION_NOT_FOUND", `Activity session '${rawId}' was not found`);
        return record;
    }

    function participant(record: InternalSession<P>, playerId: number): InternalParticipant<P> | null {
        return record.participants.find((entry) => entry.playerId === Number(playerId)) || null;
    }

    function scopeFor(player: P, definition: NormalizedDefinition<P>) {
        if (definition.scope === "global") return {};
        const location = typeof player.location === "function" ? player.location() : null;
        if (["area", "region", "areaAndVirtualWorld"].includes(definition.scope) && !location?.areaId) fail("HMP_ACTIVITY_LOCATION_UNAVAILABLE", "Your current game area is unavailable");
        if (definition.scope === "region" && !location?.regionId) fail("HMP_ACTIVITY_LOCATION_UNAVAILABLE", "Your current game region is unavailable");
        return {
            ...(["area", "region", "areaAndVirtualWorld"].includes(definition.scope) ? { areaId: location!.areaId } : {}),
            ...(definition.scope === "region" ? { regionId: location!.regionId } : {}),
            ...(["virtualWorld", "areaAndVirtualWorld"].includes(definition.scope) ? { virtualWorld: Number(player.virtualWorld || 0) } : {}),
        };
    }

    function matchesScope(player: P, record: InternalSession<P>): boolean {
        if (record.scope.virtualWorld !== undefined && Number(player.virtualWorld || 0) !== record.scope.virtualWorld) return false;
        if (!record.scope.areaId && !record.scope.regionId) return true;
        const location = typeof player.location === "function" ? player.location() : null;
        if (!location || (record.scope.areaId && !same(record.scope.areaId, location.areaId))) return false;
        return !record.scope.regionId || same(record.scope.regionId, location.regionId);
    }

    function validateSelection(record: InternalSession<P> | null, definition: NormalizedDefinition<P>, rawTeam: unknown, rawRole: unknown, excludingPlayerId?: number): { team: string | null; role: string | null } {
        const team = rawTeam === undefined || rawTeam === null || rawTeam === "" ? null : cleanId(rawTeam, "activity team");
        const role = rawRole === undefined || rawRole === null || rawRole === "" ? null : cleanId(rawRole, "activity role");
        const participants = record?.participants.filter((entry) => entry.playerId !== excludingPlayerId) || [];
        if (definition.teams.length) {
            if (!team) fail("HMP_ACTIVITY_TEAM_REQUIRED", "Choose a team before joining this activity");
            const teamDefinition = definition.teams.find((candidate) => candidate.id === team);
            if (!teamDefinition) fail("HMP_ACTIVITY_TEAM_INVALID", `Unknown activity team '${team}'`);
            if (participants.filter((entry) => entry.team === team).length >= teamDefinition.max) fail("HMP_ACTIVITY_TEAM_FULL", `${teamDefinition.label} is full`);
            if (teamDefinition.roles?.length) {
                if (!role) fail("HMP_ACTIVITY_ROLE_REQUIRED", "Choose a role before joining this activity");
                const roleDefinition = teamDefinition.roles.find((candidate) => candidate.id === role);
                if (!roleDefinition) fail("HMP_ACTIVITY_ROLE_INVALID", `Unknown role '${role}' for ${teamDefinition.label}`);
                if (participants.filter((entry) => entry.team === team && entry.role === role).length >= roleDefinition.max) fail("HMP_ACTIVITY_ROLE_FULL", `${roleDefinition.label} on ${teamDefinition.label} is full`);
            } else if (role) fail("HMP_ACTIVITY_ROLE_INVALID", "This activity team does not use roles");
            return { team, role };
        }
        if (team) fail("HMP_ACTIVITY_TEAM_INVALID", "This activity does not use teams");
        if (definition.roles.length) {
            if (!role) fail("HMP_ACTIVITY_ROLE_REQUIRED", "Choose a role before joining this activity");
            const roleDefinition = definition.roles.find((candidate) => candidate.id === role);
            if (!roleDefinition) fail("HMP_ACTIVITY_ROLE_INVALID", `Unknown activity role '${role}'`);
            if (participants.filter((entry) => entry.role === role).length >= roleDefinition.max) fail("HMP_ACTIVITY_ROLE_FULL", `${roleDefinition.label} is full`);
        } else if (role) fail("HMP_ACTIVITY_ROLE_INVALID", "This activity does not use roles");
        return { team: null, role };
    }

    function assertAvailable(player: P, definition: NormalizedDefinition<P>): void {
        const joined = [...records.values()].filter((record) => participant(record, Number(player.id)));
        if (joined.some((record) => definitions.get(record.activityId)?.exclusive) || (definition.exclusive && joined.length)) {
            fail("HMP_ACTIVITY_EXCLUSIVE", "Leave your current exclusive activity before joining another");
        }
    }

    function assertAuthorized(record: InternalSession<P>, context: HmpActivityOwnerContext<P>): void {
        const definition = definitions.get(record.activityId)!;
        if (context.resource && same(context.resource, definition.resource)) return;
        if (context.actor && Number(context.actor.id) === record.leaderPlayerId) return;
        fail("HMP_ACTIVITY_NOT_AUTHORIZED", "Only the activity owner or group leader may do that");
    }

    function touch(record: InternalSession<P>): void { record.revision++; record.updatedAt = new Date(now()).toISOString(); }

    function removeTerminal(record: InternalSession<P>, state: "completed" | "cancelled", reason: string): HmpActivitySession {
        record.state = state;
        record.endReason = cleanText(reason, "activity end reason", 500) || state;
        record.endedAt = new Date(now()).toISOString();
        record.expiresAt = null;
        touch(record);
        const final = snapshot(record);
        cancelSessionInvitations(record.id, record.endReason);
        records.delete(record.id);
        return final;
    }

    function leaveInternal(record: InternalSession<P>, target: InternalParticipant<P>, reason: string): HmpActivitySession | null {
        const definition = definitions.get(record.activityId)!;
        record.participants = record.participants.filter((entry) => entry.playerId !== target.playerId);
        if (!record.participants.length) {
            const final = removeTerminal(record, "cancelled", reason || "empty");
            emit("hmp:activities:cancelled", final, { player: target.player, reason: final.endReason });
            safeHook(`${definition.id}.onCancelled`, () => definition.onCancelled?.({ session: final, player: target.player, reason: final.endReason || undefined }));
            return null;
        }
        if (record.leaderPlayerId === target.playerId) record.leaderPlayerId = record.participants[0].playerId;
        touch(record);
        const current = snapshot(record);
        emit("hmp:activities:left", current, { player: target.player, reason });
        safeHook(`${definition.id}.onLeft`, () => definition.onLeft?.({ session: current, player: target.player, reason }));
        return current;
    }

    async function create(player: P, rawActivityId: string, input: HmpActivityCreateInput = {}): Promise<HmpActivitySession> {
        return serialized(async () => {
            ensureReady();
            if (records.size >= config.maxSessions) fail("HMP_ACTIVITY_SESSION_LIMIT", "The server activity-session limit has been reached");
            const activityId = cleanId(rawActivityId, "activity id");
            const definition = definitions.get(activityId);
            if (!definition) fail("HMP_ACTIVITY_NOT_FOUND", `Unknown activity '${activityId}'`);
            assertAvailable(player, definition);
            const character = core.characters.active(player);
            if (definition.requiresCharacter && !character) fail("HMP_ACTIVITY_CHARACTER_REQUIRED", "Select a character before joining an activity");
            const selected = validateSelection(null, definition, input.team, input.role);
            if (definition.canCreate) await gate(definition.canCreate({ player, character, session: null, ...selected }), "You cannot create this activity");
            const timestamp = new Date(now()).toISOString();
            const ttl = input.lobbyTtlSeconds === undefined ? definition.lobbyTtlSeconds : boundedInteger(input.lobbyTtlSeconds, "activity lobbyTtlSeconds", 30, config.maximumLobbyTtlSeconds);
            const visibility = input.visibility || definition.defaultVisibility;
            if (!["public", "unlisted", "private"].includes(visibility)) throw new TypeError("activity visibility is invalid");
            const record: InternalSession<P> = {
                id: `${activityId}:${makeId()}`, activityId, activityLabel: definition.label, ownerResource: definition.resource,
                state: "forming", visibility, title: cleanText(input.title || definition.label, "activity title", 120),
                note: cleanText(input.note, "activity note", 500), leaderPlayerId: Number(player.id),
                minimumPlayers: definition.minimumPlayers, maximumPlayers: definition.maximumPlayers,
                requireReady: definition.requireReady,
                participants: [{ player, playerId: Number(player.id), nickname: String(player.nickname || `#${player.id}`), characterId: character?.id || null, characterName: character?.name || null, ...selected, ready: false, joinedAt: timestamp }],
                scope: scopeFor(player, definition), metadata: metadata(input.metadata), revision: 1,
                createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(now() + ttl * 1000).toISOString(),
                startedAt: null, endedAt: null, endReason: null,
            };
            records.set(record.id, record);
            const current = snapshot(record);
            emit("hmp:activities:created", current, { player });
            safeHook(`${definition.id}.onCreated`, () => definition.onCreated?.({ session: current, player }));
            return current;
        });
    }

    async function join(player: P, sessionId: string, selection: { team?: string; role?: string } = {}): Promise<HmpActivitySession> {
        return serialized(async () => {
            ensureReady();
            const record = findRecord(sessionId);
            const definition = definitions.get(record.activityId)!;
            if (record.state !== "forming") fail("HMP_ACTIVITY_NOT_FORMING", "This activity has already started");
            if (participant(record, Number(player.id))) return snapshot(record);
            if (record.participants.length >= record.maximumPlayers) fail("HMP_ACTIVITY_FULL", "This activity is full");
            if (!matchesScope(player, record)) fail("HMP_ACTIVITY_SCOPE_MISMATCH", "You are not in this activity's game area or virtual world");
            assertAvailable(player, definition);
            const character = core.characters.active(player);
            if (definition.requiresCharacter && !character) fail("HMP_ACTIVITY_CHARACTER_REQUIRED", "Select a character before joining an activity");
            const selected = validateSelection(record, definition, selection.team, selection.role);
            if (definition.canJoin) await gate(definition.canJoin({ player, character, session: snapshot(record), ...selected }), "You cannot join this activity");
            record.participants.push({ player, playerId: Number(player.id), nickname: String(player.nickname || `#${player.id}`), characterId: character?.id || null, characterName: character?.name || null, ...selected, ready: false, joinedAt: new Date(now()).toISOString() });
            touch(record);
            const current = snapshot(record);
            emit("hmp:activities:joined", current, { player });
            safeHook(`${definition.id}.onJoined`, () => definition.onJoined?.({ session: current, player }));
            return current;
        });
    }

    async function leave(player: P, sessionId: string, reason = "left"): Promise<HmpActivitySession | null> {
        return serialized(() => {
            ensureReady();
            const record = findRecord(sessionId);
            if (record.state !== "forming") fail("HMP_ACTIVITY_RUNNING", "A running activity must be completed or cancelled by its owner");
            const target = participant(record, Number(player.id));
            if (!target) fail("HMP_ACTIVITY_NOT_MEMBER", "You are not a member of this activity");
            return leaveInternal(record, target, cleanText(reason, "activity leave reason", 500) || "left");
        });
    }

    async function select(player: P, sessionId: string, selection: { team?: string | null; role?: string | null }): Promise<HmpActivitySession> {
        return serialized(async () => {
            ensureReady();
            const record = findRecord(sessionId);
            if (record.state !== "forming") fail("HMP_ACTIVITY_NOT_FORMING", "Roles cannot change after the activity starts");
            const target = participant(record, Number(player.id));
            if (!target) fail("HMP_ACTIVITY_NOT_MEMBER", "You are not a member of this activity");
            const definition = definitions.get(record.activityId)!;
            const selected = validateSelection(record, definition, selection.team === undefined ? target.team : selection.team, selection.role === undefined ? target.role : selection.role, target.playerId);
            if (definition.canJoin) await gate(definition.canJoin({ player, character: core.characters.active(player), session: snapshot(record), ...selected }), "You cannot use that activity role");
            target.team = selected.team; target.role = selected.role; target.ready = false;
            touch(record);
            const current = snapshot(record);
            emit("hmp:activities:updated", current, { player, change: "selection" });
            return current;
        });
    }

    async function setReady(player: P, sessionId: string, ready: boolean): Promise<HmpActivitySession> {
        return serialized(() => {
            ensureReady();
            const record = findRecord(sessionId);
            if (record.state !== "forming") fail("HMP_ACTIVITY_NOT_FORMING", "This activity has already started");
            const target = participant(record, Number(player.id));
            if (!target) fail("HMP_ACTIVITY_NOT_MEMBER", "You are not a member of this activity");
            target.ready = !!ready; touch(record);
            const current = snapshot(record);
            emit("hmp:activities:updated", current, { player, change: "ready" });
            return current;
        });
    }

    async function start(sessionId: string, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession> {
        return serialized(async () => {
            ensureReady();
            const record = findRecord(sessionId); assertAuthorized(record, context);
            const definition = definitions.get(record.activityId)!;
            if (!isStartable(record, definition)) fail("HMP_ACTIVITY_NOT_STARTABLE", "Player, role, team, or readiness requirements are not satisfied");
            if (definition.canStart) {
                const player = context.actor || record.participants.find((entry) => entry.playerId === record.leaderPlayerId)?.player || record.participants[0]?.player;
                if (!player) fail("HMP_ACTIVITY_NOT_STARTABLE", "The activity has no leader to start it");
                await gate(definition.canStart({ player, character: core.characters.active(player), session: snapshot(record), team: null, role: null, resource: context.resource }), "You cannot start this activity");
            }
            record.state = "running"; record.startedAt = new Date(now()).toISOString(); record.expiresAt = null; touch(record);
            const current = snapshot(record);
            emit("hmp:activities:started", current, { player: context.actor || null });
            safeHook(`${definition.id}.onStarted`, () => definition.onStarted?.({ session: current, player: context.actor }));
            return current;
        });
    }

    async function finish(sessionId: string, state: "completed" | "cancelled", result: Record<string, unknown> | undefined, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession> {
        return serialized(() => {
            ensureReady();
            const record = findRecord(sessionId); assertAuthorized(record, context);
            if (state === "completed" && record.state !== "running") fail("HMP_ACTIVITY_NOT_RUNNING", "Only a running activity can be completed");
            const definition = definitions.get(record.activityId)!;
            const final = removeTerminal(record, state, context.reason || state);
            const safeResult = result === undefined ? undefined : metadata(result, "activity result");
            emit(state === "completed" ? "hmp:activities:completed" : "hmp:activities:cancelled", final, { player: context.actor || null, reason: final.endReason, result: safeResult });
            safeHook(`${definition.id}.${state === "completed" ? "onCompleted" : "onCancelled"}`, () => state === "completed"
                ? definition.onCompleted?.({ session: final, player: context.actor, reason: final.endReason || undefined, result: safeResult })
                : definition.onCancelled?.({ session: final, player: context.actor, reason: final.endReason || undefined }));
            return final;
        });
    }

    async function kick(sessionId: string, playerId: number, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession | null> {
        return serialized(() => {
            ensureReady();
            const record = findRecord(sessionId); assertAuthorized(record, context);
            if (record.state !== "forming") fail("HMP_ACTIVITY_RUNNING", "Participants cannot be kicked after the activity starts");
            if (Number(playerId) === record.leaderPlayerId) fail("HMP_ACTIVITY_LEADER", "Transfer leadership before removing the leader");
            const target = participant(record, Number(playerId));
            if (!target) fail("HMP_ACTIVITY_NOT_MEMBER", "That player is not a member of this activity");
            return leaveInternal(record, target, context.reason || "kicked");
        });
    }

    async function transferLeader(sessionId: string, playerId: number, context: HmpActivityOwnerContext<P>): Promise<HmpActivitySession> {
        return serialized(() => {
            ensureReady();
            const record = findRecord(sessionId); assertAuthorized(record, context);
            if (!participant(record, Number(playerId))) fail("HMP_ACTIVITY_NOT_MEMBER", "The new leader must be a member of this activity");
            record.leaderPlayerId = Number(playerId); touch(record);
            const current = snapshot(record); emit("hmp:activities:updated", current, { player: context.actor || null, change: "leader" });
            return current;
        });
    }

    async function unregister(rawId: string, rawResource: string): Promise<number> {
        return serialized(() => {
            ensureReady();
            const id = cleanId(rawId, "activity id"); const resource = cleanId(rawResource, "activity resource");
            const definition = definitions.get(id);
            if (!definition || definition.resource !== resource) return 0;
            const affected = [...records.values()].filter((record) => record.activityId === id);
            for (const record of affected) {
                const final = removeTerminal(record, "cancelled", "activity definition unloaded");
                emit("hmp:activities:cancelled", final, { reason: final.endReason });
                safeHook(`${definition.id}.onCancelled`, () => definition.onCancelled?.({ session: final, reason: final.endReason || undefined }));
            }
            definitions.delete(id);
            return affected.length;
        });
    }

    async function invite(sessionId: string, target: P, selection: { team?: string; role?: string; message?: string; ttlSeconds?: number }, context: HmpActivityOwnerContext<P>): Promise<HmpActivityInvitation> {
        return serialized(() => {
            ensureReady();
            if (invitationRecords.size >= config.maxInvitations) fail("HMP_ACTIVITY_INVITATION_LIMIT", "The server invitation limit has been reached");
            const record = findRecord(sessionId); assertAuthorized(record, context);
            if (record.state !== "forming") fail("HMP_ACTIVITY_NOT_FORMING", "Invitations may only be sent for a forming activity");
            if (participant(record, Number(target.id))) fail("HMP_ACTIVITY_ALREADY_MEMBER", "That player is already in this activity");
            if (!matchesScope(target, record)) fail("HMP_ACTIVITY_SCOPE_MISMATCH", "That player is not in this activity's game area or virtual world");
            if (record.participants.length >= record.maximumPlayers) fail("HMP_ACTIVITY_FULL", "This activity is full");
            const proposed = validateSelection(record, definitions.get(record.activityId)!, selection.team, selection.role);
            if ([...invitationRecords.values()].some((entry) => entry.sessionId === record.id && entry.toPlayerId === Number(target.id))) fail("HMP_ACTIVITY_ALREADY_INVITED", "That player already has an invitation to this activity");
            const inviter = context.actor ? participant(record, Number(context.actor.id)) : participant(record, record.leaderPlayerId);
            if (!inviter) fail("HMP_ACTIVITY_NOT_MEMBER", "The inviter must be a member of this activity");
            const ttl = selection.ttlSeconds === undefined ? config.defaultInvitationTtlSeconds : boundedInteger(selection.ttlSeconds, "activity invitation ttlSeconds", 5, config.maximumInvitationTtlSeconds);
            const createdAt = new Date(now()).toISOString();
            const invitation: HmpActivityInvitation = {
                id: `invite:${makeId()}`, sessionId: record.id, activityId: record.activityId,
                fromPlayerId: inviter.playerId, fromNickname: inviter.nickname,
                toPlayerId: Number(target.id), toNickname: String(target.nickname || `#${target.id}`),
                ...proposed, message: cleanText(selection.message, "activity invitation message", 300),
                state: "pending", createdAt, expiresAt: new Date(now() + ttl * 1000).toISOString(), respondedAt: null,
            };
            invitationRecords.set(invitation.id, invitation);
            const current = invitationSnapshot(invitation);
            dependencies.emit?.("hmp:activities:invitation:created", { invitation: current, session: snapshot(record), target });
            return current;
        });
    }

    async function acceptInvitation(player: P, invitationId: string): Promise<HmpActivitySession> {
        const reserved = await serialized(() => {
            ensureReady();
            const invitation = invitationRecords.get(String(invitationId));
            if (!invitation || invitation.state !== "pending") fail("HMP_ACTIVITY_INVITATION_NOT_FOUND", "That activity invitation is no longer available");
            if (invitation.toPlayerId !== Number(player.id)) fail("HMP_ACTIVITY_INVITATION_TARGET", "This activity invitation belongs to another player");
            if (Date.parse(invitation.expiresAt) <= now()) { settleInvitation(invitation, "expired", "invitation expired"); fail("HMP_ACTIVITY_INVITATION_EXPIRED", "That activity invitation has expired"); }
            invitationRecords.delete(invitation.id);
            return invitationSnapshot(invitation);
        });
        try {
            const session = await join(player, reserved.sessionId, { team: reserved.team || undefined, role: reserved.role || undefined });
            reserved.state = "accepted"; reserved.respondedAt = new Date(now()).toISOString();
            dependencies.emit?.("hmp:activities:invitation:accepted", { invitation: invitationSnapshot(reserved), session, player });
            return session;
        } catch (error) {
            await serialized(() => {
                if (records.get(reserved.sessionId)?.state === "forming" && Date.parse(reserved.expiresAt) > now()) invitationRecords.set(reserved.id, { ...reserved, state: "pending", respondedAt: null });
            });
            throw error;
        }
    }

    async function declineInvitation(player: P, invitationId: string, reason = "declined"): Promise<HmpActivityInvitation> {
        return serialized(() => {
            ensureReady();
            const invitation = invitationRecords.get(String(invitationId));
            if (!invitation || invitation.state !== "pending") fail("HMP_ACTIVITY_INVITATION_NOT_FOUND", "That activity invitation is no longer available");
            if (invitation.toPlayerId !== Number(player.id)) fail("HMP_ACTIVITY_INVITATION_TARGET", "This activity invitation belongs to another player");
            return settleInvitation(invitation, "declined", cleanText(reason, "activity invitation reason", 300) || "declined");
        });
    }

    async function cancelInvitation(invitationId: string, context: HmpActivityOwnerContext<P>): Promise<HmpActivityInvitation> {
        return serialized(() => {
            ensureReady();
            const invitation = invitationRecords.get(String(invitationId));
            if (!invitation || invitation.state !== "pending") fail("HMP_ACTIVITY_INVITATION_NOT_FOUND", "That activity invitation is no longer available");
            const record = findRecord(invitation.sessionId); assertAuthorized(record, context);
            return settleInvitation(invitation, "cancelled", cleanText(context.reason, "activity invitation reason", 300) || "cancelled");
        });
    }

    function listInvitations(filter: { sessionId?: string; playerId?: number; direction?: "incoming" | "outgoing" } = {}): HmpActivityInvitation[] {
        return [...invitationRecords.values()]
            .filter((entry) => !filter.sessionId || entry.sessionId === filter.sessionId)
            .filter((entry) => filter.playerId === undefined || (filter.direction === "outgoing" ? entry.fromPlayerId === Number(filter.playerId) : filter.direction === "incoming" ? entry.toPlayerId === Number(filter.playerId) : entry.toPlayerId === Number(filter.playerId) || entry.fromPlayerId === Number(filter.playerId)))
            .map(invitationSnapshot).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    async function clear(resource: string): Promise<number> {
        const ids = [...definitions.values()].filter((definition) => definition.resource === String(resource).toLowerCase()).map((definition) => definition.id);
        let count = 0;
        for (const id of ids) count += await unregister(id, resource);
        return count;
    }

    function register(raw: Parameters<ActivityService<P>["definitions"]["register"]>[0]): () => Promise<number> {
        ensureReady();
        const definition = normalizeDefinition(raw, config);
        if (definitions.has(definition.id)) throw new Error(`Activity '${definition.id}' is already registered`);
        if (definitions.size >= config.maxDefinitions) throw new Error("The activity-definition limit has been reached");
        definitions.set(definition.id, definition);
        let active = true;
        return async () => { if (!active) return 0; active = false; return unregister(definition.id, definition.resource); };
    }

    function listSessions(filter: { activityId?: string; state?: "forming" | "running"; playerId?: number } = {}): HmpActivitySession[] {
        return [...records.values()]
            .filter((record) => !filter.activityId || record.activityId === String(filter.activityId).toLowerCase())
            .filter((record) => !filter.state || record.state === filter.state)
            .filter((record) => filter.playerId === undefined || !!participant(record, Number(filter.playerId)))
            .map(snapshot).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    function discover(player: P | null = null, filter: HmpActivityDiscoverFilter = {}): HmpActivitySession[] {
        const role = filter.role ? String(filter.role).toLowerCase() : null;
        const team = filter.team ? String(filter.team).toLowerCase() : null;
        return [...records.values()].filter((record) => {
            if (record.state !== "forming" || record.visibility !== "public") return false;
            if (!filter.includeFull && record.participants.length >= record.maximumPlayers) return false;
            if (filter.activityId && record.activityId !== String(filter.activityId).toLowerCase()) return false;
            if (player && !matchesScope(player, record)) return false;
            if (filter.areaId && !same(filter.areaId, record.scope.areaId)) return false;
            if (filter.regionId && !same(filter.regionId, record.scope.regionId)) return false;
            if (filter.virtualWorld !== undefined && record.scope.virtualWorld !== Number(filter.virtualWorld)) return false;
            if (role || team) {
                const slots = composition(record, definitions.get(record.activityId)!);
                if (role && !slots.some((slot) => slot.id === role && (!team || slot.team === team) && slot.open > 0)) return false;
                if (team) {
                    const definition = definitions.get(record.activityId)!;
                    const teamDefinition = definition.teams.find((candidate) => candidate.id === team);
                    if (!teamDefinition || record.participants.filter((entry) => entry.team === team).length >= teamDefinition.max) return false;
                }
            }
            return true;
        }).map(snapshot).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    async function cleanup(resource: string): Promise<number> { return clear(String(resource || "").toLowerCase()); }

    async function disconnect(player: P): Promise<void> {
        await serialized(() => {
            for (const invitation of [...invitationRecords.values()]) if (invitation.toPlayerId === Number(player.id) || invitation.fromPlayerId === Number(player.id)) settleInvitation(invitation, "cancelled", "player disconnected");
        });
        for (const record of [...records.values()].filter((entry) => participant(entry, Number(player.id)))) {
            await serialized(() => {
                const current = records.get(record.id); const target = current && participant(current, Number(player.id));
                if (!current || !target) return;
                if (current.state === "running" && definitions.get(current.activityId)!.disconnectPolicy === "cancel") {
                    const definition = definitions.get(current.activityId)!;
                    const final = removeTerminal(current, "cancelled", "participant disconnected");
                    emit("hmp:activities:cancelled", final, { player, reason: final.endReason });
                    safeHook(`${definition.id}.onCancelled`, () => definition.onCancelled?.({ session: final, player, reason: final.endReason || undefined }));
                } else leaveInternal(current, target, "disconnected");
            });
        }
    }

    async function sweep(): Promise<number> {
        await serialized(() => {
            for (const invitation of [...invitationRecords.values()]) if (Date.parse(invitation.expiresAt) <= now()) settleInvitation(invitation, "expired", "invitation expired");
        });
        const expired = [...records.values()].filter((record) => record.state === "forming" && record.expiresAt && Date.parse(record.expiresAt) <= now());
        let count = 0;
        for (const candidate of expired) {
            await serialized(() => {
                const record = records.get(candidate.id);
                if (!record || !record.expiresAt || Date.parse(record.expiresAt) > now()) return;
                const definition = definitions.get(record.activityId)!;
                const final = removeTerminal(record, "cancelled", "lobby expired"); count++;
                emit("hmp:activities:cancelled", final, { reason: final.endReason });
                safeHook(`${definition.id}.onCancelled`, () => definition.onCancelled?.({ session: final, reason: final.endReason || undefined }));
            });
        }
        return count;
    }

    async function stop(): Promise<void> {
        await serialized(() => {
            if (stopped) return;
            for (const record of [...records.values()]) {
                const final = removeTerminal(record, "cancelled", "hmp-activities stopped");
                emit("hmp:activities:cancelled", final, { reason: final.endReason });
            }
            invitationRecords.clear(); definitions.clear(); stopped = true;
        });
    }

    return Object.freeze({
        definitions: Object.freeze({ register, unregister, clear, get: (id: string) => { const value = definitions.get(String(id).toLowerCase()); return value ? definitionInfo(value) : null; }, list: (resource?: string) => [...definitions.values()].filter((entry) => !resource || entry.resource === String(resource).toLowerCase()).map(definitionInfo) }),
        sessions: Object.freeze({
            create, join, leave, select, setReady, start,
            complete: (id: string, result: Record<string, unknown> | undefined, context: HmpActivityOwnerContext<P>) => finish(id, "completed", result, context),
            cancel: (id: string, context: HmpActivityOwnerContext<P>) => finish(id, "cancelled", undefined, context),
            kick, transferLeader,
            get: (id: string) => { const record = records.get(String(id)); return record ? snapshot(record) : null; },
            list: listSessions, forPlayer: (player: P | number) => listSessions({ playerId: typeof player === "number" ? player : Number(player.id) }), discover,
        }),
        invitations: Object.freeze({ invite, accept: acceptInvitation, decline: declineInvitation, cancel: cancelInvitation, get: (id: string) => { const value = invitationRecords.get(String(id)); return value ? invitationSnapshot(value) : null; }, list: listInvitations }),
        status: () => ({ state: stopped ? "stopped" as const : "ready" as const, definitions: definitions.size, sessions: records.size, forming: [...records.values()].filter((record) => record.state === "forming").length, running: [...records.values()].filter((record) => record.state === "running").length, participants: [...records.values()].reduce((sum, record) => sum + record.participants.length, 0), invitations: invitationRecords.size, uptimeMs: now() - startedAt }),
        cleanup, disconnect, sweep, stop,
    });
}

export = { createActivityService, HmpActivityError };

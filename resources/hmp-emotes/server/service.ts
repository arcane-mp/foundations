import normalizeModule = require("../shared/normalize");
import activitiesModule = require("../shared/activities");
import type { HmpEmoteActivity, HmpEmoteAliasRecord, HmpEmoteCandidate, HmpEmoteDefinition, HmpEmotePlayer } from "../types";
import type { EmoteDependencies, EmoteService, PersistedAlias } from "./internal";

const { nameOf, pathOf, normalizeDefinition, normalizeConfigured } = normalizeModule;
const { ACTIVITIES, activityOf } = activitiesModule;
const FAVORITES_KEY = "hmp-emotes:favorites";
const UI_CONTRACT = "hmp.emotes.ui/v1";

function favoritePath(value: unknown): string {
    const path = String(value || "").trim();
    if (!path || path.length > 256) throw new TypeError("favorite path must contain 1-256 characters");
    return path;
}

function suggestedAlias(rawPath: unknown): string {
    const path = pathOf(rawPath);
    const objectName = (path.split(".").pop() || path.split("/").pop() || "emote")
        .replace(/_C$/i, "")
        .replace(/^ABL_/i, "")
        .replace(/(?:_POSE)?_ANM$/i, "");
    return objectName
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase()
        .slice(0, 24) || "emote";
}

function createEmoteService<P extends HmpEmotePlayer>(dependencies: EmoteDependencies<P>): EmoteService<P> {
    const { repository, core, config } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const configured = new Map<string, HmpEmoteAliasRecord>();
    const registered = new Map<string, HmpEmoteAliasRecord>();
    const persisted = new Map<string, PersistedAlias>();
    const clients = new Set<number>();
    const openMenus = new Set<number>();
    let state: ReturnType<EmoteService<P>["status"]>["state"] = "starting";
    let lastError = "";
    let warnedActivities = false;

    for (const [name, raw] of Object.entries(config.aliases)) {
        const definition = normalizeConfigured(name, raw);
        configured.set(definition.name, { ...definition, source: "config" });
    }

    const startPromise = repository.start(dependencies.migrations)
        .then(() => repository.list())
        .then((rows) => {
            for (const row of rows) persisted.set(row.name, row);
            state = "ready";
            return true;
        })
        .catch((error: unknown) => {
            state = "degraded";
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
        });

    function effectiveMap(): Map<string, HmpEmoteAliasRecord> {
        const result = new Map<string, HmpEmoteAliasRecord>(configured);
        for (const [name, entry] of registered) result.set(name, entry);
        for (const [name, entry] of persisted) {
            if (entry.hidden) result.delete(name);
            else result.set(name, entry);
        }
        return result;
    }

    function publicDefinitions(): HmpEmoteDefinition[] {
        return [...effectiveMap().values()].map(({ name, path, kind, channel, resource }) => ({ name, path, kind, channel, ...(resource ? { resource } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
    }

    function availableAlias(path: string): string {
        const definitions = effectiveMap();
        const base = suggestedAlias(path);
        if (!definitions.has(base)) return base;
        for (let sequence = 2; sequence <= 9999; sequence++) {
            const suffix = `_${sequence}`;
            const candidate = `${base.slice(0, 24 - suffix.length)}${suffix}`;
            if (!definitions.has(candidate)) return candidate;
        }
        throw new Error("Could not generate a unique emote alias");
    }

    function emit(player: P, name: string, payload: unknown): boolean {
        try { player.emit(name, JSON.stringify(payload)); return true; }
        catch (_) { return false; }
    }

    async function canEdit(player: P): Promise<boolean> {
        if (!config.editorGroups.length) return false;
        const checks = await Promise.all(config.editorGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade || 0)));
        return checks.some(Boolean);
    }

    async function requireEditor(player: P): Promise<void> {
        if (!await canEdit(player)) throw Object.assign(new Error("You do not have permission to edit emotes."), { code: "HMP_EMOTES_FORBIDDEN" });
    }

    function actorAccountId(player: P): number | null {
        return core.accounts.getByPlayer(player)?.id ?? null;
    }

    async function favoriteList(player: P): Promise<string[]> {
        const account = core.accounts.getByPlayer(player);
        if (!account) return [];
        const raw = await core.metadata.getAccount<unknown>(account.id, FAVORITES_KEY);
        if (!Array.isArray(raw)) return [];
        return [...new Set(raw.filter((entry): entry is string => typeof entry === "string" && !!entry.trim() && entry.length <= 256))].slice(0, config.maxFavorites);
    }

    async function favoriteToggle(player: P, rawPath: string): Promise<string[]> {
        const account = core.accounts.getByPlayer(player);
        if (!account) throw new Error("Player does not have a ready hmp-core account");
        const path = favoritePath(rawPath);
        const values = await favoriteList(player);
        const at = values.indexOf(path);
        if (at >= 0) values.splice(at, 1);
        else {
            if (values.length >= config.maxFavorites) throw new Error(`Favourites are full (${config.maxFavorites})`);
            values.push(path);
        }
        await core.metadata.setAccount(account.id, FAVORITES_KEY, values);
        emit(player, "hmp-emotes:favorites", { paths: values });
        return values;
    }

    async function pushAliases(player: P): Promise<boolean> {
        await startPromise;
        return emit(player, "hmp-emotes:aliases", {
            aliases: Object.fromEntries(publicDefinitions().map((entry) => [entry.name, entry])),
            canEdit: await canEdit(player),
            allowAll: config.allowAll,
            browseUnaliased: config.allowAll,
        });
    }

    async function pushFavorites(player: P): Promise<boolean> {
        return emit(player, "hmp-emotes:favorites", { paths: await favoriteList(player) });
    }

    async function broadcastAliases(): Promise<void> {
        const aliases = Object.fromEntries(publicDefinitions().map((entry) => [entry.name, entry]));
        for (const player of dependencies.players()) emit(player, "hmp-emotes:aliases", { aliases });
        dependencies.events.emit("hmp:emotes:aliases-changed", publicDefinitions());
    }

    async function persist(player: P, record: PersistedAlias): Promise<HmpEmoteAliasRecord> {
        await startPromise;
        await requireEditor(player);
        await repository.put({ ...record, actorAccountId: actorAccountId(player) });
        const stored = { ...record, updatedByAccountId: actorAccountId(player), updatedAt: new Date(now()).toISOString() };
        persisted.set(record.name, stored);
        await broadcastAliases();
        return stored;
    }

    const aliases = Object.freeze({
        register(raw: HmpEmoteDefinition) {
            const definition = normalizeDefinition(raw);
            if (!definition.resource) throw new TypeError("registered emotes require a resource owner");
            const existing = registered.get(definition.name);
            if (existing && existing.resource !== definition.resource) throw new Error(`emote '${definition.name}' is already owned by '${existing.resource}'`);
            const entry: HmpEmoteAliasRecord = { ...definition, source: "resource" };
            registered.set(definition.name, entry);
            void broadcastAliases();
            let active = true;
            return () => {
                if (!active || registered.get(definition.name) !== entry) return false;
                active = false;
                return aliases.unregister(definition.name, definition.resource);
            };
        },
        unregister(rawName: string, resource?: string) {
            const name = nameOf(rawName);
            const existing = registered.get(name);
            if (!existing || (resource && existing.resource !== resource)) return false;
            registered.delete(name);
            void broadcastAliases();
            return true;
        },
        list: () => [...effectiveMap().values()].sort((a, b) => a.name.localeCompare(b.name)),
        get(rawName: string) { try { return effectiveMap().get(nameOf(rawName)) || null; } catch (_) { return null; } },
        async set(player: P, raw: HmpEmoteDefinition) {
            const definition = normalizeDefinition(raw);
            if (effectiveMap().size >= config.maxAliases && !effectiveMap().has(definition.name)) throw new Error(`Alias list is full (${config.maxAliases})`);
            for (const entry of effectiveMap().values()) {
                if (entry.path === definition.path && entry.name !== definition.name) {
                    await persist(player, { ...entry, path: "", source: "database", hidden: true });
                }
            }
            return persist(player, { ...definition, source: "database", hidden: false });
        },
        async allow(player: P, raw: HmpEmoteCandidate) {
            await startPromise;
            await requireEditor(player);
            const path = pathOf(raw?.path);
            const existing = [...effectiveMap().values()].find((entry) => entry.path === path);
            if (existing) return existing;
            if (effectiveMap().size >= config.maxAliases) throw new Error(`Alias list is full (${config.maxAliases})`);
            const definition = normalizeDefinition({
                name: availableAlias(path),
                path,
                kind: raw?.kind === "ability" ? "ability" : "pose",
                channel: raw?.channel === "PartialBody" ? "PartialBody" : "FullBody",
            });
            return persist(player, { ...definition, source: "database", hidden: false });
        },
        async deny(player: P, rawPath: string) {
            await startPromise;
            await requireEditor(player);
            const path = pathOf(rawPath);
            const matches = [...effectiveMap().values()].filter((entry) => entry.path === path);
            for (const entry of matches) await persist(player, { ...entry, path: "", source: "database", hidden: true });
            return matches.length;
        },
        async hide(player: P, rawName: string) {
            const name = nameOf(rawName);
            const existing = effectiveMap().get(name);
            if (!existing) return false;
            await persist(player, { ...existing, path: "", source: "database", hidden: true });
            return true;
        },
        async clearPath(player: P, rawPath: string) {
            return aliases.deny(player, rawPath);
        },
    });

    const emotes = Object.freeze({
        list: publicDefinitions,
        get(rawName: string) { try { return publicDefinitions().find((entry) => entry.name === nameOf(rawName)) || null; } catch (_) { return null; } },
        async play(player: P, rawName: string) {
            await startPromise;
            if (!config.enabled) return false;
            const definition = emotes.get(rawName);
            if (!definition) return false;
            return emit(player, "hmp-emotes:play", definition);
        },
        stop: (player: P) => emit(player, "hmp-emotes:stop", {}),
    });

    const ui = Object.freeze({
        async open(player: P) {
            await startPromise;
            if (!config.enabled) return false;
            openMenus.add(player.id);
            return emit(player, "hmp-emotes:open", {});
        },
        close(player: P) { openMenus.delete(player.id); return emit(player, "hmp-emotes:close", {}); },
        async sync(player: P) { await Promise.all([pushAliases(player), pushFavorites(player)]); return true; },
    });

    // A host before HogwartsMP 1.11 has no player activities: nothing is offered and nothing starts.
    function hostActivities(player: P): boolean {
        if (typeof player.startActivity === "function") return true;
        if (config.activities.length && !warnedActivities) {
            dependencies.warn?.("Player activities need HogwartsMP 1.11 or newer for player.startActivity; none are offered");
            warnedActivities = true;
        }
        return false;
    }

    function offeredActivities(): HmpEmoteActivity[] {
        return ACTIVITIES.filter((entry) => config.activities.includes(entry.id)).map((entry) => ({ id: entry.id, variants: [...entry.variants] }));
    }

    const activities = Object.freeze({
        list: offeredActivities,
        start(player: P, rawId: string, rawVariant?: string) {
            const activity = activityOf(rawId);
            if (!config.enabled || !activity || !config.activities.includes(activity.id) || !hostActivities(player)) return false;
            const variant = rawVariant === undefined || rawVariant === "" ? undefined : String(rawVariant).trim().toLowerCase();
            if (variant !== undefined && !activity.variants.includes(variant)) return false;
            try { player.startActivity!(activity.id, variant); return true; }
            catch (_) { return false; }
        },
        finish(player: P) {
            if (typeof player.finishActivity !== "function") return false;
            try { player.finishActivity(); return true; }
            catch (_) { return false; }
        },
        get(player: P) {
            try { return typeof player.getActivity === "function" ? player.getActivity() : null; }
            catch (_) { return null; }
        },
    });

    function removeForResource(resource: string): number {
        let removed = 0;
        for (const entry of [...registered.values()]) if (entry.resource === resource && aliases.unregister(entry.name, resource)) removed++;
        return removed;
    }

    return Object.freeze({
        emotes, aliases,
        favorites: Object.freeze({ list: favoriteList, toggle: favoriteToggle }),
        ui,
        activities,
        status: () => ({ state, lastError, aliases: effectiveMap().size, configuredAliases: configured.size, registeredAliases: registered.size, persistedOverrides: persisted.size, readyClients: clients.size, openMenus: openMenus.size, uptimeMs: now() - startedAt }),
        ready: () => startPromise,
        async onClientReady(player: P) {
            clients.add(player.id);
            emit(player, "hmp-emotes:configure", { contract: UI_CONTRACT, url: config.ui.url });
            emit(player, "hmp-emotes:activities", { activities: config.enabled && hostActivities(player) ? offeredActivities() : [] });
            await ui.sync(player);
            return true;
        },
        aliasRequest: pushAliases,
        favoriteRequest: pushFavorites,
        removeForResource,
        disconnect(player: P) { clients.delete(player.id); openMenus.delete(player.id); },
        stop() { state = "stopped"; clients.clear(); openMenus.clear(); },
    });
}

export = { createEmoteService, favoritePath, suggestedAlias, FAVORITES_KEY, UI_CONTRACT };

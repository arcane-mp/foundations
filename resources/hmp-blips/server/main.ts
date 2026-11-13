import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpBlipPlayer } from "../types";

const { loadConfig } = configModule;
const { createBlipsService } = serviceModule;
const Hmp = Imports.get<HmpLibServer<HmpBlipPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpBlipPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-blips");
const config = loadConfig(Hmp);
const blips = createBlipsService({ core, config, players: () => PlayerManager.getAll(), events: Events, logger });

for (const name of ["markers", "players", "waypoints", "status"] as const) Exports.register(name, blips[name]);

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safe(task: Promise<unknown>, label: string): void { task.catch((error) => logger.warn(`${label}: ${messageOf(error)}`)); }
// A character event carries { session, character }; a session event is the session itself.
function sessionPlayerId(payload: unknown): number | undefined {
    const value = payload as { playerId?: unknown; session?: { playerId?: unknown } } | null;
    const id = Number(value?.session?.playerId ?? value?.playerId);
    return value && Number.isSafeInteger(id) ? id : undefined;
}

// Connects, leaves and area changes arrive inside the packet that carries them, so the handlers only note the work:
// it runs a moment later, once for the whole burst.
Events.emitAllClients("hmp-blips:clear", "{}");
Events.emitAllClients("hmp-blips:players", JSON.stringify({ all: config.showAllPlayers, visible: [], colors: {}, houseTint: config.houseTint, scale: config.playerBlipScale, hideBaseIcon: config.hideBaseIcon }));
Events.emitAllClients("hmp-blips:native-icons", JSON.stringify(config.nativeIcons));
Events.onClient("hmp-blips:ready", (player: HmpBlipPlayer) => blips.schedule({ sync: Number(player.id) }));
Events.onClient("hmp-blips:waypoint", (player: HmpBlipPlayer, payload: unknown) => safe(blips.reportWaypoint(player, payload), `Could not take #${player.id}'s waypoint`));
Events.on("playerConnect", (player: HmpBlipPlayer) => blips.schedule({ sync: Number(player.id), views: true }));
Events.on("playerDisconnect", (player: HmpBlipPlayer) => {
    blips.markers.remove(`test-marker-${player.id}`, "hmp-blips");
    blips.markers.remove(`test-circle-${player.id}`, "hmp-blips");
    blips.disconnect(player);
    blips.schedule({ views: true });
});
Events.on("playerLocationChanged", (player: HmpBlipPlayer) => blips.schedule({ markers: Number(player.id), views: true }));
// The online players a group change is about, or undefined when the change does not say whose it is.
function groupChangePlayers(change: unknown): number[] | undefined {
    const value = change as { scope?: unknown; ownerId?: unknown; group?: { scope?: unknown } } | null;
    const scope = value?.group?.scope ?? value?.scope;
    const ownerId = Number(value?.ownerId);
    if ((scope !== "account" && scope !== "character") || !Number.isSafeInteger(ownerId)) return undefined;
    try {
        return core.sessions.all()
            .filter((session) => (scope === "account" ? session.account?.id : session.character?.id) === ownerId)
            .map((session) => Number(session.playerId));
    } catch (_) { return undefined; }
}

// Group answers are kept between refreshes; a group change, a character and a session are what change them. Every
// character load changes groups (hmp-houses and hmp-jobs project them), so a change refreshes only whom it is about.
// Duty is no group: a predicate that reads it is asked again at every refresh.
Events.on("hmp:groups:changed", (change: unknown) => {
    const ids = groupChangePlayers(change);
    if (!ids) { blips.forgetGroups(); blips.schedule({ markers: true, views: true }); return; }
    for (const id of ids) { blips.forgetGroups(id); blips.schedule({ markers: id, views: true }); }
});
Events.on("hmp:jobs:duty", () => blips.schedule({ markers: true, views: true }));
for (const name of ["hmp:character:selected", "hmp:character:unloaded", "hmp:session:ready", "hmp:session:ended"]) Events.on(name, (payload: unknown) => {
    const id = sessionPlayerId(payload);
    if (id === undefined) return;
    blips.forgetGroups(id);
    blips.schedule({ markers: id, views: true });
});
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-blips") blips.stop();
    else safe(blips.cleanup(name), `Could not clean up blips owned by '${name}'`);
});

if (config.enableCommands) {
    const commands = Hmp.command.createRouter({ prefix: "[blips]", logger });
    commands.register(config.command, {
        usage: `/${config.command} <status|list|marker [ttl]|circle [radius] [ttl]|pulse|remove|waypoint>`,
        description: "Inspect and privately test Foundations markers.",
    }, async ({ player, args, reply, usage }) => {
        const action = String(args.shift() || "status").toLowerCase();
        if (action === "status") {
            const status = blips.status();
            reply(`${status.markers} marker(s), ${status.playerGroups} player group(s), ${status.expiringMarkers} expiring; show-all=${status.showAllPlayers}`);
            return;
        }
        if (action === "list") {
            const rows = blips.markers.list().slice(0, 30);
            reply(rows.map((row) => `${row.resource}:${row.id}(${row.kind})`).join(", ") || "No live markers.");
            return;
        }
        const current = typeof player.location === "function" ? player.location() : null;
        if (action === "marker" || action === "circle") {
            const circle = action === "circle";
            const radius = circle ? Number(args[0] ?? 80) : undefined;
            const ttl = Number(args[circle ? 1 : 0] ?? 120);
            const result = await blips.markers.upsert({
                resource: "hmp-blips",
                id: `test-${action}-${player.id}`,
                kind: action,
                position: player.position,
                radius,
                label: "Foundations test",
                icon: circle ? "" : "UI_T_MiniMap_Waypoint",
                ttl,
                audience: [player],
                areaId: current?.areaId,
                regionId: current?.regionId,
                virtualWorld: Number(player.virtualWorld || 0),
            });
            reply(`Showing private ${action} '${result.id}' for ${result.ttl}s.`);
            return;
        }
        if (action === "pulse") {
            reply(blips.markers.pulse(`test-circle-${player.id}`, "hmp-blips") ? "Pulsed your test circle." : "Create a test circle first.");
            return;
        }
        if (action === "remove") {
            const removed = Number(blips.markers.remove(`test-marker-${player.id}`, "hmp-blips")) + Number(blips.markers.remove(`test-circle-${player.id}`, "hmp-blips"));
            reply(`Removed ${removed} test marker(s).`);
            return;
        }
        if (action === "waypoint") {
            const waypoint = blips.waypoints.get(player);
            reply(waypoint
                ? `Your waypoint: ${Math.round(waypoint.x)}, ${Math.round(waypoint.y)}, ${Math.round(waypoint.z)}${waypoint.target ? ` on ${waypoint.target}` : ""}${waypoint.areaId ? ` in ${waypoint.areaId}` : ""}.`
                : "No waypoint reported. Place one on the map (it needs a host with Blips.waypoint).");
            return;
        }
        reply(usage);
    });
    Events.on("chatCommand", commands.handle);
}

logger.info(`Blip registry ready; show-all players=${config.showAllPlayers}`);

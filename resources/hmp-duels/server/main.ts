import serviceModule = require("./service");
import rankingModule = require("./ranking");
import ratingModule = require("./rating");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import type { HmpMySQL } from "../../hmp-mysql/types";
import type { HmpActivities } from "../../hmp-activities/types";
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpPvp } from "../../hmp-pvp/types";
import type { HmpUiServer } from "../../hmp-ui/types";
import type { HmpDuelMatchRecord, HmpDuelPlayer, HmpDuelRatedEvent, HmpDuelStanding } from "../types";
import type { RecordedDuel } from "./internal";

const { createDuelService } = serviceModule;
const { createRanking } = rankingModule;
const { rankingConfig } = ratingModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const Hmp = Imports.get<HmpLibServer<HmpDuelPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpDuelPlayer>>("hmp-core");
const activities = Imports.get<HmpActivities<HmpDuelPlayer>>("hmp-activities");
const pvp = Imports.get<HmpPvp>("hmp-pvp");
const ui = Imports.get<HmpUiServer<HmpDuelPlayer>>("hmp-ui");
const logger = Hmp.logger.create("hmp-duels");
const loaded = Hmp.config.load<{ command: string; enableCommands: boolean; countdownSeconds: number; invitationTtlSeconds: number; koHp: number; cosmeticGear: boolean; dodge: boolean; ranking?: unknown } & Record<string, unknown>>(process.env.HMP_DUELS_CONFIG || "data/hmp-duels.json", { defaults: { command: "duel", enableCommands: true, countdownSeconds: 3, invitationTtlSeconds: 30, koHp: 1, cosmeticGear: false, dodge: true } });
const command = String(loaded.command || "duel").trim().toLowerCase();
const countdownSeconds = Math.max(1, Math.min(10, Math.floor(Number(loaded.countdownSeconds) || 3)));
const invitationTtlSeconds = Math.max(10, Math.min(300, Math.floor(Number(loaded.invitationTtlSeconds) || 30)));
const koHp = Math.max(1, Math.min(100, Number(loaded.koHp) || 1));
const ranking = createRanking({ repository: createRepository(Imports.get<HmpMySQL>("hmp-mysql")), migrations, config: rankingConfig(loaded.ranking) });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const signed = (value: number): string => value >= 0 ? `+${value}` : String(value);

function announceRating(recorded: RecordedDuel, winnerPlayerId: number, loserPlayerId: number): void {
    const { match } = recorded;
    const payload: HmpDuelRatedEvent = { match, winnerPlayerId, loserPlayerId, unrated: recorded.unrated };
    Events.emit("hmp:duels:rated", payload);
    for (const [playerId, change] of [[winnerPlayerId, match.winner], [loserPlayerId, match.loser]] as const) {
        const player = PlayerManager.getById(playerId);
        if (!player) continue;
        const note = change
            ? `Duel rating ${change.after} (${signed(change.delta)})`
            : recorded.unrated === "repeat" ? "Unrated: you have dueled this opponent often lately" : "Unrated duel";
        player.emit("hmp-duels:rated", JSON.stringify({ rated: match.rated, rating: change?.after ?? null, delta: change?.delta ?? 0, note }));
    }
}

const duels = createDuelService({
    activities, pvp, countdownSeconds, invitationTtlSeconds, koHp,
    player: (id) => PlayerManager.getById(id),
    pair: (a, b, options) => Pvp.setPair(a, b, options),
    setRecovery: (id, on) => { try { PlayerManager.getById(id)?.setHealthRecovery?.(on); } catch (_) { /* left mid-duel */ } },
    // An older host's rules have no kneelSeconds, and its kneel always ends by itself.
    kneelHeld: () => Pvp.getRules().kneelSeconds === 0,
    endKneel: (id) => { try { PlayerManager.getById(id)?.endKneel?.(); } catch (_) { /* left while kneeling */ } },
    cosmeticGear: loaded.cosmeticGear === true,
    // An older host has no gear rules, and worn gear counts as it always has.
    gearRules: (id) => {
        const player = PlayerManager.getById(id);
        if (typeof player?.setGearStatMultiplier !== "function" || typeof player.setGearTraits !== "function") return null;
        return { multiplier: Number(player.gearStatMultiplier ?? 1), traits: player.gearTraits !== false };
    },
    setGearRules: (id, rules) => {
        const player = PlayerManager.getById(id);
        try { player?.setGearStatMultiplier?.(rules.multiplier); player?.setGearTraits?.(rules.traits); }
        catch (_) { /* left mid-duel */ }
    },
    // Each duelist's client holds its own dodge, through LocalPlayer.setDodgeEnabled.
    dodge: loaded.dodge !== false,
    emit: (player, event, payload) => player.emit(event, JSON.stringify(payload)),
    notify: (player, message, tone = "inform") => { ui.notify(player, { title: "Wizard's duel", description: message, tone }); },
    warn: (message) => logger.warn(message),
    // A duel without both characters is fought as before and left unrated.
    character: (id) => {
        try { const character = core.characters?.active(id); return character ? { id: character.id, name: character.name } : null; }
        catch (_) { return null; }
    },
    finished: (draft) => {
        ranking.record(draft).then((recorded) => { if (recorded) announceRating(recorded, draft.winner.playerId, draft.loser.playerId); })
            .catch((error) => logger.warn(`Could not rate duel '${draft.reference}': ${messageOf(error)}`));
    },
});

for (const name of ["challenge", "accept", "decline", "cancel", "forfeit", "status"] as const) Exports.register(name, duels[name]);
Exports.register("ranking", Object.freeze({
    standing: ranking.standing, leaderboard: ranking.leaderboard, history: ranking.history, status: ranking.status, config: ranking.config,
}));

function describeStanding(standing: HmpDuelStanding | null, fallbackName: string): string {
    if (!standing || !standing.matches) return `${fallbackName} has no rated duels yet`;
    const streak = standing.streak > 1 ? `, ${standing.streak} wins in a row` : standing.streak < -1 ? `, ${-standing.streak} losses in a row` : "";
    const rank = standing.rank ? `#${standing.rank}` : "unranked";
    return `${standing.name}: ${rank}, rating ${standing.rating}, ${standing.wins}W ${standing.losses}L${streak} (best streak ${standing.bestStreak})`;
}

function describeMatch(match: HmpDuelMatchRecord, characterId: number): string {
    const won = match.winnerCharacterId === characterId;
    const opponent = (won ? match.loserName : match.winnerName) || "a deleted character";
    const change = won ? match.winner : match.loser;
    return `${won ? "W" : "L"} vs ${opponent} (${match.reason})${change ? ` ${signed(change.delta)} → ${change.after}` : " unrated"}`;
}

async function rankCommand(player: HmpDuelPlayer, action: string, args: string[], reply: (message: string) => void): Promise<void> {
    if (action === "top") {
        const board = await ranking.leaderboard();
        if (!board.length) { reply("nobody has a rated duel yet"); return; }
        reply(`top ${board.length} duelists:`);
        for (const entry of board) reply(`#${entry.rank} ${entry.name} ${entry.rating} (${entry.wins}W ${entry.losses}L)`);
        return;
    }
    const target = args.length > 1 ? Hmp.player.find(args.slice(1).join(" "), player) : player;
    if (!target) { reply(`Usage: /${command} ${action} [#playerId|nickname]`); return; }
    const character = core.characters.active(target);
    if (!character) { reply(`${target.nickname} has no character loaded`); return; }
    if (action === "rank") { reply(describeStanding(await ranking.standing(character.id), character.name)); return; }
    const matches = await ranking.history(character.id, 5);
    if (!matches.length) { reply(`${character.name} has no recorded duels`); return; }
    reply(`${character.name}'s last ${matches.length} duels:`);
    for (const match of matches) reply(describeMatch(match, character.id));
}

async function promptChallenge(target: HmpDuelPlayer, challenger: HmpDuelPlayer): Promise<void> {
    const answer = await ui.alert(target, {
        title: "Wizard's duel",
        content: `${challenger.nickname} challenges you to a non-lethal duel. The loser kneels; nobody dies.`,
        confirmLabel: "Accept", cancelLabel: "Decline", cancel: true, timeoutMs: invitationTtlSeconds * 1000,
    });
    if (answer === "confirm") {
        if (await duels.accept(target)) ui.notify(target, { title: "Wizard's duel", description: "Challenge accepted.", tone: "success" });
    } else await duels.decline(target, answer === null ? "challenge expired" : "challenge declined");
}

if (loaded.enableCommands !== false) Events.on("chatCommand", (player: HmpDuelPlayer, _message: unknown, rawCommand: unknown, rawArgs: unknown) => {
    if (String(rawCommand || "").toLowerCase() !== command) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[duels] ${message}`);
    void (async () => {
        const action = String(args[0] || "").toLowerCase();
        if (action === "accept") { ui.close(player, "challenge answered"); reply(await duels.accept(player) ? "challenge accepted" : "no pending challenge"); return; }
        if (action === "decline") { ui.close(player, "challenge answered"); reply(await duels.decline(player) ? "challenge declined" : "no pending challenge"); return; }
        if (action === "cancel") { reply(await duels.cancel(player) ? "challenge withdrawn" : "no outgoing challenge"); return; }
        if (action === "forfeit") { reply(await duels.forfeit(player) ? "duel forfeited" : "you are not in a duel"); return; }
        if (action === "status") { const status = duels.status(); reply(`${status.pending} pending, ${status.countdowns} countdown, ${status.live} live`); return; }
        if (action === "rank" || action === "top" || action === "history") { await rankCommand(player, action, args, reply); return; }
        const target = action ? Hmp.player.find(args.join(" "), player) : null;
        if (!target || target.id === player.id) { reply(`Usage: /${command} <#playerId|nickname> | accept | decline | cancel | forfeit | status | rank [player] | top | history [player]`); return; }
        const challenge = await duels.challenge(player, target);
        reply(`challenge sent to ${target.nickname}; expires ${new Date(challenge.expiresAt).toLocaleTimeString()}`);
        void promptChallenge(target, player).catch((error) => logger.warn(`Challenge prompt failed: ${error instanceof Error ? error.message : String(error)}`));
    })().catch((error) => reply(error instanceof Error ? error.message : String(error)));
});

Events.on("hmp:activities:invitation:expired", (payload: unknown) => { void duels.expired(payload); });
Events.on("pvpDefeat", (victim: HmpDuelPlayer, killer: HmpDuelPlayer) => { void duels.defeated(victim, killer); });
Events.on("playerDied", (player: HmpDuelPlayer) => { void duels.died(player); });
Events.on("playerDisconnect", (player: HmpDuelPlayer) => { void duels.disconnected(player); });
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-duels") void duels.stop(); });
Events.on("resourceStart", (name?: string) => {
    if (name && name !== "hmp-duels") return;
    ranking.start().then(() => { if (ranking.status().state === "ready") logger.info("Duel ranking ready"); })
        .catch((error) => logger.error(`Duel ranking unavailable: ${messageOf(error)}`));
});
logger.info("Consensual non-lethal duel service ready");

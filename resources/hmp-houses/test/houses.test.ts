import assert = require("node:assert");
import configModule = require("../server/config");
import normalizeModule = require("../shared/normalize");
import repositoryModule = require("../server/repository");
import serviceModule = require("../server/service");
import type { HmpHouseId, HmpHouseMembership, HmpHouseMembershipAudit, HmpHousePointTransaction, HmpHouseStanding } from "../types";
import type { HousesRepository, Player, PointDraft } from "../server/internal";

const { house, nativeHouse } = normalizeModule;
const { mapStanding, mapPoint } = repositoryModule;
const { createHousesService, leader, COMMON_ROOMS_KEY } = serviceModule;
const { loadConfig } = configModule;

function now(): Date { return new Date("2026-08-28T12:00:00Z"); }

async function run(): Promise<void> {
    assert.strictEqual(house("GRYFFINDOR"), "gryffindor");
    assert.strictEqual(nativeHouse("hufflepuff"), "Hufflepuff");
    assert.strictEqual(nativeHouse(null), "Unaffiliated");
    assert.throws(() => house("durmstrang"), /must be one of/);
    assert.deepStrictEqual(mapStanding({ house_id: "ravenclaw", points: "25", updated_at: now() }), { house: "ravenclaw", points: 25, updatedAt: now() });
    assert.strictEqual(mapPoint({ id: "1", reference_id: "test:1", house_id: "slytherin", amount: "-5", balance_after: "10", actor_character_id: null, source_resource: "test", reason_text: "dock", metadata_json: "{\"round\":1}", status: "completed", error_text: "", created_at: now(), completed_at: now() }).amount, -5);

    const configFrom = (file: Record<string, unknown>) => loadConfig({
        config: { load: (_path: string, options: { defaults: object }) => ({ ...options.defaults, ...file }), env: { boolean: (_value: unknown, fallback: boolean) => fallback } },
    } as never, { env: {} });
    assert.deepStrictEqual(configFrom({}).commonRoomGroups, [], "nobody gets another house's common room by default");
    assert.strictEqual(configFrom({}).greatHallBanners, "game", "the Great Hall's banners are left to the game by default");
    assert.deepStrictEqual(configFrom({ commonRoomGroups: [{ key: "Staff" }, { key: "prefect", minimumGrade: 2 }] }).commonRoomGroups, [{ key: "staff", minimumGrade: 0 }, { key: "prefect", minimumGrade: 2 }]);
    assert.throws(() => configFrom({ commonRoomGroups: "staff" }), /commonRoomGroups must be an array/);
    assert.strictEqual(configFrom({ greatHallBanners: "Leader" }).greatHallBanners, "leader");
    assert.strictEqual(configFrom({ greatHallBanners: "RAVENCLAW" }).greatHallBanners, "ravenclaw");
    assert.strictEqual(configFrom({ greatHallBanners: "none" }).greatHallBanners, "none");
    assert.throws(() => configFrom({ greatHallBanners: "durmstrang" }), /greatHallBanners must be game, none, leader/);

    const standing = (house: HmpHouseId, points: number): HmpHouseStanding => ({ house, points, updatedAt: now() });
    assert.strictEqual(leader([standing("gryffindor", 10), standing("slytherin", 5), standing("ravenclaw", 0), standing("hufflepuff", 0)]), "gryffindor");
    assert.strictEqual(leader([standing("gryffindor", 10), standing("slytherin", 10), standing("ravenclaw", 0), standing("hufflepuff", 0)]), null, "a tie keeps the banners hanging");
    assert.strictEqual(leader([standing("gryffindor", 0), standing("slytherin", 0), standing("ravenclaw", 0), standing("hufflepuff", 0)]), null, "no points is a tie");
    assert.strictEqual(leader([standing("gryffindor", -5), standing("slytherin", -9)]), "gryffindor");
    assert.strictEqual(leader([]), null);

    const memberships = new Map<number, HmpHouseMembership>();
    const membershipAudit: HmpHouseMembershipAudit[] = [];
    const standings = new Map<HmpHouseId, number>([["gryffindor", 0], ["hufflepuff", 0], ["ravenclaw", 0], ["slytherin", 0]]);
    const transactions = new Map<string, HmpHousePointTransaction>();
    let transactionId = 0;
    const repository: HousesRepository = {
        migrate: async () => undefined,
        membership: async (characterId) => memberships.get(characterId) || null,
        setMembership: async (mutation) => {
            const existing = memberships.get(mutation.characterId);
            if (existing?.house === mutation.house) return { membership: existing, previousHouse: existing.house };
            const value: HmpHouseMembership = { characterId: mutation.characterId, characterName: "Tester", house: mutation.house, assignedByCharacterId: mutation.actorCharacterId, resource: mutation.resource, reason: mutation.reason, createdAt: existing?.createdAt || now(), updatedAt: now() };
            memberships.set(mutation.characterId, value);
            membershipAudit.push({ id: membershipAudit.length + 1, characterId: mutation.characterId, fromHouse: existing?.house || null, toHouse: mutation.house, actorCharacterId: mutation.actorCharacterId, resource: mutation.resource, reason: mutation.reason, createdAt: now() });
            return { membership: value, previousHouse: existing?.house || null };
        },
        clearMembership: async (characterId, actorCharacterId, resource, reason) => {
            const existing = memberships.get(characterId);
            if (!existing) return null;
            memberships.delete(characterId);
            membershipAudit.push({ id: membershipAudit.length + 1, characterId, fromHouse: existing.house, toHouse: null, actorCharacterId, resource, reason, createdAt: now() });
            return existing.house;
        },
        members: async (house, count) => [...memberships.values()].filter((entry) => entry.house === house).slice(0, count),
        membershipHistory: async (characterId, count) => membershipAudit.filter((entry) => entry.characterId === characterId).slice(-count).reverse(),
        standing: async (house) => ({ house, points: standings.get(house)!, updatedAt: now() }),
        standings: async () => [...standings].map(([house, points]) => ({ house, points, updatedAt: now() })),
        pointTransaction: async (reference) => transactions.get(reference) || null,
        beginPoint: async (draft: PointDraft) => {
            const existing = transactions.get(draft.reference);
            if (existing) return { created: false, transaction: existing };
            const transaction: HmpHousePointTransaction = { id: ++transactionId, reference: draft.reference, house: draft.house, amount: draft.amount, balanceAfter: null, actorCharacterId: draft.actorCharacterId, resource: draft.resource, reason: draft.reason, metadata: draft.metadata, status: "pending", error: "", createdAt: now(), completedAt: null };
            transactions.set(draft.reference, transaction);
            return { created: true, transaction };
        },
        applyPoint: async (reference, allowNegative) => {
            const existing = transactions.get(reference)!;
            if (existing.status === "completed") return existing;
            const balance = standings.get(existing.house)! + existing.amount;
            if (!allowNegative && balance < 0) throw new Error("negative");
            standings.set(existing.house, balance);
            const completed = { ...existing, status: "completed" as const, balanceAfter: balance, completedAt: now() };
            transactions.set(reference, completed);
            return completed;
        },
        failPoint: async (reference, error) => {
            const existing = transactions.get(reference)!;
            const failed = { ...existing, status: "failed" as const, error, completedAt: now() };
            transactions.set(reference, failed);
            return failed;
        },
        pointHistory: async (house, count) => [...transactions.values()].filter((entry) => !house || entry.house === house).slice(-count).reverse(),
        pendingPoints: async (count) => [...transactions.values()].filter((entry) => entry.status === "pending").slice(0, count),
    };

    const player = { id: 7, nickname: "Tester", house: "Unaffiliated" as const, commonRooms: [] as NonNullable<Player["commonRooms"]> } as Player;
    const character = { id: 42, accountId: 1, slot: 1, name: "Tester", status: "active", createdAt: now(), updatedAt: now(), deletedAt: null };
    const groups = new Map<string, { scope: "character"; key: string; grade: number; metadata: Record<string, unknown> }>();
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const characterMetadata = new Map<string, unknown>();
    let effectiveGroups: Array<{ scope: "account"; key: string; grade: number; metadata: Record<string, unknown> }> = [];
    let effectiveReads = 0;
    const core = {
        characters: { active: () => character },
        sessions: { all: () => [{ player, playerId: 7, account: {}, principal: {}, character, connectedAt: "" }] },
        metadata: {
            getCharacter: async (_id: number, key: string) => characterMetadata.get(key),
            setCharacter: async (_id: number, key: string, value: unknown) => { characterMetadata.set(key, value); return value; },
        },
        groups: {
            effective: async () => { effectiveReads++; return effectiveGroups; },
            listCharacter: async () => [...groups.values()],
            setCharacter: async (_id: number, key: string, grade: number, metadata: Record<string, unknown>) => { const value = { scope: "character" as const, key, grade, metadata }; groups.set(key, value); return value; },
            removeCharacter: async (_id: number, key: string) => groups.delete(key),
        },
    };
    const baseConfig = { enableCommands: true, houseCommand: "house", pointsCommand: "points", adminGroups: [], groupPrefix: "house:", allowNegativePoints: true, commonRoomGroups: [], greatHallBanners: "game" as const };
    const service = createHousesService({
        repository, core: core as never, events: { emit: (name, payload) => { emitted.push({ name, payload }); } },
        logger: { info: () => true, warn: () => true, error: () => true },
        config: baseConfig,
        migrations: [], now: () => now().getTime(),
    });
    await service.start();
    await service.membership.set(player, "gryffindor", { resource: "hmp-sorting", actor: player, reason: "sorted" });
    assert.strictEqual(player.house, "Gryffindor");
    assert.ok(groups.has("house:gryffindor"));
    await service.membership.set(player, "slytherin", { resource: "hmp-admin", actor: player });
    assert.strictEqual(groups.has("house:gryffindor"), false);
    assert.ok(groups.has("house:slytherin"));
    assert.strictEqual((await service.membership.history(42)).length, 2);
    assert.strictEqual(await service.membership.clear(player, { resource: "hmp-admin", actor: player }), true);
    assert.strictEqual(player.house, "Unaffiliated");
    assert.strictEqual(groups.size, 0);

    const options = { reference: "quidditch:match-1:winner", resource: "hmp-quidditch", actor: player, metadata: { matchId: 1 } };
    const awarded = await service.points.award("gryffindor", 50, options);
    assert.strictEqual(awarded.balanceAfter, 50);
    assert.strictEqual((await service.points.award("gryffindor", 50, options)).balanceAfter, 50);
    await service.points.deduct("gryffindor", 10, { ...options, reference: "duels:penalty-1", resource: "hmp-duels" });
    assert.strictEqual((await service.points.get("gryffindor")).points, 40);
    await assert.rejects(() => service.points.award("slytherin", 50, options), /reused for a different operation/);
    assert.strictEqual(emitted.filter((event) => event.name === "hmp:houses:points").length, 2);
    assert.strictEqual(emitted.filter((event) => event.name === "hmp:houses:changed").length, 3);
    assert.strictEqual(service.status().state, "ready");

    // Common-room grants live on the character and reach the online player at once, by player or character id.
    assert.deepStrictEqual(await service.commonRooms.list(player), []);
    assert.strictEqual(await service.commonRooms.grant(player, "ravenclaw"), true);
    assert.deepStrictEqual(player.commonRooms, ["Ravenclaw"]);
    assert.strictEqual(await service.commonRooms.grant(player, "ravenclaw"), false);
    assert.strictEqual(await service.commonRooms.grant(42, "SLYTHERIN" as HmpHouseId), true);
    assert.deepStrictEqual(player.commonRooms, ["Ravenclaw", "Slytherin"]);
    assert.deepStrictEqual(characterMetadata.get(COMMON_ROOMS_KEY), ["ravenclaw", "slytherin"]);
    await assert.rejects(() => service.commonRooms.grant(player, "durmstrang" as HmpHouseId), /must be one of/);
    assert.strictEqual(await service.commonRooms.revoke(player, "ravenclaw"), true);
    assert.strictEqual(await service.commonRooms.revoke(player, "ravenclaw"), false);
    assert.deepStrictEqual(player.commonRooms, ["Slytherin"]);
    assert.strictEqual(await service.commonRooms.clear(player), 1);
    assert.deepStrictEqual(player.commonRooms, []);
    assert.strictEqual(effectiveReads, 0, "without commonRoomGroups no group is read");
    // A character load re-applies what the character was granted.
    characterMetadata.set(COMMON_ROOMS_KEY, ["hufflepuff", "durmstrang"]);
    await service.characterLoaded(player);
    assert.deepStrictEqual(player.commonRooms, ["Hufflepuff"]);
    characterMetadata.delete(COMMON_ROOMS_KEY);
    await service.stop();
    assert.deepStrictEqual(player.commonRooms, [], "stopping takes the access back");

    // commonRoomGroups open every common room and follow group changes.
    const warnings: string[] = [];
    const logger = { info: () => true, warn: (message: unknown) => { warnings.push(String(message)); return true; }, error: () => true };
    const staffed = createHousesService({
        repository, core: core as never, events: { emit: () => undefined }, logger,
        config: { ...baseConfig, commonRoomGroups: [{ key: "staff", minimumGrade: 1 }] }, migrations: [],
    });
    effectiveGroups = [{ scope: "account", key: "staff", grade: 0, metadata: {} }];
    assert.deepStrictEqual(await staffed.commonRooms.sync(player), []);
    effectiveGroups = [{ scope: "account", key: "Staff", grade: 1, metadata: {} }];
    const reads = effectiveReads;
    await staffed.groupsChanged({ action: "set", ownerId: 1, group: { key: "house:gryffindor" } });
    assert.strictEqual(effectiveReads, reads, "a change to another group re-syncs nobody");
    await staffed.groupsChanged({ action: "set", ownerId: 1, group: { key: "staff" } });
    assert.deepStrictEqual(player.commonRooms, ["Gryffindor", "Hufflepuff", "Ravenclaw", "Slytherin"]);
    effectiveGroups = [];
    await staffed.groupsChanged({ action: "remove", scope: "account", ownerId: 1, key: "staff" });
    assert.deepStrictEqual(player.commonRooms, []);
    effectiveGroups = [{ scope: "account", key: "staff", grade: 1, metadata: {} }];
    await staffed.characterLoaded(player);
    assert.strictEqual(player.commonRooms?.length, 4);
    await staffed.stop();
    assert.deepStrictEqual(player.commonRooms, []);

    // An older host has no player.commonRooms: access does nothing, and warns once only when someone would get some.
    const olderPlayer = { id: 8, nickname: "Older", house: "Unaffiliated" as const } as Player;
    const older = createHousesService({
        repository, core: { ...core, sessions: { all: () => [{ player: olderPlayer, playerId: 8, account: {}, principal: {}, character, connectedAt: "" }] } } as never,
        events: { emit: () => undefined }, logger, config: { ...baseConfig, commonRoomGroups: [{ key: "staff", minimumGrade: 1 }] }, migrations: [],
    });
    effectiveGroups = [];
    assert.strictEqual(await older.commonRooms.sync(olderPlayer), null);
    assert.deepStrictEqual(warnings, []);
    effectiveGroups = [{ scope: "account", key: "staff", grade: 1, metadata: {} }];
    await older.characterLoaded(olderPlayer);
    await older.groupsChanged({ action: "set", ownerId: 1, group: { key: "staff" } });
    assert.strictEqual(olderPlayer.commonRooms, undefined);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /needs a HogwartsMP host with player.commonRooms/);
    await older.stop();

    // A fixed house hangs at start and "game" comes back at stop; "game" itself never touches the host.
    const hung: string[] = [];
    const world = { setGreatHallBanners: (banners: string) => { hung.push(banners); return true; } };
    const fixed = createHousesService({ repository, core: core as never, events: { emit: () => undefined }, logger, config: { ...baseConfig, greatHallBanners: "slytherin" }, migrations: [], world });
    await fixed.start();
    await fixed.stop();
    assert.deepStrictEqual(hung, ["Slytherin", "game"]);
    hung.length = 0;
    const untouched = createHousesService({ repository, core: core as never, events: { emit: () => undefined }, logger, config: baseConfig, migrations: [], world });
    await untouched.start();
    await untouched.stop();
    assert.deepStrictEqual(hung, []);

    // "leader" hangs the House Cup leader's, follows points, and keeps the banners on a tie.
    const leading = createHousesService({ repository, core: core as never, events: { emit: () => undefined }, logger, config: { ...baseConfig, greatHallBanners: "leader" }, migrations: [], world });
    await leading.start();
    assert.deepStrictEqual(hung, ["Gryffindor"], "Gryffindor leads with 40");
    await leading.points.award("slytherin", 40, { reference: "banners:tie", resource: "test" });
    assert.deepStrictEqual(hung, ["Gryffindor"], "a tie keeps Gryffindor's banners");
    await leading.points.award("slytherin", 1, { reference: "banners:lead", resource: "test" });
    assert.deepStrictEqual(hung, ["Gryffindor", "Slytherin"]);
    await leading.points.award("slytherin", 1, { reference: "banners:extend", resource: "test" });
    assert.deepStrictEqual(hung, ["Gryffindor", "Slytherin"], "the same leader is not hung again");
    await leading.stop();
    assert.deepStrictEqual(hung, ["Gryffindor", "Slytherin", "game"]);

    // An older host has no World.setGreatHallBanners: the setting does nothing and warns once.
    warnings.length = 0;
    const bannerless = createHousesService({ repository, core: core as never, events: { emit: () => undefined }, logger, config: { ...baseConfig, greatHallBanners: "leader" }, migrations: [], world: {} });
    await bannerless.start();
    await bannerless.points.award("ravenclaw", 100, { reference: "banners:older", resource: "test" });
    await bannerless.stop();
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /greatHallBanners needs a HogwartsMP host with World.setGreatHallBanners/);
}

run().then(() => console.log("hmp-houses tests passed"));

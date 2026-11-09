import assert = require("node:assert");
import { test } from "node:test";
import coreModule = require("../server/core");
import repositoryModule = require("../server/repository");
import schemaModule = require("../server/schema");
import configModule = require("../server/config");
import ticketsModule = require("../server/tickets");
import type { HmpCoreAccount, HmpCoreCharacter, HmpCoreGroup, HmpCorePrincipal } from "../types";
import type { HmpMySQLMigration } from "../../hmp-mysql/types";
import type { CoreConfig, Database, Player, Repository, Scope } from "../server/internal";

const { createCore } = coreModule;
const { createRepository } = repositoryModule;
const { loadConfig } = configModule;
const { createTickets, hostAtLeast } = ticketsModule;
const { migrations } = schemaModule;

interface TestPlayer extends Player { mafiahubId?: string }
interface IdentityLink { accountId: number; trust: string }
interface OwnedGroup extends HmpCoreGroup { ownerId: number }
interface RecordedEvent { name: string; payload: unknown }

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function player(id: number, nickname: string, ids: Partial<TestPlayer> = {}): TestPlayer {
    return { id, nickname, position: { x: 0, y: 0, z: 0 }, emit() {}, teleport: () => 0, ...ids };
}

function memoryRepository() {
    let nextAccount = 1;
    let nextCharacter = 1;
    const accounts = new Map<number, HmpCoreAccount>();
    const identities = new Map<string, IdentityLink>();
    const characters = new Map<number, HmpCoreCharacter>();
    const groups: Record<Scope, Map<string, OwnedGroup>> = { account: new Map(), character: new Map() };
    const metadata: Record<Scope, Map<string, unknown>> = { account: new Map(), character: new Map() };
    const ownerKey = (ownerId: number, key: string) => `${ownerId}:${key}`;

    const repository: Repository = {
        async findIdentity(provider: string, subject: string) {
            const link = identities.get(`${provider}:${subject}`);
            const account = link ? accounts.get(link.accountId) : undefined;
            return link && account ? { account, principal: { provider, subject, trust: link.trust } } : null;
        },
        async findOrCreateAccount(principal: HmpCorePrincipal, displayName: string) {
            const found = await this.findIdentity(principal.provider, principal.subject);
            if (found) return found.account;
            const now = new Date().toISOString();
            const account = { id: nextAccount++, displayName, createdAt: now, lastSeenAt: now };
            accounts.set(account.id, account);
            identities.set(`${principal.provider}:${principal.subject}`, { accountId: account.id, trust: principal.trust });
            return account;
        },
        async linkIdentity(accountId: number, principal: HmpCorePrincipal) {
            const key = `${principal.provider}:${principal.subject}`;
            const found = identities.get(key);
            if (found && found.accountId !== accountId) {
                const error = Object.assign(new Error("identity conflict"), { code: "HMP_CORE_IDENTITY_CONFLICT" });
                throw error;
            }
            identities.set(key, { accountId, trust: principal.trust });
            return true;
        },
        async listIdentities(accountId: number) {
            return [...identities.entries()].filter(([, link]) => link.accountId === accountId).map(([key, link]) => {
                const [provider, subject] = key.split(":");
                return { provider, subject, trust: link.trust };
            });
        },
        async findAccountById(id: number) { return accounts.get(id) || null; },
        async touchAccount(id: number, displayName: string) {
            const account = accounts.get(id);
            if (account) account.displayName = displayName;
            return account ? 1 : 0;
        },
        async listCharacters(accountId: number) { return [...characters.values()].filter((item) => item.accountId === accountId && item.status === "active").sort((a, b) => a.slot - b.slot); },
        async findCharacterById(id: number) { return characters.get(id) || null; },
        async createCharacter(accountId: number, input: { name: string; slot: number }) {
            const now = new Date().toISOString();
            const character = { id: nextCharacter++, accountId, slot: input.slot, name: input.name, status: "active", createdAt: now, updatedAt: now, deletedAt: null };
            characters.set(character.id, character);
            return character;
        },
        async deleteCharacter(id: number) {
            const character = characters.get(id);
            if (!character || character.status !== "active") return false;
            character.status = "deleted";
            character.deletedAt = new Date().toISOString();
            return true;
        },
        async listAccountGroups(id: number) { return [...groups.account.values()].filter((group) => group.ownerId === id).map(({ ownerId: _, ...group }) => group); },
        async listCharacterGroups(id: number) { return [...groups.character.values()].filter((group) => group.ownerId === id).map(({ ownerId: _, ...group }) => group); },
        async setGroup(scope: Scope, ownerId: number, key: string, grade: number, details: Record<string, unknown>) {
            const group = { scope, key, grade, metadata: details, ownerId };
            groups[scope].set(ownerKey(ownerId, key), group);
            const { ownerId: _, ...result } = group;
            return result;
        },
        async removeGroup(scope: Scope, ownerId: number, key: string) { return groups[scope].delete(ownerKey(ownerId, key)); },
        async getMetadata(scope: Scope, ownerId: number, key: string) { return metadata[scope].get(ownerKey(ownerId, key)); },
        async setMetadata<T>(scope: Scope, ownerId: number, key: string, value: T) { metadata[scope].set(ownerKey(ownerId, key), value); return value; },
        async deleteMetadata(scope: Scope, ownerId: number, key: string) { return metadata[scope].delete(ownerKey(ownerId, key)); },
    };
    return repository;
}

function setup(overrides: Partial<CoreConfig> = {}, onEmit?: (name: string) => Promise<void> | undefined) {
    const emitted: RecordedEvent[] = [];
    const warnings: string[] = [];
    const migrated: Array<{ resource: string; list: HmpMySQLMigration[] }> = [];
    const repository = memoryRepository();
    const database = {
        ready: async () => true,
        migrate: async (resource: string, list: HmpMySQLMigration[]) => { migrated.push({ resource, list }); },
    } as unknown as Database;
    const core = createCore({
        repository,
        database,
        migrations,
        events: { emit: (name: string, payload: unknown) => { emitted.push({ name, payload }); return onEmit?.(name); } },
        listPlayers: () => [],
        logger: { error: () => true, warn: (message: unknown) => warnings.push(String(message)) > 0 },
        config: {
            maxCharacters: 2,
            autoSelectSingleCharacter: false,
            duplicateSession: "reject-new",
            duplicateSessionGroup: "admin",
            duplicateSessionMinimumGrade: 1,
            kickDuplicateSession: false,
            identityOrder: ["steamId", "discordId", "hardwareId"],
            ...overrides,
        },
    });
    return { core, repository, emitted, migrated, warnings };
}

test("starts with the resource-owned schema and creates an asserted account session", async () => {
    const { core, emitted, migrated } = setup();
    await core.start();
    assert.strictEqual(core.status().state, "ready");
    assert.strictEqual(migrated[0].resource, "hmp-core");
    assert.strictEqual(migrated[0].list, migrations);

    const connectedPlayer = player(7, "Poppy", { steamId: "76561198000000001" });
    const session = await core.connect(connectedPlayer);
    assert.ok(session);
    assert.strictEqual(session.account.id, 1);
    assert.deepStrictEqual(session.principal, { provider: "client-steam", subject: connectedPlayer.steamId, trust: "asserted" });
    assert.strictEqual(core.accounts.getByPlayer(connectedPlayer), session.account);
    assert.strictEqual(core.sessions.isReady(7), true);
    assert.strictEqual(core.characters.limit(), 2);
    assert.ok(emitted.some((event) => event.name === "hmp:session:ready"));
});

test("keeps the account when a later session announces fewer client identifiers", async () => {
    const { core } = setup();
    await core.start();
    const full = player(1, "Poppy", { steamId: "100", discordId: "200", hardwareId: "300" });
    const account = (await core.connect(full))?.account;
    assert.ok(account);
    const character = await core.characters.create(full, { name: "Poppy Sweeting" });
    await core.disconnect(full);

    for (const ids of [{ hardwareId: "300" }, { discordId: "200" }, { discordId: "200", hardwareId: "300" }]) {
        const partial = player(2, "Player", ids);
        assert.strictEqual((await core.connect(partial))?.account.id, account.id, `matched by ${Object.keys(ids).join("+")}`);
        assert.deepStrictEqual((await core.characters.list(partial)).map((item) => item.id), [character.id]);
        await core.disconnect(partial);
    }
});

test("adopts an account first created from a lower-ranked identifier", async () => {
    const { core, warnings } = setup();
    await core.start();
    const hardwareOnly = player(1, "Player", { hardwareId: "300" });
    const account = (await core.connect(hardwareOnly))?.account;
    assert.ok(account);
    await core.disconnect(hardwareOnly);

    const withSteam = player(2, "Poppy", { steamId: "100", hardwareId: "300" });
    const session = await core.connect(withSteam);
    assert.strictEqual(session?.account.id, account.id);
    assert.deepStrictEqual(session.principal, { provider: "client-steam", subject: "100", trust: "asserted" });
    await core.disconnect(withSteam);

    const steamOnly = player(3, "Poppy", { steamId: "100" });
    assert.strictEqual((await core.connect(steamOnly))?.account.id, account.id);
    assert.deepStrictEqual(warnings, []);
});

test("keeps players who share a machine on separate accounts", async () => {
    const { core, warnings } = setup();
    await core.start();
    const first = player(1, "First", { steamId: "100", hardwareId: "300" });
    const firstAccount = (await core.connect(first))?.account;
    assert.ok(firstAccount);
    await core.disconnect(first);

    const sibling = player(2, "Sibling", { steamId: "101", hardwareId: "300" });
    const siblingAccount = (await core.connect(sibling))?.account;
    assert.ok(siblingAccount);
    assert.notStrictEqual(siblingAccount.id, firstAccount.id);
    assert.deepStrictEqual(warnings, [`[hmp-core] Account ${siblingAccount.id} shares a client-hardware ID with account ${firstAccount.id}; the accounts were not merged`]);
    await core.disconnect(sibling);

    const back = player(3, "First", { steamId: "100", hardwareId: "300" });
    assert.strictEqual((await core.connect(back))?.account.id, firstAccount.id);
});

test("manages character slots, scoped groups and JSON metadata", async () => {
    const { core, emitted } = setup();
    await core.start();
    const connectedPlayer = player(7, "Poppy", { discordId: "123456789" });
    const session = await core.connect(connectedPlayer);
    assert.ok(session);
    const first = await core.characters.create(connectedPlayer, { name: "  Poppy   Sweeting " });
    const second = await core.characters.create(connectedPlayer, { name: "Natsai Onai", slot: 2 });
    assert.deepStrictEqual([first.slot, first.name, second.slot], [1, "Poppy Sweeting", 2]);
    await assert.rejects(() => core.characters.create(connectedPlayer, { name: "Third Character" }), (error) => hasCode(error, "HMP_CORE_CHARACTER_LIMIT"));

    await core.characters.select(connectedPlayer, first.id);
    assert.strictEqual(core.characters.active(connectedPlayer)?.id, first.id);
    await core.groups.setAccount(session.account.id, "staff", 1, { title: "helper" });
    await core.groups.setCharacter(first.id, "staff", 3, { title: "admin" });
    assert.strictEqual((await core.groups.effective(connectedPlayer))[0].grade, 3);
    assert.strictEqual(await core.groups.has(connectedPlayer, "STAFF", 2), true);

    await core.metadata.setCharacter(first.id, "appearance", { robe: "blue" });
    assert.deepStrictEqual(await core.metadata.getCharacter(first.id, "appearance"), { robe: "blue" });
    await assert.rejects(() => core.metadata.setAccount(session.account.id, "bad", undefined), (error) => hasCode(error, "HMP_CORE_INVALID_METADATA"));

    assert.strictEqual(await core.characters.delete(connectedPlayer, first.id), true);
    assert.strictEqual(core.characters.active(connectedPlayer), null);
    assert.deepStrictEqual((await core.characters.list(connectedPlayer)).map((item) => item.id), [second.id]);
    assert.ok(emitted.some((event) => event.name === "hmp:character:unloaded"));
});

test("prefers verified providers and rejects duplicate sessions and identity theft", async () => {
    const { core } = setup();
    core.identity.register({
        name: "mafiahub-auth",
        resource: "hmp-auth",
        priority: 100,
        trust: "verified",
        resolve: async (candidate) => {
            const mafiahubId = (candidate as TestPlayer).mafiahubId;
            return mafiahubId ? { provider: "mafiahub", subject: mafiahubId, trust: "verified" } : null;
        },
    });
    await core.start();
    const first = player(1, "One", { steamId: "100", mafiahubId: "mh-1" });
    const duplicate = player(2, "Two", { steamId: "200", mafiahubId: "mh-1" });
    const other = player(3, "Three", { steamId: "300", mafiahubId: "mh-3" });
    const firstSession = await core.connect(first);
    assert.ok(firstSession);
    assert.strictEqual(firstSession.principal.trust, "verified");
    await assert.rejects(() => core.connect(duplicate), (error) => hasCode(error, "HMP_CORE_DUPLICATE_SESSION"));
    const otherSession = await core.connect(other);
    assert.ok(otherSession);

    await core.accounts.linkIdentity(firstSession.account.id, { provider: "mafiahub-alias", subject: "shared", trust: "verified" });
    await assert.rejects(
        () => core.accounts.linkIdentity(otherSession.account.id, { provider: "mafiahub-alias", subject: "shared", trust: "verified" }),
        (error) => hasCode(error, "HMP_CORE_IDENTITY_CONFLICT"),
    );
    assert.strictEqual(await core.disconnect(first), true);
    assert.strictEqual(core.sessions.isReady(first), false);
});

test("raises every disconnect teardown event before yielding", async () => {
    const { core, emitted } = setup();
    await core.start();
    const leaving = player(1, "Leaving", { steamId: "100" });
    await core.connect(leaving);
    const character = await core.characters.create(leaving, { name: "Ominis Gaunt" });
    await core.characters.select(leaving, character.id);
    emitted.length = 0;

    // The engine destroys the player once the disconnect handler yields; events raised later can't carry it.
    const closing = core.disconnect(leaving);
    assert.deepStrictEqual(emitted.map((event) => event.name), ["hmp:character:unloading", "hmp:character:unloaded", "hmp:session:ended"]);
    assert.strictEqual(core.sessions.isReady(leaving), false);
    assert.strictEqual(await closing, true);

    const back = player(2, "Back", { steamId: "100" });
    await core.connect(back);
    assert.strictEqual((await core.characters.select(back, character.id)).id, character.id, "the character's claim was not released");
});

test("releases a character whose player disconnects while it is loading", async () => {
    let finishLoading = () => {};
    const loading = new Promise<void>((resolve) => { finishLoading = resolve; });
    const { core, emitted } = setup({}, (name) => name === "hmp:character:loading" ? loading : undefined);
    await core.start();
    const leaving = player(1, "Leaving", { steamId: "100" });
    await core.connect(leaving);
    const character = await core.characters.create(leaving, { name: "Ominis Gaunt" });

    // Another resource is still loading the character when the player disconnects.
    const selecting = core.characters.select(leaving, character.id);
    while (!emitted.some((event) => event.name === "hmp:character:loading")) await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(await core.disconnect(leaving), true);
    finishLoading();
    await assert.rejects(selecting, (error) => hasCode(error, "HMP_CORE_SESSION_MISSING"));
    assert.ok(!emitted.some((event) => event.name === "hmp:character:loaded"), "the character was loaded into an ended session");

    const back = player(2, "Back", { steamId: "100" });
    await core.connect(back);
    assert.strictEqual((await core.characters.select(back, character.id)).id, character.id, "the character's claim was not released");
});

test("allows duplicate sessions for an account group and keeps characters exclusive", async () => {
    const { core } = setup({ duplicateSession: "allow-group" });
    await core.start();
    const first = player(1, "First", { steamId: "100" });
    const second = player(2, "Second", { steamId: "100" });
    const firstSession = await core.connect(first);
    assert.ok(firstSession);
    await assert.rejects(() => core.connect(second), (error) => hasCode(error, "HMP_CORE_DUPLICATE_SESSION"));

    await core.groups.setAccount(firstSession.account.id, "admin", 1);
    const secondSession = await core.connect(second);
    assert.ok(secondSession);
    assert.strictEqual(core.sessions.all().length, 2);

    const professor = await core.characters.create(first, { name: "Professor Fig" });
    const student = await core.characters.create(first, { name: "Natsai Onai" });
    await core.characters.select(first, professor.id);
    await assert.rejects(() => core.characters.select(second, professor.id), (error) => hasCode(error, "HMP_CORE_CHARACTER_IN_USE"));
    await assert.rejects(() => core.characters.delete(second, professor.id), (error) => hasCode(error, "HMP_CORE_CHARACTER_IN_USE"));
    await core.characters.select(second, student.id);

    assert.strictEqual(core.characters.active(first)?.id, professor.id);
    assert.strictEqual(core.characters.active(second)?.id, student.id);
    assert.strictEqual(await core.disconnect(first), true);
    await core.characters.select(second, professor.id);
    assert.strictEqual(core.characters.active(second)?.id, professor.id);
});

test("repository refuses to transfer an existing identity", async () => {
    const calls: unknown[][] = [];
    const database = {
        query: async () => [],
        single: async () => ({
            id: 4,
            display_name: "Existing",
            created_at: "now",
            last_seen_at: "now",
            provider: "mafiahub",
            subject: "subject",
            trust_level: "verified",
        }),
        update: async (...args: unknown[]) => { calls.push(args); return 1; },
        insert: async (...args: unknown[]) => { calls.push(args); return 1; },
    } as unknown as Database;
    const repository = createRepository(database);
    await assert.rejects(
        () => repository.linkIdentity(5, { provider: "mafiahub", subject: "subject", trust: "verified" }),
        (error) => hasCode(error, "HMP_CORE_IDENTITY_CONFLICT"),
    );
    assert.strictEqual(calls.length, 0);
});

function joining(ticket: string, ids: Partial<HogwartsMpPendingConnection> = {}) {
    const rejected: string[] = [];
    const connection: HogwartsMpPendingConnection = {
        nickname: "Sebastian",
        steamId: "",
        epicId: "",
        discordId: "",
        hardwareId: "42",
        ip: "203.0.113.5",
        ticket,
        ...ids,
        reject: (reason?: string) => { rejected.push(String(reason)); },
    };
    return { connection, rejected };
}

function ticketSetup(config: Partial<{ required: boolean; rejectMessage: string; repeatSeconds: number }> = {}, supported = true) {
    let clock = 1_000;
    const warnings: string[] = [];
    const tickets = createTickets({
        config: { required: false, rejectMessage: "Join from the website.", repeatSeconds: 120, ...config },
        supported,
        logger: { warn: (message: string) => warnings.push(message) },
        now: () => clock,
    });
    return { tickets, warnings, advance: (ms: number) => { clock += ms; } };
}

test("reads the host release for link tickets", () => {
    assert.strictEqual(hostAtLeast("1.11.0", 1, 11), true);
    assert.strictEqual(hostAtLeast("2.0.0", 1, 11), true);
    assert.strictEqual(hostAtLeast("1.10.3", 1, 11), false);
    assert.strictEqual(hostAtLeast("", 1, 11), false);
    assert.strictEqual(hostAtLeast(undefined, 1, 11), false);
});

test("loads the ticket settings off by default and refuses bad ones", () => {
    let overrides: Record<string, unknown> = {};
    const Hmp = {
        config: {
            load: (_path: string, options: { defaults: Record<string, unknown> }) => ({ ...options.defaults, ...overrides }),
            env: { number: Number, boolean: (value: unknown, fallback?: boolean) => value === undefined ? Boolean(fallback) : value === "true" },
        },
    } as unknown as Parameters<typeof loadConfig>[0];
    assert.deepStrictEqual(loadConfig(Hmp, { env: {} }).tickets, { required: false, rejectMessage: "Join this server from its website.", repeatSeconds: 120 });
    assert.strictEqual(loadConfig(Hmp, { env: { HMP_CORE_REQUIRE_TICKET: "true" } }).tickets.required, true);
    overrides = { tickets: { required: true, rejectMessage: "Use the Join button.", repeatSeconds: 30 } };
    assert.deepStrictEqual(loadConfig(Hmp, { env: {} }).tickets, { required: true, rejectMessage: "Use the Join button.", repeatSeconds: 30 });
    overrides = { tickets: { repeatSeconds: -1 } };
    assert.throws(() => loadConfig(Hmp, { env: {} }), /repeatSeconds/);
    overrides = { tickets: { rejectMessage: " " } };
    assert.throws(() => loadConfig(Hmp, { env: {} }), /rejectMessage/);
});

test("asks redeemers about a link's ticket and hands the accepted one to the joining player", async () => {
    const { tickets, warnings } = ticketSetup();
    const asked: string[] = [];
    tickets.api.register({ name: "broken", resource: "site", priority: 10, redeem: () => { asked.push("broken"); throw new Error("site down"); } });
    tickets.api.register({ name: "other", resource: "site", priority: 5, redeem: () => { asked.push("other"); return null; } });
    const unregister = tickets.api.register({
        name: "website",
        resource: "site",
        redeem: async ({ ticket, hardwareId }) => { asked.push("website"); return ticket === "abc" && { accountId: 7, hardwareId }; },
    });
    assert.throws(() => tickets.api.register({ name: "website", resource: "site", redeem: () => true }), /already registered/);
    assert.deepStrictEqual(tickets.api.list().map((entry) => entry.name), ["broken", "other", "website"]);

    const { connection, rejected } = joining("abc");
    assert.deepStrictEqual(await tickets.connecting(connection), { redeemer: "website", result: { accountId: 7, hardwareId: "42" }, repeat: false });
    assert.deepStrictEqual(asked, ["broken", "other", "website"]);
    assert.deepStrictEqual(rejected, []);
    assert.match(warnings[0], /broken failed for Sebastian: site down/);
    assert.ok(!warnings[0].includes("abc"), "a ticket is never logged");

    const sebastian = player(3, "Sebastian", { hardwareId: "42", getIP: () => "203.0.113.5" });
    const stranger = player(4, "Ominis", { hardwareId: "43", ip: "203.0.113.6" });
    assert.strictEqual(tickets.attach(stranger), null);
    assert.deepStrictEqual(tickets.attach(sebastian), { redeemer: "website", result: { accountId: 7, hardwareId: "42" }, repeat: false });
    assert.deepStrictEqual(tickets.api.get(3)?.result, { accountId: 7, hardwareId: "42" });
    assert.strictEqual(tickets.api.get(stranger), null);
    assert.strictEqual(tickets.detach(sebastian), true);
    assert.strictEqual(tickets.api.get(sebastian), null);

    // Joined from the server list: no ticket, and nobody is asked.
    asked.length = 0;
    assert.strictEqual(await tickets.connecting(joining("").connection), null);
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(unregister(), true);
    assert.strictEqual(tickets.removeForResource("site"), 2);
    assert.deepStrictEqual(tickets.api.list(), []);
});

test("accepts the same join's second presentation of a ticket without asking again", async () => {
    const { tickets, advance } = ticketSetup({ required: true, repeatSeconds: 60 });
    let redeemed = 0;
    tickets.api.register({ name: "website", resource: "site", redeem: () => ++redeemed === 1 });
    assert.strictEqual((await tickets.connecting(joining("once").connection))?.repeat, false);
    advance(30_000);
    const again = joining("once");
    assert.deepStrictEqual(await tickets.connecting(again.connection), { redeemer: "website", result: true, repeat: true });
    assert.deepStrictEqual(again.rejected, []);
    assert.strictEqual(redeemed, 1);
    const elsewhere = joining("once", { hardwareId: "99" });
    assert.strictEqual(await tickets.connecting(elsewhere.connection), null, "another machine is asked, and the spent ticket fails");
    assert.deepStrictEqual(elsewhere.rejected, ["Join from the website."]);
    advance(31_000);
    const late = joining("once");
    assert.strictEqual(await tickets.connecting(late.connection), null);
    assert.deepStrictEqual(late.rejected, ["Join from the website."]);
});

test("turns away a join without an accepted ticket only when required on a host that passes tickets on", async () => {
    const required = ticketSetup({ required: true });
    assert.strictEqual(required.tickets.api.required(), true);
    for (const ticket of ["", "made-up"]) {
        const { connection, rejected } = joining(ticket);
        assert.strictEqual(await required.tickets.connecting(connection), null);
        assert.deepStrictEqual(rejected, ["Join from the website."]);
    }
    assert.strictEqual(required.warnings.filter((message) => /no resource registered a ticket redeemer/.test(message)).length, 1);

    const optional = ticketSetup();
    const allowed = joining("");
    assert.strictEqual(await optional.tickets.connecting(allowed.connection), null);
    assert.deepStrictEqual(allowed.rejected, []);

    // An older host's clients never pass their link's ticket on: required is not enforced there.
    const older = ticketSetup({ required: true }, false);
    assert.strictEqual(older.tickets.api.required(), false);
    const join = joining("");
    assert.strictEqual(await older.tickets.connecting(join.connection), null);
    assert.deepStrictEqual(join.rejected, []);
    assert.deepStrictEqual(older.warnings, []);
});
// Source-level TypeScript tests.

import configModule = require("./config");
import repositoryModule = require("./repository");
import coreModule = require("./core");
import schemaModule = require("./schema");
import ticketsModule = require("./tickets");
import announcedModule = require("./announced");
import type { Player } from "./internal";

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { createCore } = coreModule;
const { migrations } = schemaModule;
const { createTickets, hostAtLeast } = ticketsModule;
const { createAnnounced } = announcedModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const logger = Hmp.logger.create("hmp-core");
const config = loadConfig(Hmp);
const repository = createRepository(database);
// Identifiers a join announces that the player object lacks, such as an Epic Games account ID.
const announced = createAnnounced();
const core = createCore({
    repository,
    database,
    migrations,
    events: Events,
    listPlayers: () => PlayerManager.getAll(),
    logger,
    config,
    announcedIdentities: (player) => announced.get(player),
});

// HogwartsMP 1.11 is the first host whose clients pass a launch link's ticket on; before it every ticket is empty.
const ticketsSupported = typeof ExecutionEnvironment !== "undefined" && hostAtLeast(ExecutionEnvironment.modVersion, 1, 11);
const tickets = createTickets({ config: config.tickets, supported: ticketsSupported, logger });
if (config.tickets.required && !ticketsSupported) {
    logger.warn("tickets.required needs HogwartsMP 1.11 or newer, whose clients pass their link's ticket on; joins are not checked");
}

for (const name of ["status", "identity", "accounts", "sessions", "characters", "groups", "metadata"] as const) {
    Exports.register(name, core[name]);
}
Exports.register("tickets", tickets.api);

Events.on("playerConnecting", (connection) => {
    announced.remember(connection);
    return tickets.connecting(connection);
});

Events.on("playerConnect", (player: unknown) => {
    const currentPlayer = player as Player;
    tickets.attach(currentPlayer);
    announced.attach(currentPlayer);
    core.connect(currentPlayer).catch((error: unknown) => {
        logger.error(`Could not initialize ${Hmp.player.format(currentPlayer)}: ${messageOf(error)}`);
        if (typeof currentPlayer.kick === "function") currentPlayer.kick("Server services are temporarily unavailable. Please try again later.");
    });
});

Events.on("playerDisconnect", (player: unknown) => {
    const currentPlayer = player as Player;
    tickets.detach(currentPlayer);
    core.disconnect(currentPlayer).finally(() => announced.detach(currentPlayer)).catch((error: unknown) => logger.error(`Could not close ${Hmp.player.format(currentPlayer)}: ${messageOf(error)}`));
});

Events.on("resourceStop", (name: unknown) => {
    if (name === "hmp-core" || !name) {
        core.stop().catch((error: unknown) => logger.error(`Shutdown failed: ${messageOf(error)}`));
        return;
    }
    core.removeIdentityProvidersForResource(name as string);
    tickets.removeForResource(name as string);
});

Events.on("resourceStart", async (name: unknown) => {
    if (name && name !== "hmp-core") return;
    await core.start();
    logger.info("Accounts, characters, groups and metadata are ready");
});
// TypeScript source.

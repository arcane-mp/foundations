import serviceModule = require("./service");
import type { HmpLibClient } from "../../hmp-lib/types";

declare const World: {
    setBoundaryPolicy(remove: boolean): number;
    setAmbientPopulation(enabled: boolean): boolean;
    /** Absent on a host older than population density and exclusions. */
    setPopulationDensity?(density: number): number;
    setPopulationExclusions?(exclusions: { names?: string[]; types?: string[] }): unknown;
};

const { createWorldClient } = serviceModule;
const Hmp = Imports.get<HmpLibClient>("hmp-lib");
const logger = Hmp.logger.create("hmp-world");
const world = createWorldClient({
    native: World,
    player: LocalPlayer,
    emitReady: () => Events.emitServer("hmp-world:ready", "{}"),
    warn: (message: string) => logger.warn(message),
});

Exports.register("policy", world.policy);
Exports.register("status", world.status);
Events.on("hmp-world:policy", (payload: unknown) => {
    if (!world.apply(payload)) logger.warn("Rejected malformed world policy");
});
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-world") world.stop(); });

logger.info("Client world policy coordinator ready");

import type { InventoryConfig, Lib, StartingItemEntry } from "./internal";

function normalizeStartingItems(raw: unknown): StartingItemEntry[] {
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) throw new TypeError("hmp-inventory startingItems must be an array");
    const source = Array.isArray(raw) ? raw : [];
    const entries: StartingItemEntry[] = [];
    for (const candidate of source) {
        const value = typeof candidate === "string"
            ? { name: candidate }
            : candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
        if (!value) continue;
        const name = String(value.name ?? value.item ?? "").trim().toLowerCase().slice(0, 64);
        if (!name) continue;
        const amount = Math.max(1, Math.min(100000, Math.trunc(Number(value.amount ?? value.count ?? value.quantity)) || 1));
        const entry: StartingItemEntry = { name, amount };
        if (value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) {
            entry.metadata = value.metadata as Record<string, unknown>;
        }
        entries.push(entry);
    }
    return entries;
}

// The host's range for player.inventory.gearCapacity; null keeps the game's own 20 plus Merlin upgrades.
const MAX_GEAR_CAPACITY = 200;

function normalizeGearCapacity(raw: unknown, label: string): number | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_GEAR_CAPACITY) {
        throw new TypeError(`${label} must be null or a whole number from 1 to ${MAX_GEAR_CAPACITY}`);
    }
    return raw;
}

function loadConfig(Hmp: Lib, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): InventoryConfig {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const defaults = {
        slots: 36,
        maxWeight: 60,
        autoSaveMs: 30000,
        allowInventoryCommand: true,
        items: [],
        startingItems: [],
        gearCapacity: null,
        ui: {
            url: "fw://resources/hmp-inventory/dist/index.html",
        },
    };
    const config = Hmp.config.load<InventoryConfig>(env.HMP_INVENTORY_CONFIG || "data/hmp-inventory.json", { cwd, defaults });
    config.slots = Math.max(1, Math.min(200, Math.trunc(Number(config.slots)) || defaults.slots));
    config.maxWeight = Math.max(0, Math.min(100000, Number(config.maxWeight) || defaults.maxWeight));
    config.autoSaveMs = Math.max(0, Math.min(3600000, Math.trunc(Number(config.autoSaveMs)) || 0));
    if (env.HMP_INVENTORY_COMMAND) config.allowInventoryCommand = Hmp.config.env.boolean(env.HMP_INVENTORY_COMMAND);
    if (!config.ui || typeof config.ui !== "object") config.ui = { ...defaults.ui };
    if (env.HMP_INVENTORY_UI_URL) config.ui.url = String(env.HMP_INVENTORY_UI_URL).trim();
    config.ui.url = String(config.ui.url || defaults.ui.url).trim();
    if (!config.ui.url.startsWith("fw://resources/") && !config.ui.url.startsWith("https://")) {
        throw new TypeError("hmp-inventory ui.url must be a resource URL or an HTTPS URL");
    }
    if (!Array.isArray(config.items)) throw new TypeError("hmp-inventory items must be an array");
    config.startingItems = normalizeStartingItems(config.startingItems);
    config.gearCapacity = normalizeGearCapacity(config.gearCapacity, "hmp-inventory gearCapacity");
    return config;
}

export = { loadConfig, normalizeStartingItems, normalizeGearCapacity };
// TypeScript source.

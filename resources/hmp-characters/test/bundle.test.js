const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const serverHandlers = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const emittedToServer = [];
const emittedToWeb = [];
const importedLooks = [];
const patches = [];
const viewUrls = [];
let creatorBegun = 0;
let creatorCommitted = 0;
let creatorCancelled = 0;
let nextView = 0;
const logger = { info() {}, error() {}, warn() {}, debug() {} };
const last = (name) => emittedToWeb.findLast((event) => event.name === name)?.payload;
const core = {
    sessions: { get: () => null },
    characters: { list: async () => [], active: () => null, limit: () => 4 },
    metadata: {},
};

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Character = { isAllowed: () => true };
global.Imports = {
    get(name) {
        if (name === "hmp-core") return core;
        if (name === "hmp-inventory") return { native: { save: async () => true } };
        if (name === "hmp-lib") return {
            logger: { create: () => logger },
            config: { load: (_path, options) => ({ ...options.defaults }), env: { boolean: (value) => value === "true" } },
            rateLimit: { create: () => ({ allow: () => true }) },
            command: { createRouter: () => ({ register() {}, handle() {} }) },
            input: { controls: { acquire: () => ({ release: () => true }) } },
        };
        throw new Error(`Unexpected import ${name}`);
    },
};
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit: async () => {},
};

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["ui", "appearance"]);
assert.strictEqual(typeof exportsSeen.get("ui").open, "function");
assert.strictEqual(exportsSeen.get("appearance").listTransmogs().length, 151);
assert.ok(serverHandlers.has("worldReady"));
assert.ok(serverHandlers.has("playerAppearanceChanged"));
assert.ok(serverHandlers.has("loadingFinished"));
assert.ok(serverHandlers.has("client:hmp-characters:select"));

global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => emittedToServer.push({ name, payload }),
};
global.Web = {
    createView(url) { viewUrls.push(url); return ++nextView; },
    on: (_view, name, handler) => webHandlers.set(name, handler),
    emit(_view, name, payload) { emittedToWeb.push({ name, payload }); return true; },
    showView() {},
    hideView() {},
    focusView() {},
};
global.Game = { lockControls() {}, notify() {} };
const creatorSchema = {
    version: 1,
    gender: 1,
    categories: {
        preset: { options: ["preset-a"], count: 1 },
        hairStyle: { options: ["saved-look", "shared-look"], count: 2 },
        glasses: { options: ["GA_Face_001"], count: 1 },
        facialHair: { options: ["M_Facial_zBase_FullBeard", "M_Facial_zBase_WizardLong"], count: 2 },
        facialHairColor: { options: ["hair", "#1c1410"], count: 2 },
    },
};
const creatorState = {
    gender: 1,
    selections: { preset: "preset-a", hairStyle: "shared-look", hairColour: "#4a3020" },
    faceGear: "",
    voice: { tone: 0, pitch: 0 },
    name: { first: "Natsai", last: "Onai" },
    pronoun: "wizard",
};
const olderHost = { version: 3, session: true, sessionHolder: "none", schema: true, state: true, patch: true, preview: true, look: true };
let capabilities = { ...olderHost, version: 6, facialHair: true, pronoun: true, hairColourHex: true };
global.Creator = {
    getCapabilities: () => capabilities,
    begin() { creatorBegun++; return true; },
    commit() { creatorCommitted++; return true; },
    cancel() { creatorCancelled++; return true; },
    getSchema: () => creatorSchema,
    getState: () => creatorState,
    applyPatch(patch) { patches.push(patch); return 1; },
    setVoice: () => true,
    setName: () => true,
    exportLook: () => ({ format: "hogwartsmp-look", version: 6, gender: "female", presets: { hairStyle: "shared-look", hairColour: "#4a3020" }, gear: [], pronoun: "wizard" }),
    importLook(look) { importedLooks.push(look); return true; },
};
global.CreatorPreview = { setCamera() {}, restoreCamera() {}, rotate() {}, freeze() {}, playIdle: () => true };
global.Portrait = {
    capture: () => true,
    result: () => "OK",
    busy: () => false,
    lastImage: () => "data:image/png;base64,dGVzdA==",
};

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-characters:open"));
assert.ok(clientHandlers.has("hmp-characters:look"));
assert.ok(clientHandlers.has("creatorChanged"));
assert.ok(webHandlers.has("select"));
assert.ok(webHandlers.has("import"));
assert.ok(webHandlers.has("export"));
assert.ok(webHandlers.has("creator:ready"));
assert.ok(webHandlers.has("creator:confirm"));
assert.ok(webHandlers.has("creator:export"));
assert.deepStrictEqual(viewUrls, ["fw://resources/hmp-characters/dist/index.html", "fw://resources/hmp-characters/dist/creator.html"]);
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "creator.html")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "creator.js")));
const page = fs.readFileSync(path.resolve(__dirname, "..", "dist", "index.html"), "utf8");
assert.match(page, /hmp-characters:portrait/);
assert.match(page, /hmp-characters:export/);
assert.match(page, /id="copy-export"/);
assert.match(page, /id="import-modal"/);
assert.match(page, /id="submit-import"/);
assert.doesNotMatch(page, /id="download-export"/);
const creatorPage = fs.readFileSync(path.resolve(__dirname, "..", "dist", "creator.html"), "utf8");
const creatorBundle = fs.readFileSync(path.resolve(__dirname, "..", "dist", "creator.js"), "utf8");
assert.match(creatorPage, /creator\.js/);
assert.match(creatorBundle, /COPY LOOK JSON/);
assert.match(creatorBundle, /IMPORT JSON/);
assert.match(creatorBundle, /Facial Hair Colour/);
assert.match(creatorBundle, /creator:hair-colour/);
assert.match(creatorBundle, /CHOOSE A DORMITORY/);
const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inlineScript);
assert.doesNotThrow(() => new Function(inlineScript[1]));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Cinzel-Variable.ttf")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Spectral-Regular.ttf")));

webHandlers.get("ready")();
webHandlers.get("creator:ready")();
clientHandlers.get("hmp-characters:open")({
    mode: "wardrobe",
    title: "Characters",
    subtitle: "Choose",
    characters: [{ id: 4, slot: 1, name: "Natsai Onai" }],
    activeCharacterId: null,
    lastCharacterId: 4,
    limit: 4,
    full: false,
    allowDelete: true,
    canClose: true,
});
clientHandlers.get("hmp-characters:look")({
    characterId: 4,
    look: { format: "hogwartsmp-look", version: 2, gender: "female", presets: { hairStyle: "saved-look" }, gear: [] },
    transmog: "",
});
webHandlers.get("export")({ characterId: 4 });
const exported = emittedToWeb.find((event) => event.name === "hmp-characters:export");
assert.strictEqual(exported?.payload.name, "Natsai Onai");
assert.strictEqual(JSON.parse(exported?.payload.json).presets.hairStyle, "saved-look");
setTimeout(() => {
    assert.ok(emittedToWeb.some((event) => event.name === "hmp-characters:portrait" && event.payload.characterId === 4 && event.payload.src.startsWith("data:image/png")));
    const imported = { format: "hogwartsmp-look", version: 2, gender: "female", presets: { hairStyle: "shared-look" }, gear: [] };
    webHandlers.get("import")({ look: imported });
    assert.ok(emittedToServer.some((event) => event.name === "hmp-characters:create"));
    clientHandlers.get("hmp-characters:create")();
    assert.strictEqual(creatorBegun, 1);
    clientHandlers.get("creatorChanged")({});
    assert.deepStrictEqual(importedLooks, [imported]);
    clientHandlers.get("creatorChanged")({});
    const opened = last("hmp-creator:open");
    assert.strictEqual(opened.schema, creatorSchema);
    assert.deepStrictEqual(opened.capabilities, { pronoun: true, hairColourHex: true });
    assert.strictEqual(opened.imported, true);
    assert.strictEqual(opened.state.pronoun, "wizard");
    // Slider 1 clears the clearable categories; their options start at 2.
    for (const [category, index] of [["facialHair", 1], ["facialHair", 3], ["facialHairColor", 1], ["facialHairColor", 2], ["hairStyle", 2]]) {
        webHandlers.get("creator:option")({ category, index });
    }
    assert.deepStrictEqual(patches, [{ facialHair: "" }, { facialHair: "M_Facial_zBase_WizardLong" }, { facialHairColor: "" }, { facialHairColor: "hair" }, { hairStyle: "shared-look" }]);
    patches.length = 0;
    webHandlers.get("creator:hair-colour")({ colour: "#4A3020" });
    webHandlers.get("creator:hair-colour")({ colour: "brown" });
    assert.deepStrictEqual(patches, [{ hairColour: "#4a3020" }]);
    assert.strictEqual(last("hmp-creator:error").message, "Enter the hair colour as #rrggbb.");
    clientHandlers.get("creatorChanged")({});
    assert.deepStrictEqual(last("hmp-creator:snapshot").capabilities, { pronoun: true, hairColourHex: true });
    assert.strictEqual(last("hmp-creator:snapshot").state.selections.hairColour, "#4a3020");
    // The game takes the pick only when the saved look loads, so the copied JSON carries the page's.
    webHandlers.get("creator:export")({ dorm: "witch" });
    const copied = JSON.parse(last("hmp-creator:export").json);
    assert.strictEqual(copied.presets.hairStyle, "shared-look");
    assert.strictEqual(copied.presets.hairColour, "#4a3020");
    assert.strictEqual(copied.pronoun, "witch");
    webHandlers.get("creator:confirm")({ first: "Natsai", last: "Onai", dorm: "" });
    assert.strictEqual(creatorCommitted, 0);
    assert.strictEqual(last("hmp-creator:error").message, "Choose Witch or Wizard before confirming.");
    webHandlers.get("creator:confirm")({ first: "Natsai", last: "Onai", dorm: "witch" });
    assert.strictEqual(creatorCommitted, 1);
    assert.strictEqual(creatorCancelled, 0);
    assert.deepStrictEqual(JSON.parse(emittedToServer.at(-1).payload), { first: "Natsai", last: "Onai", pronoun: "witch" });

    // An older host offers neither: the page hides both and the client sends no pronoun.
    capabilities = olderHost;
    clientHandlers.get("hmp-characters:open")({ mode: "create", title: "Characters", subtitle: "Choose", characters: [], activeCharacterId: null, lastCharacterId: null, limit: 4, full: false, allowDelete: true, canClose: false });
    clientHandlers.get("hmp-characters:create")();
    assert.strictEqual(creatorBegun, 2);
    clientHandlers.get("creatorChanged")({});
    assert.deepStrictEqual(last("hmp-creator:open").capabilities, { pronoun: false, hairColourHex: false });
    assert.strictEqual(last("hmp-creator:open").imported, false);
    patches.length = 0;
    webHandlers.get("creator:hair-colour")({ colour: "#4a3020" });
    assert.deepStrictEqual(patches, []);
    assert.strictEqual(last("hmp-creator:error").message, "This client does not support a custom hair colour.");
    webHandlers.get("creator:export")({ dorm: "witch" });
    assert.strictEqual(JSON.parse(last("hmp-creator:export").json).pronoun, "wizard");
    webHandlers.get("creator:confirm")({ first: "Natsai", last: "Onai", dorm: "witch" });
    assert.strictEqual(creatorCommitted, 2);
    assert.deepStrictEqual(JSON.parse(emittedToServer.at(-1).payload), { first: "Natsai", last: "Onai" });
    console.log("hmp-characters bundle contract passed");
}, 100);

import assert = require("node:assert");
import { test } from "node:test";
import lookModule = require("../shared/look");

const { PRONOUN_LOOK_VERSION, pronounOf, hexColourOf, withPronoun } = lookModule;

function look(version: number, extra: Partial<HogwartsMpLook> = {}): HogwartsMpLook {
    return { format: "hogwartsmp-look", version, gender: "male", presets: { hairColour: "#4a3020" }, gear: [], ...extra };
}

test("accepts only the Witch/Wizard pronouns", () => {
    assert.strictEqual(pronounOf("witch"), "witch");
    assert.strictEqual(pronounOf("wizard"), "wizard");
    for (const value of ["Witch", "", "dragon", undefined, null, 1, {}]) assert.strictEqual(pronounOf(value), "");
});

test("normalizes #rrggbb colours and refuses anything else", () => {
    assert.strictEqual(hexColourOf("#4A3020"), "#4a3020");
    assert.strictEqual(hexColourOf("#8e6a4e"), "#8e6a4e");
    for (const value of ["4a3020", "#4a302", "#4a30200", "#4a302g", "HairColorMale007", "", undefined, 0x4a3020]) {
        assert.strictEqual(hexColourOf(value), "");
    }
});

test("puts the pronoun only on a look format that carries it", () => {
    assert.strictEqual(PRONOUN_LOOK_VERSION, 5);
    assert.deepStrictEqual(withPronoun(look(6, { pronoun: "wizard" }), "witch"), look(6, { pronoun: "witch" }));
    assert.deepStrictEqual(withPronoun(look(5), "wizard"), look(5, { pronoun: "wizard" }));
    const older = look(4);
    assert.strictEqual(withPronoun(older, "witch"), older);
    const current = look(6, { pronoun: "wizard" });
    assert.strictEqual(withPronoun(current, ""), current);
    assert.strictEqual(withPronoun(current, "dragon"), current);
});
// Source-level TypeScript tests.

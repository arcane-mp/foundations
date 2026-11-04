type Pronoun = NonNullable<HogwartsMpLook["pronoun"]>;

// Looks carry the Witch/Wizard pronoun from format 5; an older host's look has no field for it.
const PRONOUN_LOOK_VERSION = 5;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function pronounOf(value: unknown): Pronoun | "" {
    return value === "witch" || value === "wizard" ? value : "";
}

function hexColourOf(value: unknown): string {
    return typeof value === "string" && HEX_COLOUR.test(value) ? value.toLowerCase() : "";
}

function withPronoun<T extends HogwartsMpLook>(look: T, value: unknown): T {
    const pronoun = pronounOf(value);
    return pronoun && Number(look.version) >= PRONOUN_LOOK_VERSION ? { ...look, pronoun } : look;
}

export = { PRONOUN_LOOK_VERSION, pronounOf, hexColourOf, withPronoun };

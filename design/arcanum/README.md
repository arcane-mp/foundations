# Arcanum

Arcanum is the visual language of the Foundations screens: charcoal surfaces, one gold accent, Cinzel for
titles, labels and buttons, Spectral for reading text. This folder is its single source.

Resources never load these files from another resource at runtime. Each resource's build copies what it
needs into its own `dist/`, so every resource can be installed on its own.

## Contents

| File | What |
|---|---|
| `tokens.css` | `--arc-*` custom properties (colour, type, space, corners, elevation, motion) and the `@font-face` rules. |
| `fonts/Cinzel-Variable.ttf` | Cinzel, weights 400-900. SIL Open Font License 1.1, `fonts/OFL-Cinzel.txt`. |
| `fonts/Spectral-Regular.ttf`, `fonts/Spectral-SemiBold.ttf` | Spectral 400 and 600. SIL Open Font License 1.1, `fonts/OFL-Spectral.txt`. |

The fonts are the files published in [google/fonts](https://github.com/google/fonts) (`ofl/cinzel`,
`ofl/spectral`), unmodified.

## Using it in a resource

Call the copy helpers from the resource's `scripts/copy-static.mjs` (or `scripts/build.mjs`):

```js
import { copyArcanum, copyArcanumFonts } from "../../../scripts/arcanum.mjs";

await copyArcanum(root); // dist/arcanum/tokens.css and dist/arcanum/fonts/
await copyArcanumFonts(root); // dist/fonts/ with Cinzel, Spectral Regular and both licences
```

A page that uses the tokens links the stylesheet from its own folder, and lists the copied files in the
manifest's `files`:

```html
<link rel="stylesheet" href="arcanum/tokens.css">
```

```json
"files": ["dist/index.html", "dist/arcanum/**"]
```

## Tokens

All text tokens reach 4.5:1 contrast on every surface token. The ratios below are against
`--arc-surface-window` (`#15120c`).

| Group | Tokens |
|---|---|
| Gold | `--arc-gold-300` `#e6cc94`, `-400` `#d8b56b` (hover, focus), `-500` `#c9a25a` (the accent), `-600` `#a8843f` (pressed), `-700` `#6e5628` (decorative rules only, never text), `--arc-on-gold` `#1a1306` (text on gold, 7.7:1) |
| Lines | `--arc-line-strong`, `--arc-line`, `--arc-line-soft`: gold-500 at 30%, 14% and 8% |
| Surfaces | `--arc-surface-base` `#0a0805`, `-field` `#0e0b07` (inputs, slots), `-panel` `#100d08`, `-window` `#15120c`, `-raised` `#1c170e`, `-track` `#2a241a`, `--arc-scrim` |
| Text | `--arc-text-heading` 14.7:1, `-body` 11.3:1, `-data` 9.0:1, `-muted` 5.9:1, `-disabled` (disabled controls only) |
| Status | `--arc-success` `#a3bd82`, `--arc-warning` `#e09a52`, `--arc-danger` `#e06d5c`, `--arc-info` `#92b6c0`. Pair each with an icon or a word; colour alone does not tell the state. |
| Type | `--arc-font-display`, `--arc-font-body`, `--arc-font-mono`; sizes `--arc-text-xs` 12px to `--arc-text-display` 46px. Nothing smaller than 12px. |
| Space | `--arc-space-1` 4px to `--arc-space-12` 48px, in 4px steps |
| Corners | `--arc-radius-sm` 3px, `-md` 5px, `-lg` 7px, `-pill` |
| Elevation | `--arc-shadow-raised`, `--arc-shadow-window`, `--arc-shadow-gold`, `--arc-focus-ring` |
| Motion | `--arc-duration-fast` 80ms, `-base` 120ms, `-slow` 200ms, `-exit` 140ms; `--arc-ease-out`, `--arc-ease-in`. With `prefers-reduced-motion: reduce` every duration is 0. |

// Copies the Arcanum design source (design/arcanum) into a resource's dist/, so each resource ships its own
// copy and never loads styles or fonts from another resource at runtime. Resource builds call these from their
// copy-static or build scripts.
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "design", "arcanum");

// The fonts pages load from dist/fonts/ today, with their licences.
const pageFonts = ["Cinzel-Variable.ttf", "Spectral-Regular.ttf", "OFL-Cinzel.txt", "OFL-Spectral.txt"];

// dist/arcanum/: tokens.css and every font. A page links arcanum/tokens.css.
export async function copyArcanum(resourceRoot) {
    const target = path.join(resourceRoot, "dist", "arcanum");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(path.join(source, "tokens.css"), path.join(target, "tokens.css"));
    await cp(path.join(source, "fonts"), path.join(target, "fonts"), { recursive: true });
}

// dist/fonts/: the fonts named, for pages that declare their own @font-face rules.
export async function copyArcanumFonts(resourceRoot, names = pageFonts) {
    const target = path.join(resourceRoot, "dist", "fonts");
    await mkdir(target, { recursive: true });
    for (const name of names) await cp(path.join(source, "fonts", name), path.join(target, name));
}

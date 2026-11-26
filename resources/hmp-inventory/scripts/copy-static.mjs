import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyArcanum } from "../../../scripts/arcanum.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "dist"), { recursive: true });
await cp(path.join(root, "client", "index.html"), path.join(root, "dist", "index.html"));
await cp(path.join(root, "client", "icons"), path.join(root, "dist", "icons"), { recursive: true });
await copyArcanum(root);

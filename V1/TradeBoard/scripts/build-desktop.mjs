// TradeBoard desktop-shell build.
//
// The Tauri shell loads a LOCAL copy of the app rather than the deployed URL, so
// it keeps working offline and a bad web deploy can't break the scheduler. That
// local copy is just the same canonical tradeboard.html:
//
//   tradeboard.html  ->  desktop/dist/index.html
//
// This is intentionally the same one-file copy that scripts/build.mjs does for
// Cloudflare Pages — the two targets share one source of truth, and neither
// build can drift from the other.
//
// Run with:  npm run build:desktop
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "desktop", "dist");
mkdirSync(dist, { recursive: true });

copyFileSync(resolve(root, "tradeboard.html"), resolve(dist, "index.html"));

console.log("build:desktop — desktop/dist/index.html written");

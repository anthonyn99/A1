// TradeBoard build for Cloudflare Pages.
// Cloudflare Pages serves a static output directory. This script produces it:
//   • copies the canonical tradeboard.html -> public/index.html
//   • writes public/_headers so HTML is never cached (app updates reach devices
//     immediately, same behavior as the old Firebase hosting config)
//
// No _redirects file: Pages already serves index.html at the root, so a catch-all
// redirect to /index.html just triggers an infinite-loop error. A single-page app
// needs no redirect rules.
//
// Cloudflare Pages project settings should use:
//   Build command:        npm run build
//   Build output directory: public
//
// Run locally with:  npm run build
import { writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = resolve(root, "public");
mkdirSync(pub, { recursive: true });

// 1) canonical HTML -> index.html
copyFileSync(resolve(root, "tradeboard.html"), resolve(pub, "index.html"));

// 2) no-cache headers for HTML (Pages honors a top-level _headers file)
writeFileSync(
  resolve(pub, "_headers"),
  [
    "/*",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "/index.html",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "",
  ].join("\n")
);

// 3) remove any stale _redirects from earlier builds (would cause a loop error)
try { rmSync(resolve(pub, "_redirects"), { force: true }); } catch {}

console.log("build: public/index.html + _headers written (no _redirects)");

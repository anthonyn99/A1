// ── V1 suite build ──────────────────────────────────────────────────────────
// Produces ONE static output directory (`dist/`) containing every app in the
// suite. The site Worker (workers/site) serves that directory:
//
//   TradeBoard/tradeboard.html  ->  dist/index.html          (site root)
//   Finance/finance.html        ->  dist/finance/index.html  (/finance/)
//
// TradeBoard stays at the ROOT URL on purpose: it is already deployed, already
// installed as a PWA, and already bookmarked. Moving it under /tradeboard/ would
// break every one of those. New apps are added as subdirectories instead, so the
// suite grows without ever invalidating an existing install.
//
// Adding a future app is a one-line change to the APPS array below.
//
// CI runs this before deploying workers/site, so `dist/` is generated fresh on
// every push and never needs committing.
//
// Run locally with:  npm run build
import { writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

// Each app: where its canonical HTML lives, and the URL path it is served at.
// `out: ""` means the site root; anything else becomes a subdirectory.
//
// `assets` lists sibling directories/files the HTML loads RELATIVE TO ITSELF.
// Single-file apps omit it (TradeBoard and Finance inline everything). StudyOS
// does not: studyos.html resolves css/, js/, config/ and assets/ relative to its
// own location, so those must land beside it in dist/ or every one of them 404s.
//
// `rootFiles` are copied to the SITE ROOT regardless of which subdirectory the
// app is served from. A service worker can only control pages at or below its
// own path, and the FCM SDK looks for firebase-messaging-sw.js at the root, so
// it cannot live in the app's subdirectory.
//
// studyos-sw.js is the mirror image: it is an ASSET, not a rootFile, because
// its scope must be /studyos/ (covering the app) WITHOUT claiming the root
// scope that firebase-messaging-sw.js requires. Moving it into rootFiles
// would break push notifications.
const APPS = [
  { name: "TradeBoard", src: "TradeBoard/tradeboard.html", out: "" },
  { name: "Finance", src: "Finance/finance.html", out: "finance" },
  {
    name: "StudyOS",
    src: "studyos.html",
    out: "studyos",
    assets: ["css", "js", "config", "assets", "manifest.webmanifest", "studyos-sw.js"],
    rootFiles: [["firebase/firebase-messaging-sw.js", "firebase-messaging-sw.js"]],
  },
];

// Start from a clean output so a deleted source file can never linger in a deploy.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const app of APPS) {
  const src = resolve(root, app.src);
  if (!existsSync(src)) {
    console.warn(`build: SKIP ${app.name} — ${app.src} not found`);
    continue;
  }
  const outDir = app.out ? resolve(dist, app.out) : dist;
  mkdirSync(outDir, { recursive: true });
  copyFileSync(src, resolve(outDir, "index.html"));
  console.log(`build: ${app.name} -> dist/${app.out ? app.out + "/" : ""}index.html`);

  // Sibling assets the HTML loads relative to itself.
  for (const rel of app.assets ?? []) {
    const from = resolve(root, rel);
    if (!existsSync(from)) {
      console.warn(`build: SKIP ${app.name} asset — ${rel} not found`);
      continue;
    }
    cpSync(from, resolve(outDir, rel), { recursive: true });
    console.log(`build:   + ${rel}`);
  }

  // Files that must sit at the site root no matter where the app is served.
  for (const [rel, dest] of app.rootFiles ?? []) {
    const from = resolve(root, rel);
    if (!existsSync(from)) {
      console.warn(`build: SKIP ${app.name} root file — ${rel} not found`);
      continue;
    }
    copyFileSync(from, resolve(dist, dest));
    console.log(`build:   + /${dest} (site root)`);
  }
}

// No-cache headers for HTML so app updates reach devices immediately (same
// behavior the old Firebase hosting config had). Workers Static Assets honors a
// top-level _headers file; these globs cover the root app and every subdir app.
writeFileSync(
  resolve(dist, "_headers"),
  [
    "/*",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "/index.html",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "/*/index.html",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "",
  ].join("\n")
);

// Deliberately NO _redirects file: Static Assets already serves index.html at
// the root of each directory, and a catch-all redirect to /index.html causes an
// infinite-loop error.
console.log("build: dist/_headers written (no _redirects)");

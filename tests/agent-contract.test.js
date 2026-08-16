#!/usr/bin/env node
/**
 * Checks that shield.html and the Shield desktop agent still agree.
 *
 * The two halves are written in different languages and neither compiler can
 * see the other. Tauri maps an invoke payload's KEYS to the Rust command's
 * PARAMETER NAMES, so renaming a Rust parameter — or adding a command to
 * generate_handler! and forgetting to write it, or the reverse — breaks the
 * bridge at runtime with nothing failing at build time. On an emergency tool
 * that surfaces as "I pressed the button and nothing happened".
 *
 * This also pins the one ordering rule the whole Reopen feature depends on:
 * capture_and_kill must build the launch manifest BEFORE it closes anything,
 * because an image path and command line are unreadable once the process is
 * gone. Getting that backwards does not fail loudly — it silently produces
 * history entries that can never be reverted.
 *
 * Skips cleanly if desktop/shield is absent, so the suite still runs for anyone
 * who only has the web half checked out.
 *
 * Run: node tests/agent-contract.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AG = path.join(ROOT, 'desktop', 'shield');
const SRC = path.join(AG, 'src-tauri', 'src');

if (!fs.existsSync(SRC)) {
  console.log('Shield agent not present — skipping agent-contract checks.');
  process.exit(0);
}

const fail = [];
const pass = [];
function check(name, ok, detail) {
  (ok ? pass : fail).push(name + (detail ? '  — ' + detail : ''));
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (!ok && detail ? '  — ' + detail : ''));
}

const conf = JSON.parse(fs.readFileSync(path.join(AG, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const cap = JSON.parse(fs.readFileSync(path.join(AG, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
const lib = fs.readFileSync(path.join(SRC, 'lib.rs'), 'utf8');
const rust = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8'))
  .join('\n');
const html = fs.readFileSync(path.join(ROOT, 'shield.html'), 'utf8');

console.log('\nShield agent: command surface');

// Declared commands and their parameters.
const declared = [...rust.matchAll(/#\[tauri::command\]\s*\n\s*(?:pub\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g)]
  .map((m) => ({ name: m[1], params: m[2] }));
const handler = (lib.match(/generate_handler!\[([\s\S]*?)\]/) || [, ''])[1];
const registered = handler.split(',').map((s) => s.trim()).filter(Boolean);

check('at least one command is declared', declared.length > 0, declared.length + ' found');
check(
  'every #[tauri::command] is registered in generate_handler!',
  declared.every((d) => registered.includes(d.name)),
  declared.filter((d) => !registered.includes(d.name)).map((d) => d.name).join(', ')
);
check(
  'generate_handler! lists no command that does not exist',
  registered.every((r) => declared.some((d) => d.name === r)),
  registered.filter((r) => !declared.some((d) => d.name === r)).join(', ')
);

console.log('\nShield agent: the ACL (three files must agree)');

// Tauri v2 subjects remote origins to ACL resolution, and Shield's UI is loaded
// from GitHub Pages — so EVERY command is a remote call. A command missing from
// build.rs or from the capability is not a compile error and not a runtime
// crash: the button just silently does nothing and the page reports
// "Command sh_kill not allowed by ACL". That is how this shipped broken once.
const buildRs = fs.readFileSync(path.join(AG, 'src-tauri', 'build.rs'), 'utf8');
const declaredInBuild = [...(buildRs.match(/const COMMANDS[\s\S]*?\];/) || [''])[0].matchAll(/"([a-z_]+)"/g)].map(
  (m) => m[1]
);
const capPerms = cap.permissions || [];
const kebab = (s) => 'allow-' + s.replace(/_/g, '-');

check('build.rs declares an app manifest of commands', declaredInBuild.length > 0, declaredInBuild.length + ' listed');
check(
  'every registered command is declared in build.rs',
  registered.every((r) => declaredInBuild.includes(r)),
  registered.filter((r) => !declaredInBuild.includes(r)).join(', ')
);
check(
  'build.rs declares no command that is not registered',
  declaredInBuild.every((c) => registered.includes(c)),
  declaredInBuild.filter((c) => !registered.includes(c)).join(', ')
);
check(
  'the capability grants allow-* for every command',
  registered.every((r) => capPerms.includes(kebab(r))),
  registered.filter((r) => !capPerms.includes(kebab(r))).map(kebab).join(', ')
);
// ...and the reverse. A permission naming a command that was never written is
// a HARD BUILD FAILURE from tauri-build ("Permission allow-x not found"), and
// the error arrives buried under a 3000-character list of every valid
// permission in the framework. Catching it here names the culprit in one line.
const appPerms = capPerms.filter((p) => p.startsWith('allow-sh-'));
check(
  'the capability grants no allow-* for a command that does not exist',
  appPerms.every((p) => registered.some((r) => kebab(r) === p)),
  appPerms.filter((p) => !registered.some((r) => kebab(r) === p)).join(', ')
);

// Plugins declared in Cargo.toml but never initialised in lib.rs are dead
// weight at best; a declared URL scheme that nothing handles is a feature that
// silently does nothing.
const cargo = fs.readFileSync(path.join(AG, 'src-tauri', 'Cargo.toml'), 'utf8');
const plugins = [...cargo.matchAll(/^tauri-plugin-([a-z-]+)\s*=/gm)].map((m) => m[1]);
const uninit = plugins.filter((p) => !lib.includes('tauri_plugin_' + p.replace(/-/g, '_') + '::'));
check('every tauri plugin in Cargo.toml is initialised in lib.rs', uninit.length === 0, uninit.join(', '));
// A single /* does not match a nested path like /A1/shield.html. Without /**
// the IPC is never injected and window.__TAURI__ is simply absent.
check(
  'the remote URL pattern uses /** so a nested path matches',
  ((cap.remote || {}).urls || []).some((u) => u.endsWith('/**')),
  ((cap.remote || {}).urls || []).join(', ')
);

console.log('\nShield agent: the JS bridge');

const calls = [...html.matchAll(/Agent\.invoke\(\s*'([^']+)'\s*,\s*(\{[^;]*?\})\s*\)/g)].map((m) => ({
  cmd: m[1],
  arg: m[2].replace(/\s+/g, ' '),
}));

check('shield.html makes at least one invoke call', calls.length > 0, calls.length + ' found');
check(
  'shield.html only invokes commands the agent defines',
  calls.every((c) => declared.some((d) => d.name === c.cmd)),
  calls.filter((c) => !declared.some((d) => d.name === c.cmd)).map((c) => c.cmd).join(', ')
);

// Tauri injects these; they are not part of the JS payload.
const INJECTED = new Set(['app', 'ctx', 'window', 'webview', 'state']);
const mismatches = [];
for (const c of calls) {
  const d = declared.find((x) => x.name === c.cmd);
  if (!d) continue;
  // Blank out <...> first: State<'_, Ctx> holds a comma that is not a parameter
  // separator, which would otherwise invent a parameter named "Ctx>".
  const flat = d.params.replace(/<[^<>]*>/g, (m) => ' '.repeat(m.length));
  const params = flat
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(':')[0].trim())
    .filter((n) => n && !INJECTED.has(n));
  for (const p of params) {
    if (!new RegExp('(^|[{,\\s])' + p + '\\s*:').test(c.arg)) {
      mismatches.push(c.cmd + ' expects key "' + p + '"');
    }
  }
}
check('every invoke passes the key its Rust parameter is named', mismatches.length === 0, mismatches.join(', '));

console.log('\nShield agent: capture-before-kill');

const procRs = fs.readFileSync(path.join(SRC, 'proc.rs'), 'utf8');
const body = (procRs.match(/pub fn capture_and_kill[\s\S]*?\n}/) || [''])[0];
const capturePos = body.indexOf('launch: Vec<LaunchItem>');
const closePos = body.indexOf('request_close');
check(
  'capture_and_kill builds the manifest BEFORE closing anything',
  capturePos > -1 && closePos > -1 && capturePos < closePos,
  'capture@' + capturePos + ' close@' + closePos
);
const wd = (procRs.match(/pub fn kill_on_sight[\s\S]*?\n}/) || [''])[0];
check('the watchdog path does not re-capture manifests', wd.length > 0 && !wd.includes('LaunchItem'));

console.log('\nShield agent: refuses to kill the operating system');

check(
  'system processes are deny-listed',
  ['explorer.exe', 'csrss.exe', 'winlogon.exe', 'lsass.exe', 'services.exe'].every((n) =>
    procRs.includes('"' + n + '"')
  )
);
check(
  'the deny-list is enforced in the kill path, not only at input',
  /fn capture_and_kill[\s\S]*?is_denied/.test(procRs)
);
check(
  'the deny-list is enforced again on config the page pushes down',
  /fn sh_set_config[\s\S]*?is_denied/.test(lib)
);

console.log('\nShield agent: config + icons');

const PAGES = 'https://anthonyn99.github.io';

check(
  'the window loads the live Pages URL (keeps CORS + App Check + Firestore origin intact)',
  conf.app.windows[0].url === PAGES + '/A1/shield.html',
  conf.app.windows[0].url
);
// The agent re-navigates on launch with a cache-busting query string, because
// WebView2 honours the Pages cache lifetime and was serving an old build after
// an update. The URL in the config and the one in the code must not drift.
const pageConst = (lib.match(/const PAGE_URL: &str = "([^"]+)"/) || [])[1];
check(
  'the URL constant in lib.rs matches the configured window URL',
  pageConst === conf.app.windows[0].url,
  pageConst + ' vs ' + conf.app.windows[0].url
);
check(
  'the agent re-navigates with a cache-buster so an update is never masked by cache',
  /\?v=\{\}-\{\}/.test(lib) && /w\.navigate\(/.test(lib)
);
check(
  'the capability grants invoke to that same origin',
  ((cap.remote || {}).urls || []).some((u) => u.startsWith(PAGES)),
  ((cap.remote || {}).urls || []).join(', ')
);
// The tray is built in code, not declared in tauri.conf.json — declaring it in
// both would create two tray icons. So the id the builder uses and the id
// publish() looks up have to match, and nothing but this checks that.
const trayBuilt = (lib.match(/TrayIconBuilder::with_id\("([^"]+)"\)/) || [])[1];
const trayUsed = (lib.match(/tray_by_id\("([^"]+)"\)/) || [])[1];
check('the tray is built in code, not duplicated in tauri.conf.json', !conf.app.trayIcon);
check('the tray id built matches the id looked up', !!trayBuilt && trayBuilt === trayUsed,
  trayBuilt + ' vs ' + trayUsed);
check('withGlobalTauri is on (the page uses window.__TAURI__)', conf.app.withGlobalTauri === true);
check('installs per-user, never to HKLM', conf.bundle.windows.nsis.installMode === 'currentUser');
check(
  'frontendDist points at a page that exists',
  fs.existsSync(path.join(AG, 'src-tauri', conf.build.frontendDist, 'index.html')),
  conf.build.frontendDist
);
check(
  'every bundle icon exists',
  conf.bundle.icon.every((i) => fs.existsSync(path.join(AG, 'src-tauri', i)))
);
const included = [...lib.matchAll(/include_bytes!\("([^"]+)"\)/g)].map((m) => m[1]);
check(
  'every include_bytes! icon exists',
  included.length > 0 && included.every((r) => fs.existsSync(path.resolve(SRC, r))),
  included.join(' ')
);
const mods = [...lib.matchAll(/^mod (\w+);/gm)].map((m) => m[1]);
check('every `mod` has a source file', mods.every((m) => fs.existsSync(path.join(SRC, m + '.rs'))), mods.join(', '));

console.log('\n' + '─'.repeat(64));
if (fail.length) {
  console.error('\n' + fail.length + ' agent-contract check(s) FAILED:\n');
  fail.forEach((f) => console.error('  • ' + f));
  console.error('\nThe UI and the agent have drifted apart. Fix before shipping.');
  process.exit(1);
}
console.log('All ' + pass.length + ' agent-contract checks passed.');

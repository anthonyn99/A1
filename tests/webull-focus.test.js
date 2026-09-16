// The morning's WeBull step must not lose a race with the browser.
//
// WHAT HAPPENED ON 2026-09-14
//   [06:47:25] AI analysis: adding 1 search tab(s) + MAGI to the TradeHub window...
//   [06:47:29] WeBull: could not focus the window — skipping tab/account switch.
//
// webull_post_launch runs LAST, four seconds after Brave was told to open tabs,
// and Brave raises its window asynchronously while it does that. Windows refuses
// SetForegroundWindow during another process's activation — that is the
// foreground lock, and AttachThreadInput does not lift it. _focus_window polls
// for about 1.6 seconds and then gives up, and the step's response to that was
// to return, skipping BOTH the Individual Margin switch and the Trackers tab.
//
// Nothing was broken about either action: they worked every morning through
// 09-11 and still do (verified against the live app). The regression was purely
// that the gate in front of them gave up too early, so this pins the gate.
//
// Run: node tests/webull-focus.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LAUNCH = path.join(ROOT, 'trading-auto-launch', 'launch.py');
const SRC = fs.readFileSync(LAUNCH, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

/** Run a snippet against the real module, with launch.py imported (not run). */
function py(body) {
  const prog = `
import importlib.util, json, time
spec = importlib.util.spec_from_file_location("al", r"${LAUNCH.replace(/\\/g, '\\\\')}")
al = importlib.util.module_from_spec(spec)
spec.loader.exec_module(al)
${body}
`;
  const r = spawnSync('python', ['-c', prog], { encoding: 'utf8' });
  if (r.status !== 0) return { err: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch (e) { return { err: 'unparsable: ' + (r.stdout || '').slice(0, 200) }; }
}

console.log('\nThe focus keeps asking while another app holds the foreground');
{
  // Brave's activation is transient: the answer a second later is usually yes.
  const out = py(`
calls = {"n": 0}
def flaky(hwnd):
    calls["n"] += 1
    return calls["n"] > 5          # refused five times, then allowed
al._focus_window = flaky
t0 = time.monotonic()
got = al._focus_window_patient(1234, timeout=12.0)
print(json.dumps({"ok": got, "calls": calls["n"], "secs": round(time.monotonic() - t0, 2)}))
`);
  ok('it imports', !out.err, out.err);
  ok('a window that refuses five times is still focused', out.ok === true, JSON.stringify(out));
  ok('  it really did retry', out.calls === 6, out.calls);
  ok('  and got there in a couple of seconds', out.secs < 5, out.secs);
}

console.log('\nBut it does give up, rather than hanging the morning');
{
  const out = py(`
al._focus_window = lambda hwnd: False
t0 = time.monotonic()
got = al._focus_window_patient(1234, timeout=1.5)
print(json.dumps({"ok": got, "secs": round(time.monotonic() - t0, 2)}))
`);
  ok('a window that never focuses reports failure', out.ok === false, JSON.stringify(out));
  ok('  bounded by its timeout', out.secs >= 1.4 && out.secs < 4, out.secs);
}

console.log('\nIt waits out whoever is currently grabbing the foreground');
{
  const out = py(`
seq = {"i": 0}
# Foreground flips for a moment -- Brave raising its window -- then settles.
def fg():
    seq["i"] += 1
    return 111 if seq["i"] < 6 else 222
al._u32.GetForegroundWindow = fg
t0 = time.monotonic()
al._foreground_settled(timeout=6.0, quiet=0.6)
print(json.dumps({"secs": round(time.monotonic() - t0, 2), "polls": seq["i"]}))
`);
  ok('it returns once the foreground holds still', out.secs > 0.5 && out.secs < 4, JSON.stringify(out));
  ok('  after actually watching it', out.polls > 4, out.polls);
}

console.log('\nAnd it cannot wait forever');
{
  const out = py(`
n = {"i": 0}
def fg():
    n["i"] += 1
    return n["i"]              # never the same twice: something keeps stealing focus
al._u32.GetForegroundWindow = fg
t0 = time.monotonic()
al._foreground_settled(timeout=1.2, quiet=0.5)
print(json.dumps({"secs": round(time.monotonic() - t0, 2)}))
`);
  ok('a desktop that never settles still gets its clicks attempted',
    out.secs >= 1.0 && out.secs < 3.5, JSON.stringify(out));
}

console.log('\nThe step itself is wired the way the fix intends');
{
  const fn = SRC.slice(SRC.indexOf('def webull_post_launch('), SRC.indexOf('def _primary_brave_hwnd('));
  ok('it settles before reaching for the foreground',
    fn.indexOf('_foreground_settled()') < fn.indexOf('_focus_window_patient'), 'order');
  ok('it is patient, not single-shot', /_focus_window_patient\(cand\)/.test(fn));
  ok('it tries the re-resolved window AND the one from launch',
    /for cand in \(_find_largest_title_window\("webull"\), hwnd\)/.test(fn));
  ok('  without trying the same window twice', /if not cand or cand in tried/.test(fn));
  // The account switch is what the user actually wants; the tab is cosmetic.
  ok('the account switch comes before the tab',
    fn.indexOf('webull_select_account') < fn.indexOf('WEBULL_TRACKERS_TAB'));
  // Clicking without the foreground would land the click in whatever IS in
  // front -- which during the morning is a browser full of open tabs.
  ok('it never clicks blind when it cannot focus',
    /not clicking blind/.test(fn) && /Clicking blind would land/.test(fn));
  ok('and both failures say what happened', (fn.match(/log\(/g) || []).length >= 4);
}

console.log('\nThe two WeBull actions are still both there');
{
  ok('Individual Margin is the target', /WEBULL_TARGET_ACCOUNT = "margin"/.test(SRC));
  ok('the Trackers tab is still clicked', /WEBULL_TRACKERS_TAB\s+= \(\d+, \d+\)/.test(SRC));
  ok('both run from the morning flow', /webull_post_launch\(webull_hwnd\)/.test(SRC));
  // 09-16: the step ran after the AI tab opened and lost the foreground to the
  // Vault extension, which holds that tab in front while it types. Order is the fix.
  const flow = SRC.slice(SRC.indexOf('webull_hwnd = open_webull()'));
  ok('WeBull acts BEFORE the AI step takes the foreground',
    flow.indexOf('webull_post_launch(webull_hwnd)') < flow.indexOf('open_chatgpt_analysis(target_hwnd=tradehub_hwnd)'));
  ok('and waits for WeBull to be READY rather than assuming a delay',
    /_wait_webull_ready\(\)/.test(SRC.slice(SRC.indexOf('def webull_post_launch('))));
  ok('the patient focus releases the foreground lock before giving up',
    /keybd_event\(_VK_MENU/.test(SRC.slice(SRC.indexOf('def _focus_window_patient('))));
  ok('and the switch is verified against WeBull’s own label, not assumed',
    /want in label\.lower\(\)/.test(SRC));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

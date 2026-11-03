// The daily analysis: TradeHub's Analysis prompt (2026-11-01) and its search
// tabs (2026-11-02) go out ON THEIR OWN, from launch.py --analysis, at 6 AM in the
// PC's own time zone or the first trigger after, standard and daylight time
// alike. It never waits for the Daily Reminder or for Trading Auto Launch, and
// the morning flow no longer opens either.
//
// The real module is imported (not run) and Brave, the network and the clock
// are stubbed, so nothing opens and nothing is sent.
//
// Run: node tests/daily-analysis.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LAUNCH = path.join(ROOT, 'tools', 'trading-auto-launch', 'launch.py');
const SRC = fs.readFileSync(LAUNCH, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

// Each run gets its own state file and log, so the real .last_analysis is never touched.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-analysis-'));
let n = 0;

/** Run the daily analysis against the real module with `now` as the local clock. */
function run({ now, ran = null, cfg, magiUp = true, test = false, tradehubOpen = false, braveOpen = false }) {
  const state = path.join(TMP, 'state' + (++n));
  if (ran) fs.writeFileSync(state, ran);
  const prog = `
import importlib.util, json, datetime as _dt
import ctypes, unittest.mock
if not hasattr(ctypes, 'windll'):
    ctypes.windll = unittest.mock.MagicMock()
    ctypes.WINFUNCTYPE = ctypes.CFUNCTYPE
spec = importlib.util.spec_from_file_location("al", r"${LAUNCH.replace(/\\/g, '\\\\')}")
al = importlib.util.module_from_spec(spec)
spec.loader.exec_module(al)
from pathlib import Path
NOW = _dt.datetime.fromisoformat(${JSON.stringify(now)})
class FakeDT(_dt.datetime):
    @classmethod
    def now(cls, tz=None): return NOW
class FakeDate(_dt.date):
    @classmethod
    def today(cls): return NOW.date()
al.datetime = FakeDT
al.date = FakeDate
al.ANALYSIS_STATE_FILE = Path(r"${state.replace(/\\/g, '\\\\')}")
al.LOG_FILE = Path(r"${path.join(TMP, 'log.txt').replace(/\\/g, '\\\\')}")
opened, logs = [], []
al.log = lambda m: logs.append(m)
al.wait_for_connectivity = lambda *a, **k: True
al._find_brave = lambda: "brave.exe"
al._set_clipboard_text = lambda t: True
al._fetch_analysis_config = lambda *a, **k: ${cfg === null ? 'None' : 'json.loads(' + JSON.stringify(JSON.stringify(cfg)) + ')'}
al._wait_for_magi_engine = lambda *a, **k: ${magiUp ? 'True' : 'False'}
class P:
    def __init__(self, args): opened.append(args)
al.subprocess.Popen = P
al._find_open_tradehub_window = lambda *a, **k: ${tradehubOpen ? 4242 : 'None'}
focused = []
al._focus_window = lambda h: focused.append(h) or True
al._primary_brave_hwnd = lambda: ${braveOpen ? 777 : 'None'}
al._all_brave_hwnds = lambda: set()
al._wait_for_new_brave_window = lambda *a, **k: None
gate = []
al.daily_reminder_gate = lambda: gate.append(1) or False
al.run_daily_analysis(test=${test ? 'True' : 'False'})
st = al.ANALYSIS_STATE_FILE.read_text().strip() if al.ANALYSIS_STATE_FILE.exists() else None
print(json.dumps({"opened": opened, "focused": focused, "marked": st, "gate": len(gate), "logs": logs}))
`;
  const r = spawnSync('python', ['-c', prog], { encoding: 'utf8' });
  if (r.status !== 0) return { err: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch (e) { return { err: 'unparsable: ' + (r.stdout || '').slice(0, 200) }; }
}

const MAGI = { ok: true, text: 'Daily prompt', name: 'Daily', aiUrl: 'https://anthonyn99.github.io/A1/magi/magi.html', magiUnits: ['chatgpt', 'claude'], searches: ['finviz.com'] };
const CHAT = { ok: true, text: 'Daily prompt', name: 'Daily', aiUrl: 'https://chatgpt.com/', searches: ['finviz.com'] };
const decode = (u) => JSON.parse(Buffer.from(/#tb=([^&]+)/.exec(u)[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

console.log('\n6 AM local, on a market day, once');
{
  // Mon 2026-11-02 is a market day.
  const a = run({ now: '2026-11-02T06:00:00', cfg: MAGI });
  ok('it imports and runs', !a.err, a.err);
  const ai = a.opened && a.opened[a.opened.length - 1];
  ok('at 6:00 local it sends the prompt to MAGI', ai && /magi\.html#tb=/.test(ai[1]), JSON.stringify(a.opened));
  const p = ai && decode(ai[1]);
  ok('…with the prompt and the ticked units, set to run', p && p.q === 'Daily prompt' && p.units.join() === 'chatgpt,claude' && p.run === 1, JSON.stringify(p));
  ok('…after opening the search tabs, in one new window when TradeHub is not open', a.opened && a.opened.length === 2 && a.opened[0].includes('--new-window') && a.opened[0].includes('https://finviz.com'), JSON.stringify(a.opened));
  ok('…and marks the day', a.marked === '2026-11-02', a.marked);
  ok('it never shows the Daily Reminder', a.gate === 0);

  const b = run({ now: '2026-11-02T05:59:00', cfg: MAGI });
  ok('before 6:00 local it sends nothing and leaves the day open', b.opened.length === 0 && b.marked === null, JSON.stringify(b));
  const c = run({ now: '2026-11-02T14:30:00', cfg: MAGI });
  ok('the first open of the day, however late, still sends it', c.opened.length === 2 && c.marked === '2026-11-02');
  const d = run({ now: '2026-11-02T09:00:00', ran: '2026-11-02', cfg: MAGI });
  ok('a second trigger the same day opens nothing', d.opened.length === 0, JSON.stringify(d.opened));
  const e = run({ now: '2026-11-03T06:05:00', ran: '2026-11-02', cfg: MAGI });
  ok('the next day it goes again', e.opened.length === 2 && e.marked === '2026-11-03');
  const h = run({ now: '2026-07-01T06:00:00', cfg: MAGI });
  ok('6:00 local in daylight time (July) goes too', h.opened.length === 2 && h.marked === '2026-07-01');
  const i = run({ now: '2026-07-01T05:59:00', cfg: MAGI });
  ok('…and 5:59 local in daylight time does not', i.opened.length === 0 && i.marked === null);
  const f = run({ now: '2026-11-01T08:00:00', cfg: MAGI });
  ok('a weekend sends nothing', f.opened.length === 0 && f.marked === null);
  const g = run({ now: '2026-11-26T08:00:00', cfg: MAGI });
  ok('an NYSE holiday (Thanksgiving) sends nothing', g.opened.length === 0);
}

console.log('\nThe destination is whatever TradeHub has selected');
{
  const a = run({ now: '2026-11-02T06:00:00', cfg: CHAT });
  ok('a chat site opens with the #tbauto marker for the Vault extension', a.opened.length === 2 && a.opened[1][1] === 'https://chatgpt.com/#tbauto', JSON.stringify(a.opened));
  const b = run({ now: '2026-11-02T06:00:00', cfg: { ...CHAT, aiUrl: '' } });
  ok('"no AI tab" is honoured (the searches still open), and the day counts as done', b.opened.length === 1 && b.opened[0].includes('https://finviz.com') && b.marked === '2026-11-02', JSON.stringify(b));
  const c = run({ now: '2026-11-02T06:00:00', cfg: null });
  ok('no prompt from the worker: nothing opens and the next trigger retries', c.opened.length === 0 && c.marked === null);
  const d = run({ now: '2026-11-02T06:00:00', cfg: MAGI, magiUp: false });
  ok('a MAGI engine still starting does not stop it (it opens after the wait)', d.opened.length === 2 && d.logs.some((l) => /did not answer/.test(l)));
  const e = run({ now: '2026-11-01T03:00:00', cfg: MAGI, test: true });
  ok('--test-analysis sends it now, whatever the day or hour, and marks nothing', e.opened.length === 2 && e.marked === null);
}

console.log('\nThe search tabs');
{
  const a = run({ now: '2026-11-02T06:00:00', cfg: MAGI, tradehubOpen: true });
  ok('an open TradeHub window gets them as tabs (no new window)', a.opened.length === 2 && a.opened[0].join() === 'brave.exe,https://finviz.com', JSON.stringify(a.opened));
  ok('…and the prompt is focused into that same window', a.focused.length === 2 && a.focused.every((h) => h === 4242), JSON.stringify(a.focused));
  // 2026-11-03: a window full of A1 tabs was open (no TradeHub tab in front) and
  // the searches + ChatGPT still went to a window of their own.
  const w = run({ now: '2026-11-02T06:00:00', cfg: CHAT, braveOpen: true });
  ok('any open Brave window gets them when TradeHub is not open (no new window)', w.opened.length === 2 && w.opened[0].join() === 'brave.exe,https://finviz.com' && !w.opened.some((x) => x.includes('--new-window')), JSON.stringify(w.opened));
  ok('…and the prompt goes into it too', w.opened[1][1] === 'https://chatgpt.com/#tbauto' && w.focused.length === 2 && w.focused.every((h) => h === 777), JSON.stringify(w.focused));
  const m = run({ now: '2026-11-02T06:00:00', cfg: { ...MAGI, searches: [] }, braveOpen: true });
  ok('no searches: MAGI still goes into the open window', m.opened.length === 1 && m.focused.join() === '777', JSON.stringify(m));
  const b = run({ now: '2026-11-02T06:00:00', cfg: { ...CHAT, searches: ['finviz.com', 'chatgpt.com', 'NVDA earnings'] } });
  ok('a search pointing at the AI destination is skipped; text becomes a Google search', b.opened[0].includes('https://finviz.com') && !b.opened[0].some((u) => /chatgpt/.test(u)) && b.opened[0].includes('https://www.google.com/search?q=NVDA%20earnings'), JSON.stringify(b.opened[0]));
  const c = run({ now: '2026-11-02T06:00:00', cfg: { ...MAGI, searches: [] } });
  ok('no searches: only the AI tab opens', c.opened.length === 1 && /magi\.html#tb=/.test(c.opened[0][1]));
  const d = run({ now: '2026-11-01T08:00:00', cfg: MAGI });
  ok('a weekend opens no searches either', d.opened.length === 0);
}

console.log('\nIt is its own task, and the morning flow no longer sends the prompt');
{
  const flow = SRC.slice(SRC.indexOf('def _launch_all('), SRC.indexOf('def deploy_from_tradehub('));
  ok('Trading Auto Launch opens neither the searches nor the prompt', !/open_analysis_searches\(|open_ai_prompt\(|run_daily_analysis\(/.test(flow));
  ok('setup registers TradingDailyAnalysis running --analysis', /ANALYSIS_TASK_NAME = "TradingDailyAnalysis"/.test(SRC) && /\(ANALYSIS_TASK_NAME, " --analysis"/.test(SRC) && /_register_task\(name, arg, limit, desc\)/.test(SRC));
  ok('…on the same four triggers (6 AM daily is the PC\'s local clock)', /-Trigger @\(\$dailyTrigger, \$logonTrigger, \$unlockTrigger, \$wakeTrigger\)/.test(SRC) && /New-ScheduledTaskTrigger -Daily -At \{TRIGGER_HOUR\}:00/.test(SRC) && /^ANALYSIS_HOUR\s+= 6$/m.test(SRC));
  ok('the 6 AM trigger is rewritten without a UTC offset (local wall clock all year, never pinned to UTC)', /\$dailyTrigger\.StartBoundary = \(Get-Date -Hour \{TRIGGER_HOUR\} -Minute 0 -Second 0\)\.ToString\("yyyy-MM-dd'T'HH:mm:ss"\)/.test(SRC));
  ok('nothing reads Mountain time any more', !/America\/Denver|Mountain Standard Time|mountain_/.test(SRC));
  ok('uninstall removes it too', /_remove_task\(ANALYSIS_TASK_NAME\)/.test(SRC));
  ok('the task description has no apostrophe to break the PowerShell string', !/"Sends[^"]*'/.test(SRC));
  ok('--analysis is wired to run_daily_analysis', /elif args\.analysis:\n\s+run_daily_analysis\(\)/.test(SRC));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

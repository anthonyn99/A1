// Veda's Rules must survive undo/redo (index.html, Veda's App).
//
// THE BUG: vxApply (undo/redo) rebuilt vdRef.current as a fresh object holding
// only data/habits/hc/goals/monthlyGoals/goalPrefs. buildVdPayload then wrote
// `rules: vdRef.current.rules||[]`, so the next save uploaded an empty list and
// every device's applyRemote adopted it: the rules "erased themselves" some time
// after an undo. This pins both halves of the fix.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 200) : '')); }
};

// Veda's block is the one that uses vdRef.
const vdStart = src.indexOf('const vdRef=useRef(');
if (vdStart < 0) throw new Error('Veda block (vdRef) not found in index.html');

console.log('\n-- vxApply keeps the rest of vdRef --');
{
  const i = src.indexOf('const vxApply=', vdStart);
  const line = src.slice(i, src.indexOf('\n', i));
  ok('Veda vxApply found', i > 0);
  ok('vxApply merges into ...vdRef.current', /vdRef\.current=\{\.\.\.vdRef\.current,/.test(line), line.slice(0, 200));
  ok('vxApply never rebuilds vdRef from scratch', !/vdRef\.current=\{data:/.test(line));
}

console.log('\n-- buildVdPayload never invents an empty rules list --');
const startMarker = 'const buildVdPayload=useCallback(()=>{';
const b0 = src.indexOf(startMarker, vdStart);
const b1 = src.indexOf('\n  },[]);', b0);
if (b0 < 0 || b1 < 0) throw new Error('buildVdPayload not found');
const body = src.slice(b0 + startMarker.length, b1);

function build(current, store) {
  const ls = store || {};
  const fn = new Function('vdRef', 'vdArchivedRef', 'loadJ', 'SK', 'GOAL_PREFS_DEF', 'RULES_DAILY_DEF', 'getMondayKey', body);
  return fn(
    { current },
    { current: {} },
    (k, fb) => (k in ls ? JSON.parse(ls[k]) : fb),
    { rules: 'td_rules', rulesDaily: 'td_rules_daily' },
    { hideShort: false, hideLong: false },
    { lastCompleted: null, lastShown: null, enabled: true },
    () => '2026-10-05'
  );
}
const base = { data: {}, habits: [], hc: {}, goals: [], monthlyGoals: [] };
const RULES = [{ id: 'a', text: 'No trade without a plan', created: 1 }, { id: 'b', text: 'One setup', created: 2 }];

{
  const p = build({ ...base, rules: RULES, rulesDaily: { enabled: false, lastShown: '2026-10-05' } });
  ok('rules in vdRef pass through unchanged', JSON.stringify(p.rules) === JSON.stringify(RULES), p.rules);
  ok('rulesDaily passes through', p.rulesDaily.enabled === false && p.rulesDaily.lastShown === '2026-10-05', p.rulesDaily);
}
{
  // The exact post-undo state: vdRef has no rules key at all.
  const p = build({ ...base }, { td_rules: JSON.stringify(RULES), td_rules_daily: JSON.stringify({ enabled: false }) });
  ok('missing rules fall back to the persisted list', JSON.stringify(p.rules) === JSON.stringify(RULES), p.rules);
  ok('missing rulesDaily falls back to the persisted value', p.rulesDaily && p.rulesDaily.enabled === false, p.rulesDaily);
}
{
  const p = build({ ...base });
  ok('nothing known anywhere -> rules field omitted, not []', !('rules' in p), p.rules);
  ok('nothing known anywhere -> rulesDaily omitted', !('rulesDaily' in p), p.rulesDaily);
}
{
  const p = build({ ...base, rules: [] }, { td_rules: JSON.stringify(RULES) });
  ok('a deliberate delete-all still sends []', Array.isArray(p.rules) && p.rules.length === 0, p.rules);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);

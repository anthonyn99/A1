#!/usr/bin/env node
/**
 * Neo — Veda's hands-free TaskHub assistant (TaskHub/veda-assistant.js).
 *
 * WHY THIS FILE EXISTS
 * Neo is VEDA-ONLY, but three of its four pieces live in shared places: the
 * voice engine in index.html (both TaskHubs use it), the personal-ai worker's
 * /taskhub/parse prompt (both profiles), and the page that hosts both sides.
 * These tests pin that Tony's side is untouched:
 *   · Tony's prompt carries none of Neo's actions or rules, and his state is
 *     shaped exactly as before (no tradingRules).
 *   · Neo's new action types do nothing against a bridge without Veda's methods.
 *   · veda-assistant.js never opens the mic unless the active profile is veda.
 * …and that Veda's new reach works (rules, navigation, AI prep, timer, off).
 *
 * Run: node tests/veda-assistant.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }
const ROOT = path.join(__dirname, '..');

// ── 1. worker prompt ────────────────────────────────────────────────────────
section('worker: Neo lines are Veda-only');
const wsrc = fs.readFileSync(path.join(ROOT, 'workers', 'personal-ai', 'worker.js'), 'utf8')
  .replace(/^export default\s*\{/m, 'const __workerDefault = {')
  .replace(/^export (?=(?:async )?function |const |let )/gm, '');
const wctx = { console, URL, Response: function (b) { this.body = b; }, fetch: () => Promise.reject(new Error('no network in tests')), setTimeout, clearTimeout, AbortController };
vm.createContext(wctx);
vm.runInContext(wsrc + '\n;globalThis.__T = { buildTaskPrompt, handleTaskhub, ACTION_SCHEMA };', wctx);
const W = wctx.__T;
const st = { today: '2026-11-05', calendar: {} };
const NEO_MARKERS = ['open_pc_app', 'open_site', 'pcApps', 'rules_add', 'open_app', 'prep_task', 'assistant_off', 'timer_close', 'reels_shuffle', 'Neo', 'SPOKEN ALOUD', 'QUESTIONS', 'butler', 'BRIEFINGS', 'PERSONALITY'];
for (const audio of [true, false]) {
  const tony = W.buildTaskPrompt('tony', 'x', st, '2026-11-05', 'Thursday', audio, { bulk: false, neo: true });
  const hits = NEO_MARKERS.filter(m => tony.includes(m));
  t(`Tony's prompt (${audio ? 'audio' : 'typed'}) has no Neo lines, even with neo:true`, !hits.length, hits.join(', '));
}
const vedaPlain = W.buildTaskPrompt('veda', 'x', st, '2026-11-05', 'Thursday', true, {});
const vedaNeo = W.buildTaskPrompt('veda', 'x', st, '2026-11-05', 'Thursday', true, { neo: true });
t('Veda\'s prompt offers the Neo actions', ['rules_add', 'open_app', 'prep_task', 'assistant_off', 'timer_close'].every(m => vedaPlain.includes(m)));
t('Veda\'s prompt answers questions in "say"', vedaPlain.includes('QUESTIONS'));
t('Veda\'s prompt carries the butler personality and briefings', vedaPlain.includes('British AI butler') && vedaPlain.includes('BRIEFINGS'));
t('the wake-word note only appears for a Neo capture', vedaNeo.includes('wake phrase "Hey Neo"') && !vedaPlain.includes('wake phrase "Hey Neo"'));
t('schema carries open_app\'s target', !!W.ACTION_SCHEMA.properties.actions.items.properties.target);

section('worker: state shaping');
(async () => {
  const seen = {};
  wctx.runModelChain = async (models, key, o) => { seen.prompt = o.prompt; throw new Error('stop'); };
  const env = { VEDA_GEMINI_KEY: 'v', TONY_GEMINI_KEY: 't' };
  const state = { data: {}, habits: [], rules: ['No trades after 3pm'], rulesDailyGate: true, timerOpen: false, pcApps: ['Spotify', 'Visual Studio Code'], onPc: true };
  await W.handleTaskhub({ profile: 'tony', transcript: 'what are my rules', state, today: '2026-11-05', mode: 'neo' }, env);
  t('Tony\'s state never carries tradingRules', !/tradingRules|No trades after 3pm|rulesDailyGate/.test(seen.prompt || ''));
  t('Tony\'s state never carries her PC\'s apps', !/pcApps|Visual Studio Code|"onPc"/.test(seen.prompt || ''));
  await W.handleTaskhub({ profile: 'veda', transcript: 'what are my rules', state, today: '2026-11-05', mode: 'neo' }, env);
  t('Veda\'s state carries her trading rules', /"tradingRules":\["No trades after 3pm"\]/.test(seen.prompt || ''));
  t('Veda\'s state carries her PC\'s app names and onPc', /"pcApps":\["Spotify","Visual Studio Code"\]/.test(seen.prompt || '') && /"onPc":true/.test(seen.prompt || ''));
  t('Veda\'s prompt offers open_pc_app / open_site', /open_pc_app/.test(seen.prompt || '') && /open_site/.test(seen.prompt || ''));
  t('Veda + mode:neo gets the wake-word note', (seen.prompt || '').includes('wake phrase "Hey Neo"'));

  // Tony's call: the same schema, item fields and prompt as before Neo grew.
  wctx.runModelChain = async (models, key, o) => { seen.prompt = o.prompt; seen.schema = o.schema; throw new Error('stop'); };
  const flagged = { data: { '2026-11-05': [{ id: 'x', title: 'Email prof', aiPrep: true, aiSite: 'claude', aiNote: 'secret note' }] }, habits: [],
    plans: [{ title: 'Dinner', stage: 'proposed', waitingOn: 'veda' }], marketCal: [{ date: '2026-11-06', title: 'NVDA Earnings', kind: 'earnings' }] };
  const prev = { said: 'add gym tomorrow', reply: 'Done.', did: [{ type: 'add_task', ok: true, id: 'u9', title: 'Gym', date: '2026-11-06' }] };
  await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev }, env);
  t('Tony\'s call keeps ACTION_SCHEMA exactly', seen.schema === W.ACTION_SCHEMA && !('aiPrep' in W.ACTION_SCHEMA.properties.actions.items.properties));
  t('Tony\'s items never show aiPrep; his state has no plans, earnings or previous turn', !/aiPrep|aiSite|"plans"|NVDA|previousTurn/.test(seen.prompt || ''));
  for (const m of ['close_pc_app', 'prep_off', 'plan_add', 'journal_entry', 'previousTurn', 'PREVIOUS TURN', 'clear_reminder']) {
    t(`Tony's prompt has no "${m}"`, !(seen.prompt || '').includes(m));
  }
  await W.handleTaskhub({ profile: 'veda', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev }, env);
  t('Veda\'s call uses her own wider schema', seen.schema && seen.schema !== W.ACTION_SCHEMA && !!seen.schema.properties.actions.items.properties.aiPrep && !!seen.schema.properties.actions.items.properties.set.properties.aiPrep);
  t('Veda\'s items show aiPrep / aiSite (never the note itself)', /"aiPrep":true/.test(seen.prompt) && /"aiSite":"claude"/.test(seen.prompt) && !/secret note/.test(seen.prompt));
  t('Veda\'s state carries plans, earnings and the previous turn (with the id)', /"waitingOn":"veda"/.test(seen.prompt) && /NVDA Earnings/.test(seen.prompt) && /"previousTurn":\{[^}]*"said":"add gym tomorrow"/.test(seen.prompt) && /"id":"u9"/.test(seen.prompt));

  // ── 2. voice engine (index.html) ──────────────────────────────────────────
  section('engine: Neo actions');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = html.indexOf("var WORKER='https://personal-ai.av1.workers.dev';");
  const end = html.indexOf('</script>', start);
  t('found the voice engine in index.html', start > 0 && end > start);
  const engine = html.slice(html.lastIndexOf('(function(){', start), end);

  function makeEngine(profile, bridge, fetchReply) {
    const ctx = {
      console, setTimeout, clearTimeout, JSON, Object, Array, String, Math, Date, Promise, Intl, Blob: function () {}, FileReader: function () {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { getElementById: () => null, addEventListener() {}, documentElement: { style: { setProperty() {} } }, body: {} },
      getComputedStyle: () => ({}),
      navigator: {},
      fetch: async () => ({ json: async () => fetchReply }),
    };
    ctx.window = ctx; ctx._activeProfile = profile;   // the context IS window, like a page
    if (profile === 'veda') ctx._vdVoice = bridge; else ctx._thVoice = bridge;
    vm.createContext(ctx);
    vm.runInContext(engine, ctx);
    return { THV: ctx._THV, win: ctx };
  }
  function vedaBridge(log) {
    let rules = [{ id: 'r1', text: 'No trades after 3pm' }, { id: 'r2', text: 'Always set a stop loss' }];
    const data = { '2026-11-05': [{ id: 'e1', type: 'task', title: 'Email professor', done: false, category: 'study' }] };
    return {
      profile: 'veda', uid: () => 'id' + Math.random().toString(36).slice(2, 7),
      getState: () => ({ data, habits: [], hc: {}, longGoals: [], shortGoals: [], selectedDate: '2026-11-05' }),
      mutateData() {}, mutateHabits() {}, mutateLongGoals() {}, mutateShortGoals() {}, mutateHc() {},
      getRules: () => rules.slice(), changeRules: fn => { rules = fn(rules.slice()); log.push(['rules', rules.map(r => r.text)]); },
      setRulesGate: on => log.push(['gate', on]), openRules: () => log.push(['openRules']),
      nav: tg => log.push(['nav', tg]), openPlans: () => log.push(['plans']), openShield: () => log.push(['shield']),
      openTimer: () => log.push(['timer']), closeTimer: () => log.push(['closeTimer']),
      reelsShuffle: () => log.push(['reels']), prep: (item, dk) => log.push(['prep', item.title, dk]),
      launchPc: (app, url) => { log.push(['launch', app, url]); return true; },
    };
  }
  const ACTIONS = [
    { type: 'rules_add', title: 'Journal every trade' },
    { type: 'rules_remove', match: { title: 'stop loss' } },
    { type: 'rules_edit', match: { title: 'trades after 3' }, set: { title: 'No trades after 2pm' } },
    { type: 'rules_gate', on: false },
    { type: 'open_app', target: 'notebook' },
    { type: 'open_app', target: 'gita' },
    { type: 'open_app', target: 'plans' },
    { type: 'prep_task', match: { title: 'email professor' } },
    { type: 'timer_close' },
    { type: 'reels_shuffle' },
    { type: 'open_pc_app', name: 'Spotify' },
    { type: 'open_site', url: 'https://www.youtube.com' },
  ];
  {
    const log = [];
    const neoCalls = [];
    const { THV, win } = makeEngine('veda', vedaBridge(log), { ok: true, actions: ACTIONS, say: 'Done' });
    win._vdNeo = { setOn: on => neoCalls.push(on) };
    t('engine exports sendAudio', THV && typeof THV.sendAudio === 'function');
    const r = await THV.sendAudio('AAAA', { extra: { mode: 'neo' }, silent: true });
    t('every Neo action applied on Veda\'s side', r.ok && r.n === ACTIONS.length, JSON.stringify(r));
    const lastRules = log.filter(l => l[0] === 'rules').pop();
    t('rules add / remove / edit land in order', JSON.stringify(lastRules && lastRules[1]) === JSON.stringify(['No trades after 2pm', 'Journal every trade']), JSON.stringify(lastRules));
    t('notebook → _vedaNav("journal")', log.some(l => l[0] === 'nav' && l[1] === 'journal'));
    t('gita → _vedaNav("gita")', log.some(l => l[0] === 'nav' && l[1] === 'gita'));
    t('prep_task finds the calendar task and its date', log.some(l => l[0] === 'prep' && l[1] === 'Email professor' && l[2] === '2026-11-05'));
    t('open_pc_app / open_site reach launchPc', log.some(l => l[0] === 'launch' && l[1] === 'Spotify' && l[2] === null) && log.some(l => l[0] === 'launch' && l[1] === null && l[2] === 'https://www.youtube.com'));
    t('rules gate / timer close / reels reached', ['gate', 'closeTimer', 'reels', 'plans'].every(k => log.some(l => l[0] === k)));
    const e3 = makeEngine('veda', vedaBridge([]), { ok: true, actions: [{ type: 'assistant_off' }], say: 'Bye' });
    const calls = []; e3.win._vdNeo = { setOn: on => calls.push(on) };
    await e3.THV.sendAudio('AAAA', { silent: true });
    t('assistant_off turns Neo off on Veda\'s side', calls.length === 1 && calls[0] === false);
  }

  section('engine: Tony\'s side is untouched');
  {
    const tonyLog = [];
    const tonyBridge = {
      profile: 'tony', uid: () => 'x', getState: () => ({ data: {}, habits: [], hc: {}, longGoals: [], shortGoals: [], selectedDate: '2026-11-05' }),
      mutateData() {}, mutateHabits() {}, mutateLongGoals() {}, mutateShortGoals() {}, mutateHc() {},
      openTimer: () => tonyLog.push('timer'), goToDate() {},
    };
    const { THV, win } = makeEngine('tony', tonyBridge, { ok: true, actions: ACTIONS.concat([{ type: 'assistant_off' }]), say: '' });
    const calls = []; win._vdNeo = { setOn: on => calls.push(on) };
    const r = await THV.sendAudio('AAAA', { silent: true });
    t('no Neo action applies on Tony\'s bridge', r.ok && r.n === 0, JSON.stringify(r));
    t('assistant_off never reaches Neo from Tony\'s side', calls.length === 0);
    t('nothing was called on Tony\'s bridge', tonyLog.length === 0, tonyLog.join(','));
    // The actions added for "full functionality" (2026-11-05) are just as inert there.
    const NEW = [{ type: 'prep_task', match: { title: 'x' } }, { type: 'prep_off', match: { title: 'x' } }, { type: 'prep_open', match: { title: 'x' } },
      { type: 'prep_show', match: { title: 'x' } }, { type: 'close_pc_app', name: 'Spotify' }, { type: 'close_all_pc_apps' }, { type: 'timer_mode', mode: 'short' },
      { type: 'timer_add', minutes: 5 }, { type: 'rules_run' }, { type: 'rules_check' }, { type: 'rules_move', match: { title: 'x' }, position: 'top' },
      { type: 'open_link', label: 'Shruti' }, { type: 'gita_next' }, { type: 'gita_open', lesson: 3 }, { type: 'week_view', collapsed: true },
      { type: 'goals_tab', target: 'long' }, { type: 'month_shift', by: 1 }, { type: 'lock_app', target: 'notebook' }, { type: 'journal_entry', text: 'hi' },
      { type: 'start_class', name: 'CS' }, { type: 'plan_add', title: 'Dinner' }, { type: 'plan_confirm', match: { title: 'Dinner' } }];
    const e2 = makeEngine('tony', tonyBridge, { ok: true, actions: NEW, say: 'Done' });
    const r2 = await e2.THV.sendAudio('AAAA', { silent: true });
    t('the new Neo actions do nothing on Tony\'s bridge either', r2.ok && r2.n === 0 && r2.results.every(x => !x.ok) && tonyLog.length === 0, JSON.stringify(r2.results.filter(x => x.ok)));
  }

  // ── 2b. the engine tells the truth: per-action results ────────────────────
  section('engine: every action reports what actually happened');
  {
    // A Veda bridge whose writes land, so the resulting state can be checked.
    function liveBridge(opts) {
      opts = opts || {};
      const st = { data: opts.data || {}, habits: [], hc: {}, longGoals: [], shortGoals: [], selectedDate: '2026-11-05' };
      let n = 0;
      const log = [];
      const b = {
        profile: 'veda', uid: () => 'u' + (++n),
        getState: () => st,
        mutateData: fn => { st.data = fn(st.data); }, mutateHabits() {}, mutateLongGoals() {}, mutateShortGoals() {}, mutateHc() {},
        prep: (item, dk) => { log.push(['prep', item.title, dk, item.aiPrep]); return Promise.resolve(opts.kit === undefined ? { summary: 'ok' } : opts.kit); },
        prepOpen: (item, dk) => { log.push(['prepOpen', item.title, dk]); return true; },
        launchPc: (app) => app === 'Photoshop' ? { ok: false, reason: 'not_found' } : Promise.resolve(app === 'Slack' ? { ok: false, reason: 'bridge_down', say: 'down' } : true),
        timer: (cmd, arg) => { log.push(['timer', cmd, arg]); return Promise.resolve(true); },
        changeRules: () => { const p = Promise.resolve('locked'); p.gated = true; return p; }, getRules: () => [{ id: 'r', text: 'No trades after 3pm' }],
      };
      return { b, st, log };
    }
    function engineWith(lb, extra) {
      const e = makeEngine('veda', lb.b, { ok: true, actions: [], say: '' });
      const nlog = [];
      e.win.thCancelNotif = (id, rid) => { nlog.push(['cancel', id, rid]); return new Promise(r => setTimeout(r, 5)); };
      e.win.thScheduleNotif = (it) => { nlog.push(['schedule', it.id, it.notifyAt]); };
      Object.assign(e.win, extra || {});
      return { THV: e.THV, nlog };
    }
    const day = (k, items) => ({ [k]: items });

    // not found / missing bridge / partial success
    {
      const lb = liveBridge({ data: day('2026-11-05', [{ id: 'a', type: 'task', title: 'Buy milk', category: 'personal' }]) });
      const { THV } = engineWith(lb);
      const r = THV.runActions([
        { type: 'toggle_task', match: { title: 'buy milk' }, done: true },
        { type: 'remove_task', match: { title: 'dentist appointment' } },
        { type: 'open_app', target: 'plans' },
      ]);
      t('partial success: n counts only what ran', r.n === 1, JSON.stringify(r.results));
      t('a task that isn\'t there is not_found', r.results[1].ok === false && r.results[1].reason === 'not_found');
      t('a bridge without the method is no_bridge', r.results[2].ok === false && r.results[2].reason === 'no_bridge');
      t('…and the one that worked really changed state', lb.st.data['2026-11-05'][0].done === true);
    }

    // AI prep: the flag is set, the kit is requested, the result arrives later
    {
      const lb = liveBridge({ data: day('2026-11-05', [{ id: 'p1', type: 'task', title: 'Email professor', category: 'study' }]) });
      const { THV } = engineWith(lb);
      const r = THV.runActions([{ type: 'prep_task', match: { title: 'email professor' }, aiNote: 'Ask about the midterm', aiSite: 'claude' }]);
      const it = lb.st.data['2026-11-05'][0];
      t('prep_task sets aiPrep:true on the task (so ✦ shows and the kit survives the stale sweep)', it.aiPrep === true && it.aiNote === 'Ask about the midterm' && it.aiSite === 'claude', JSON.stringify(it));
      t('…and asks for the kit with the flagged item', lb.log.some(l => l[0] === 'prep' && l[1] === 'Email professor' && l[3] === true));
      t('…reported as pending, not done', r.results[0].ok && r.results[0].pending === true);
      const later = await r.later;
      t('the kit landing settles it ok', later.length === 1 && later[0].ok === true);
      const lb2 = liveBridge({ data: day('2026-11-05', [{ id: 'p2', type: 'task', title: 'Essay', category: 'study' }]), kit: null });
      const later2 = await engineWith(lb2).THV.runActions([{ type: 'prep_task', match: { title: 'essay' } }]).later;
      t('a kit that never comes is a failure (prep_failed)', later2[0].ok === false && later2[0].reason === 'prep_failed');
      THV.runActions([{ type: 'prep_off', match: { title: 'email professor' } }]);
      const off = lb.st.data['2026-11-05'][0];
      t('prep_off removes all three keys', !('aiPrep' in off) && !('aiNote' in off) && !('aiSite' in off));
      const lb3 = liveBridge();
      engineWith(lb3).THV.runActions([{ type: 'add_task', box: 'calendar', date: '2026-11-06', title: 'Email the professor', category: 'study', aiPrep: true, aiSite: 'claude' }]);
      const added = lb3.st.data['2026-11-06'][0];
      t('add_task with aiPrep flags the new task and preps it', added.aiPrep === true && added.aiSite === 'claude' && lb3.log.some(l => l[0] === 'prep' && l[1] === 'Email the professor'));
      const r4 = engineWith(lb3).THV.runActions([{ type: 'prep_open', match: { title: 'email the professor' } }, { type: 'prep_open', match: { title: 'nothing like it' } }]);
      t('prep_open starts a flagged task; an unknown one is not_found', r4.results[0].ok && lb3.log.some(l => l[0] === 'prepOpen') && r4.results[1].reason === 'not_found');
    }

    // Reminders
    {
      const at = (d, h, m) => new Date(2026, 10, d, h, m || 0).toISOString();
      const lb = liveBridge({ data: day('2026-11-05', [
        { id: 'g', type: 'event', title: 'Gym', time: '17:00', category: 'health', notifyAt: at(5, 16, 45), notifyRepeat: 'none', notifyRepeatId: null },
        { id: 'm', type: 'event', title: 'Meeting', time: '10:00', category: 'work', notifyAt: at(5, 9, 30), notifyRepeat: 'weekly', notifyRepeatId: 'series1' },
      ]) });
      const { THV, nlog } = engineWith(lb);
      THV.runActions([{ type: 'edit_task', match: { title: 'meeting' }, set: { notify: { date: '2026-11-05', time: '09:00' } } }]);
      await new Promise(r => setTimeout(r, 30));
      const ci = nlog.findIndex(l => l[0] === 'cancel' && l[1] === 'm' && l[2] === 'series1'), si = nlog.findIndex(l => l[0] === 'schedule' && l[1] === 'm');
      t('a changed reminder cancels the old series first, then schedules the new one', ci >= 0 && si > ci, JSON.stringify(nlog));
      nlog.length = 0;
      THV.runActions([{ type: 'edit_task', match: { title: 'gym' }, set: { date: '2026-11-07' } }]);
      await new Promise(r => setTimeout(r, 30));
      const gym = lb.st.data['2026-11-07'] && lb.st.data['2026-11-07'][0];
      t('moving a task\'s date moves its reminder by the same days', gym && gym.notifyAt === at(7, 16, 45), gym && gym.notifyAt);
      nlog.length = 0;
      THV.runActions([{ type: 'edit_task', match: { title: 'gym' }, set: { time: '18:30' } }]);
      await new Promise(r => setTimeout(r, 30));
      t('a new event time keeps "15 minutes before" 15 minutes before', lb.st.data['2026-11-07'][0].notifyAt === at(7, 18, 15) && nlog.some(l => l[0] === 'cancel'));
      const r = THV.runActions([{ type: 'clear_reminder', match: { title: 'gym' } }, { type: 'clear_reminder', match: { title: 'gym' } }]);
      t('clear_reminder removes it; a second time says no_reminder', !lb.st.data['2026-11-07'][0].notifyAt && r.results[0].ok && r.results[1].reason === 'no_reminder', JSON.stringify(r.results));
      THV.runActions([{ type: 'edit_task', match: { title: 'gym' }, set: { notify: { date: '2026-11-07', time: '08:00', repeat: 'weekly', repeatDays: [0, 2] } } }]);
      const g2 = lb.st.data['2026-11-07'][0];
      t('repeating reminders carry their cadence and a series id', g2.notifyRepeat === 'weekly' && JSON.stringify(g2.notifyRepeatDays) === '[0,2]' && !!g2.notifyRepeatId);
    }

    // Moving keeps everything; ids; repeat scope
    {
      const rep = (k, id) => ({ id, type: 'task', title: 'Gym', category: 'health', repeat: 'weekly', repeatDays: [3], repeatId: 'R' });
      const lb = liveBridge({ data: Object.assign(
        day('2026-11-05', [{ id: 'e', type: 'task', title: 'Email professor', category: 'study', aiPrep: true, aiNote: 'n', aiSite: 'claude' }, rep('2026-11-05', 'g1')]),
        day('2026-11-12', [rep('2026-11-12', 'g2')]), day('2026-11-19', [rep('2026-11-19', 'g3')])) });
      const { THV } = engineWith(lb);
      THV.runActions([{ type: 'move_task', match: { title: 'email professor' }, toBox: 'calendar', toDate: '2026-11-06' }]);
      const mv = lb.st.data['2026-11-06'][0];
      t('move_task keeps the SAME item: id, AI prep and all', mv.id === 'e' && mv.aiPrep === true && mv.aiNote === 'n' && mv.aiSite === 'claude', JSON.stringify(mv));
      const r = THV.runActions([{ type: 'edit_task', match: { id: 'e' }, set: { title: 'Email Dr Smith' } }]);
      t('match.id finds the item the last turn touched', r.results[0].ok && lb.st.data['2026-11-06'][0].title === 'Email Dr Smith' && r.results[0].ref.id === 'e');
      THV.runActions([{ type: 'remove_task', match: { title: 'gym', date: '2026-11-12' }, scope: 'future' }]);
      t('remove scope:"future" takes this and later occurrences, never earlier ones',
        (lb.st.data['2026-11-05'] || []).some(x => x.id === 'g1') && !(lb.st.data['2026-11-12'] || []).length && !(lb.st.data['2026-11-19'] || []).length);
      const lb2 = liveBridge({ data: day('2026-11-05', [{ id: 'w', type: 'task', title: 'Water plants', category: 'personal' }]) });
      engineWith(lb2).THV.runActions([{ type: 'edit_task', match: { title: 'water plants' }, set: { repeat: 'daily' } }]);
      const days = Object.keys(lb2.st.data).filter(k => (lb2.st.data[k] || []).some(x => x.title === 'Water plants')).length;
      t('edit set.repeat fills in the future occurrences like the editor (15 days)', days === 15, String(days));
    }

    // PC actions and gated rules report through results
    {
      const lb = liveBridge();
      const { THV } = engineWith(lb);
      const r = THV.runActions([{ type: 'open_pc_app', name: 'Photoshop' }, { type: 'open_pc_app', name: 'Spotify' }, { type: 'open_pc_app', name: 'Slack' }, { type: 'rules_add', title: 'Journal trades' }]);
      t('an app she doesn\'t have fails at once (not_found)', r.results[0].ok === false && r.results[0].reason === 'not_found');
      t('a launch is pending until the bridge answers', r.results[1].ok && r.results[1].pending);
      t('a rule change behind the lock is marked gated', r.results[3].gated === true);
      const later = await r.later;
      t('bridge down / lock cancelled settle as failures with their reasons',
        later.find(l => l.action.name === 'Slack').reason === 'bridge_down' && later.find(l => l.action.type === 'rules_add').reason === 'locked', JSON.stringify(later.map(l => l.reason)));
      THV.runActions([{ type: 'timer_set', minutes: 25, start: true }]);
      t('"set 25 and start" is one action: set, then start', JSON.stringify(lb.log.filter(l => l[0] === 'timer').map(l => l[1])) === '["set","start"]');
    }

    // Neo can hold a destructive request for a yes/no before anything runs
    {
      const lb = liveBridge({ data: day('2026-11-07', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]) });
      const e = makeEngine('veda', lb.b, { ok: true, actions: [{ type: 'clear', box: 'calendar', date: '2026-11-07' }], say: 'Cleared.' });
      const r = await e.THV.sendAudio('AAAA', { silent: true, hold: () => ({ question: 'Shall I?' }) });
      t('a held request changes nothing and hands back the question', r.held && r.held.question === 'Shall I?' && r.n === 0 && lb.st.data['2026-11-07'].length === 2);
    }
  }

  section('index.html wiring');
  t('veda-assistant.js is loaded by index.html', /<script src="TaskHub\/veda-assistant\.js" defer><\/script>/.test(html));
  const vedaStart = html.indexOf('window._vdVoice={profile:"veda"');
  const tonyBlock = html.slice(html.indexOf('window._thVoice='), html.indexOf('window._thVoice=') + 3000);
  t('Veda\'s bridge exposes changeRules / nav / prep', vedaStart > 0 && /changeRules:/.test(html.slice(vedaStart, vedaStart + 4000)) && /prep:\(item,dk\)/.test(html.slice(vedaStart, vedaStart + 4000)));
  t('Tony\'s bridge gained none of them', !/changeRules|closeTimer|reelsShuffle|openShield/.test(tonyBlock));
  t('the Neo button sits only in Veda\'s header', (html.match(/key:"vx-neo"/g) || []).length === 1 && html.indexOf('key:"vx-neo"') > html.indexOf('window._vdVoice={profile:"veda"'));

  // ── 3. veda-assistant.js ──────────────────────────────────────────────────
  section('veda-assistant.js: profile gate');
  const asrc = fs.readFileSync(path.join(ROOT, 'TaskHub', 'veda-assistant.js'), 'utf8');
  function el() {
    const cls = new Set();
    return { style: {}, className: '', textContent: '', setAttribute() {}, appendChild() {}, remove() {}, querySelector: () => el(), set innerHTML(v) {}, onclick: null,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: c => cls.has(c) } };
  }
  const store = { vd_neo_on: '1' };
  let micCalls = 0;
  const actx = {
    console, URL, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, JSON, Math, Date, Promise, Float32Array, ArrayBuffer, DataView, Uint8Array, String, Array, Object,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { mediaDevices: { getUserMedia: () => { micCalls++; return new Promise(() => {}); } } },
  };
  actx.document = { hidden: false, addEventListener() {}, createElement: el, head: el(), body: el() };
  actx.window = actx; actx.dispatchEvent = () => {};
  actx._activeProfile = 'tony';
  vm.createContext(actx);
  vm.runInContext(asrc, actx);
  const N = actx._vdNeo;
  t('window._vdNeo exists', !!N);
  N._test.sync();
  t('on Tony\'s side the mic is never opened (even with Neo switched on)', micCalls === 0, 'getUserMedia calls: ' + micCalls);
  actx._activeProfile = null; N._test.sync();
  t('on the profile picker the mic is never opened', micCalls === 0);
  actx._activeProfile = 'veda'; N._test.sync();
  t('on Veda\'s side it starts listening', micCalls === 1);
  N.setOn(false);
  t('turning Neo off clears the saved preference', !('vd_neo_on' in store));

  section('veda-assistant.js: wake word + end-point');
  const T = N._test;
  t('"hey neo" wakes', T.isWake('hey neo'));
  t('"[unk] hey neo [unk]" wakes', T.isWake('[unk] hey neo [unk]'));
  t('"neo" alone / "okay neo" / "neo hey" do not wake (the phrase is "Hey Neo")', !T.isWake('neo') && !T.isWake('okay neo') && !T.isWake('[unk] neo [unk]') && !T.isWake('neo hey'));
  t('"neon" / "new" / "nemo" do not wake', !T.isWake('neon') && !T.isWake('new') && !T.isWake('nemo') && !T.isWake('[unk] [unk]'));
  t('grammar ends with [unk]', T.GRAMMAR[T.GRAMMAR.length - 1] === '[unk]' && T.GRAMMAR.includes('neo'));
  {
    const floor = 0.005, ms = 85;
    const s = { speech: false, silentMs: 0, elapsedMs: 0 };
    let r = 'go', steps = 0;
    for (let i = 0; i < 12 && r === 'go'; i++, steps++) r = T.vadStep(s, 0.08, floor, ms);       // ~1 s of speech
    t('keeps recording while she talks', r === 'go');
    while (r === 'go' && steps < 200) { r = T.vadStep(s, 0.002, floor, ms); steps++; }
    t('ends after ~1.4 s of silence', r === 'end' && s.silentMs >= 1400 && s.silentMs < 1500, r + ' ' + s.silentMs);
    const q = { speech: false, silentMs: 0, elapsedMs: 0 }; let r2 = 'go';
    while (r2 === 'go') r2 = T.vadStep(q, 0.002, floor, ms);
    t('gives up quietly when nothing is said', r2 === 'none' && q.elapsedMs >= 6000);
    const l = { speech: false, silentMs: 0, elapsedMs: 0 }; let r3 = 'go';
    while (r3 === 'go') r3 = T.vadStep(l, 0.08, floor, ms);
    t('caps a capture at 30 s', r3 === 'end' && l.elapsedMs >= 30000 && l.elapsedMs < 30100);
    t('the speech threshold rises with room noise', T.threshold(0.02) > T.threshold(0.001));
  }
  section('veda-assistant.js: the HUD\'s words');
  {
    const card = (a) => T.cardFor(a) || {};
    t('add_task → TASK ADDED with title and date', card({ type: 'add_task', box: 'calendar', title: 'Buy milk', date: '2026-11-06' }).label === 'TASK ADDED' && card({ type: 'add_task', box: 'calendar', title: 'Buy milk', date: '2026-11-06' }).detail === 'Buy milk · FRI 6 NOV');
    t('a timed add is an EVENT, with a 🔔 for a reminder', card({ type: 'add_task', title: 'Gym', time: '17:00', notify: { date: '2026-11-06', time: '16:45' } }).label === 'EVENT ADDED' && /17:00 · 🔔$/.test(card({ type: 'add_task', title: 'Gym', time: '17:00', notify: {} }).detail));
    t('habits and goals get their own labels', card({ type: 'add_task', box: 'dailyHabits', title: 'Read' }).label === 'HABIT ADDED' && card({ type: 'add_task', box: 'longTermGoals', title: 'X' }).label === 'GOAL ADDED');
    t('timer_set shows mm:00', card({ type: 'timer_set', minutes: 25 }).detail === '25:00');
    t('toggle off reads UNCHECKED', card({ type: 'toggle_task', match: { title: 'x' }, done: false }).label === 'UNCHECKED');
    t('rules, opening, prep and stand-down have cards', ['rules_add', 'open_app', 'prep_task', 'assistant_off', 'rules_gate'].every(ty => T.cardFor({ type: ty, title: 't', target: 'gita' })));
    t('every engine action type has a card', ['add_task', 'edit_task', 'remove_task', 'toggle_task', 'move_task', 'swap', 'reorder', 'clear', 'shift_range', 'clear_completed', 'go_to_date', 'set_edit_mode', 'refresh_quote', 'timer_set', 'timer_start', 'timer_stop', 'timer_reset', 'timer_open', 'timer_close', 'undo', 'redo', 'rules_edit', 'rules_remove', 'reels_shuffle'].every(ty => T.cardFor({ type: ty, days: 1 })));
    t('unknown actions show nothing', T.cardFor({ type: 'nope' }) === null);

    const at = (h, m) => { const d = new Date(2026, 10, 5, h, m || 0); return d; };
    const st = { data: { '2026-11-05': [{ id: 'a', title: 'Essay', done: true }, { id: 'b', title: 'Gym', time: '17:00' }, { id: 'c', title: 'Call mom' }] }, habits: [{ id: 'h1' }, { id: 'h2' }], hc: { 'h1-2026-10-5': true } };
    t('greeting: evening, counts and the next event', T.greeting(st, at(16, 30)) === 'Good afternoon, Veda. Neo online. Two tasks remain today; next up, Gym at 5 PM.', T.greeting(st, at(16, 30)));
    t('greeting: morning / evening / late', /^Good morning/.test(T.greeting(st, at(8))) && /^Good evening/.test(T.greeting(st, at(19))) && /^Working late/.test(T.greeting(st, at(2))));
    t('greeting: a clear day', T.greeting({ data: {} }, at(9)) === 'Good morning, Veda. Neo online. Your day is clear.');
    const ds = T.dayStats(st, at(16, 30));
    t('telemetry: tasks 1/3, habits 1/2, next Gym', ds.done === 1 && ds.total === 3 && ds.habitsDone === 1 && ds.habits === 2 && ds.next && ds.next.title === 'Gym');
    t('spoken times', T.spokenTime('17:00') === '5 PM' && T.spokenTime('07:30') === '7:30 AM' && T.spokenTime('12:00') === 'noon');

    section('veda-assistant.js: opening apps on her PC');
    const APPS = [{ id: 'a1', name: 'Spotify' }, { id: 'a2', name: 'Visual Studio Code' }, { id: 'a3', name: 'Google Chrome' }, { id: 'a4', name: 'Chrome Remote Desktop' },
      { id: 'a5', name: 'Word' }, { id: 'a6', name: 'Zoom Workplace' }, { id: 'a7', name: 'WhatsApp' }, { id: 'a8', name: 'Brave' }, { id: 'a9', name: 'Brave (TaskHub)' }];
    const m = (q) => (T.matchApp(q, APPS) || {}).name || null;
    t('exact names match', m('Spotify') === 'Spotify' && m('word') === 'Word' && m('Brave') === 'Brave');
    t('a name that starts the app\'s name ("Zoom" → Zoom Workplace)', m('Zoom') === 'Zoom Workplace');
    t('a word inside the name, shortest wins ("Chrome" → Google Chrome)', m('Chrome') === 'Google Chrome');
    t('word overlap ("Visual Studio" → Visual Studio Code)', m('Visual Studio') === 'Visual Studio Code');
    t('nicknames ("VS Code", "chrome") and never chrome_proxy', m('VS Code') === 'Visual Studio Code' && (T.matchApp('Chrome', APPS.concat([{ id: 'p', name: 'chrome_proxy' }])) || {}).name === 'Google Chrome');
    t('nothing close → null (Photoshop)', m('Photoshop') === null && m('') === null);
    t('urls: bare domains become https', T.webUrl('youtube.com') === 'https://youtube.com/' && T.webUrl('https://mail.google.com/x') === 'https://mail.google.com/x');
    t('urls: no javascript:, file: or junk', T.webUrl('javascript:alert(1)') === '' && T.webUrl('file:///C:/x') === '' && T.webUrl('spotify') === '');
    t('issue: an app she doesn\'t have is named', T.launchIssue({ ok: true }, ['Photoshop'], '', {}) === 'I couldn\'t find Photoshop on your PC, I\'m afraid.');
    t('issue: bridge down vs blocked', /StudyOS Bridge/.test(T.launchIssue(null, [], 'down', {})) && /local network access/.test(T.launchIssue(null, [], 'blocked-or-down', {})));
    t('issue: an app that failed to open is named', T.launchIssue({ ok: true, opened: [], unknown: ['a1'], failed: [] }, [], '', { a1: 'Spotify' }) === 'Spotify didn\'t open, I\'m afraid.');
    t('issue: none when everything opened', T.launchIssue({ ok: true, opened: ['a1'], unknown: [], failed: [] }, [], '', {}) === '');
    t('cards: LAUNCHING Spotify / OPENING youtube.com', T.cardFor({ type: 'open_pc_app', name: 'Spotify' }).label === 'LAUNCHING' && T.cardFor({ type: 'open_site', url: 'https://www.youtube.com/watch' }).detail === 'youtube.com');

    t('issue: a refused app is named from res.failed (names, not ids)', T.launchIssue({ ok: true, opened: [], unknown: [], failed: ['Word'] }, [], '', {}) === 'Word didn\'t open, I\'m afraid.');

    section('veda-assistant.js: saying only what happened');
    const R = (a, ok, reason, extra) => Object.assign({ action: a, ok, reason: reason || '' }, extra || {});
    const milk = { type: 'add_task', title: 'Buy milk' }, gym = { type: 'remove_task', match: { title: 'Gym' } };
    t('all worked → the model\'s line', T.compose('Done. Buy milk is on.', [R(milk, true)]) === 'Done. Buy milk is on.');
    t('nothing worked → only the failure, never "Done"', T.compose('Done. Gym is gone.', [R(gym, false, 'not_found')]) === 'I\'m afraid I couldn\'t find a task called Gym.');
    t('some worked → the line, then what didn\'t', T.compose('Added milk and removed gym.', [R(milk, true), R(gym, false, 'not_found')]) === 'Added milk and removed gym. I\'m afraid I couldn\'t find a task called Gym.');
    t('a question (no actions) → the answer', T.compose('You have two tasks left.', []) === 'You have two tasks left.');
    t('n=0 with an empty say still names the failure', /couldn't find/.test(T.compose('', [R(gym, false, 'not_found')])));
    t('a bridge\'s own line wins (Spotify wasn\'t running)', T.failLine(R({ type: 'close_pc_app', name: 'Spotify' }, false, 'not_running', { say: 'Spotify wasn\'t running.' })) === 'Spotify wasn\'t running.');
    t('closing off the PC says so', T.failLine(R({ type: 'close_pc_app', name: 'Spotify' }, false, 'off_pc')) === 'I can only close apps on your PC, Veda.');
    t('duplicate lines are said once', T.failSpeech([R({ type: 'open_pc_app', name: 'A' }, false, 'off_pc'), R({ type: 'open_pc_app', name: 'B' }, false, 'off_pc')]) === 'I can only open apps from your PC, Veda.');
    t('a failed action gets a red ✕ card', T.failCard(R(gym, false, 'not_found')).bad === true && /COULDN'T/.test(T.failCard(R(gym, false, 'not_found')).label));
    t('cards: CLOSING / FORCE QUIT / AI PREP OFF / PLAN CONFIRMED', T.cardFor({ type: 'close_pc_app', name: 'Spotify' }).label === 'CLOSING' && T.cardFor({ type: 'close_pc_app', name: 'X', force: true }).label === 'FORCE QUIT'
      && T.cardFor({ type: 'prep_off', match: { title: 'x' } }).label === 'AI PREP OFF' && T.cardFor({ type: 'plan_confirm', match: { title: 'x' } }).label === 'PLAN CONFIRMED');
    const NEO_TYPES = ['prep_task', 'prep_off', 'prep_open', 'prep_show', 'close_pc_app', 'close_all_pc_apps', 'clear_reminder', 'timer_mode', 'timer_add', 'rules_run', 'rules_check', 'rules_move',
      'open_link', 'gita_next', 'gita_prev', 'gita_open', 'week_view', 'goals_tab', 'month_shift', 'lock_app', 'journal_entry', 'start_class',
      'plan_add', 'plan_propose', 'plan_confirm', 'plan_decline', 'plan_cancel_request', 'plan_done'];
    t('every Neo action in the prompt has a card', NEO_TYPES.every(ty => T.cardFor({ type: ty, text: 'x' })), NEO_TYPES.filter(ty => !T.cardFor({ type: ty, text: 'x' })).join(','));
    t('…and an executor in the engine', NEO_TYPES.every(ty => html.includes("case '" + ty + "'")), NEO_TYPES.filter(ty => !html.includes("case '" + ty + "'")).join(','));
    t('…and a line in Veda\'s prompt', NEO_TYPES.every(ty => vedaPlain.includes('"' + ty + '"')), NEO_TYPES.filter(ty => !vedaPlain.includes('"' + ty + '"')).join(','));
    const merged = T.mergeLater([R(milk, true), R({ type: 'open_pc_app', name: 'Slack' }, true, '', { pending: true })], [{ action: null }, { action: null }]);
    t('mergeLater keeps an unsettled pending result as it was', merged[1].pending === true);
    const sl = { type: 'open_pc_app', name: 'Slack' };
    const merged2 = T.mergeLater([R(sl, true, '', { pending: true })], [{ action: sl, ok: false, reason: 'bridge_down', say: 'Start the bridge.' }]);
    t('…and turns a failed outcome into a failure with its line', merged2[0].ok === false && T.failLine(merged2[0]) === 'Start the bridge.');

    section('veda-assistant.js: asking first');
    const sat = { data: { '2026-11-07': [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }, selectedDate: '2026-11-05' };
    t('clearing a day asks, with the count and the day', (T.needsConfirm([{ type: 'clear', box: 'calendar', date: '2026-11-07' }], sat) || {}).question === 'Shall I clear all two items on Saturday the 7th?');
    t('more than three removals ask', /remove four items/.test((T.needsConfirm([gym, gym, gym, gym], sat) || {}).question || ''));
    t('one removal does not ask', T.needsConfirm([gym], sat) === null && T.needsConfirm([milk], sat) === null);
    t('shift_range / clear_completed / close_all ask', ['shift_range', 'clear_completed', 'close_all_pc_apps'].every(ty => T.needsConfirm([{ type: ty, days: 1, from: '2026-11-09', to: '2026-11-15' }], sat)));
    t('confirming a plan with no date asks first', /no date yet/.test((T.needsConfirm([{ type: 'plan_confirm', match: { title: 'dinner' } }], { plans: [{ title: 'Dinner at Nobu', stage: 'proposed' }] }) || {}).question || ''));
    t('yes / no', T.isYes('yes') && T.isYes('yeah go ahead') && T.isYes('do it') && T.isNo('no') && T.isNo('never mind') && !T.isYes('no') && !T.isNo('yes please'));

    section('veda-assistant.js: closing apps, websites on the phone, the timer queue');
    t('close: closed → nothing to say', T.closeNote('Spotify', { closed: ['Spotify'] }) === '');
    t('close: not running', T.closeNote('Spotify', { closed: [], notRunning: ['Spotify'] }).say === 'Spotify wasn\'t running.');
    t('close: asking to save is left open, and said', /asking to save, so I've left it open/.test(T.closeNote('Word', { closed: [], stillOpen: ['Word'] }).say));
    t('off her PC, an app can\'t be closed or opened', T.queueClose('Spotify', false).reason === 'off_pc' && T.queueLaunch('Spotify', null).reason === 'off_pc');
    const opened = []; actx.open = (u) => { opened.push(u); return {}; };
    t('…but a website opens on the phone in a new tab', T.queueLaunch(null, 'youtube.com') === true && opened[0] === 'https://youtube.com/');
    actx.open = () => null;
    t('…and a blocked pop-up is said, not claimed', T.queueLaunch(null, 'youtube.com').reason === 'blocked');
    {
      const ran = [];
      let gen = 0;
      const mk = () => { const g = ++gen; return (cmd, arg) => { ran.push([cmd, arg, g]); actx._vdTimerExec = mk(); }; };
      actx._vdTimerExec = mk();
      const p1 = T.timerRun('set', 25), p2 = T.timerRun('start');
      const v = await Promise.all([p1, p2]);
      t('timer: "set" then "start", each on a fresh hook (never the stale one)', v[0] === true && v[1] === true && ran.length === 2 && ran[0][0] === 'set' && ran[1][0] === 'start' && ran[1][2] === ran[0][2] + 1, JSON.stringify(ran));
    }
    {
      let locked = null;
      actx.Guardian = { status: id => ({ hasLock: id === 'veda_journal' }), lockNow: id => { locked = id; } };
      t('lock_app locks a program that has a lock', T.ops.lockApp('notebook') === true && locked === 'veda_journal');
      t('…and says when there is none', T.ops.lockApp('gita').reason === 'no_lock');
      const openedL = [];
      actx._navGetLinks = () => [{ id: 'l1', label: 'Shruti' }, { id: 'l2', label: 'Study Playlist' }];
      actx._navOpenLink = (p, id) => openedL.push([p, id]);
      t('open_link opens a header link by its label', T.ops.openLink('shruti') === true && openedL[0][0] === 'veda' && openedL[0][1] === 'l1');
      t('…an unknown label is not_found', T.ops.openLink('Netflix').reason === 'not_found');
    }

    const V = (name, lang) => ({ name, lang });
    t('voice: Ryan via Orca is the default', T.VOICE === 'en-GB-RyanNeural');
    t('fallback: Microsoft Ryan first', T.pickVoiceFrom([V('Microsoft Aria Online', 'en-US'), V('Microsoft Ryan Online (Natural)', 'en-GB')]).name.startsWith('Microsoft Ryan'));
    t('fallback: Google UK English Male next', T.pickVoiceFrom([V('Google US English', 'en-US'), V('Google UK English Female', 'en-GB'), V('Google UK English Male', 'en-GB')]).name === 'Google UK English Male');
    t('fallback: any en-GB, then any English', T.pickVoiceFrom([V('X', 'en-US'), V('Y', 'en-GB')]).name === 'Y' && T.pickVoiceFrom([V('X', 'en-US')]).name === 'X');
  }
  {
    const buf = T.encodeWav([new Float32Array(48000)], 48000, 16000);
    const dv = new DataView(buf);
    t('WAV is 16 kHz mono, 1 s → 32044 bytes', buf.byteLength === 44 + 32000 && dv.getUint32(24, true) === 16000 && dv.getUint16(22, true) === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

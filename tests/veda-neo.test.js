#!/usr/bin/env node
/**
 * Neo — the hands-free TaskHub assistant (TaskHub/veda-assistant.js).
 *
 * WHY THIS FILE EXISTS
 * Neo was Veda's alone until 2026-11-06; now each side has its own. Its pieces
 * live in shared places: the voice engine in index.html (both TaskHubs use
 * it), the personal-ai worker's /taskhub/parse prompt (both profiles), and the
 * page that hosts both sides. These tests pin:
 *   · Tony's mic and text buttons are untouched: without mode:"neo" his prompt
 *     carries none of Neo's actions or rules and his state, schema and item
 *     fields are shaped exactly as before.
 *   · Tony's Neo (mode:"neo") gets his own lines (his name, his reach) and
 *     never Veda's (trading rules, Gita lessons, classes, reels).
 *   · Neo's action types do nothing against a bridge without Neo's methods.
 *   · veda-assistant.js opens the mic only for the side in front, and only if
 *     that side switched Neo on; never on the profile picker.
 * …and that Veda's reach works (rules, navigation, AI prep, timer, off).
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
section('worker: Neo lines per side');
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
  const tony = W.buildTaskPrompt('tony', 'x', st, '2026-11-05', 'Thursday', audio, { bulk: false });
  const hits = NEO_MARKERS.filter(m => tony.includes(m));
  t(`Tony's mic/text prompt (${audio ? 'audio' : 'typed'}) has no Neo lines`, !hits.length, hits.join(', '));
}
{
  const tonyNeo = W.buildTaskPrompt('tony', 'x', st, '2026-11-05', 'Thursday', true, { neo: true });
  t('Tony\'s Neo prompt offers his Neo actions', ['open_pc_app', 'open_site', 'prep_task', 'assistant_off', 'timer_close', 'plan_add', 'journal_entry', 'lock_app'].every(m => tonyNeo.includes(m)));
  t('Tony\'s Neo prompt is his: his name, the butler, briefings', tonyNeo.includes('TONY\'S ASSISTANT') && tonyNeo.includes('British AI butler') && tonyNeo.includes('"Tony" or "sir"') && tonyNeo.includes('BRIEFINGS') && tonyNeo.includes('wake phrase "Hey Neo"'));
  const vedaOnly = ['rules_add', 'rules_check', 'gita_next', 'start_class', 'reels_shuffle', 'VEDA\'S ASSISTANT', 'Address her', 'tradingRules'];
  const leak = vedaOnly.filter(m => tonyNeo.includes(m));
  t('Tony\'s Neo prompt carries none of Veda\'s own reach', !leak.length, leak.join(', '));
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
  await W.handleTaskhub({ profile: 'tony', transcript: 'what are my rules', state, today: '2026-11-05' }, env);
  t('Tony\'s mic/text state never carries tradingRules', !/tradingRules|No trades after 3pm|rulesDailyGate/.test(seen.prompt || ''));
  t('Tony\'s mic/text state never carries PC apps', !/pcApps|Visual Studio Code|"onPc"/.test(seen.prompt || ''));
  await W.handleTaskhub({ profile: 'tony', transcript: 'what are my rules', state, today: '2026-11-05', mode: 'neo' }, env);
  t('Tony\'s Neo state never carries tradingRules', !/tradingRules|No trades after 3pm|rulesDailyGate/.test(seen.prompt || ''));
  t('Tony\'s Neo state carries his PC\'s app names and onPc', /"pcApps":\["Spotify","Visual Studio Code"\]/.test(seen.prompt || '') && /"onPc":true/.test(seen.prompt || ''));
  await W.handleTaskhub({ profile: 'veda', transcript: 'what are my rules', state, today: '2026-11-05', mode: 'neo' }, env);
  t('Veda\'s state carries her trading rules', /"tradingRules":\["No trades after 3pm"\]/.test(seen.prompt || ''));
  t('Veda\'s state carries her PC\'s app names and onPc', /"pcApps":\["Spotify","Visual Studio Code"\]/.test(seen.prompt || '') && /"onPc":true/.test(seen.prompt || ''));
  t('Veda\'s prompt offers open_pc_app / open_site', /open_pc_app/.test(seen.prompt || '') && /open_site/.test(seen.prompt || ''));
  t('Veda + mode:neo gets the wake-word note', (seen.prompt || '').includes('wake phrase "Hey Neo"'));

  // Tony's mic/text call: the same schema, item fields and prompt as before Neo grew.
  wctx.runModelChain = async (models, key, o) => { seen.prompt = o.prompt; seen.schema = o.schema; throw new Error('stop'); };
  const flagged = { data: { '2026-11-05': [{ id: 'x', title: 'Email prof', aiPrep: true, aiSite: 'claude', aiNote: 'secret note' }] }, habits: [],
    plans: [{ title: 'Dinner', stage: 'proposed', waitingOn: 'veda' }], marketCal: [{ date: '2026-11-06', title: 'NVDA Earnings', kind: 'earnings' }] };
  const prev = { said: 'add gym tomorrow', reply: 'Done.', did: [{ type: 'add_task', ok: true, id: 'u9', title: 'Gym', date: '2026-11-06' }] };
  await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: flagged, today: '2026-11-05', prev }, env);
  t('Tony\'s call keeps ACTION_SCHEMA exactly', seen.schema === W.ACTION_SCHEMA && !('aiPrep' in W.ACTION_SCHEMA.properties.actions.items.properties));
  t('Tony\'s items never show aiPrep; his state has no plans, earnings or previous turn', !/aiPrep|aiSite|"plans"|NVDA|previousTurn/.test(seen.prompt || ''));
  for (const m of ['close_pc_app', 'prep_off', 'plan_add', 'journal_entry', 'previousTurn', 'PREVIOUS TURN', 'clear_reminder']) {
    t(`Tony's mic/text prompt has no "${m}"`, !(seen.prompt || '').includes(m));
  }
  await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev }, env);
  t('Tony\'s Neo call uses the wider schema', seen.schema && seen.schema !== W.ACTION_SCHEMA && !!seen.schema.properties.actions.items.properties.aiPrep);
  t('Tony\'s Neo state shows aiPrep (never the note), plans, earnings and the previous turn', /"aiPrep":true/.test(seen.prompt) && !/secret note/.test(seen.prompt) && /"waitingOn":"veda"/.test(seen.prompt) && /NVDA Earnings/.test(seen.prompt) && /"previousTurn":\{[^}]*"said":"add gym tomorrow"/.test(seen.prompt));
  await W.handleTaskhub({ profile: 'veda', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev }, env);
  t('Veda\'s call uses her own wider schema', seen.schema && seen.schema !== W.ACTION_SCHEMA && !!seen.schema.properties.actions.items.properties.aiPrep && !!seen.schema.properties.actions.items.properties.set.properties.aiPrep);
  t('Veda\'s items show aiPrep / aiSite (never the note itself)', /"aiPrep":true/.test(seen.prompt) && /"aiSite":"claude"/.test(seen.prompt) && !/secret note/.test(seen.prompt));
  {
    const history = [{ said: 'add dentist friday', reply: 'Which time, Veda?', did: [] }, { said: 'move gym to 5', reply: 'Done.', did: [{ type: 'edit_task', ok: true, id: 'g1', title: 'Gym' }] }, prev];
    await W.handleTaskhub({ profile: 'veda', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev, history }, env);
    t('Veda\'s state carries the earlier turns as conversation (oldest first, the last stays previousTurn)', /"conversation":\[\{"said":"add dentist friday"/.test(seen.prompt) && /"id":"g1"/.test(seen.prompt) && /CONVERSATION/.test(seen.prompt) && /CLARIFYING/.test(seen.prompt));
    await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: flagged, today: '2026-11-05', prev, history }, env);
    t('Tony\'s mic/text prompt never carries a conversation', !/conversation|CONVERSATION|add dentist friday|TRANSCRIPT: transcribe what Veda/.test(seen.prompt || ''));
    await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev, history }, env);
    t('Tony\'s Neo prompt carries the conversation too', /"conversation":\[\{"said":"add dentist friday"/.test(seen.prompt) && /CONVERSATION/.test(seen.prompt));
    await W.handleTaskhub({ profile: 'veda', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev }, env);
  }
  {
    const progs = [{ id: 'studyos', label: 'StudyOS', ops: ['add_task(title, date?)'], summary: '4 classes; next: Bio quiz Mon' }, { id: 'warden', label: 'Warden' }];
    await W.handleTaskhub({ profile: 'veda', transcript: 'x', state: Object.assign({}, flagged, { programs: progs }), today: '2026-11-05', mode: 'neo' }, env);
    t('Veda\'s state carries her programs (id, label, ops, summary)', /"programs":\[\{"id":"studyos","label":"StudyOS","ops":\["add_task\(title, date\?\)"\],"summary":"4 classes; next: Bio quiz Mon"\}/.test(seen.prompt) && /open_program/.test(seen.prompt) && /\{type:"program", program, op/.test(seen.prompt));
    t('…and her schema carries program / op / args as [{k, v}]', !!seen.schema.properties.actions.items.properties.program && seen.schema.properties.actions.items.properties.args.items.properties.k.type === 'STRING');
    await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: Object.assign({}, flagged, { programs: progs }), today: '2026-11-05', mode: 'neo' }, env);
    t('Tony\'s Neo prompt offers no program actions', !/open_program|type:"program"|Her other programs/.test(seen.prompt));
    await W.handleTaskhub({ profile: 'tony', transcript: 'x', state: Object.assign({}, flagged, { programs: progs }), today: '2026-11-05' }, env);
    t('Tony\'s mic/text prompt never carries programs', !/"programs"|Bio quiz/.test(seen.prompt));
    await W.handleTaskhub({ profile: 'veda', transcript: 'x', state: flagged, today: '2026-11-05', mode: 'neo', prev }, env);
  }
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
    const pl = [];
    const vb = Object.assign(vedaBridge([]), { openProgram: (q, deep) => { pl.push(['open', q, deep]); return true; }, program: (q, op, args) => { pl.push(['run', q, op, args]); return { ok: false, reason: 'no_op' }; } });
    const e5 = makeEngine('veda', vb, { ok: true, actions: [{ type: 'open_program', program: 'studyos' }, { type: 'program', program: 'mylist', op: 'add_item', args: [{ k: 'text', v: 'milk' }] }], say: 'Done' });
    const r5 = await e5.THV.sendAudio('AAAA', { extra: { mode: 'neo' }, silent: true });
    t('open_program reaches her bridge', r5.results[0].ok && pl[0][0] === 'open' && pl[0][1] === 'studyos');
    t('program passes op and args, and its {ok:false, reason} is reported', !r5.results[1].ok && r5.results[1].reason === 'no_op' && pl[1][2] === 'add_item' && pl[1][3][0].v === 'milk', JSON.stringify(r5.results[1]));
  }

  section('engine: a bridge without Neo\'s methods (Tony\'s mic) is untouched');
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
    t('no Neo action applies on a bridge without Neo\'s methods (assistant_off aside)', r.ok && r.n === 1 && r.results.filter(x => x.ok).every(x => x.action.type === 'assistant_off'), JSON.stringify(r.results.filter(x => x.ok)));
    t('assistant_off turns Tony\'s Neo off on his side', calls.length === 1 && calls[0] === false);
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
    const e4 = makeEngine('tony', tonyBridge, { ok: true, actions: [{ type: 'open_program', program: 'studyos' }, { type: 'program', program: 'studyos', op: 'add_task', args: [{ k: 'title', v: 'x' }] }], say: 'Done' });
    const r4 = await e4.THV.sendAudio('AAAA', { silent: true });
    t('open_program / program do nothing on Tony\'s side', r4.n === 0 && r4.results.every(x => !x.ok && x.reason === 'no_bridge'), JSON.stringify(r4.results));
    t('the newer Neo actions do nothing there either', r2.ok && r2.n === 0 && r2.results.every(x => !x.ok) && tonyLog.length === 0, JSON.stringify(r2.results.filter(x => x.ok)));
  }

  section('engine: Tony\'s Neo drives his own bridge');
  {
    const log = [];
    const data = { '2026-11-05': [{ id: 'e1', type: 'task', title: 'Email landlord', done: false, category: 'personal' }] };
    const tb = {
      profile: 'tony', uid: () => 'id' + Math.random().toString(36).slice(2, 7),
      getState: () => ({ data, habits: [], hc: {}, longGoals: [], shortGoals: [], selectedDate: '2026-11-05' }),
      mutateData() {}, mutateHabits() {}, mutateLongGoals() {}, mutateShortGoals() {}, mutateHc() {},
      nav: tg => log.push(['nav', tg]), openPlans: () => log.push(['plans']), openShield: () => log.push(['shield']),
      openTimer: () => log.push(['timer']), closeTimer: () => log.push(['closeTimer']), timer: c => { log.push(['timer', c]); return true; },
      timerMode: () => true, timerAdd: () => true, prep: (item, dk) => { log.push(['prep', item.title, dk]); return null; },
      launchPc: (app, url) => { log.push(['launch', app, url]); return true; }, weekView: v => { log.push(['week', v]); return true; },
      journalEntry: tx => { log.push(['journal', tx]); return true; }, goToDate() {},
    };
    const acts = [{ type: 'open_app', target: 'notebook' }, { type: 'open_app', target: 'plans' }, { type: 'open_app', target: 'shield' }, { type: 'timer_close' },
      { type: 'prep_task', match: { title: 'email landlord' } }, { type: 'open_pc_app', name: 'Spotify' }, { type: 'week_view', collapsed: true }, { type: 'journal_entry', text: 'Good day' },
      { type: 'rules_add', title: 'x' }, { type: 'gita_next' }, { type: 'reels_shuffle' }, { type: 'start_class', name: 'CS' }];
    const e = makeEngine('tony', tb, { ok: true, actions: acts, say: 'Done' });
    const r = await e.THV.sendAudio('AAAA', { extra: { mode: 'neo' }, silent: true });
    t('Tony\'s Neo actions apply on his bridge', r.results.slice(0, 8).every(x => x.ok), JSON.stringify(r.results.slice(0, 8).filter(x => !x.ok)));
    t('Veda\'s own reach stays out of it (rules, Gita, reels, classes)', r.results.slice(8).every(x => !x.ok && x.reason === 'no_bridge'), JSON.stringify(r.results.slice(8)));
    t('notebook → his Notebook, prep finds his task', log.some(l => l[0] === 'nav' && l[1] === 'journal') && log.some(l => l[0] === 'prep' && l[1] === 'Email landlord' && l[2] === '2026-11-05'));
    e.THV.runActions([{ type: 'timer_set', minutes: 25, start: true }]);
    t('"set 25 and start" sets then starts on his side too', JSON.stringify(log.filter(l => l[0] === 'timer' && l[1]).map(l => l[1])) === '["set","start"]');
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

    // spotlight: preview() names what each action touches, and changes nothing
    {
      const lb = liveBridge({ data: day('2026-11-05', [{ id: 'a', type: 'task', title: 'Buy milk', category: 'personal' }, { id: 'b', type: 'task', title: 'Gym', category: 'health' }]) });
      const { THV } = engineWith(lb);
      const before = JSON.stringify(lb.b.getState().data);
      const pv = THV.preview([
        { type: 'add_task', box: 'calendar', date: '2026-11-20', title: 'Essay draft', category: 'study' },
        { type: 'remove_task', match: { title: 'buy milk' } },
        { type: 'edit_task', match: { title: 'gym' }, set: { title: 'Gym, legs' } },
        { type: 'open_app', target: 'gita' },
      ]);
      t('preview: an add points at its date', pv[0].ok && pv[0].ref && pv[0].ref.date === '2026-11-20' && !pv[0].from, JSON.stringify(pv[0]));
      t('preview: a remove names the row it takes away', pv[1].ok && pv[1].from && pv[1].from.id === 'a' && pv[1].from.date === '2026-11-05', JSON.stringify(pv[1]));
      t('preview: an edit names its row', pv[2].ok && pv[2].from.id === 'b' && pv[2].ref.id === 'b');
      t('preview: non-task actions are left out', pv.length === 3);
      t('preview: nothing in state changes', JSON.stringify(lb.b.getState().data) === before);
    }
    {
      const order = [];
      const lb = liveBridge({ data: {} });
      const e = makeEngine('veda', Object.assign(lb.b, { mutateData: fn => { order.push('commit'); lb.b.getState().data = fn(lb.b.getState().data); } }),
        { ok: true, actions: [{ type: 'add_task', box: 'calendar', date: '2026-11-06', title: 'Milk', category: 'personal' }], say: 'Done' });
      await e.THV.sendAudio('AAAA', { silent: true, before: async acts => { await new Promise(r => setTimeout(r, 5)); order.push('before:' + acts.length); } });
      t('send(): `before` runs, and is awaited, before the change is applied', order.join() === 'before:1,commit', order.join());
    }

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
      const lbS = liveBridge({ data: day('2026-11-05', [{ id: 's1', type: 'task', title: 'Email professor', category: 'study' }]) });
      engineWith(lbS).THV.runActions([{ type: 'prep_task', match: { title: 'email professor' }, set: { aiPrep: true, aiSite: 'claude' } }]);
      t('prep_task also takes aiSite nested in set (as Gemini really sent it, 2026-11-05)', lbS.st.data['2026-11-05'][0].aiSite === 'claude');
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
  const tonyFull = html.slice(html.indexOf('window._thVoice='), html.indexOf('canRedo:', html.indexOf('window._thVoice=')));
  t('Tony\'s bridge has Neo\'s reach (PC, prep, timer, nav, plans, journal, locks)', ['launchPc:', 'closePc:', 'prep:', 'prepOpen:', 'prepShow:', 'timerMode:', 'timerAdd:', 'closeTimer:', 'nav:', 'openPlans:', 'openShield:', 'journalEntry:', 'lockApp:', 'plan:', 'weekView:', 'goalsTab:', 'mobDay:'].every(k => tonyFull.includes(k)));
  t('Tony\'s bridge has none of Veda\'s own reach', !/changeRules|reelsShuffle|startClass|gita:|rulesRun/.test(tonyFull));
  t('a Neo button in each header', (html.match(/key:"vx-neo"/g) || []).length === 2 && html.indexOf('key:"vx-neo"') < html.indexOf('window._vdVoice={profile:"veda"') && html.lastIndexOf('key:"vx-neo"') > html.indexOf('window._vdVoice={profile:"veda"'));
  t('each side\'s button only mirrors its own side', /if\(d\.who&&d\.who!=="tony"\)return;/.test(html) && /if\(d\.who&&d\.who!=="veda"\)return;/.test(html));
  t('Tony\'s Orca key is read from his Shruti doc (read-only)', /_fbLoadTonyOrcaKey = async[^\n]*\n[^\n]*doc\(db, 'dashboards\/shruti'\)/.test(html));

  // ── 3. veda-assistant.js ──────────────────────────────────────────────────
  section('veda-assistant.js: profile gate');
  const asrc = fs.readFileSync(path.join(ROOT, 'TaskHub', 'veda-assistant.js'), 'utf8');
  function el() {
    const cls = new Set();
    return { style: {}, className: '', textContent: '', setAttribute() {}, appendChild() {}, remove() {}, querySelector: () => el(), set innerHTML(v) {}, onclick: null,
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: c => cls.has(c) } };
  }
  const store = { vd_neo_on: '1' };   // Veda switched hers on; Tony hasn't (th_neo_on unset)
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
  t('on Tony\'s side, with his Neo off, the mic is never opened (hers being on doesn\'t count)', micCalls === 0, 'getUserMedia calls: ' + micCalls);
  actx._activeProfile = null; N._test.sync();
  t('on the profile picker the mic is never opened', micCalls === 0);
  actx._activeProfile = 'veda'; N._test.sync();
  t('on Veda\'s side it starts listening', micCalls === 1);
  N.setOn(false);
  t('turning Neo off clears the saved preference', !('vd_neo_on' in store));
  actx._activeProfile = 'tony'; N._test.sync();
  t('switching to Tony\'s side takes up his own (off) switch', N.who() === 'tony' && N.isOn() === false && micCalls === 1);
  N._test.state.starting = false;   // the stub mic never answers, so Veda's start is still pending
  N.setOn(true);
  t('switching Tony\'s on saves HIS preference only, and starts listening', store.th_neo_on === '1' && !('vd_neo_on' in store) && micCalls === 2);
  t('his greeting uses his name', /^(Good (morning|afternoon|evening)|Working late), Tony\./.test(N._test.greeting({ data: {} })));
  N._test.state.starting = false;
  actx._activeProfile = 'veda'; N._test.sync();
  t('back on Veda\'s side her (now off) switch rules: the mic is released, not reopened', N.who() === 'veda' && N.isOn() === false && micCalls === 2);
  t('her greeting uses her name', /, Veda\./.test(N._test.greeting({ data: {} })));
  {
    const css = N._test.tonySheet(['#vd-neo-hud .vn-glass{background:linear-gradient(160deg,rgba(30,22,38,.78),rgba(14,11,18,.82));border:1px solid rgba(201,179,217,.28);color:#E6D9F0}', '.vn-spot-gone{border-color:#d27a8a}', '@keyframes vnSpin{to{transform:rotate(360deg)}}']);
    t('Tony\'s HUD sheet is scoped to .p-tony, in his purple, on a solid panel', /#vd-neo-hud\.p-tony \.vn-glass\{background:rgba\(26,26,29,\.94\);border:1px solid rgba\(192,174,234,\.28\);color:#ebe4fb\}/.test(css) && !/linear-gradient/.test(css));
    t('Tony\'s sheet never restyles Veda\'s rings or keyframes', /\.p-tony\.vn-spot-gone/.test(css) && !/^\.vn-spot-gone/m.test(css) && !/@keyframes vnSpin/.test(css));
  }
  actx._activeProfile = 'tony'; N._test.sync(); N.setOn(false); actx._activeProfile = 'veda'; N._test.sync();

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
    t('ends after ~1.1 s of silence', r === 'end' && s.silentMs >= 1100 && s.silentMs < 1200, r + ' ' + s.silentMs);
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
      'plan_add', 'plan_propose', 'plan_confirm', 'plan_decline', 'plan_cancel_request', 'plan_done', 'open_program', 'program'];
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
    // The "Call Ashton" loop (2026-11-05): with nothing said, Neo re-added the task it
    // had just added, over and over: its own voice / silence + the previous turn.
    {
      const said = 'I\'ve added the call to Ashton at East Park to your calendar for today, Veda.';
      const addA = [{ type: 'add_task', box: 'calendar', title: 'Call Ashton at East Park regarding the lease', date: '2026-11-05' }];
      T.state.lastSaid = said;
      t('Neo hearing its own reply is dropped', (T.guardTurn(addA, {}, { transcript: 'added the call to Ashton at East Park to your calendar for today Veda' }) || {}).drop === 'echo');
      T.state.lastSaid = '';
      T.state.prev = { at: Date.now(), data: { did: [{ type: 'add_task', ok: true, title: 'Call Ashton at East Park regarding the lease' }] } };
      t('a re-add of what the last turn just added is dropped', (T.guardTurn(addA, {}, { transcript: '' }) || {}).drop === 'replay');
      t('…unless she says "again" / "another"', T.guardTurn(addA, {}, { transcript: 'add another call to Ashton' }) === null);
      t('a different task still goes through', T.guardTurn([{ type: 'add_task', title: 'Buy milk' }], {}, { transcript: 'add buy milk' }) === null);
      t('an edit of that task (a real follow-up) still goes through', T.guardTurn([{ type: 'edit_task', match: { title: 'Call Ashton' }, set: { time: '16:00' } }], {}, { transcript: 'make it 4 pm' }) === null);
      T.state.prev = null;
      const lb = { profile: 'veda', uid: () => 'z', getState: () => ({ data: {}, habits: [], hc: {}, longGoals: [], shortGoals: [], selectedDate: '2026-11-05' }), mutateData: () => { throw new Error('must not write'); }, mutateHabits() {}, mutateLongGoals() {}, mutateShortGoals() {}, mutateHc() {} };
      const eng = makeEngine('veda', lb, { ok: true, actions: addA, say: said, transcript: 'x' });
      const rd = await eng.THV.sendAudio('AAAA', { silent: true, hold: () => ({ drop: 'replay' }) });
      t('a dropped reply changes nothing and says nothing', rd.ok && rd.dropped === 'replay' && rd.n === 0 && rd.say === '');
    }
    t('the worker prompt says the previous turn is never to be repeated', vedaPlain.includes('NEVER repeat its actions'));
    t('yes / no',T.isYes('yes') && T.isYes('yeah go ahead') && T.isYes('do it') && T.isNo('no') && T.isNo('never mind') && !T.isYes('no') && !T.isNo('yes please'));

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
  section('neo-programs.js: every program linked from her TaskHub');
  {
    const psrc = fs.readFileSync(path.join(ROOT, 'TaskHub', 'neo-programs.js'), 'utf8');
    const opened = [], tabs = [], launched = [];
    let warden = 0;
    const pctx = { console, setTimeout: (f) => { f(); return 0; }, Promise, JSON, Object, Array, String, Date, Math };
    pctx.window = pctx;
    pctx._activeProfile = 'veda';
    // Her real External Links (Settings, 2026-11-06), plus the two seeded ones and a stranger.
    pctx._navGetLinks = (p) => p === 'veda' ? [
      { id: 'shield', label: 'Shield', url: 'https://anthonyn99.github.io/A1/shield.html' },
      { id: 'l2', label: 'Shruti', url: 'https://anthonyn99.github.io/A1/shruti.html' },
      { id: 'c1', label: 'STUDY', url: 'https://tradeboard.vedapatel05.workers.dev/studyos/' },
      { id: 'c2', label: 'MAGI', url: 'https://magi-council-4f7a.vedapatel05.workers.dev/' },
      { id: 'c3', label: 'MAGI (T)', url: 'https://anthonyn99.github.io/A1/magi.html' },
      { id: 'c4', label: 'LIST', url: 'https://anthonyn99.github.io/A1/mylist.html' },
      { id: 'c5', label: 'TRADE', url: 'https://tradeboard.vedapatel05.workers.dev/' },
      { id: 'c6', label: 'FINANCE', url: 'https://tradeboard.vedapatel05.workers.dev/finance/' },
      { id: 'c7', label: 'WARDEN', url: 'https://vedacpatel.github.io/warden/warden.html' },
      { id: 'c8', label: 'SYSTEM (SOLO-LEVELING)', url: 'https://solo-leveling.vedapatel05.workers.dev/' },
      { id: 'c9', label: 'ORCA', url: 'https://orca.vedapatel05.workers.dev/' },
      { id: 'c10', label: 'RESERV', url: 'https://reserv.vedapatel05.workers.dev/' },
      { id: 'c11', label: 'EVERWELL', url: 'https://a1-priv.av1.workers.dev/everwell.html' },
      { id: 'c12', label: 'RIFTIQ', url: 'https://a1-priv.av1.workers.dev/riftiq.html' },
      { id: 'l4', label: 'Canvas', url: 'https://canvas.kent.edu' }] : [];
    pctx._navOpenLink = (p, id) => opened.push([p, id]);
    pctx.LifeHub = {
      list: (p) => p === 'veda' ? [
        { id: 'taskhub', name: 'TaskHub', url: 'https://anthonyn99.github.io/A1/index.html' },
        { id: 'studyos', name: 'StudyOS', url: 'https://tradeboard.vedapatel05.workers.dev/studyos/' },
        { id: 'mylist', name: 'MyList', url: 'https://anthonyn99.github.io/A1/mylist.html' },
        { id: 'shruti', name: 'Shruti', url: 'https://anthonyn99.github.io/A1/shruti.html' },
        { id: 'wellness', name: 'Wellness', url: 'https://anthonyn99.github.io/A1/V1/wellness.html' },
        { id: 'recipes', name: 'Recipes', url: 'https://recipes.example/' },
        { id: 'magi', name: 'MAGI', url: 'https://anthonyn99.github.io/A1/magi.html' },
        { id: 'old', name: 'Old thing', url: 'https://x.example', hidden: true }] : [],
      launch: (p, id) => { launched.push([p, id]); return true; },
    };
    pctx._tnOpenTab = (u, k) => { tabs.push([u, k]); return {}; };
    pctx._gotoWarden = () => { warden++; };
    vm.createContext(pctx);
    vm.runInContext(psrc, pctx);
    const R = pctx._vdNeoPrograms;
    const ids = R.list().map(p => p.id);
    t('lists every header link, her LifeHub list and Warden, each page once', JSON.stringify(ids) === JSON.stringify(['notebook', 'plans', 'shield', 'shruti', 'studyos', 'magi_council', 'magi', 'mylist', 'tradeboard', 'finance', 'warden', 'system', 'reserv', 'link:l4', 'lh:recipes']), JSON.stringify(ids));
    t('Warden from her header is the header link (her button, its lock)', R.find('warden').id === 'warden');
    t('"MAGI" is MAGI (T), the A1 page; her council link is "council"', R.find('MAGI').id === 'magi' && R.find('MAGI (T)').id === 'magi' && R.find('council').id === 'magi_council');
    t('Everwell, Wellness, RiftIQ and ORCA are left out: not listed, not found, not opened', ['everwell', 'wellness', 'riftiq', 'orca'].every(q => !ids.includes(q) && R.find(q) === null && R.open(q).reason === 'not_found'));
    t('every program in her list is found by what she calls it', ['study', 'list', 'trade', 'finance', 'system', 'solo leveling', 'reserv'].every(q => R.find(q)), ['study', 'list', 'trade', 'finance', 'system', 'solo leveling', 'reserv'].filter(q => !R.find(q)).join());
    t('TaskHub itself and hidden tiles are left out', !ids.includes('lh:taskhub') && !ids.includes('lh:old'));
    t('finds a program by id, label or alias', R.find('studyos').label === 'STUDY' && R.find('My List').id === 'mylist' && R.find('my links').id === 'warden' && R.find('canvas').id === 'link:l4' && R.find('Netflix') === null);
    t('a header link opens through its button (locks and tabs kept)', R.open('Shruti') === true && opened[0][0] === 'veda' && opened[0][1] === 'l2');
    t('a LifeHub app opens through LifeHub, like its tile', R.open('recipes') === true && launched[0][1] === 'recipes');
    t('Warden opens through her header button', R.open('warden') === true && opened[opened.length - 1][1] === 'c7' && warden === 0);
    t('an unknown program is not_found', R.open('Netflix').reason === 'not_found');
    t('a program with no ops: no_op', R.run('mylist', 'add_item', {}).reason === 'no_op');
    const got = [];
    R.register('mylist', { summary: () => 'Groceries: 3 items', ops: { add_item: { args: 'list, text', run: (a) => { got.push(a); return true; } }, clear_list: { args: 'list', confirm: (a) => 'clear your ' + a.list + ' list', run: () => true } },
      deep: (d) => 'https://anthonyn99.github.io/A1/mylist.html#' + d });
    t('an op runs with its args, [{k, v}] turned into an object', R.run('My List', 'add_item', [{ k: 'list', v: 'Groceries' }, { k: 'text', v: 'milk' }]) === true && got[0].list === 'Groceries' && got[0].text === 'milk');
    await new Promise(r => setImmediate(r));
    const sm = R.state().filter(p => p.id === 'mylist')[0];
    t('state lists each program, its ops and its summary', sm && sm.ops.join() === 'add_item(list, text),clear_list(list)' && sm.summary === 'Groceries: 3 items', JSON.stringify(sm));
    t('a connector\'s deep link opens in its own tab', R.open('mylist', 'groceries') === true && tabs[tabs.length - 1][0].endsWith('#groceries'));
    t('opInfo exposes ask-first ops', R.opInfo('mylist', 'clear_list').op.confirm({ list: 'Groceries' }) === 'clear your Groceries list');
    actx._vdNeoPrograms = R;
    t('…and Neo asks first for them', /clear your Groceries list/.test((T.needsConfirm([{ type: 'program', program: 'mylist', op: 'clear_list', args: { list: 'Groceries' } }], {}) || {}).question || ''));
    t('cards and lines name the program, not its id', T.cardFor({ type: 'open_program', program: 'mylist' }).detail === 'LIST' && T.cardFor({ type: 'program', program: 'mylist', op: 'add_item' }).label === 'ADD ITEM'
      && /can't do that inside it yet/.test(T.failLine({ ok: false, reason: 'no_op', action: { type: 'program', program: 'mylist' } })));
    actx._activeProfile = 'veda'; actx._navGetLinks = () => [];
    t('open_link falls back to any linked program', T.ops.openLink('Recipes') === true && launched.length === 2 && launched[1][1] === 'recipes');
    delete actx._vdNeoPrograms;
    pctx._activeProfile = 'tony';
    t('on Tony\'s side it lists nothing and does nothing', R.list().length === 0 && R.state().length === 0 && R.open('studyos').reason === 'no_bridge' && R.run('mylist', 'add_item', {}).reason === 'no_bridge');
  }
  section('veda-assistant.js: spotlight stops');
  {
    const s = T.spotStops([
      { box: 'calendar', date: '2026-11-20', id: 'x' }, { box: 'calendar', date: '2026-11-20', id: 'y' },
      { box: 'shortTermGoals', id: 'g' }, { box: 'calendar', date: '2026-11-05', id: 'a', gone: true },
      { box: 'calendar', date: '2026-11-07', id: 'b' }, { box: 'dailyHabits', id: 'h' }, { box: 'calendar', date: null, id: 'z' },
    ]);
    t('grouped by day or list, in order, at most 4', s.length === 4 && s.map(x => x.key).join() === 'd:2026-11-20,b:shortTermGoals,d:2026-11-05,d:2026-11-07', s.map(x => x.key).join());
    t('ids gathered per stop; leaving rows kept apart', s[0].ids.join() === 'x,y' && s[2].gone.join() === 'a' && !s[2].ids.length);
    const b = T.spotBefore([
      { ok: true, action: { type: 'add_task' }, ref: { box: 'calendar', date: '2026-11-20', id: 'tmp' } },
      { ok: true, action: { type: 'remove_task' }, from: { box: 'calendar', date: '2026-11-20', id: 'a' } },
      { ok: false, action: { type: 'edit_task' }, from: { box: 'calendar', date: '2026-11-09', id: 'q' } },
    ]);
    t('before: an add goes to its day with nothing to ring yet; a remove rings red', b.length === 1 && !b[0].ids.length && b[0].gone.join() === 'a');
    const a = T.spotAfter([
      { ok: true, action: { type: 'add_task' }, ref: { box: 'calendar', date: '2026-11-20', id: 'n1' } },
      { ok: true, action: { type: 'remove_task' } },
      { ok: false, action: { type: 'edit_task' }, ref: { box: 'calendar', date: '2026-11-09', id: 'q' } },
    ]);
    t('after: rings what landed, skips failures', a.length === 1 && a[0].ids.join() === 'n1');
  }
  section('veda-assistant.js: live captions snap to her words');
  {
    const vocab = ['Spotify', 'Visual Studio Code', 'Calculus homework', 'Neo'].map(x => ({ text: x, n: x.split(' ').length, l: x.toLowerCase().replace(/[^a-z0-9]/g, ''), sk: T.skel(x) }));
    t('"open spotty fi" → "open Spotify"', T.fixCaption('open spotty fi', vocab) === 'open Spotify', T.fixCaption('open spotty fi', vocab));
    t('"finish calculous homework" → "finish Calculus homework"', T.fixCaption('finish calculous homework', vocab) === 'finish Calculus homework', T.fixCaption('finish calculous homework', vocab));
    t('ordinary words are left alone', T.fixCaption('add buy milk tomorrow and call mom', vocab) === 'add buy milk tomorrow and call mom', T.fixCaption('add buy milk tomorrow and call mom', vocab));
    t('an exact word is kept as she said it', T.fixCaption('open spotify', vocab) === 'open spotify');
    const v2 = ['Shield'].map(x => ({ text: x, n: 1, l: x.toLowerCase(), sk: T.skel(x) }));
    t('"should" is never snapped to "Shield"', T.fixCaption('which one i should keep', v2) === 'which one i should keep', T.fixCaption('which one i should keep', v2));
    t('…a misheard "shield" still is', T.fixCaption('open sheild', v2) === 'open Shield', T.fixCaption('open sheild', v2));
    t('tidy: noise word and misheard wake phrase are dropped', T.tidyText('you hey new hello') === 'Hello', T.tidyText('you hey new hello'));
    t('tidy: "her new" is the wake phrase too', T.tidyText('her new so tell me about each task') === 'So tell me about each task', T.tidyText('her new so tell me about each task'));
    t('tidy: a lone "you" is nothing', T.tidyText('you') === '' && T.tidyText('you hey neo') === '');
    t('tidy: "i" becomes "I", a "new task" is kept', T.tidyText('add a new task i need milk') === 'Add a new task I need milk', T.tidyText('add a new task i need milk'));
  }
  {
    const buf = T.encodeWav([new Float32Array(48000)], 48000, 16000);
    const dv = new DataView(buf);
    t('WAV is 16 kHz mono, 1 s → 32044 bytes', buf.byteLength === 44 + 32000 && dv.getUint32(24, true) === 16000 && dv.getUint16(22, true) === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

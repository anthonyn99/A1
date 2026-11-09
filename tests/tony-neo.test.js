#!/usr/bin/env node
/**
 * Tony's Neo AI — his hands-free TaskHub assistant (TaskHub/tony-neo.js).
 *
 * WHY THIS FILE EXISTS
 * Tony asked (2026-11-09) for his Neo to be its own program, separate from
 * Veda's (tests/veda-neo.test.js), and for it to:
 *   · say just "Done" for a change and SHOW exactly what changed (an undo shows
 *     what it undid), briefly;
 *   · fit his quote's slot without text running off it;
 *   · answer with HIS Gemini key (the request says profile "tony");
 *   · take over his old voice assistant: Talk (the mic button), Type (the text
 *     button), and the microphone choice, now in Settings → Tony's Neo AI with
 *     his voice and typed-reply choice, synced through dashboards/neo_tony.
 * These tests pin each of those, plus the gate: it never listens off his side.
 *
 * Run: node tests/tony-neo.test.js
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
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'TaskHub', 'tony-neo.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── a page for tony-neo.js ───────────────────────────────────────────────────
function el(tag) {
  const cls = new Set(), kids = [];
  const e = {
    tagName: tag, style: {}, textContent: '', children: kids, isConnected: true, parentNode: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { kids.push(c); c.parentNode = e; return c; }, insertBefore(c) { kids.push(c); c.parentNode = e; return c; }, remove() {},
    querySelector: () => el('div'), querySelectorAll: () => [el('span'), el('span')], addEventListener() {}, removeEventListener() {},
    scrollTo() {}, focus() {}, blur() {}, getContext: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    set innerHTML(v) { e._html = v; kids.length = 0; }, get innerHTML() { return e._html || ''; },
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { if (on === undefined) on = !cls.has(c); on ? cls.add(c) : cls.delete(c); return on; }, contains: c => cls.has(c) },
  };
  return e;
}
function makePage(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const counts = { mic: 0 };
  const ctx = {
    console, URL, setTimeout, clearTimeout, setInterval: () => 0, JSON, Math, Date, Promise, Float32Array, ArrayBuffer, DataView, Uint8Array, String, Array, Object, Number, isFinite,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { userAgent: 'test', mediaDevices: { getUserMedia: () => { counts.mic++; return new Promise(() => {}); }, enumerateDevices: async () => (opts.devices || []) } },
    requestAnimationFrame: f => setTimeout(() => f(Date.now()), 1), getComputedStyle: () => ({ borderRadius: '6px', display: 'block' }), innerHeight: 800, innerWidth: 1200,
    performance: { now: () => Date.now() },
  };
  const listeners = {};
  ctx.addEventListener = (n, f) => { (listeners[n] = listeners[n] || []).push(f); };
  ctx.removeEventListener = () => {};
  ctx.dispatchEvent = (ev) => { (listeners[ev.type] || []).forEach(f => f(ev)); return true; };
  ctx.document = { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: el, head: el('head'), body: el('body'), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, documentElement: { style: { setProperty() {} } } };
  ctx.window = ctx;
  ctx._activeProfile = opts.profile === undefined ? 'tony' : opts.profile;
  Object.assign(ctx, opts.win || {});
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, store, counts, N: ctx._thNeo, T: ctx._thNeo._test };
}

(async () => {
  // ── 1. his side only ───────────────────────────────────────────────────────
  section('tony-neo.js: his side only');
  t('tony-neo.js carries nothing of Veda\'s Neo (no _vdNeo, _vdVoice, vd_neo_on, #vd-neo-hud, .vn-)', !/_vdNeo|_vdVoice|vd_neo_on|vd-neo-hud|\.vn-|neo-programs|_sosBridge/.test(src.replace(/\/\*[\s\S]*?\*\//, '')));
  {
    const pg = makePage({ profile: 'veda', store: { th_neo_on: '1', vd_neo_on: '1' } });
    t('window._thNeo exists, and nothing of Veda\'s', !!pg.N && !pg.ctx._vdNeo);
    pg.T.sync();
    t('on Veda\'s side the mic is never opened, his switch on or not', pg.counts.mic === 0);
    pg.ctx._activeProfile = null; pg.T.sync();
    t('on the profile picker the mic is never opened', pg.counts.mic === 0);
    pg.ctx._activeProfile = 'tony'; pg.T.sync();
    t('on his side, with his switch on, it listens', pg.counts.mic === 1);
    pg.N.setOn(false);
    t('switching it off clears HIS preference only', !('th_neo_on' in pg.store) && pg.store.vd_neo_on === '1');
    t('Talk works with the switch off: the mic opens at once (no wake phrase)', pg.N.talk() === true && pg.T.state.talk === true && pg.counts.mic === 2);
    pg.T.state.starting = false; pg.T.state.talk = false;
    pg.ctx._activeProfile = 'veda';
    t('Talk and Type do nothing off his side', pg.N.talk() === false && pg.N.openAsk() === false);
    t('his greeting is short and uses his name', /^(Good (morning|afternoon|evening)|Working late), Tony\. /.test(pg.T.greeting({ data: {} })) && pg.T.greeting({ data: {} }).split(' ').length <= 8);
  }

  // ── 2. says "Done", shows exactly what changed ─────────────────────────────
  section('tony-neo.js: brief to the ear, exact on screen');
  const { T, N, ctx, store } = makePage({ store: {} });
  const R = (a, ok, reason, extra) => Object.assign({ action: a, ok, reason: reason || '' }, extra || {});
  const milk = { type: 'add_task', box: 'calendar', title: 'Buy milk', date: '2026-11-06' }, gym = { type: 'remove_task', match: { title: 'Gym' } };
  t('a change that worked is spoken as just "Done."', T.spokenFor('Done. Buy milk is on tomorrow\'s list, sir.', [R(milk, true)]) === 'Done.');
  t('…and shown exactly: what, when', T.shownFor('whatever', [R(milk, true)]) === 'Task added · Buy milk · Fri 6 Nov', T.shownFor('', [R(milk, true)]));
  t('nothing worked → the failure, briefly, never "Done"', T.spokenFor('Done.', [R(gym, false, 'not_found')]) === 'Couldn\'t find Gym.');
  t('some worked → "Done, except: …"', T.spokenFor('x', [R(milk, true), R(gym, false, 'not_found')]) === 'Done, except: Couldn\'t find Gym.');
  t('…shown with both', T.shownFor('x', [R(milk, true), R(gym, false, 'not_found')]) === 'Task added · Buy milk · Fri 6 Nov. Couldn\'t find Gym.', T.shownFor('x', [R(milk, true), R(gym, false, 'not_found')]));
  t('a question is answered aloud in full', T.spokenFor('Two left: Gym and Call mom.', []) === 'Two left: Gym and Call mom.' && T.shownFor('Two left: Gym and Call mom.', []) === 'Two left: Gym and Call mom.');
  const many = [1, 2, 3, 4].map(i => R({ type: 'add_task', box: 'calendar', title: 'T' + i }, true));
  t('many changes: two named, the rest counted (all under Details)', T.shownFor('', many) === 'Task added · T1; Task added · T2; +2 more', T.shownFor('', many));
  const LONG = /afraid|I'm|sir|splendid/i;
  const reasons = ['not_found', 'off_pc', 'locked', 'no_reminder', 'not_flagged', 'prep_failed', 'no_lock', 'already', 'not_waiting', 'not_confirmed', 'bioFailed', 'journal_not_ready', 'nothing', 'invalid', 'no_bridge', 'weird'];
  const lines = reasons.map(r => T.failLine(R({ type: 'edit_task', match: { title: 'Gym' } }, false, r)));
  t('every failure line is short and plain (no "I\'m afraid")', lines.every(l => l && !LONG.test(l) && l.split(' ').length <= 8), lines.filter(l => LONG.test(l) || l.split(' ').length > 8).join(' | '));
  t('cards read like his UI (Title case, no shouting)', T.cardFor(milk).label === 'Task added' && T.cardFor({ type: 'toggle_task', match: { title: 'x' } }).label === 'Done' && T.cardFor({ type: 'timer_set', minutes: 25, start: true }).detail === '25:00 · running');
  const TYPES = ['add_task', 'edit_task', 'remove_task', 'toggle_task', 'move_task', 'swap', 'reorder', 'clear', 'shift_range', 'clear_completed', 'go_to_date', 'set_edit_mode', 'refresh_quote', 'timer_set', 'timer_start', 'timer_stop', 'timer_reset', 'timer_open', 'timer_close',
    'timer_mode', 'timer_add', 'undo', 'redo', 'open_app', 'open_link', 'prep_task', 'prep_off', 'prep_open', 'prep_show', 'assistant_off', 'open_pc_app', 'open_site', 'close_pc_app', 'close_all_pc_apps', 'clear_reminder', 'week_view', 'goals_tab', 'month_shift', 'lock_app', 'journal_entry',
    'plan_add', 'plan_propose', 'plan_confirm', 'plan_decline', 'plan_cancel_request', 'plan_done'];
  t('every action his prompt offers has a card', TYPES.every(ty => T.cardFor({ type: ty, text: 'x', days: 1 })), TYPES.filter(ty => !T.cardFor({ type: ty, text: 'x', days: 1 })).join());
  t('Veda\'s own actions have none here', ['rules_add', 'gita_next', 'reels_shuffle', 'start_class', 'open_program', 'program'].every(ty => T.cardFor({ type: ty }) === null));

  // ── 3. what an undo undid ──────────────────────────────────────────────────
  section('tony-neo.js: an undo shows what it undid');
  {
    const a = { data: { '2026-11-06': [{ id: 'm', title: 'Buy milk' }, { id: 'g', title: 'Gym', done: true, time: '17:00' }], '2026-11-07': [{ id: 'r', title: 'Run' }] },
      habits: [{ id: 'h1', title: 'Read' }], hc: { 'h1-2026-10-6': true }, shortGoals: [], longGoals: [{ id: 'L', title: 'Ship Neo' }] };
    const b = JSON.parse(JSON.stringify(a));
    b.data['2026-11-06'] = [{ id: 'g', title: 'Gym', done: false, time: '18:00' }];              // milk gone, gym unticked + retimed
    b.data['2026-11-08'] = [{ id: 'r', title: 'Morning run' }]; delete b.data['2026-11-07'];       // run moved + renamed
    b.data['2026-11-09'] = [{ id: 'n', title: 'Dentist' }];                                       // dentist back
    b.hc = {}; b.longGoals = [];
    const d = T.diffState(a, b);
    const has = (verb, title) => d.some(x => x.verb === verb && x.title === title);
    t('removed, restored, unticked, retimed, moved, renamed, habit unticked, goal removed', has('removed', 'Buy milk') && has('restored', 'Dentist') && has('unticked', 'Gym') && has('retimed', 'Gym') && has('moved', 'Morning run') && has('renamed', 'Run') && has('unticked', 'Read') && has('removed', 'Ship Neo'), JSON.stringify(d));
    t('one line, verbs first, with the day', T.diffLine([{ verb: 'removed', title: 'Buy milk', key: '2026-11-06' }]) === 'removed Buy milk · Fri 6 Nov');
    t('a whole series reads as one ("removed Gym ×14")', T.diffLine(Array.from({ length: 14 }, (_, i) => ({ verb: 'removed', title: 'Gym', key: '2026-11-' + String(10 + i) }))) === 'removed Gym ×14');
    t('long diffs are capped with a count', /; \+2 more$/.test(T.diffLine([1, 2, 3, 4, 5].map(i => ({ verb: 'removed', title: 'T' + i })))));
    t('no change → nothing to say', T.diffLine(T.diffState(a, a)) === '');
    t('the shown line for an undo names it', T.shownFor('', [R({ type: 'undo' }, true, '', { diff: [{ verb: 'removed', title: 'Buy milk', key: '2026-11-06' }] })]) === 'Undone: removed Buy milk · Fri 6 Nov');
    t('…and an empty undo says so', T.shownFor('', [R({ type: 'undo' }, false, 'nothing')]) === 'Nothing to undo.' && T.spokenFor('', [R({ type: 'undo' }, false, 'nothing')]) === 'Nothing to undo.');
    t('undo / redo said or typed alone run on the device', T.isUndo('undo') && T.isUndo('Undo that.') && T.isUndo('go back') && T.isRedo('redo it') && !T.isUndo('undo the gym task and add milk') && !T.isUndo('do it'));
  }

  // ── 4. a typed request, as Neo sends it: HIS key, Neo mode ─────────────────
  section('tony-neo.js: Type → the same path, as Tony');
  {
    const state = { data: { '2026-11-06': [{ id: 'm', title: 'Buy milk' }] }, habits: [], hc: {}, shortGoals: [], longGoals: [], selectedDate: '2026-11-06' };
    const sent = [];
    const pg = makePage({ win: {
      _thVoice: { profile: 'tony', getState: () => state, undo: () => { state.data['2026-11-06'] = []; return true; }, redo: () => false },
      _THV: {
        request: async (extra, opts) => {
          sent.push({ extra, opts });
          const acts = [{ type: 'add_task', box: 'calendar', title: 'Gym', date: '2026-11-07' }];
          const held = opts.hold(acts, state, { transcript: extra.transcript });
          if (held) return { ok: true, n: 0, held: Object.assign({ actions: acts }, held), say: '' };
          if (opts.before) await opts.before(acts);
          return { ok: true, n: 1, results: [{ action: acts[0], ok: true, ref: { id: 'x', box: 'calendar', date: '2026-11-07', title: 'Gym' } }], later: Promise.resolve([]), say: 'Added Gym, Saturday.', transcript: 'Add gym on Saturday' };
        },
        refreshButtons() {},
      },
    } });
    pg.N.setSettings({ speakTyped: false });
    const r = await pg.N.ask('add gym on saturday');
    const x = sent[0] && sent[0].extra;
    t('it goes out as Tony (his Gemini key) in Neo mode, with his words', x && x.profile === 'tony' && x.mode === 'neo' && x.transcript === 'add gym on saturday', JSON.stringify(x));
    t('…through the guard and the spotlight hooks', sent[0] && typeof sent[0].opts.hold === 'function' && typeof sent[0].opts.before === 'function' && sent[0].opts.silent === true);
    t('the reply is shown exactly; with "Speak typed replies" off nothing is spoken', r.ok && pg.T.state.turn && pg.T.state.turn.shown === 'Task added · Gym · Sat 7 Nov' && pg.T.state.lastSaid === '', JSON.stringify(pg.T.state.turn));
    const sent2 = sent.length;
    await pg.N.ask('add gym on saturday again');
    t('the next request carries the previous turn and the conversation', sent[sent2] && sent[sent2].extra.prev && sent[sent2].extra.prev.did[0].title === 'Gym' && Array.isArray(sent[sent2].extra.history));
    pg.T.state.turn = null;
    const before = sent.length;
    await pg.N.ask('undo');
    await sleep(260);
    t('"undo" typed runs on the device (no request), and shows what it undid', sent.length === before && pg.T.state.turn && pg.T.state.turn.shown === 'Undone: removed Buy milk · Fri 6 Nov', JSON.stringify(pg.T.state.turn));
    const r3 = await pg.N.ask('redo');
    t('an empty redo says so', r3.ok && pg.T.state.turn.shown === 'Nothing to redo.');
    t('a typed turn never trips the "Neo heard itself" guard', (() => { pg.T.state.typed = true; pg.T.state.lastSaid = 'add gym on saturday please now'; const g = pg.T.guardTurn([{ type: 'add_task', title: 'New' }], {}, { transcript: 'add gym on saturday please now' }); pg.T.state.lastSaid = ''; return g === null; })());
    pg.T.state.typed = false;
    t('…a spoken one still does', (() => { pg.T.state.lastSaid = 'Added Gym on Saturday for you'; const g = pg.T.guardTurn([{ type: 'add_task', title: 'New' }], {}, { transcript: 'added gym on saturday for you' }); pg.T.state.lastSaid = ''; return g && g.drop === 'echo'; })());
    t('asking first: a bulk change is a question', /^Clear all two items on Saturday the 7th\?$/.test((pg.T.needsConfirm([{ type: 'clear', box: 'calendar', date: '2026-11-07' }], { data: { '2026-11-07': [{ title: 'a' }, { title: 'b' }] } }) || {}).question || ''));
  }

  // ── 5. settings: synced, cleaned, his ─────────────────────────────────────
  section('tony-neo.js: Settings → Tony\'s Neo AI');
  {
    const saved = [];
    const pg = makePage({ win: { _fbSaveNeoTony: o => { saved.push(o); return Promise.resolve(true); } },
      devices: [{ kind: 'audioinput', deviceId: 'd1', label: 'Desk mic (USB)' }, { kind: 'audioinput', deviceId: 'd2', label: 'Headset' }, { kind: 'audiooutput', deviceId: 'o', label: 'Speakers' }] });
    t('defaults: Ryan, system mic, typed replies spoken', pg.N.settings().voice === 'en-GB-RyanNeural' && pg.N.settings().micLabel === '' && pg.N.settings().speakTyped === true);
    t('the voices are Shruti\'s set (Orca\'s Edge voices)', (() => { const orca = fs.readFileSync(path.join(ROOT, 'Shruti', 'app', 'orca.js'), 'utf8'); const ids = pg.N.voices().map(v => v.id); return ids.length === 20 && ids.every(id => orca.includes("'" + id + "'")); })());
    pg.N.setSettings({ voice: 'en-GB-SoniaNeural', micLabel: 'Headset' });
    t('a change is saved on the device and sent to Firestore (dashboards/neo_tony)', JSON.parse(pg.store.th_neo_settings).voice === 'en-GB-SoniaNeural' && saved.length === 1 && saved[0].voice === 'en-GB-SoniaNeural' && saved[0].micLabel === 'Headset' && saved[0].speakTyped === true && typeof saved[0].at === 'number');
    t('junk never gets in (an unknown voice, a non-boolean)', pg.N.setSettings({ voice: 'evil', speakTyped: 'yes' }) === false && pg.N.settings().voice === 'en-GB-SoniaNeural');
    t('the mic is matched by NAME on this device (ids differ per device)', await pg.T.micDeviceId() === 'd2' && pg.store.th_neo_mic_id === 'd2');
    pg.N.setSettings({ micLabel: 'Another PC\'s mic' });
    t('a mic this device doesn\'t have falls back to the default', await pg.T.micDeviceId() === '');
    const at = pg.N.settings().at;
    t('another device\'s newer change lands', pg.T.applyRemote({ voice: 'en-US-GuyNeural', micLabel: '', speakTyped: false, at: at + 1000 }) === true && pg.N.settings().voice === 'en-US-GuyNeural' && pg.N.settings().speakTyped === false);
    t('an older copy (or its own echo) is ignored', pg.T.applyRemote({ voice: 'en-GB-ThomasNeural', at: at - 5 }) === false && pg.T.applyRemote({ voice: 'en-GB-ThomasNeural', at: pg.N.settings().at }) === false && pg.N.settings().voice === 'en-US-GuyNeural');
    let ev = null; pg.ctx.addEventListener('th-neo-settings', e => { ev = e.detail; });
    pg.ctx.dispatchEvent(new pg.ctx.CustomEvent('th-neo-remote', { detail: { voice: 'en-IE-ConnorNeural', at: Date.now() + 99999 } }));
    t('index.html\'s listener event (th-neo-remote) reaches it', pg.N.settings().voice === 'en-IE-ConnorNeural' && ev && ev.voice === 'en-IE-ConnorNeural');
    const V = (name, lang) => ({ name, lang });
    t('device-voice fallback follows his chosen voice (female → female, US → US)', pg.T.pickVoiceFrom([V('Microsoft Ryan Online', 'en-GB'), V('Microsoft Libby Online', 'en-GB')], 'en-GB-LibbyNeural').name === 'Microsoft Libby Online'
      && pg.T.pickVoiceFrom([V('Microsoft Ryan Online', 'en-GB'), V('Microsoft Guy Online', 'en-US')], 'en-US-GuyNeural').name === 'Microsoft Guy Online'
      && pg.T.pickVoiceFrom([V('Google US English', 'en-US'), V('Microsoft Ryan Online (Natural)', 'en-GB')], 'en-GB-RyanNeural').name.startsWith('Microsoft Ryan'));
  }

  // ── 6. the engine hands Tony's side to his Neo ────────────────────────────
  section('engine (index.html): Tony\'s old voice assistant is retired into Neo');
  {
    const start = html.indexOf("var WORKER='https://personal-ai.av1.workers.dev';");
    const engine = html.slice(html.lastIndexOf('(function(){', start), html.indexOf('</script>', start));
    let body = null;
    const calls = [];
    const ctx2 = {
      console, setTimeout, clearTimeout, JSON, Object, Array, String, Math, Date, Promise, Intl, Blob: function () {}, FileReader: function () {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { getElementById: () => null, addEventListener() {}, documentElement: { style: { setProperty() {} } }, body: {} },
      getComputedStyle: () => ({}), navigator: { mediaDevices: { getUserMedia: () => { calls.push('mic'); return Promise.reject(new Error('no')); } } },
      fetch: async (u, o) => { body = JSON.parse(o.body); return { json: async () => ({ ok: true, actions: [{ type: 'undo' }, { type: 'assistant_off' }], say: '' }) }; },
    };
    ctx2.window = ctx2; ctx2._activeProfile = 'tony';
    ctx2._thVoice = { profile: 'tony', uid: () => 'u', getState: () => ({ data: {}, habits: [], hc: {}, longGoals: [], shortGoals: [], selectedDate: '2026-11-06' }), undo: () => false, redo: () => false, mutateData() {}, mutateHabits() {}, mutateLongGoals() {}, mutateShortGoals() {}, mutateHc() {} };
    ctx2._thNeo = { talk: () => calls.push('talk'), openAsk: () => calls.push('ask'), setOn: on => calls.push('off:' + on) };
    ctx2._vdNeo = { setOn: on => calls.push('VEDA:' + on) };
    ctx2._openSettings = p => calls.push('settings:' + p);
    vm.createContext(ctx2);
    vm.runInContext(engine, ctx2);
    const THV = ctx2._THV;
    THV.toggleVoice(); THV.openText(); THV.openDevicePicker();
    t('the old mic → Talk to Neo; the old text box → Neo\'s composer; the device picker → Settings', calls.join() === 'talk,ask,settings:tony', calls.join());
    t('nothing of the old recorder opened his mic', !calls.includes('mic'));
    const r = await THV.request({ transcript: 'undo then stop listening', mode: 'neo', profile: 'tony' }, { silent: true });
    t('request() sends his words as Tony in Neo mode', body && body.profile === 'tony' && body.mode === 'neo' && body.transcript === 'undo then stop listening');
    t('an undo with nothing to undo is reported, not claimed', r.results[0].ok === false && r.results[0].reason === 'nothing');
    t('"stop listening" turns HIS Neo off, never Veda\'s', calls.includes('off:false') && !calls.some(c => /^VEDA/.test(c)));
  }

  // ── 7. index.html wiring ───────────────────────────────────────────────────
  section('index.html: Tony\'s header, bridge, settings, sync');
  {
    const hs = html.indexOf('key:"vx-talk"'), he = html.indexOf('key:"vx-undo"', hs);
    const hdr = html.slice(hs, he);
    t('his header: Talk → _thNeo.talk, Type → _thNeo.openAsk, NEO → _thNeo.toggle', hs > 0 && /onClick:\(\)=>window\._thNeo&&window\._thNeo\.talk\(\)/.test(hdr) && /onClick:\(\)=>window\._thNeo&&window\._thNeo\.openAsk\(\)/.test(hdr) && /onClick:\(\)=>window\._thNeo&&window\._thNeo\.toggle\(\)/.test(hdr));
    t('…and no device button, no old recorder, nothing of Veda\'s Neo', !/vx-dev|toggleVoice|openDevicePicker|_vdNeo|vd-neo-btn|vxRec/.test(hdr));
    t('the old recorder state is gone from his App', !/const\[vxRec,setVxRec\]/.test(html.slice(0, html.indexOf('window._vdVoice={profile:"veda"'))));
    const b0 = html.indexOf('window._thVoice={profile:"tony"'), b1 = html.indexOf('canRedo:', b0);
    const tb = html.slice(b0, b1);
    t('his bridge uses HIS Neo\'s ops (_thNeoOps, _thNeoLaunch, _thNeoClose, _thNeoCloseAll), never Veda\'s', /window\._thNeoOps/.test(tb) && /window\._thNeoLaunch/.test(tb) && /window\._thNeoCloseAll/.test(tb) && !/_vdNeo/.test(tb));
    t('Settings has a Tony\'s Neo AI section, drawn by his Neo', /Tony\\'s Neo AI/.test(html) && /window\._thNeo\.renderSettings\(neoBox\)/.test(html) && /\(profile==='tony'\?'<div class="thset-sec">'/.test(html));
    t('his settings sync through dashboards/neo_tony only, written only from his side', /_fbSaveNeoTony = async \(o\) => \{\n\s*if \(window\._activeProfile !== 'tony'/.test(html) && /setDoc\(doc\(db, 'dashboards\/neo_tony'\), o, \{ merge: true \}\)/.test(html) && /onSnapshot\(doc\(db, 'dashboards\/neo_tony'\)/.test(html) && /'th-neo-remote'/.test(html));
    t('tony-neo.js is loaded after veda-neo.js, both deferred', html.indexOf('<script src="TaskHub/veda-neo.js" defer></script>') > 0 && html.indexOf('<script src="TaskHub/tony-neo.js" defer></script>') > html.indexOf('<script src="TaskHub/veda-neo.js" defer></script>'));
    t('Veda\'s header is untouched: her mic, text and device buttons remain', /RC\("button",\{key:"vx-voice"/.test(html) && /RC\("button",\{key:"vx-dev"/.test(html) && /RC\("button",\{key:"vx-text"/.test(html));
  }

  // ── 8. the worker: his key, brief replies, typed requests ─────────────────
  section('worker: Tony\'s Neo prompt and key');
  {
    const wsrc = fs.readFileSync(path.join(ROOT, 'workers', 'personal-ai', 'worker.js'), 'utf8')
      .replace(/^export default\s*\{/m, 'const __workerDefault = {')
      .replace(/^export (?=(?:async )?function |const |let )/gm, '');
    const wctx = { console, URL, Response: function (b) { this.body = b; }, fetch: () => Promise.reject(new Error('no network in tests')), setTimeout, clearTimeout, AbortController };
    vm.createContext(wctx);
    vm.runInContext(wsrc + '\n;globalThis.__T = { buildTaskPrompt, handleTaskhub };', wctx);
    const W = wctx.__T;
    const seen = {};
    wctx.runModelChain = async (models, key, o) => { seen.key = key; seen.prompt = o.prompt; throw new Error('stop'); };
    const env = { VEDA_GEMINI_KEY: 'veda-key', TONY_GEMINI_KEY: 'tony-key' };
    await W.handleTaskhub({ profile: 'tony', mode: 'neo', transcript: 'brief me', state: { data: {} }, today: '2026-11-09' }, env);
    t('Tony\'s Neo request is answered with HIS Gemini key', seen.key === 'tony-key');
    await W.handleTaskhub({ profile: 'veda', mode: 'neo', transcript: 'brief me', state: { data: {} }, today: '2026-11-09' }, env);
    t('…and Veda\'s with hers', seen.key === 'veda-key');
    const p = W.buildTaskPrompt('tony', 'x', { today: '2026-11-09', calendar: {} }, '2026-11-09', 'Monday', false, { neo: true });
    t('his prompt asks for brevity: terse change lines (the page says "Done"), short answers', p.includes('BREVITY') && p.includes('SPEAKS only "Done."') && p.includes('at most 10 words') && p.includes('up to 30 words') && p.includes('up to 45 words'));
    t('his prompt knows a request may be typed', p.includes('may be TYPED'));
    t('no long-winded examples left in his prompt', !/One less thing on your plate|Focus well, sir|I'm afraid I can't find/.test(p));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

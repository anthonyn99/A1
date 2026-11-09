/* ════════════════════════════════════════════════════════════════════════════
   TONY'S NEO AI — his hands-free TaskHub assistant.
   Docs: docs/TaskHub/neo-assistant.md ("Tony's Neo AI").

   Tony's alone. Veda's Neo AI is a separate program (TaskHub/veda-neo.js);
   the two share no state, globals, styles or settings (split 2026-11-09):
     Tony:  window._thNeo, _thNeoOps, _thNeoLaunch/_thNeoClose/_thNeoCloseAll,
            event "th-neo-change", #th-neo-hud, .tn-*, localStorage th_neo_*,
            Firestore dashboards/neo_tony (his settings, synced)
     Veda:  window._vdNeo, _vdNeoOps, ..., event "vd-neo-change", #vd-neo-hud, .vn-*
   It runs only while Tony's TaskHub is in front.

   Ways in (all three end in the same place):
     · "Hey Neo" — Vosk (on-device WASM) hears the wake phrase while his switch
       (the NEO button) is on; then it records until he stops talking.
     · Talk (the mic button) — records at once, no wake phrase, no 41 MB model;
       tap again to send. Works with the switch off (the mic is released after).
     · Type (the text button) — the composer; Ctrl/⌘+Enter sends.
   ─► window._THV (index.html's engine) → personal-ai /taskhub/parse with
      profile "tony" and mode "neo", so HIS Gemini key answers (keyFor 'tony')
   ─► the engine's executor on HIS bridge (window._thVoice), with the spotlight
   ─► the answer. Changes are spoken as just "Done." and shown, concisely and
      exactly, in the HUD (an undo shows what it undid); questions are spoken.

   Settings (Settings → Tony's Neo AI): microphone, voice (Orca's Edge voices,
   the same set Shruti offers) and whether typed requests are spoken. Saved on
   the device and in dashboards/neo_tony, so every device of his follows.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window._thNeo) return;

  var VOSK_SRC = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';
  var MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
  var DEFAULT_VOICE = 'en-GB-RyanNeural';
  var SCRIPT_URL = (document.currentScript && document.currentScript.src) ||
    ((typeof location !== 'undefined' ? String(location.href) : '').replace(/[^/]*$/, '') + 'TaskHub/tony-neo.js');

  // MAGI's purple (docs/Theme/theme-overhaul-plan.md §2).
  var C = { core: '#ebe4fb', ring: '#c0aeea', accent: '#9a86c9', hot: '#f4f0fd', red: '#d68a7c' };

  // His everything. Each entry names a window global (read live: his TaskHub and
  // its prep code set them after this script loads).
  var P = {
    id: 'tony', name: 'Tony', pref: 'th_neo_on', orcaLs: 'shruti.tony.orcaKey', loadKey: '_fbLoadTonyOrcaKey',
    bridge: '_thVoice', pcApps: '_thPcApps', up: '_thBridgeUp', err: '_thBridgeErr', running: '_thPcRunning',
    prepReq: '_thPrepRequest', prepBusy: '_thPrepBusy', prepKits: '_thPrepKits', openLocal: '_thPrepOpenLocal',
    nb: 'tj', lockTH: 'tony_taskhub', mobStrip: '.th-mob-day-strip', dock: '#root .thwx-band > .thwx-bq',
    locks: { taskhub: 'tony_taskhub', notebook: 'tony_myjournal', journal: 'tony_myjournal', shield: 'tony_shield' },
    bridgeHint: 'Start the A1 Prep Bridge (it normally starts at logon).',
  };
  function onTony() { return window._activeProfile === 'tony'; }
  function W(k) { return window[P[k]]; }

  // Words Vosk may choose between. Only "hey neo" wakes; the near-sounding decoys
  // give similar speech somewhere else to land.
  var GRAMMAR = ['neo', 'hey neo', 'okay neo', 'new', 'no', 'know', 'now', 'leo', 'neon', 'nemo', 'knee', 'video', 'oh', 'hey', '[unk]'];

  var PRE_ROLL_S = 1.5;      // audio kept from before the wake word fired
  var END_SILENCE_MS = 1100; // he stopped talking
  var NO_SPEECH_MS = 6000;   // woke but nothing followed
  var MAX_CAPTURE_MS = 30000;
  var FOLLOW_MS = 10000;     // after a reply: listen without the wake word
  var ASK_MS = 16000;        // …longer when Neo has just asked him something
  var DEAF_MS = 700;         // …starting this long after Neo stops talking

  // ══ pure helpers (tests/tony-neo.test.js) ══════════════════════════════════
  function isWake(text) {
    var w = String(text || '').toLowerCase().split(/\s+/).filter(function (t) { return t && t !== '[unk]'; });
    for (var i = 1; i < w.length; i++) if (w[i] === 'neo' && w[i - 1] === 'hey') return true;
    return false;
  }
  function rms(buf) { var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / (buf.length || 1)); }
  function threshold(floor) { return Math.max(0.012, floor * 2.8); }
  // One step of the end-point detector → 'go' | 'end' (he finished) | 'none' (nothing said).
  function vadStep(st, level, floor, ms) {
    st.elapsedMs += ms;
    if (level > threshold(floor)) { st.speech = true; st.silentMs = 0; }
    else st.silentMs += ms;
    if (st.elapsedMs >= MAX_CAPTURE_MS) return st.speech ? 'end' : 'none';
    if (st.speech && st.silentMs >= END_SILENCE_MS) return 'end';
    if (!st.speech && st.elapsedMs >= NO_SPEECH_MS) return 'none';
    return 'go';
  }
  function encodeWav(buffers, inRate, outRate) {
    var len = 0; buffers.forEach(function (b) { len += b.length; });
    var data = new Float32Array(len), off = 0;
    buffers.forEach(function (b) { data.set(b, off); off += b.length; });
    var ratio = inRate / outRate, outLen = Math.floor(data.length / ratio), out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) out[i] = data[Math.floor(i * ratio)];
    var buf = new ArrayBuffer(44 + out.length * 2), v = new DataView(buf);
    function ws(o, s) { for (var k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); }
    ws(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, out.length * 2, true);
    var p = 44; for (var j = 0; j < out.length; j++) { var s = Math.max(-1, Math.min(1, out[j])); v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true); p += 2; }
    return buf;
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf), bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var NUMW = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  var DKEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dkey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDate(k) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || '')); if (!m) return ''; var d = new Date(+m[1], +m[2] - 1, +m[3]); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; }
  function spokenTime(hhmm) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); if (!m) return '';
    var h = +m[1], mi = +m[2], ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
    if (h === 12 && mi === 0) return 'noon';
    return h12 + (mi ? ':' + pad2(mi) : '') + ' ' + ap;
  }
  function clip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function cap1(s) { return String(s).replace(/^./, function (c) { return c.toUpperCase(); }); }
  function clone(o) { try { return JSON.parse(JSON.stringify(o == null ? null : o)); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function normWords(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // The day at a glance, from his bridge state (telemetry strip, greeting).
  function dayStats(st, now) {
    now = now || new Date();
    st = st || {};
    var today = dkey(now), items = ((st.data || {})[today] || []).filter(function (x) { return x && x.title; });
    var left = items.filter(function (x) { return !x.done; });
    var hm = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    var next = left.filter(function (x) { return x.time && x.time >= hm; }).sort(function (a, b) { return a.time < b.time ? -1 : 1; })[0] || null;
    var habits = st.habits || [], hc = st.hc || {};
    var hkey = '-' + now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
    var ticked = habits.filter(function (h) { return hc[h.id + hkey]; }).length;
    return { total: items.length, done: items.length - left.length, left: left.length, next: next, habits: habits.length, habitsDone: ticked };
  }
  // Short on purpose (Tony, 2026-11-09: "too long winded").
  function greeting(st, now) {
    now = now || new Date();
    var h = now.getHours(), s = dayStats(st, now);
    var line = h < 5 ? 'Working late, Tony.' : h < 12 ? 'Good morning, Tony.' : h < 17 ? 'Good afternoon, Tony.' : 'Good evening, Tony.';
    if (!s.total) return line + ' Your day is clear.';
    if (!s.left) return line + ' All done today.';
    line += ' ' + cap1(s.left <= 12 ? NUMW[s.left] : String(s.left)) + ' left today';
    if (s.next) line += '; next, ' + s.next.title + ' at ' + spokenTime(s.next.time);
    return line + '.';
  }

  // One action → one card {icon, label, detail}, or null for nothing to show.
  function cardFor(a) {
    if (!a || !a.type) return null;
    var m = a.match || {}, t = a.title || m.title || '';
    var when = [fmtDate(a.date), a.time ? a.time : ''].filter(Boolean).join(' · ');
    switch (a.type) {
      case 'add_task':
        if (a.box === 'dailyHabits') return { icon: '✦', label: 'Habit added', detail: t };
        if (a.box === 'shortTermGoals' || a.box === 'longTermGoals') return { icon: '◆', label: 'Goal added', detail: t };
        return { icon: '✓', label: (a.kind === 'event' || a.time) ? 'Event added' : 'Task added', detail: [t || (a.altSeqTitles || []).join(' / '), when].filter(Boolean).join(' · ') + (a.notify ? ' · reminder' : '') };
      case 'edit_task': return { icon: '✎', label: 'Updated', detail: t };
      case 'remove_task': return { icon: '✕', label: 'Removed', detail: t + (a.scope === 'future' ? ' · future' : a.scope === 'all' ? ' · all' : '') };
      case 'toggle_task': return { icon: a.done === false ? '○' : '✓', label: a.done === false ? 'Unticked' : 'Done', detail: t };
      case 'move_task': return { icon: '➜', label: 'Moved', detail: [t, fmtDate(a.toDate)].filter(Boolean).join(' → ') };
      case 'swap': return { icon: '⇄', label: 'Swapped', detail: [(a.first || {}).title, (a.second || {}).title].filter(Boolean).join(' ⇄ ') };
      case 'reorder': return { icon: '↕', label: 'Reordered', detail: t };
      case 'clear': return { icon: '✕', label: 'Cleared', detail: fmtDate(a.date) || a.box || '' };
      case 'shift_range': return { icon: '⇥', label: 'Shifted', detail: (a.days > 0 ? '+' : '') + a.days + ' day' + (Math.abs(a.days) === 1 ? '' : 's') + ' · ' + [fmtDate(a.from), fmtDate(a.to)].filter(Boolean).join(' – ') };
      case 'clear_completed': return { icon: '✓', label: 'Cleaned up', detail: 'completed items' };
      case 'go_to_date': return { icon: '◎', label: 'Showing', detail: fmtDate(a.date) };
      case 'set_edit_mode': return { icon: '✎', label: 'Edit mode', detail: a.on ? 'on' : 'off' };
      case 'refresh_quote': return { icon: '❝', label: 'New quote', detail: '' };
      case 'timer_set': return { icon: '⏱', label: 'Timer', detail: pad2(a.minutes || 0) + ':00' + (a.start ? ' · running' : '') };
      case 'timer_start': return { icon: '⏱', label: 'Timer', detail: 'running' };
      case 'timer_stop': return { icon: '⏱', label: 'Timer', detail: 'paused' };
      case 'timer_reset': return { icon: '⏱', label: 'Timer', detail: 'reset' };
      case 'timer_open': return { icon: '⏱', label: 'Timer', detail: 'open' };
      case 'timer_close': return { icon: '⏱', label: 'Timer', detail: 'closed' };
      case 'timer_mode': return { icon: '⏱', label: 'Timer', detail: String(a.mode || '') };
      case 'timer_add': return { icon: '⏱', label: 'Timer', detail: (a.minutes > 0 ? '+' : '') + a.minutes + ' min' };
      case 'undo': return { icon: '↶', label: 'Undone', detail: '' };
      case 'redo': return { icon: '↷', label: 'Redone', detail: '' };
      case 'open_app': return { icon: '◎', label: 'Opening', detail: cap1(String(a.target || '')) };
      case 'open_link': return { icon: '◎', label: 'Opening', detail: String(a.label || t) };
      case 'prep_task': return { icon: '✦', label: 'AI prep', detail: t };
      case 'prep_off': return { icon: '✦', label: 'AI prep off', detail: t };
      case 'prep_open': return { icon: '✦', label: 'Starting', detail: t };
      case 'prep_show': return { icon: '✦', label: 'Prep panel', detail: t };
      case 'assistant_off': return { icon: '⏻', label: 'Neo off', detail: '' };
      case 'open_pc_app': return { icon: '⧉', label: 'Launching', detail: a.name || t };
      case 'open_site': { var host = String(a.url || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').split('/')[0]; return { icon: '◎', label: 'Opening', detail: host }; }
      case 'close_pc_app': return { icon: '⊗', label: a.force ? 'Force quit' : 'Closing', detail: a.name || t };
      case 'close_all_pc_apps': return { icon: '⊗', label: 'Closing all', detail: (a.except && a.except.length) ? 'except ' + a.except.join(', ') : '' };
      case 'clear_reminder': return { icon: '○', label: 'Reminder cleared', detail: t };
      case 'week_view': return { icon: '▤', label: 'Week', detail: a.collapsed === false ? 'expanded' : 'collapsed' };
      case 'goals_tab': return { icon: '◆', label: 'Goals', detail: /long/i.test(a.tab || a.target || '') ? 'long term' : 'short term' };
      case 'month_shift': return { icon: '◎', label: 'Month', detail: (a.by > 0 ? 'next' : 'previous') };
      case 'lock_app': return { icon: '⊘', label: 'Locked', detail: cap1(String(a.target || '')) };
      case 'journal_entry': return { icon: '✎', label: 'Journal entry', detail: a.title || clip(a.text, 40) };
      case 'plan_add': return { icon: '✧', label: 'Plan idea', detail: t };
      case 'plan_propose': return { icon: '✧', label: 'Plan proposed', detail: t };
      case 'plan_confirm': return { icon: '✧', label: 'Plan confirmed', detail: t };
      case 'plan_decline': return { icon: '✧', label: 'Plan declined', detail: t };
      case 'plan_cancel_request': return { icon: '✧', label: 'Cancel asked', detail: t };
      case 'plan_done': return { icon: '✧', label: 'Plan done', detail: t };
    }
    return null;
  }

  // ══ saying only what actually happened — and saying it briefly ═════════════
  function actName(a) {
    a = a || {}; var m = a.match || {};
    return String(a.name || a.title || m.title || a.label || (a.first || {}).title || '').trim();
  }
  var BAD_CARD = {
    not_found: 'not found', no_bridge: 'out of reach', off_pc: 'PC only', locked: 'locked', no_reminder: 'no reminder',
    not_flagged: 'no AI prep', prep_failed: 'prep failed', not_running: 'not running', still_open: 'left open', bridge_down: 'bridge down',
    blocked: 'blocked', nothing: 'nothing to do', already: 'already done', bioFailed: 'not verified', failed: 'failed',
  };
  function failCard(r) {
    var a = (r && r.action) || {};
    var base = cardFor(a) || { detail: actName(a) };
    return { icon: '✕', label: (base.label || 'Not done') + (BAD_CARD[r.reason] ? ' · ' + BAD_CARD[r.reason] : ' · not done'), detail: base.detail || actName(a), bad: true };
  }
  // One failed result → one short line (shown, and spoken when nothing worked).
  function failLine(r) {
    if (!r || r.ok) return '';
    if (r.say) return r.say;
    var a = r.action || {}, ty = a.type || '', t = actName(a);
    switch (r.reason) {
      case 'not_found':
        if (/^plan_/.test(ty)) return 'No plan called ' + (t || 'that') + '.';
        if (ty === 'open_pc_app' || ty === 'close_pc_app') return 'Can\'t find ' + (t || 'that app') + ' on your PC.';
        if (ty === 'open_link') return 'No link called ' + (t || 'that') + '.';
        if (ty === 'shift_range' || ty === 'clear_completed') return 'Nothing there to change.';
        return t ? 'Couldn\'t find ' + t + '.' : 'Couldn\'t find that.';
      case 'off_pc': return /^close_/.test(ty) ? 'Apps only close from your PC.' : 'Apps only open from your PC.';
      case 'locked': return 'Still locked; nothing changed.';
      case 'no_reminder': return (t || 'That') + ' has no reminder.';
      case 'not_flagged': return (t || 'That task') + ' has no AI prep yet.';
      case 'prep_failed': return 'Couldn\'t prep ' + (t || 'that') + '.';
      case 'no_lock': return 'That has no lock.';
      case 'already': return /^plan_/.test(ty) ? 'Already done for ' + (t || 'that plan') + '.' : 'Already done.';
      case 'not_waiting': return (t || 'That plan') + ' isn\'t waiting on you.';
      case 'not_confirmed': return (t || 'That plan') + ' isn\'t confirmed yet.';
      case 'bioFailed': return 'Fingerprint didn\'t pass.';
      case 'journal_not_ready': return 'Your journal isn\'t loaded yet.';
      case 'nothing': return ty === 'redo' ? 'Nothing to redo.' : 'Nothing to undo.';
      case 'invalid': return 'Didn\'t catch that.';
      case 'no_bridge': return 'Out of reach here.';
    }
    return t ? 'Couldn\'t do ' + t + '.' : 'Couldn\'t do that.';
  }
  function failSpeech(results) {
    var seen = {}, out = [];
    (results || []).forEach(function (r) { var l = failLine(r); if (l && !seen[l]) { seen[l] = 1; out.push(l); } });
    return out.join(' ');
  }
  // What he HEARS once the actions have run (Tony, 2026-11-09: say "Done", show
  // the detail). A question (no actions) is answered aloud in full.
  //   nothing returned → the model's answer      everything worked → "Done."
  //   nothing worked   → the failures             some worked      → "Done, except: …"
  function spokenFor(say, results) {
    results = results || [];
    if (!results.length) return String(say || '').trim();
    var bad = results.filter(function (r) { return !r.ok; });
    if (!bad.length) return 'Done.';
    var fl = failSpeech(bad);
    return bad.length === results.length ? fl : 'Done, except: ' + fl;
  }
  // What he SEES: exactly what changed, in one short line. The full list is
  // under the details button.
  function cardText(c) { return c.label + (c.detail ? ' · ' + c.detail : ''); }
  function shownFor(say, results) {
    results = results || [];
    if (!results.length) return String(say || '').trim();
    var ok = results.filter(function (r) { return r.ok; }), bad = results.filter(function (r) { return !r.ok; });
    var parts = ok.map(function (r) {
      if (r.diff && r.diff.length) return (r.action.type === 'redo' ? 'Redone: ' : 'Undone: ') + diffLine(r.diff);
      if (r.action && (r.action.type === 'undo' || r.action.type === 'redo')) return r.action.type === 'redo' ? 'Redid the last undo.' : 'Undid the last change.';
      var c = cardFor(r.action); return c ? cardText(c) : '';
    }).filter(Boolean);
    var line = parts.length <= 2 ? parts.join('; ') : parts.slice(0, 2).join('; ') + '; +' + (parts.length - 2) + ' more';
    if (!line && ok.length) line = String(say || '').trim() || 'Done.';
    var notes = ok.map(function (r) { return r.note; }).filter(Boolean).join(' ');
    if (notes) line = (line ? line + '. ' : '') + notes;
    if (bad.length) line = (line ? line.replace(/[.;]?$/, '.') + ' ' : '') + failSpeech(bad);
    return line;
  }

  // ══ what an undo undid: a diff of his TaskHub before and after ═════════════
  function snapState(st) {
    if (!st) return null;
    return clone({ data: st.data || {}, habits: st.habits || [], hc: st.hc || {}, shortGoals: st.shortGoals || [], longGoals: st.longGoals || [] });
  }
  function indexItems(s) {
    var out = {};
    Object.keys((s && s.data) || {}).forEach(function (k) {
      if (!DKEY_RE.test(k)) return;
      (s.data[k] || []).forEach(function (x) { if (x && x.id && !x._planId) out['c:' + x.id] = { item: x, key: k, box: 'calendar' }; });
    });
    [['habits', 'habit'], ['shortGoals', 'short-term goal'], ['longGoals', 'long-term goal']].forEach(function (b) {
      ((s && s[b[0]]) || []).forEach(function (x) { if (x && x.id) out[b[0] + ':' + x.id] = { item: x, box: b[1] }; });
    });
    return out;
  }
  // → [{verb, title, key?, extra?}] (grouped later by diffLine). Pure.
  function diffState(a, b) {
    if (!a || !b) return [];
    var A = indexItems(a), B = indexItems(b), out = [];
    Object.keys(A).forEach(function (id) {
      var x = A[id], y = B[id], t = (x.item.title || '').trim(); if (!t) return;
      if (!y) { out.push({ verb: 'removed', title: t, key: x.key }); return; }
      var yt = (y.item.title || '').trim();
      if (yt && yt !== t) out.push({ verb: 'renamed', title: t, extra: yt });
      if (x.key && y.key && x.key !== y.key) out.push({ verb: 'moved', title: yt || t, extra: fmtDate(y.key) });
      if (!!x.item.done !== !!y.item.done) out.push({ verb: y.item.done ? 'ticked' : 'unticked', title: yt || t, key: y.key });
      if ((x.item.time || '') !== (y.item.time || '')) out.push({ verb: 'retimed', title: yt || t, extra: y.item.time ? spokenTime(y.item.time) : 'no time' });
      if ((x.item.notifyAt || '') !== (y.item.notifyAt || '')) out.push({ verb: y.item.notifyAt ? (x.item.notifyAt ? 'reminder changed' : 'reminder set') : 'reminder cleared', title: yt || t });
      if (!!x.item.aiPrep !== !!y.item.aiPrep) out.push({ verb: y.item.aiPrep ? 'AI prep on' : 'AI prep off', title: yt || t });
    });
    Object.keys(B).forEach(function (id) {
      if (A[id]) return; var y = B[id], t = (y.item.title || '').trim(); if (!t) return;
      out.push({ verb: 'restored', title: t, key: y.key });
    });
    // Habit ticks: "<habitId>-<y>-<m 0-11>-<d>".
    var names = {}; ((b.habits || []).concat(a.habits || [])).forEach(function (h) { if (h && h.id) names[h.id] = h.title; });
    var ha = a.hc || {}, hb = b.hc || {}, keys = {};
    Object.keys(ha).concat(Object.keys(hb)).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (!!ha[k] === !!hb[k]) return;
      var m = /^(.*)-(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(k); if (!m || !names[m[1]]) return;
      out.push({ verb: hb[k] ? 'ticked' : 'unticked', title: names[m[1]], key: dkey(new Date(+m[2], +m[3], +m[4])) });
    });
    return out;
  }
  // [{verb, title, key?, extra?}] → "removed Buy milk · Fri 6 Nov; unticked Read". Pure.
  function diffLine(list, max) {
    max = max || 3;
    var groups = [], at = {};
    (list || []).forEach(function (d) {
      var k = d.verb + '\u0001' + d.title + '\u0001' + (d.extra || '');
      if (!(k in at)) { at[k] = groups.length; groups.push({ d: d, n: 0 }); }
      groups[at[k]].n++;
    });
    var phr = groups.map(function (g) {
      var d = g.d, s;
      if (d.verb === 'renamed') s = 'renamed ' + d.title + ' to ' + d.extra;
      else if (d.verb === 'moved') s = 'moved ' + d.title + ' to ' + d.extra;
      else if (d.verb === 'retimed') s = d.title + ' → ' + d.extra;
      else if (/^(reminder|AI prep)/.test(d.verb)) s = d.title + ': ' + d.verb;
      else s = d.verb + ' ' + d.title;
      if (g.n > 1) s += ' ×' + g.n; else if (d.key && !/^(moved|renamed)$/.test(d.verb)) s += ' · ' + fmtDate(d.key);
      return s;
    });
    if (!phr.length) return '';
    return phr.length <= max ? phr.join('; ') : phr.slice(0, max).join('; ') + '; +' + (phr.length - max) + ' more';
  }

  // ══ asking first ═══════════════════════════════════════════════════════════
  // Bulk deletions, range shifts and "close everything" are asked back as a
  // question; nothing runs until he says (or taps, or types) yes.
  var BOXN = { dailyHabits: 'daily habits', shortTermGoals: 'short-term goals', longTermGoals: 'long-term goals' };
  function spokenNum(n) { return n <= 12 ? (n === 0 ? 'no' : NUMW[n]) : String(n); }
  function spokenDate(k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || '')); if (!m) return 'that day';
    var d = new Date(+m[1], +m[2] - 1, +m[3]), n = d.getDate();
    var th = (n % 10 === 1 && n !== 11) ? 'st' : (n % 10 === 2 && n !== 12) ? 'nd' : (n % 10 === 3 && n !== 13) ? 'rd' : 'th';
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ' the ' + n + th;
  }
  function needsConfirm(acts, st) {
    st = st || {};
    var data = st.data || {}, q = [], removes = 0;
    (acts || []).forEach(function (a) {
      if (!a || !a.type) return;
      if (a.type === 'remove_task') {
        removes++;
        if (a.scope === 'future' || a.scope === 'all') q.push('remove ' + (a.scope === 'all' ? 'every' : 'every future') + ' ' + (actName(a) || 'occurrence') + ' in that series');
      } else if (a.type === 'clear') {
        if (a.box && a.box !== 'calendar') { q.push('clear all your ' + (BOXN[a.box] || 'items')); return; }
        var k = a.date || st.selectedDate, n = (data[k] || []).filter(function (x) { return x && x.title; }).length;
        if (n) q.push('clear all ' + spokenNum(n) + ' item' + (n === 1 ? '' : 's') + ' on ' + spokenDate(k));
      } else if (a.type === 'clear_completed') {
        q.push('delete every completed item' + (a.from && a.to ? ' from ' + spokenDate(a.from) + ' to ' + spokenDate(a.to) : ''));
      } else if (a.type === 'shift_range') {
        var d = parseInt(a.days, 10) || 0;
        q.push('move everything ' + (a.from ? 'from ' + spokenDate(a.from) + ' ' : '') + (a.to && a.to !== a.from ? 'to ' + spokenDate(a.to) + ' ' : '') + spokenNum(Math.abs(d)) + ' day' + (Math.abs(d) === 1 ? '' : 's') + (d < 0 ? ' earlier' : ' later'));
      } else if (a.type === 'close_all_pc_apps') {
        q.push('close all your apps' + (a.except && a.except.length ? ' except ' + a.except.join(' and ') : ''));
      } else if (a.type === 'plan_confirm') {
        var pl = (st.plans || []).filter(function (p) { return p && p.title && actName(a) && p.title.toLowerCase().indexOf(actName(a).toLowerCase()) >= 0; })[0];
        if (pl && !pl.date) q.push('confirm ' + pl.title + ', though it has no date yet');
      }
    });
    if (removes > 3) q.unshift('remove ' + spokenNum(removes) + ' items');
    return q.length ? { question: cap1(q.join(', and ')) + '?' } : null;
  }
  // Before anything runs: is this really a new request from him?
  //  · Neo hearing itself (spoken turns only): the transcript is mostly Neo's last line.
  //  · a replay: every action re-adds what the previous turn just added, and he
  //    didn't say "again" / "another".
  function overlap(a, b) {
    var wa = normWords(a).split(' ').filter(function (w) { return w.length > 2; });
    var wb = normWords(b).split(' ').filter(function (w) { return w.length > 2; });
    if (wa.length < 3 || !wb.length) return 0;
    return wa.filter(function (w) { return wb.indexOf(w) >= 0; }).length / wa.length;
  }
  function isReplay(acts, prev, transcript) {
    if (!prev || !acts || !acts.length) return false;
    if (/\b(again|another|one more|second|twice|duplicate|copy)\b/i.test(String(transcript || ''))) return false;
    var added = (prev.did || []).filter(function (d) { return d.type === 'add_task' && d.ok && d.title; }).map(function (d) { return normWords(d.title); });
    if (!added.length) return false;
    return acts.every(function (a) { return a && a.type === 'add_task' && added.indexOf(normWords(a.title || (a.altSeqTitles || [])[0] || '')) >= 0; });
  }
  function guardTurn(acts, st, reply) {
    var tr = (reply && reply.transcript) || '';
    if (!S.typed && S.lastSaid && overlap(tr, S.lastSaid) >= 0.6) return { drop: 'echo' };
    var prev = S.prev && Date.now() - S.prev.at < PREV_MS ? S.prev.data : null;
    if (isReplay(acts, prev, tr)) return { drop: 'replay' };
    return needsConfirm(acts, st);
  }
  function isYes(t) { return /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|confirm(ed)?|please( do)?|affirmative|correct|right)\b/i.test(String(t || '')); }
  function isNo(t) { return /^\s*(no|nope|nah|don'?t|do not|cancel|stop|never ?mind|leave it|wait)\b/i.test(String(t || '')); }
  // Undo / redo said or typed on their own run here, on the device: instant, free.
  function isUndo(t) { return /^\s*(please\s+)?(undo( that| last| it)?|revert( that)?|go back|that was a mistake)\s*[.!?]?\s*$/i.test(String(t || '')); }
  function isRedo(t) { return /^\s*(please\s+)?(redo( that| last| it)?)\s*[.!?]?\s*$/i.test(String(t || '')); }

  // What people call an app → its Start-menu name (normalised).
  var APP_ALIASES = {
    'vs code': 'visual studio code', 'vscode': 'visual studio code', 'code': 'visual studio code',
    'chrome': 'google chrome', 'google': 'google chrome', 'explorer': 'file explorer', 'files': 'file explorer',
    'teams': 'microsoft teams', 'edge': 'microsoft edge', 'store': 'microsoft store', 'settings': 'settings',
    'terminal': 'terminal', 'cmd': 'command prompt', 'calc': 'calculator', 'ppt': 'powerpoint', 'powerpoint': 'powerpoint',
  };
  // A spoken app name → one of his PC's apps ({id,name}, which his PC's A1 Prep
  // Bridge publishes). Exact, alias, whole words (shortest name wins), overlap.
  function matchApp(name, apps) {
    var norm = function (s) { return String(s).toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9+#_]+/g, ' ').trim(); };
    var q = norm(name || '');
    if (!q) return null;
    var list = (apps || []).filter(function (a) { return a && a.id && a.name; });
    var i, n;
    for (i = 0; i < list.length; i++) if (norm(list[i].name) === q) return list[i];
    var alias = APP_ALIASES[q];
    if (alias) for (i = 0; i < list.length; i++) if (norm(list[i].name) === alias) return list[i];
    var best = null;
    if (q.length >= 2) for (i = 0; i < list.length; i++) { n = norm(list[i].name); if ((' ' + n + ' ').indexOf(' ' + q + ' ') >= 0 && (!best || n.length < norm(best.name).length)) best = list[i]; }
    if (best) return best;
    var qw = q.split(' ').filter(function (w) { return w.length > 1; }), score = 0;
    for (i = 0; i < list.length; i++) {
      var ws = norm(list[i].name).split(' '), hit = qw.filter(function (w) { return ws.indexOf(w) >= 0; }).length;
      var sc = hit / Math.max(qw.length, ws.length);
      if (hit && sc > score) { score = sc; best = list[i]; }
    }
    return score >= 0.5 ? best : null;
  }
  function webUrl(u) {
    u = String(u || '').trim(); if (!u) return '';
    if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    try { var p = new URL(u); return /^https?:$/.test(p.protocol) && p.hostname.indexOf('.') > 0 ? p.href : ''; } catch (e) { return ''; }
  }
  function launchIssue(res, missing, bridgeErr, names) {
    if (missing && missing.length) return 'Can\'t find ' + missing.join(' or ') + ' on your PC.';
    if (!res) {
      if (/blocked/.test(bridgeErr || '')) return 'The browser is blocking your PC. Allow local network access for this site.';
      return 'Your PC\'s launcher isn\'t answering. ' + P.bridgeHint;
    }
    var bad = (res.unknown || []).map(function (id) { return names[id] || 'one of them'; }).concat(res.failed || []);
    return bad.length ? bad.join(' and ') + ' didn\'t open.' : '';
  }

  // The device voice when Orca can't speak: his chosen voice's locale first,
  // then British male (like Ryan).
  function pickVoiceFrom(vs, voiceId) {
    vs = vs || [];
    var loc = (/^([a-z]{2}-[A-Z]{2})-/.exec(String(voiceId || '')) || [])[1];
    var male = !voiceId || VOICE_GENDER[voiceId] !== 'female';
    var prefs = male ? ['Microsoft Ryan Online', 'Microsoft Thomas Online', 'Google UK English Male', 'Daniel', 'Microsoft George', 'Arthur', 'Oliver']
      : ['Microsoft Libby Online', 'Microsoft Sonia Online', 'Google UK English Female', 'Serena', 'Kate', 'Microsoft Hazel'];
    if (loc && loc !== 'en-GB') {
      var same = vs.filter(function (v) { return String(v.lang).replace('_', '-') === loc; });
      var g = same.find(function (v) { return male ? !/female|woman/i.test(v.name) : /female|woman|aria|jenny|ava|emma|michelle|natasha|neerja|emily/i.test(v.name); });
      if (g || same[0]) return g || same[0];
    }
    for (var i = 0; i < prefs.length; i++) { var p = prefs[i], hit = vs.find(function (v) { return String(v.name).indexOf(p) === 0; }); if (hit) return hit; }
    return vs.find(function (v) { return /^en[-_]GB/i.test(v.lang) && (male ? /male|man|guy/i.test(v.name) && !/female|woman/i.test(v.name) : /female|woman/i.test(v.name)); })
      || vs.find(function (v) { return /^en[-_]GB/i.test(v.lang); })
      || vs.find(function (v) { return /^en/i.test(v.lang); }) || null;
  }

  // ══ his settings (synced: dashboards/neo_tony) ═════════════════════════════
  // Orca's Edge voices, the set Shruti offers (Shruti/app/orca.js VOICES).
  var VOICES = [
    ['en-GB-RyanNeural', 'Ryan', 'en-GB', 'male'], ['en-GB-ThomasNeural', 'Thomas', 'en-GB', 'male'],
    ['en-GB-SoniaNeural', 'Sonia', 'en-GB', 'female'], ['en-GB-LibbyNeural', 'Libby', 'en-GB', 'female'],
    ['en-US-AndrewMultilingualNeural', 'Andrew', 'en-US', 'male'], ['en-US-BrianMultilingualNeural', 'Brian', 'en-US', 'male'],
    ['en-US-GuyNeural', 'Guy', 'en-US', 'male'], ['en-US-ChristopherNeural', 'Christopher', 'en-US', 'male'], ['en-US-SteffanNeural', 'Steffan', 'en-US', 'male'],
    ['en-US-AvaMultilingualNeural', 'Ava', 'en-US', 'female'], ['en-US-EmmaMultilingualNeural', 'Emma', 'en-US', 'female'],
    ['en-US-JennyNeural', 'Jenny', 'en-US', 'female'], ['en-US-AriaNeural', 'Aria', 'en-US', 'female'], ['en-US-MichelleNeural', 'Michelle', 'en-US', 'female'],
    ['en-AU-WilliamMultilingualNeural', 'William', 'en-AU', 'male'], ['en-AU-NatashaNeural', 'Natasha', 'en-AU', 'female'],
    ['en-IN-PrabhatNeural', 'Prabhat', 'en-IN', 'male'], ['en-IN-NeerjaNeural', 'Neerja', 'en-IN', 'female'],
    ['en-IE-ConnorNeural', 'Connor', 'en-IE', 'male'], ['en-IE-EmilyNeural', 'Emily', 'en-IE', 'female'],
  ].map(function (v) { return { id: v[0], name: v[1], locale: v[2], gender: v[3] }; });
  var VOICE_GENDER = {}; VOICES.forEach(function (v) { VOICE_GENDER[v.id] = v.gender; });
  var LOCALE_NAME = { 'en-GB': 'British', 'en-US': 'American', 'en-AU': 'Australian', 'en-IN': 'Indian', 'en-IE': 'Irish' };
  function voiceName(id) { var v = VOICES.find(function (x) { return x.id === id; }); return v ? v.name : 'Ryan'; }

  var SET_LS = 'th_neo_settings', MIC_LS = 'th_neo_mic_id';
  var DEFAULTS = { voice: DEFAULT_VOICE, micLabel: '', speakTyped: true, at: 0 };
  // Only known shapes get in, from either side (this device or the cloud).
  function cleanSettings(o) {
    o = (o && typeof o === 'object') ? o : {};
    var out = {};
    if (typeof o.voice === 'string' && VOICE_GENDER[o.voice]) out.voice = o.voice;
    if (typeof o.micLabel === 'string') out.micLabel = o.micLabel.slice(0, 200);
    if (typeof o.speakTyped === 'boolean') out.speakTyped = o.speakTyped;
    if (typeof o.at === 'number' && isFinite(o.at)) out.at = o.at;
    return out;
  }
  function readSettings() {
    var o = {}; try { o = JSON.parse(localStorage.getItem(SET_LS) || '{}'); } catch (e) {}
    return Object.assign({}, DEFAULTS, cleanSettings(o));
  }
  var SET = readSettings();
  function storeSettings() { try { localStorage.setItem(SET_LS, JSON.stringify(SET)); } catch (e) {} }
  function settingsChanged() { try { window.dispatchEvent(new CustomEvent('th-neo-settings', { detail: Object.assign({}, SET) })); } catch (e) {} if (H) refreshTele(); }
  // A change made here: this device now, every device of his through Firestore.
  function setSettings(patch) {
    var c = cleanSettings(patch);
    if (!Object.keys(c).length) return false;
    SET = Object.assign({}, SET, c, { at: Date.now() });
    storeSettings(); settingsChanged();
    var save = window._fbSaveNeoTony;
    if (typeof save === 'function') { try { save({ voice: SET.voice, micLabel: SET.micLabel, speakTyped: SET.speakTyped, at: SET.at }); } catch (e) {} }
    return true;
  }
  // The cloud copy (index.html's listener): newer wins.
  function applyRemote(o) {
    var c = cleanSettings(o);
    if (!c.at || c.at <= (SET.at || 0)) return false;
    SET = Object.assign({}, DEFAULTS, SET, c);
    storeSettings(); settingsChanged();
    if (S.running && c.micLabel !== undefined) { teardown(); sync(); }   // a new mic: reopen on it
    return true;
  }
  window.addEventListener('th-neo-remote', function (e) { applyRemote(e && e.detail); });
  if (window._thNeoRemote) applyRemote(window._thNeoRemote);

  async function listMics() {
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return [];
    try { return (await md.enumerateDevices()).filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'; }); } catch (e) { return []; }
  }
  // His chosen microphone on THIS device: device ids differ per device and site,
  // so the label is what syncs; the id found for it is kept on the device.
  async function micDeviceId() {
    if (!SET.micLabel) return '';
    var local = ''; try { local = localStorage.getItem(MIC_LS) || ''; } catch (e) {}
    var devs = await listMics();
    var hit = devs.find(function (d) { return d.label && d.label === SET.micLabel; });
    if (hit) { try { localStorage.setItem(MIC_LS, hit.deviceId); } catch (e) {} return hit.deviceId; }
    var labelled = devs.some(function (d) { return d.label; });
    return labelled ? '' : local;   // no labels yet (no permission): the last id this device used
  }

  // ══ state ══════════════════════════════════════════════════════════════════
  var S = {
    on: false, running: false, starting: false,
    talk: false,            // a Talk-button session (no wake phrase; ends when the conversation does)
    talkStart: false,       // …start capturing as soon as the mic is up
    typed: false,           // the turn in hand was typed
    mode: 'off',            // off | loading | boot | wake | capture | thinking | speaking | follow | note | error
    stream: null, ctx: null, src: null, proc: null, sr: 48000, anMic: null, anOut: null,
    model: null, rec: null, cap: null,
    ring: [], ringLen: 0, chunks: [], vad: null, followUntil: 0,
    floor: 0.006, greet: false, level: 0, afterSay: '',
    capText: '', pending: null, lastSaid: '', deafUntil: 0, capFollow: false,
    prev: null, history: [], holdUntil: 0,
    turn: null,             // the latest turn, for the details popover: {you, shown, cards, truncated}
  };
  try { S.on = localStorage.getItem(P.pref) === '1'; } catch (e) {}
  var reduced = false; try { reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function emit() { try { window.dispatchEvent(new CustomEvent('th-neo-change', { detail: { on: S.on, mode: S.mode, talk: S.talk } })); } catch (e) {} }
  function setMode(m) { S.mode = m; hudMode(m); emit(); }
  function bridgeState() { try { var b = W('bridge'); return b && b.getState ? b.getState() : null; } catch (e) { return null; } }

  // ══ styles ═════════════════════════════════════════════════════════════════
  var styled = false;
  function ensureStyles() {
    if (styled || !document.head) return; styled = true;
    var st = document.createElement('style'); st.id = 'th-neo-style';
    st.textContent = [
      '#th-neo-hud{--ac:#c0aeea;--acl:#dbd0f5;--acd:#9a86c9;--tx:#f4f3f0;--txd:#adadb2;--txm:#8d8d94;--s1:#232327;--s2:#2c2c31;--bdl:#45454c;--hl:rgba(255,255,255,.06);--red:#d68a7c;',
      ' position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:100000;width:min(560px,calc(100vw - 32px));box-sizing:border-box;',
      ' transform:translate(-50%,14px);opacity:0;pointer-events:none;transition:opacity .22s ease,transform .3s cubic-bezier(.2,.9,.25,1);',
      " font-family:'Inter',system-ui,-apple-system,sans-serif;color:var(--tx);font-variant-numeric:tabular-nums;}",
      '#th-neo-hud.show{opacity:1;transform:translate(-50%,0);pointer-events:auto;}',
      '#th-neo-hud .tn-panel{display:flex;align-items:center;gap:14px;min-width:0;box-sizing:border-box;padding:14px 14px 14px 16px;background:var(--s1);border:1px solid var(--hl);border-radius:8px;box-shadow:0 18px 48px rgba(0,0,0,.45);}',
      '#th-neo-hud .tn-orb{flex:0 0 84px;width:84px;height:84px;align-self:center;}',
      '#th-neo-hud canvas{width:100%;height:100%;display:block;}',
      '#th-neo-hud .tn-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;}',
      '#th-neo-hud .tn-head{display:flex;align-items:center;gap:10px;min-width:0;}',
      "#th-neo-hud .tn-brand{font-family:'Manrope','Inter',sans-serif;font-weight:800;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--acl);}",
      '#th-neo-hud .tn-state{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--txm);}',
      '#th-neo-hud .tn-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--ac);flex:0 0 auto;}',
      '#th-neo-hud.m-capture .tn-state::before{background:var(--red);animation:tnBlink 1s steps(2) infinite;}',
      '#th-neo-hud.m-thinking .tn-state::before,#th-neo-hud.m-loading .tn-state::before{animation:tnBreathe 1s ease-in-out infinite;}',
      '#th-neo-hud.m-error .tn-state{color:var(--red);}#th-neo-hud.m-error .tn-state::before{background:var(--red);}',
      '#th-neo-hud .tn-clock{margin-left:auto;font-size:10px;font-weight:600;letter-spacing:.6px;color:var(--txm);white-space:nowrap;}',
      '#th-neo-hud .tn-side{flex:0 0 auto;align-self:flex-start;display:flex;align-items:center;gap:6px;}',
      '#th-neo-hud .tn-side .tn-state{display:none;}',
      "#th-neo-hud .tn-btn{flex:0 0 auto;box-sizing:border-box;height:22px;min-width:22px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;gap:4px;background:transparent;border:1px solid var(--bdl);border-radius:6px;color:var(--txd);font:inherit;font-size:10px;font-weight:700;letter-spacing:.4px;line-height:1;cursor:pointer;transition:border-color .15s,color .15s;}",
      '#th-neo-hud .tn-btn:hover,#th-neo-hud .tn-btn[aria-expanded="true"]{border-color:var(--ac);color:var(--acl);}',
      '#th-neo-hud .tn-btn:focus-visible{outline:2px solid var(--ac);outline-offset:1px;}',
      '#th-neo-hud .tn-btn[hidden]{display:none;}',
      '#th-neo-hud .tn-more .ok{color:var(--ac);}#th-neo-hud .tn-more .bad{color:var(--red);}',
      '#th-neo-hud .tn-you{font-size:12px;line-height:1.4;color:var(--txm);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;}',
      '#th-neo-hud .tn-you:empty{display:none;}',
      '#th-neo-hud .tn-you::before{content:"You  ";color:var(--acd);font-weight:700;font-size:9.5px;letter-spacing:1px;text-transform:uppercase;}',
      '#th-neo-hud .tn-you.heard{color:var(--txd);}',
      '#th-neo-hud .tn-say{position:relative;font-size:14px;line-height:1.5;color:var(--tx);max-height:7.5em;overflow:hidden;overflow-wrap:anywhere;}',
      '#th-neo-hud .tn-say:empty{display:none;}',
      '#th-neo-hud .tn-say .w{opacity:.3;transition:opacity .18s;}#th-neo-hud .tn-say .w.lit{opacity:1;}',
      '#th-neo-hud .tn-say.ovf{-webkit-mask-image:linear-gradient(180deg,#000 62%,transparent);mask-image:linear-gradient(180deg,#000 62%,transparent);}',
      '#th-neo-hud .tn-cards{display:flex;flex-wrap:wrap;gap:6px;max-height:52px;overflow:hidden;}',
      '#th-neo-hud .tn-cards:empty{display:none;}',
      '#th-neo-hud .tn-card{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;box-sizing:border-box;padding:2px 8px;border:1px solid var(--bdl);border-radius:4px;font-size:11px;line-height:18px;animation:tnIn .3s ease both;}',
      '#th-neo-hud .tn-card i{font-style:normal;color:var(--ac);}',
      '#th-neo-hud .tn-card b{font-size:9.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--txd);white-space:nowrap;}',
      '#th-neo-hud .tn-card span{color:var(--txm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
      '#th-neo-hud .tn-card.bad{border-color:color-mix(in srgb,var(--red) 55%,transparent);}#th-neo-hud .tn-card.bad i,#th-neo-hud .tn-card.bad b{color:var(--red);}',
      '#th-neo-hud .tn-ask{display:inline-flex;align-items:center;gap:6px;}',
      '#th-neo-hud .tn-ask button{font:inherit;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 10px;border-radius:6px;cursor:pointer;background:transparent;color:var(--acl);border:1px solid var(--bdl);}',
      '#th-neo-hud .tn-ask button:hover{border-color:var(--ac);}#th-neo-hud .tn-ask button.y{background:var(--ac);border-color:var(--ac);color:#1a1a1d;}',
      '#th-neo-hud .tn-tele{display:flex;flex-wrap:wrap;gap:4px 14px;padding-top:8px;border-top:1px solid var(--hl);font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--txm);}',
      '#th-neo-hud .tn-tele b{color:var(--txd);font-weight:600;}',
      // phone: a bottom sheet
      '@media (max-width:600px){#th-neo-hud{left:0;right:0;width:auto;bottom:0;transform:translateY(20px);}',
      ' #th-neo-hud.show{transform:translateY(0);}',
      ' #th-neo-hud .tn-panel{border-radius:12px 12px 0 0;border-bottom:0;padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));gap:12px;}',
      ' #th-neo-hud .tn-orb{flex-basis:60px;width:60px;height:60px;}#th-neo-hud .tn-clock{display:none;}}',
      // ── docked: in his quote's slot (between weather and Tesla), at exactly the
      // quote's height so nothing below moves (taskhub-no-pixel-shift). One line
      // of what he said, the reply in the rest (it scrolls with the voice), and
      // everything else behind the details button.
      'body.tn-docked #root .thwx-band > .thwx-bq{display:none;}',
      'body.tn-undock #root .thwx-band > .thwx-bq{animation:tnIn .35s ease;}',
      '#th-neo-hud.tn-dock{position:relative;left:auto;right:auto;bottom:auto;z-index:auto;width:auto;min-width:0;display:none;transform:none;opacity:1;transition:none;overflow:hidden;}',
      '#th-neo-hud.tn-dock.show{display:block;animation:tnIn .3s ease;}',
      '#th-neo-hud.tn-dock .tn-panel{height:100%;gap:10px;padding:0 8px 0 10px;background:transparent;border:1px solid var(--hl);box-shadow:none;border-radius:8px;overflow:hidden;}',
      '#th-neo-hud.tn-dock .tn-orb{flex:0 0 36px;width:36px;height:20px;}',
      '#th-neo-hud.tn-dock .tn-body{height:100%;justify-content:center;gap:1px;padding:4px 0;box-sizing:border-box;min-height:0;}',
      '#th-neo-hud.tn-dock .tn-head,#th-neo-hud.tn-dock .tn-cards,#th-neo-hud.tn-dock .tn-tele{display:none;}',
      '#th-neo-hud.tn-dock .tn-you{flex:0 0 auto;font-size:11px;line-height:1.35;-webkit-line-clamp:1;}',
      '#th-neo-hud.tn-dock .tn-say{flex:0 1 auto;min-height:0;max-height:none;font-size:12.5px;line-height:1.4;}',
      '#th-neo-hud.tn-dock .tn-side{align-self:center;}',
      '#th-neo-hud.tn-dock .tn-side .tn-state{display:inline-flex;font-size:9px;letter-spacing:1px;}',
      '@media (max-width:600px){#th-neo-hud.tn-dock .tn-side .tn-state{display:none;}#th-neo-hud.tn-dock .tn-say{font-size:12px;}}',
      // ── the details popover (outside the HUD: the docked HUD clips)
      ".tn-pop{position:fixed;z-index:100001;box-sizing:border-box;width:min(420px,calc(100vw - 24px));max-height:min(60vh,460px);overflow:auto;overscroll-behavior:contain;padding:12px 14px;background:#232327;border:1px solid #45454c;border-radius:8px;box-shadow:0 18px 48px rgba(0,0,0,.5);font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5;color:#f4f3f0;font-variant-numeric:tabular-nums;opacity:0;transform:translateY(-4px);transition:opacity .15s ease,transform .15s ease;}",
      '.tn-pop.on{opacity:1;transform:none;}',
      ".tn-pop h4{margin:0 0 4px;font-family:'Manrope','Inter',sans-serif;font-weight:800;font-size:9.5px;letter-spacing:1.6px;text-transform:uppercase;color:#8d8d94;}",
      '.tn-pop section+section{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06);}',
      '.tn-pop p{margin:0;overflow-wrap:anywhere;}.tn-pop .you{color:#adadb2;}',
      '.tn-pop ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}',
      '.tn-pop li{display:grid;grid-template-columns:16px auto 1fr;gap:8px;align-items:baseline;}',
      '.tn-pop li i{font-style:normal;color:#c0aeea;}.tn-pop li b{font-size:9.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#adadb2;white-space:nowrap;}',
      '.tn-pop li span{color:#f4f3f0;overflow-wrap:anywhere;}.tn-pop li.bad i,.tn-pop li.bad b{color:#d68a7c;}',
      '.tn-pop .note{font-size:11.5px;color:#e0b874;}',
      // ── spotlight: the ring Neo draws round the row it is changing
      '.tn-spot{position:fixed;pointer-events:none;z-index:99990;box-sizing:border-box;border:1.5px solid #c0aeea;background:transparent;opacity:0;transform:scale(1.035);transition:opacity .18s ease-out,transform .18s ease-out;will-change:opacity,transform;}',
      '.tn-spot.on{opacity:1;transform:none;}',
      '.tn-spot.out{opacity:0;transform:scale(.97);transition:opacity .22s ease-in,transform .22s ease-in;}',
      '.tn-spot-gone{border-color:#d68a7c;}',
      // ── the composer (Type)
      '#tn-ask{position:fixed;inset:0;z-index:99400;display:flex;align-items:center;justify-content:center;padding:22px;box-sizing:border-box;background:rgba(0,0,0,.6);-webkit-backdrop-filter:blur(7px) saturate(.9);backdrop-filter:blur(7px) saturate(.9);opacity:0;pointer-events:none;transition:opacity .18s ease;}',
      '#tn-ask.show{opacity:1;pointer-events:auto;}',
      "#tn-ask .tn-ask-box{width:100%;max-width:600px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:14px 14px 12px;background:#232327;border:1px solid rgba(255,255,255,.06);border-radius:8px;box-shadow:0 24px 64px rgba(0,0,0,.5);font-family:'Inter',system-ui,-apple-system,sans-serif;color:#f4f3f0;transform:translateY(8px);transition:transform .2s ease;}",
      '#tn-ask.show .tn-ask-box{transform:none;}',
      '#tn-ask .tn-ask-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      "#tn-ask .tn-ask-title{display:flex;align-items:center;gap:8px;font-family:'Manrope','Inter',sans-serif;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#dbd0f5;}",
      '#tn-ask .tn-ask-title svg{width:14px;height:14px;color:#c0aeea;}',
      '#tn-ask .tn-ask-x{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid #45454c;border-radius:6px;color:#8d8d94;cursor:pointer;font-size:14px;line-height:1;}',
      '#tn-ask .tn-ask-x:hover{border-color:#c0aeea;color:#f4f3f0;}',
      '#tn-ask .tn-ask-wrap{position:relative;--ds-ac:#c0aeea;--ds-tx:#f4f3f0;--ds-txd:#8d8d94;}',
      "#tn-ask textarea{display:block;width:100%;box-sizing:border-box;min-height:96px;max-height:42vh;resize:none;overflow-y:auto;overscroll-behavior:contain;padding:11px 12px;background:#1a1a1d;border:1px solid #45454c;border-radius:6px;outline:none;font:inherit;font-size:15px;line-height:1.5;color:#f4f3f0;transition:border-color .15s,box-shadow .15s;}",
      '#tn-ask textarea:focus{border-color:#c0aeea;box-shadow:0 0 0 3px rgba(192,174,234,.16);}',
      '#tn-ask textarea::placeholder{color:#8d8d94;opacity:.7;}',
      '#tn-ask .tn-ask-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '#tn-ask .tn-ask-hint{font-size:11px;color:#8d8d94;line-height:1.4;min-width:0;}',
      '#tn-ask kbd{font:inherit;font-size:10px;font-weight:700;border:1px solid #45454c;border-radius:4px;padding:0 5px;}',
      '#tn-ask .tn-ask-send{flex:0 0 auto;background:#c0aeea;color:#1a1a1d;border:1px solid #c0aeea;border-radius:6px;padding:8px 18px;font:inherit;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;}',
      '#tn-ask .tn-ask-send:hover{box-shadow:0 0 0 3px rgba(192,174,234,.22);}',
      '#tn-ask .tn-ask-send:disabled{opacity:.5;cursor:default;box-shadow:none;}',
      '@media (max-width:600px){#tn-ask{align-items:flex-end;padding:0;}',
      ' #tn-ask .tn-ask-box{max-width:none;border-radius:12px 12px 0 0;border-bottom:0;padding-bottom:calc(12px + env(safe-area-inset-bottom,0px));margin-bottom:var(--tn-kb,0px);}',
      ' #tn-ask textarea{font-size:16px;min-height:88px;max-height:34vh;}#tn-ask .tn-ask-hint{display:none;}#tn-ask .tn-ask-foot{justify-content:flex-end;}}',
      // ── Settings → Tony's Neo AI
      '.tns{display:flex;flex-direction:column;gap:8px;}',
      '.thset-row.tns-row{display:flex;align-items:center;gap:12px;flex-wrap:nowrap;}',
      '.tns-txt{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;}',
      '.tns-txt .thset-label{white-space:normal;}',
      '.tns-sub{font-size:11px;font-weight:500;line-height:1.4;color:#8d8d94;}',
      '.tns-sub.warn{color:#e0b874;}',
      '.tns-ctl{display:flex;align-items:center;gap:6px;flex:0 1 260px;min-width:0;justify-content:flex-end;}',
      '.tns-ctl select{flex:1 1 auto;min-width:0;width:100%;}',
      '.tns-sw{position:relative;flex:0 0 auto;width:36px;height:20px;border-radius:10px;border:1px solid #45454c;background:transparent;cursor:pointer;padding:0;transition:background .15s,border-color .15s;}',
      '.tns-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#8d8d94;transition:transform .15s,background .15s;}',
      '.tns-sw[aria-checked="true"]{background:#c0aeea;border-color:#c0aeea;}',
      '.tns-sw[aria-checked="true"]::after{transform:translateX(16px);background:#1a1a1d;}',
      '.tns-sw:focus-visible{outline:2px solid #c0aeea;outline-offset:2px;}',
      '.tns-foot{font-size:10.5px;font-weight:600;color:#8d8d94;letter-spacing:.3px;}',
      '@media (max-width:520px){.thset-row.tns-row.tns-wrap{flex-wrap:wrap;}.tns-wrap .tns-ctl{flex:1 1 100%;}}',
      // ── header buttons: the NEO switch (a mini reactor) and Talk
      '.th-neo-btn .tnb{width:15px;height:15px;display:block;overflow:visible;}',
      '.th-neo-btn .tnb .r1{transform-origin:12px 12px;}',
      '.th-neo-btn.on .tnb .r1{animation:tnSpin 9s linear infinite;}',
      '.th-neo-btn.on .tnb .c{animation:tnBreathe 3.2s ease-in-out infinite;}',
      '.th-neo-btn.busy .tnb .r1{animation:tnSpin 1.1s linear infinite;}',
      '.th-neo-talk.rec{animation:tnRec 1.2s ease-in-out infinite;}',
      '@keyframes tnSpin{to{transform:rotate(360deg)}}',
      '@keyframes tnBreathe{0%,100%{opacity:.5}50%{opacity:1}}',
      '@keyframes tnBlink{50%{opacity:.25}}',
      '@keyframes tnRec{0%,100%{opacity:1}50%{opacity:.62}}',
      '@keyframes tnIn{from{opacity:0}to{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.th-neo-btn .tnb .r1,.th-neo-btn .tnb .c,.th-neo-talk.rec{animation:none!important}#th-neo-hud .tn-card{animation-duration:.01s}.tn-spot,.tn-spot.out{transform:none!important;transition:opacity .01s!important}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ══ HUD ════════════════════════════════════════════════════════════════════
  var H = null;
  function ensureHud() {
    if (H || !document.body) return H;
    ensureStyles();
    var el = document.createElement('div');
    el.id = 'th-neo-hud';
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="tn-panel"><div class="tn-orb"><canvas></canvas></div>' +
      '<div class="tn-body"><div class="tn-head"><span class="tn-brand">Neo</span><span class="tn-state">Online</span><span class="tn-clock"></span></div>' +
      '<div class="tn-you"></div><div class="tn-say"></div><div class="tn-cards"></div><div class="tn-tele"></div></div>' +
      '<div class="tn-side"><span class="tn-state">Online</span>' +
      '<button type="button" class="tn-btn tn-more" hidden aria-expanded="false" aria-haspopup="dialog" title="Details"></button>' +
      '<button type="button" class="tn-btn tn-x" aria-label="Dismiss" title="Dismiss">✕</button></div></div>';
    document.body.appendChild(el);
    var states = el.querySelectorAll('.tn-state');
    H = { el: el, canvas: el.querySelector('canvas'), states: states, clock: el.querySelector('.tn-clock'),
      you: el.querySelector('.tn-you'), say: el.querySelector('.tn-say'), cards: el.querySelector('.tn-cards'),
      tele: el.querySelector('.tn-tele'), more: el.querySelector('.tn-more') };
    el.querySelector('.tn-x').onclick = function () { cancel(); };
    // The details button; while Neo waits for a yes, it carries the yes / no.
    H.more.onclick = function (e) { e.stopPropagation(); if (S.pending) askYesNo(); else togglePop(); };
    return H;
  }
  var hideTimer = null, boot = 0;
  var LABEL = { loading: 'Starting', boot: 'Online', capture: 'Listening', thinking: 'Working', speaking: 'Replying', follow: 'Standing by', error: 'Error', note: 'Neo', wake: 'Online' };
  // Where the HUD sits: in place of his quote when that's on screen, else the
  // floating panel at the bottom. The docked HUD copies the quote's box exactly
  // (height, flex and order, so the tablet layout's full-width quote row stays
  // full width), so nothing on the page moves.
  function placeHud(h) {
    var b = document.querySelector(P.dock), dock = false;
    var r = b ? b.getBoundingClientRect() : null;
    if (r) dock = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 0);
    var s = h.el.style;
    if (dock) {
      var cs = getComputedStyle(b);
      s.height = Math.round(r.height) + 'px';
      s.flexGrow = cs.flexGrow; s.flexShrink = cs.flexShrink; s.flexBasis = cs.flexBasis; s.order = cs.order; s.maxWidth = cs.maxWidth;
      if (h.el.previousElementSibling !== b) b.parentNode.insertBefore(h.el, b.nextSibling);
    } else {
      s.height = s.flexGrow = s.flexShrink = s.flexBasis = s.order = s.maxWidth = '';
      if (h.el.parentNode !== document.body) document.body.appendChild(h.el);
    }
    h.el.classList.toggle('tn-dock', dock);
    document.body.classList.toggle('tn-docked', dock);
  }
  function hudShow(on) {
    var h = ensureHud(); if (!h) return;
    clearTimeout(hideTimer);
    if (on) { if (!h.el.classList.contains('show') || !h.el.isConnected) { placeHud(h); h.el.classList.add('show'); refreshTele(); startAnim(); } }
    else {
      closePop();
      if (h.el.classList.contains('show')) { h.el.classList.remove('show'); var bd = document.body.classList; if (bd.contains('tn-docked')) { bd.remove('tn-docked'); bd.add('tn-undock'); setTimeout(function () { bd.remove('tn-undock'); }, 400); } }
    }
  }
  // Hide once there's nothing left to read (holdUntil keeps a reply up).
  function hideSoon(ms) {
    clearTimeout(hideTimer);
    var wait = Math.max(ms || 0, S.holdUntil - Date.now());
    hideTimer = setTimeout(function () { if (S.mode === 'wake' || S.mode === 'off' || S.mode === 'note') hudShow(false); }, wait);
  }
  function hudMode(m) {
    var h = ensureHud(); if (!h) return;
    ['loading', 'boot', 'capture', 'thinking', 'speaking', 'follow', 'error', 'note'].forEach(function (k) { h.el.classList.toggle('m-' + k, k === m); });
    if (LABEL[m] && m !== 'wake') {
      for (var i = 0; i < h.states.length; i++) h.states[i].textContent = LABEL[m];
      hudShow(true);
    }
    if (m === 'capture') { h.you.textContent = ''; h.you.classList.remove('heard'); h.say.innerHTML = ''; h.say.classList.remove('ovf'); h.cards.innerHTML = ''; S.turn = null; refreshMore(); closePop(); }
    if (m === 'wake') hideSoon(900);
    if (m === 'off') { S.holdUntil = 0; hideSoon(0); }
  }
  function hudNote(text, kind, ms) {
    var h = ensureHud(); if (!h) return;
    hudMode(kind || 'note');
    h.you.textContent = ''; h.cards.innerHTML = '';
    h.say.innerHTML = ''; h.say.textContent = text; markOverflow();
    S.turn = { you: '', shown: text, cards: [] }; refreshMore();
    S.holdUntil = Date.now() + (ms || 3400);
    hideSoon(ms || 3400);
  }
  function showYou(text, heard) {
    var h = ensureHud(); if (!h) return;
    h.you.textContent = text || ''; h.you.classList.toggle('heard', !!heard);
    if (S.turn) S.turn.you = text || '';
  }
  // Floating: the cards themselves. Docked: they live behind the details button.
  function hudCards(cards) {
    var h = ensureHud(); if (!h) return;
    h.cards.innerHTML = '';
    (cards || []).filter(Boolean).forEach(function (c, i) {
      var d = document.createElement('div'); d.className = 'tn-card' + (c.bad ? ' bad' : ''); d.style.animationDelay = (i * 70) + 'ms';
      d.innerHTML = '<i></i><b></b><span></span>';
      d.querySelector('i').textContent = c.icon; d.querySelector('b').textContent = c.label;
      if (c.detail) d.querySelector('span').textContent = c.detail; else d.querySelector('span').remove();
      d.title = cardText(c);
      h.cards.appendChild(d);
    });
    if (S.turn) S.turn.cards = (cards || []).filter(Boolean);
    refreshMore();
  }
  // The details button: how many changes landed (and didn't), or "More" when
  // the reply is longer than the slot.
  function refreshMore() {
    var h = H; if (!h) return;
    var t = S.turn, cards = (t && t.cards) || [], ok = cards.filter(function (c) { return !c.bad; }).length, bad = cards.length - ok;
    var long = h.say.scrollHeight > h.say.clientHeight + 2 || h.you.scrollHeight > h.you.clientHeight + 2;
    if (!t || (!cards.length && !long && !t.truncated)) { h.more.hidden = true; h.more.innerHTML = ''; return; }
    var html = '';
    if (ok) html += '<span class="ok">✓</span>' + ok;
    if (bad) html += (ok ? '&nbsp;' : '') + '<span class="bad">✕</span>' + bad;
    if (!html) html = 'More';
    h.more.innerHTML = html; h.more.hidden = false;
    h.more.title = cards.length ? cards.length + ' change' + (cards.length === 1 ? '' : 's') + ' · details' : 'Details';
  }
  function markOverflow() {
    var h = H; if (!h) return;
    requestAnimationFrame(function () { h.say.classList.toggle('ovf', h.say.scrollHeight > h.say.clientHeight + 2 && h.say.scrollTop + h.say.clientHeight < h.say.scrollHeight - 2); refreshMore(); });
  }

  // ── the details popover ──
  var POP = null;
  function closePop() {
    if (!POP) return;
    var p = POP; POP = null;
    document.removeEventListener('pointerdown', popOutside, true); document.removeEventListener('keydown', popKey, true);
    window.removeEventListener('resize', placePop); window.removeEventListener('scroll', placePop, true);
    p.classList.remove('on'); setTimeout(function () { try { p.remove(); } catch (e) {} }, 160);
    if (H) H.more.setAttribute('aria-expanded', 'false');
  }
  function popOutside(e) { if (POP && !POP.contains(e.target) && !(H && H.more.contains(e.target))) closePop(); }
  function popKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } }
  function placePop() {
    if (!POP || !H) return;
    var r = H.more.getBoundingClientRect(), pw = POP.offsetWidth, ph = POP.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(12, Math.min(vw - pw - 12, r.right - pw));
    var below = r.bottom + 6, above = r.top - 6 - ph;
    var top = (below + ph <= vh - 8 || above < 8) ? below : above;
    POP.style.left = left + 'px'; POP.style.top = Math.max(8, top) + 'px';
  }
  function togglePop() {
    if (POP) { closePop(); return; }
    var t = S.turn; if (!t || !H) return;
    var p = document.createElement('div'); p.className = 'tn-pop'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Neo — details');
    var html = '';
    if (t.you) html += '<section><h4>You</h4><p class="you">' + esc(t.you) + '</p></section>';
    if (t.shown) html += '<section><h4>Neo</h4><p>' + esc(t.shown) + '</p></section>';
    if (t.cards && t.cards.length) html += '<section><h4>' + t.cards.length + ' change' + (t.cards.length === 1 ? '' : 's') + '</h4><ul>' + t.cards.map(function (c) {
      return '<li' + (c.bad ? ' class="bad"' : '') + '><i>' + esc(c.icon) + '</i><b>' + esc(c.label) + '</b><span>' + esc(c.detail || '') + '</span></li>';
    }).join('') + '</ul></section>';
    if (t.truncated) html += '<section><p class="note">A long request: check the last items landed.</p></section>';
    p.innerHTML = html;
    document.body.appendChild(p); POP = p;
    placePop(); requestAnimationFrame(function () { p.classList.add('on'); });
    H.more.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', popOutside, true); document.addEventListener('keydown', popKey, true);
    window.addEventListener('resize', placePop); window.addEventListener('scroll', placePop, true);
  }

  function refreshTele() {
    var h = H; if (!h) return;
    var now = new Date();
    h.clock.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ' · ' + DOW[now.getDay()] + ' ' + now.getDate() + ' ' + MON[now.getMonth()];
    var s = dayStats(bridgeState(), now);
    var parts = ['Tasks <b>' + s.done + '/' + s.total + '</b>'];
    parts.push('Next <b>' + (s.next ? esc(clip(s.next.title, 22)) + ' ' + s.next.time : '—') + '</b>');
    if (s.habits) parts.push('Habits <b>' + s.habitsDone + '/' + s.habits + '</b>');
    parts.push('Voice <b>' + esc(lastVoice || (orcaOk === false ? 'Device' : voiceName(SET.voice))) + '</b>');
    h.tele.innerHTML = parts.map(function (p) { return '<span>' + p + '</span>'; }).join('');
  }

  // The reply as word spans. Spoken in full (karaoke): lit in time with the
  // voice, and the box scrolls so the word being said stays in view.
  function sayWords(text) {
    var h = ensureHud(); if (!h) return [];
    h.say.innerHTML = ''; h.say.scrollTop = 0; h.say.classList.remove('ovf');
    return String(text).split(/\s+/).filter(Boolean).map(function (w) {
      var s = document.createElement('span'); s.className = 'w'; s.textContent = w + ' '; h.say.appendChild(s); return s;
    });
  }
  function lightTo(spans, n) {
    for (var i = 0; i < spans.length; i++) spans[i].classList.toggle('lit', i < n);
    var cur = spans[Math.max(0, n - 1)], box = H && H.say;
    if (cur && box && box.scrollHeight > box.clientHeight + 1) {
      var want = Math.max(0, cur.offsetTop + cur.offsetHeight - box.clientHeight);
      if (want > box.scrollTop + 1) { try { box.scrollTo({ top: want, behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { box.scrollTop = want; } }
    }
  }

  // Docked: a quiet row of rounded bars, tall where his voice (or Neo's) is loud.
  function drawBars(cv, dpr, t, m) {
    var w = cv.clientWidth || 36, ht = cv.clientHeight || 20;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(ht * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(ht * dpr); }
    var g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, ht);
    g.globalCompositeOperation = 'source-over'; g.shadowBlur = 0;
    var n = 7, gap = (w - 2) / (n - 1), mid = (n - 1) / 2, live = m === 'capture' || m === 'follow' || m === 'speaking';
    g.lineCap = 'round'; g.lineWidth = 2;
    for (var i = 0; i < n; i++) {
      var d = Math.abs(i - mid), v = smooth[Math.min(63, 4 + Math.round(d * 7))];
      var idle = reduced ? 0.14 : 0.12 + 0.07 * Math.sin(t * 1.6 - d * 0.6);
      if (m === 'thinking' && !reduced) idle = 0.14 + 0.3 * Math.max(0, Math.sin(t * 4 - i * 0.7));
      var a = live ? Math.max(idle, Math.min(1, v * 1.6)) * (1 - d / (mid + 3)) : idle;
      var len = Math.max(2, a * (ht - 4));
      g.globalAlpha = 0.5 + 0.5 * Math.min(1, a * 1.4); g.strokeStyle = m === 'capture' ? C.red : C.ring;
      var x = 1 + i * gap; g.beginPath(); g.moveTo(x, ht / 2 - len / 2); g.lineTo(x, ht / 2 + len / 2); g.stroke();
    }
    g.globalAlpha = 1;
  }

  // ── the orb (floating): rings, a voice-level waveform and a solid core ──────
  var now0 = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
  var raf = 0, bins = new Uint8Array(64), smooth = new Float32Array(64), t0 = now0();
  function startAnim() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    var h = H; if (!h || !h.el.classList.contains('show')) return;
    var cv = h.canvas, dpr = Math.min(2, window.devicePixelRatio || 1), size = cv.clientWidth || 84, docked = h.el.classList.contains('tn-dock');
    if (!docked && (cv.width !== Math.round(size * dpr) || cv.height !== cv.width)) { cv.width = cv.height = Math.round(size * dpr); }
    var g = cv.getContext('2d'); if (!g) return;
    var t = (now - t0) / 1000, m = S.mode;
    var an = m === 'capture' || m === 'follow' ? S.anMic : (m === 'speaking' && speakingViaAudio ? S.anOut : null);
    var lvl = 0;
    if (an) { try { var fb = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(fb); for (var i = 0; i < 64; i++) bins[i] = fb[Math.min(fb.length - 1, 2 + Math.floor(i * (fb.length * 0.55) / 64))]; } catch (e) {} }
    else for (var j = 0; j < 64; j++) bins[j] = m === 'speaking' ? 90 + 70 * Math.max(0, Math.sin(t * 9 + j * 0.7) * Math.sin(t * 3.3 + j * 0.23)) : m === 'thinking' ? 40 + 40 * Math.max(0, Math.sin(t * 6 - j * 0.4)) : 18 + 10 * Math.sin(t * 2 + j * 0.5);
    for (var k = 0; k < 64; k++) { smooth[k] += (bins[k] / 255 - smooth[k]) * 0.35; lvl += smooth[k]; }
    lvl /= 64; S.level = lvl;
    if (docked) { drawBars(cv, dpr, t, m); raf = requestAnimationFrame(frame); return; }
    var speed = reduced ? 0.12 : ({ capture: 0.45, thinking: 2.2, speaking: 0.7, follow: 0.3, loading: 1.4, boot: 1 }[m] || 0.35);
    var bootP = Math.min(1, (now - boot) / 1100);
    var s = size / 150, c = (cv.width / dpr) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over'; g.shadowBlur = 0;
    var flicker = m === 'error' ? (0.45 + 0.55 * (Math.random() > 0.15 ? 1 : 0.2)) : 1;
    g.lineCap = 'round';
    var rot1 = t * speed * 0.35;
    g.strokeStyle = C.ring;
    for (var a = 0; a < 72 * bootP; a++) {
      var ang = rot1 + a * Math.PI * 2 / 72, long = a % 6 === 0, r0 = 66 * s, r1 = (long ? 73 : 69.5) * s;
      g.globalAlpha = flicker * (long ? 0.8 : 0.3); g.lineWidth = (long ? 1.6 : 1) * s;
      g.beginPath(); g.moveTo(c + Math.cos(ang) * r0, c + Math.sin(ang) * r0); g.lineTo(c + Math.cos(ang) * r1, c + Math.sin(ang) * r1); g.stroke();
    }
    var rot2 = -t * speed * 0.8;
    g.globalAlpha = flicker * 0.85; g.lineWidth = 2.2 * s; g.strokeStyle = C.core;
    for (var q = 0; q < 3; q++) { var st0 = rot2 + q * Math.PI * 2 / 3; g.beginPath(); g.arc(c, c, 60 * s, st0, st0 + (Math.PI * 2 / 3 - 0.55) * bootP); g.stroke(); }
    g.lineWidth = 2 * s; g.strokeStyle = m === 'capture' ? C.red : C.ring;
    for (var b = 0; b < 64; b++) {
      var an2 = b * Math.PI * 2 / 64 - Math.PI / 2, len = (2 + smooth[b] * 15) * s * bootP, rb = 44 * s;
      g.globalAlpha = flicker * (0.3 + smooth[b] * 0.7);
      g.beginPath(); g.moveTo(c + Math.cos(an2) * rb, c + Math.sin(an2) * rb); g.lineTo(c + Math.cos(an2) * (rb + len), c + Math.sin(an2) * (rb + len)); g.stroke();
    }
    g.globalAlpha = flicker * 0.45; g.lineWidth = 1 * s; g.strokeStyle = C.ring;
    g.beginPath(); g.arc(c, c, 38 * s, 0, Math.PI * 2 * bootP); g.stroke();
    var rot3 = t * speed * 2.4;
    g.globalAlpha = flicker; g.lineWidth = 2.4 * s; g.strokeStyle = C.hot;
    g.beginPath(); g.arc(c, c, 38 * s, rot3, rot3 + 0.7); g.stroke();
    if (m === 'thinking' || m === 'loading') {
      g.fillStyle = C.hot;
      for (var p = 0; p < 6; p++) { var pa = t * (1.6 + p * 0.35) + p; var pr = (52 + 6 * Math.sin(t * 2 + p)) * s; g.globalAlpha = flicker * 0.75; g.beginPath(); g.arc(c + Math.cos(pa) * pr, c + Math.sin(pa) * pr, 1.6 * s, 0, Math.PI * 2); g.fill(); }
    }
    var cr = (17 + lvl * 9 + Math.sin(t * 2.2) * 1.2) * s * (0.4 + 0.6 * bootP);
    g.globalAlpha = flicker * 0.22; g.fillStyle = C.ring; g.beginPath(); g.arc(c, c, cr * 1.55, 0, Math.PI * 2); g.fill();
    g.globalAlpha = flicker * 0.9; g.fillStyle = C.core; g.beginPath(); g.arc(c, c, cr * 0.8, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  setInterval(function () { if (H && H.el.classList.contains('show')) refreshTele(); }, 15000);

  // ══ sound (synthesized, quiet) ═════════════════════════════════════════════
  function sfx(name) {
    var ctx = S.ctx; if (!ctx || ctx.state !== 'running') return;
    try {
      var t = ctx.currentTime, out = ctx.createGain(); out.gain.value = 0.9; out.connect(ctx.destination);
      var tone = function (f0, f1, at, dur, type, vol) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t + at); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
        g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(vol || 0.05, t + at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
        o.connect(g); g.connect(out); o.start(t + at); o.stop(t + at + dur + 0.02);
      };
      if (name === 'wake') { tone(740, 1110, 0, 0.16, 'sine', 0.05); tone(1110, 1480, 0.09, 0.2, 'sine', 0.04); }
      else if (name === 'think') { tone(196, 220, 0, 0.22, 'sine', 0.03); }
      else if (name === 'done') { tone(1320, 0, 0, 0.09, 'sine', 0.04); tone(1760, 0, 0.08, 0.14, 'sine', 0.035); }
      else if (name === 'error') { tone(440, 260, 0, 0.32, 'triangle', 0.045); }
      else if (name === 'boot') { tone(660, 0, 0, 0.18, 'sine', 0.035); tone(990, 0, 0.12, 0.26, 'sine', 0.03); }
    } catch (e) {}
  }

  // ══ Vosk ═══════════════════════════════════════════════════════════════════
  var voskP = null;
  function loadVosk() {
    if (window.Vosk) return Promise.resolve(window.Vosk);
    if (voskP) return voskP;
    voskP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = VOSK_SRC; s.async = true;
      s.onload = function () { window.Vosk ? res(window.Vosk) : rej(new Error('Vosk missing')); };
      s.onerror = function () { voskP = null; rej(new Error('Couldn\'t load the wake-word engine. Check the connection.')); };
      document.head.appendChild(s);
    });
    return voskP;
  }
  var modelP = null;
  function loadModel() {
    if (S.model) return Promise.resolve(S.model);
    if (modelP) return modelP;
    modelP = loadVosk().then(function (V) { return V.createModel(MODEL_URL); })
      .then(function (m) { S.model = m; return m; })
      .catch(function (e) { modelP = null; throw e; });
    return modelP;
  }
  function newRecognizer() {
    if (!S.model) return;
    if (S.rec) { try { S.rec.remove(); } catch (e) {} }
    var r = new S.model.KaldiRecognizer(S.sr, JSON.stringify(GRAMMAR));
    r.on('partialresult', function (m) { if (S.mode === 'wake' && m && m.result && isWake(m.result.partial)) onWake(); });
    r.on('result', function (m) { if (S.mode === 'wake' && m && m.result && isWake(m.result.text)) onWake(); });
    S.rec = r;
  }
  // Live captions: the browser's recognizer (Chrome / Edge) leads when it works;
  // otherwise a free-form Vosk recognizer (only when the model is loaded). Words
  // are snapped to his own names. Gemini's transcript replaces them.
  var WS = window.SpeechRecognition || window.webkitSpeechRecognition, wsBroken = false;
  var WAKE_RE = /^\s*(?:(?:you|the|uh+|um+|hmm+|ah|oh|huh)[,.]?\s+)*(?:(?:hey|hi|hay|her|okay|ok)[,.]?\s+(?:neo|new|neil|nio|knee|know|now|leo|neon|nemo|no)|neo|nio)\b[,.!?]?\s*/i;
  function stripWake(s) { return String(s || '').replace(WAKE_RE, ''); }
  function tidyText(s) {
    s = stripWake(s).replace(/\s+/g, ' ').trim();
    if (/^(?:you|the|uh+|um+|hmm+|ah|oh|huh)[.?!]?$/i.test(s)) return '';
    s = s.replace(/\bi\b(?!\.)/g, 'I');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function showCap(text) { S.capText = tidyText(fixCaption(stripWake(text), S.capVocab)); if (S.mode === 'capture' && H) H.you.textContent = S.capText; }
  function startCaptions() {
    stopCaptions();
    S.capVocab = captionVocab();
    S.capWs = false;
    if (WS && !wsBroken) {
      try {
        var w = new WS(), fin = '';
        w.lang = 'en-US'; w.continuous = true; w.interimResults = true; w.maxAlternatives = 1;
        w.onresult = function (e) {
          var interim = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) fin = (fin + ' ' + e.results[i][0].transcript).trim(); else interim += ' ' + e.results[i][0].transcript;
          }
          S.capWs = true; showCap((fin + ' ' + interim).trim());
        };
        w.onerror = function (e) { if (e && /network|not-allowed|service-not-allowed|language-not-supported/.test(e.error || '')) wsBroken = true; S.capWs = false; };
        w.start(); S.capWsRec = w;
      } catch (e) { wsBroken = true; }
    }
    if (!S.model) return;
    var done = '';
    try {
      var r = new S.model.KaldiRecognizer(S.sr);
      r.on('partialresult', function (m) { if (S.mode === 'capture' && m.result && !S.capWs) showCap((done + ' ' + (m.result.partial || '')).trim()); });
      r.on('result', function (m) { if (m.result && m.result.text) { done = (done + ' ' + m.result.text).trim(); if (!S.capWs) showCap(done); } });
      S.cap = r;
    } catch (e) { S.cap = null; }
  }
  function stopCaptions() {
    if (S.cap) { try { S.cap.remove(); } catch (e) {} S.cap = null; }
    if (S.capWsRec) { var w = S.capWsRec; S.capWsRec = null; w.onresult = w.onerror = null; try { w.abort(); } catch (e) {} }
  }
  function captionVocab() {
    var out = ['Neo', 'TaskHub', 'Notebook', 'Shield', 'TradeHub', 'WarRoom', 'Keychain', 'Spotify', 'YouTube', 'Gmail', 'Pomodoro'];
    try {
      var st = bridgeState() || {}, data = st.data || {}, now = new Date();
      for (var d = -3; d <= 10; d++) { var t = new Date(now); t.setDate(now.getDate() + d); (data[dkey(t)] || []).forEach(function (x) { if (x && x.title) out.push(x.title); }); }
      (st.habits || []).concat(st.shortGoals || [], st.longGoals || []).forEach(function (x) { var n = x && (x.title || x.text || x.name); if (n) out.push(n); });
      (W('pcApps') || []).forEach(function (a) { if (a && a.name) out.push(String(a.name).replace(/\.exe$/i, '')); });
    } catch (e) {}
    var seen = {}, vocab = [];
    out.forEach(function (p) {
      p = String(p).replace(/[^A-Za-z0-9' ]+/g, ' ').trim(); if (!p) return;
      var ws = p.split(/\s+/);
      var add = function (q) { var k = q.toLowerCase(); if (seen[k] || letters(q).length < 5) return; seen[k] = 1; vocab.push({ text: q, n: q.split(/\s+/).length, l: letters(q), sk: skel(q) }); };
      if (ws.length <= 4) add(p);
      ws.forEach(function (w) { if (w.length >= 5) add(w); });
    });
    return vocab.slice(0, 400);
  }
  function letters(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function skel(s) {
    var l = letters(s).replace(/ph/g, 'f').replace(/[ckq]/g, 'k').replace(/[sz]/g, 's').replace(/[dt]/g, 't').replace(/[bp]/g, 'p');
    return l.charAt(0) + l.slice(1).replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
  }
  function lev(a, b) {
    var m = a.length, n = b.length, row = [], i, j, prev, tmp;
    for (j = 0; j <= n; j++) row[j] = j;
    for (i = 1; i <= m; i++) { prev = row[0]; row[0] = i; for (j = 1; j <= n; j++) { tmp = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; } }
    return row[n];
  }
  var COMMON_SET = {};
  ('a about after again all also am an and any are as ask at back be because been before being both but by call can check close could day did do does done each else even every first for from get give go going good got had has have he help her here him his how i if in into is it its just keep know last later let like list long look make many me more morning most move much must my need never new next night no not now of off on once one only open or other our out over please put read really remind right said same say see set shall she should show so some start still stop such take tell than thank thanks that the their them then there these they thing things think this those through time to today told tomorrow tonight too under until up us very wait want was way we week well were what when where which while who why will with work would yes yet you your')
    .split(' ').forEach(function (w) { COMMON_SET[w] = 1; });
  function allCommon(ws) { return ws.every(function (w) { return COMMON_SET[letters(w)]; }); }
  function fixCaption(text, vocab) {
    if (!text || !vocab || !vocab.length) return text;
    var words = text.split(/\s+/), out = [], i = 0;
    while (i < words.length) {
      var best = null;
      for (var v = 0; v < vocab.length; v++) {
        var Q = vocab[v];
        for (var k = Q.n; k <= Q.n + 1 && i + k <= words.length; k++) {
          var win = words.slice(i, i + k).join(' '), wl = letters(win);
          if (wl !== Q.l && allCommon(words.slice(i, i + k))) continue;
          if (!wl || wl === Q.l) { if (wl === Q.l && (!best || Q.l.length > best.score)) best = { k: k, text: Q.text, score: Q.l.length, exact: true }; continue; }
          if (wl.charAt(0) !== Q.l.charAt(0) || Math.abs(wl.length - Q.l.length) > 3) continue;
          var sim = 1 - lev(wl, Q.l) / Math.max(wl.length, Q.l.length);
          if (sim >= 0.86 || (sim >= 0.6 && skel(win) === Q.sk)) { if (!best || Q.l.length > best.score) best = { k: k, text: Q.text, score: Q.l.length }; }
        }
      }
      if (best && !best.exact) { out.push(best.text); i += best.k; }
      else { out.push(words[i]); i++; }
    }
    return out.join(' ');
  }

  // ══ mic ════════════════════════════════════════════════════════════════════
  async function openMic() {
    var base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    var dev = ''; try { dev = await micDeviceId(); } catch (e) {}
    if (dev) { try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: dev } }, base) }); } catch (e) {} }
    return await navigator.mediaDevices.getUserMedia({ audio: base });
  }
  var resumeArmed = false;
  function armResume() {
    if (resumeArmed) return; resumeArmed = true;
    var go = function () {
      resumeArmed = false;
      document.removeEventListener('pointerdown', go, true); document.removeEventListener('keydown', go, true);
      if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume().catch(function () {});
    };
    document.addEventListener('pointerdown', go, true); document.addEventListener('keydown', go, true);
  }

  async function start() {
    if (S.running || S.starting) return;
    S.starting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser gives Neo no microphone.');
      var stream;
      try { stream = await openMic(); } catch (e) { throw new Error('Neo needs the microphone. Allow it for this site, then try again.'); }
      if (!shouldRun()) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
      if (ctx.state === 'suspended') armResume();
      S.stream = stream; S.ctx = ctx; S.sr = ctx.sampleRate;
      // The wake word needs the model; Talk alone doesn't (no 41 MB wait).
      if (S.on) {
        var slow = S.model ? 0 : setTimeout(function () {
          if (S.model || !S.on) return;
          boot = performance.now(); setMode('loading');
          if (H) H.say.textContent = 'Loading voice recognition — the first start takes a moment.';
        }, S.greet ? 0 : 1500);
        try { await loadModel(); }
        finally { clearTimeout(slow); }
        if (!shouldRun() || S.ctx !== ctx) return;
        newRecognizer();
      }
      S.src = ctx.createMediaStreamSource(stream);
      S.anMic = ctx.createAnalyser(); S.anMic.fftSize = 256; S.anMic.smoothingTimeConstant = 0.6;
      S.anOut = ctx.createAnalyser(); S.anOut.fftSize = 256; S.anOut.smoothingTimeConstant = 0.55; S.anOut.connect(ctx.destination);
      S.src.connect(S.anMic);
      S.proc = ctx.createScriptProcessor(4096, 1, 1);
      S.proc.onaudioprocess = onAudio;
      S.src.connect(S.proc); S.proc.connect(ctx.destination);
      S.ring = []; S.ringLen = 0;
      S.running = true;
      prefetchKey();
      if (S.talkStart) { S.talkStart = false; S.greet = false; boot = performance.now(); sfx('wake'); refreshRunning(); beginCapture(0, false); }
      else if (S.greet) {
        S.greet = false;
        boot = performance.now(); setMode('boot'); sfx('boot');
        setTimeout(function () { if (S.running && S.mode === 'boot') speak(greeting(bridgeState()), false); }, 500);
      } else setMode('wake');
    } catch (e) {
      console.warn('[tony-neo]', e);
      var wasOn = S.on;
      teardown();
      S.talk = false; S.talkStart = false;
      if (wasOn) setOn(false); else emit();
      hudNote((e && e.message) || 'Neo couldn\'t start.', 'error', 5600);
    } finally { S.starting = false; }
  }

  function teardown() {
    S.running = false;
    if (SP.saved) spotEnd(true);
    try { S.proc && (S.proc.onaudioprocess = null); S.proc && S.proc.disconnect(); S.src && S.src.disconnect(); } catch (e) {}
    try { S.stream && S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    stopVoice();
    try { S.ctx && S.ctx.close(); } catch (e) {}
    if (S.rec) { try { S.rec.remove(); } catch (e) {} S.rec = null; }
    stopCaptions();
    S.proc = S.src = S.stream = S.ctx = S.anMic = S.anOut = null;
    S.ring = []; S.chunks = []; S.vad = null;
    if (S.mode !== 'off') setMode('off');
  }
  // Back to waiting. Without his switch on (a Talk session) the mic is released.
  function idle() {
    if (!S.on) { S.talk = false; if (S.running || S.starting) teardown(); else if (S.mode !== 'off') setMode('off'); emit(); return; }
    setMode('wake'); newRecognizer();
  }

  // ══ audio loop ═════════════════════════════════════════════════════════════
  function onAudio(e) {
    var chunk = new Float32Array(e.inputBuffer.getChannelData(0));
    var ms = chunk.length * 1000 / S.sr;
    var level = rms(chunk);
    S.ring.push(chunk); S.ringLen += chunk.length;
    while (S.ringLen - S.ring[0].length > PRE_ROLL_S * S.sr) S.ringLen -= S.ring.shift().length;
    if (S.mode === 'wake') {
      if (level < threshold(S.floor)) S.floor = S.floor * 0.95 + level * 0.05;   // ambient noise, learned while quiet
      if (S.rec) { try { S.rec.acceptWaveformFloat(chunk, S.sr); } catch (err) {} }
    } else if (S.mode === 'capture') {
      S.chunks.push(chunk);
      if (S.cap) { try { S.cap.acceptWaveformFloat(chunk, S.sr); } catch (err) {} }
      var r = vadStep(S.vad, level, S.floor, ms);
      if (r === 'end') finishCapture();
      else if (r === 'none') { stopCaptions(); idle(); }
    } else if (S.mode === 'follow') {
      if (Date.now() < S.deafUntil) return;   // the tail of Neo's own voice
      if (level > threshold(S.floor) * 1.3) beginCapture(0.6, true);
      else if (Date.now() > S.followUntil) idle();
    }
  }
  function onWake() {
    if (S.mode !== 'wake') return;
    sfx('wake');
    refreshRunning();
    beginCapture(PRE_ROLL_S, false);
  }
  function beginCapture(preSec, alreadySpeaking) {
    var keep = Math.floor(preSec * S.sr), pre = [], n = 0;
    for (var i = S.ring.length - 1; i >= 0 && n < keep; i--) { pre.unshift(S.ring[i]); n += S.ring[i].length; }
    S.chunks = pre;
    S.vad = { speech: !!alreadySpeaking, silentMs: 0, elapsedMs: 0 };
    S.capFollow = !!alreadySpeaking;
    S.typed = false;
    setMode('capture');
    startCaptions();
    if (S.cap) pre.forEach(function (c) { try { S.cap.acceptWaveformFloat(c, S.sr); } catch (e) {} });
  }

  // Everything a request carries besides what he said.
  function extraFor() {
    var extra = { mode: 'neo', profile: 'tony' };   // HIS Gemini key (worker keyFor 'tony')
    if (S.prev && Date.now() - S.prev.at < PREV_MS) extra.prev = S.prev.data;
    var hist = recentHistory(); if (hist.length) extra.history = hist;
    return extra;
  }
  var preSnap = null;
  async function beforeRun(actions) {
    preSnap = snapState(bridgeState());
    await spotlightBefore(actions);
  }

  async function finishCapture() {
    var buffers = S.chunks; S.chunks = []; S.vad = null;
    var heard = S.capText || ''; S.capText = '';
    var hadCaptions = !!S.cap, browserHeard = !!S.capWs, wasFollow = S.capFollow; S.capFollow = false;
    stopCaptions();
    if (wasFollow && !S.pending && hadCaptions && !heard.trim()) { idle(); return; }
    if (S.pending) {
      var pend = S.pending; S.pending = null;
      if (Date.now() - pend.at < 30000) {
        if (isYes(heard)) return runHeld(pend);
        if (isNo(heard) || !heard.trim()) { hudCards([]); respond('Cancelled.', 'Cancelled — nothing changed.', true); return; }
      }
    }
    // "Undo" / "redo" heard clearly by the browser: done here, no round trip.
    if (browserHeard && (isUndo(heard) || isRedo(heard))) { showYou(heard, true); return localUndo(isUndo(heard) ? 'undo' : 'redo', heard); }
    setMode('thinking'); sfx('think');
    S.turn = { you: heard, shown: '', cards: [] };
    var res = null;
    try {
      if (!window._THV || !window._THV.sendAudio) throw new Error('TaskHub voice is not ready');
      var wav = encodeWav(buffers, S.sr, 16000);
      res = await window._THV.sendAudio(b64(wav), { extra: extraFor(), silent: true, hold: guardTurn, before: beforeRun });
    } catch (e) { console.warn('[tony-neo]', e); res = { ok: false, error: 'network' }; }
    if (res && res.transcript) showYou(tidyText(res.transcript), true);
    if (res && res.dropped) { console.info('[tony-neo] ignored:', res.dropped, res.transcript || ''); idle(); return; }
    if (!S.running) { if (res && res.ok) await handle(res, res.transcript || heard); return; }
    await handle(res, (res && res.transcript) || heard);
  }

  // A reply in hand → held for a yes, an error, or reported.
  async function handle(res, transcript) {
    if (!res || !res.ok) {
      sfx('error'); hudMode('error');
      respond(res && /network/i.test(res.error || '') ? 'The connection seems to be down.' : 'Couldn\'t do that. Try again.', null, true);
      return;
    }
    if (res.held) {
      S.pending = { actions: res.held.actions, say: res.say, transcript: res.transcript || transcript || '', at: Date.now() };
      showConfirm(res.held.question);
      respond(res.held.question, null, true);
      return;
    }
    if (S.turn) S.turn.truncated = !!res.truncated;
    await report(res, transcript || '');
  }

  // Says and shows what the engine reports, never what the model hoped.
  var PREV_MS = 120000, SETTLE_MS = 700, HISTORY_N = 8, HISTORY_MS = 15 * 60000;
  function recentHistory() {
    var now = Date.now();
    S.history = S.history.filter(function (h) { return now - h.at < HISTORY_MS; }).slice(-HISTORY_N);
    return S.history.map(function (h) { return h.data; });
  }
  function mergeLater(results, list) {
    return results.map(function (r) {
      if (!r.pending) return r;
      var mine = (list || []).filter(function (l) { return l.action === r.action; });
      if (!mine.length) return r;
      var bad = mine.filter(function (l) { return !l.ok; })[0];
      return Object.assign({}, r, bad ? { ok: false, reason: bad.reason, say: bad.say } : { note: mine.map(function (l) { return l.say; }).filter(Boolean).join(' ') }, { pending: false });
    });
  }
  function cardsOf(results) {
    return results.map(function (r) {
      if (!r.ok) return failCard(r);
      var c = cardFor(r.action);
      if (c && r.diff && r.diff.length) c = Object.assign({}, c, { detail: diffLine(r.diff, 8) });
      return c;
    }).filter(Boolean);
  }
  function rememberTurn(transcript, say, results) {
    S.prev = { at: Date.now(), data: { said: clip(transcript, 300), reply: clip(say, 300), did: results.slice(0, 12).map(function (r) {
      var o = { type: r.action.type, ok: !!r.ok }, t = actName(r.action);
      if (t) o.title = clip(t, 80);
      if (r.ref) { o.id = r.ref.id; o.box = r.ref.box; if (r.ref.date) o.date = r.ref.date; if (r.ref.title) o.title = clip(r.ref.title, 80); }
      return o;
    }) } };
    S.history.push(S.prev); recentHistory();
  }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function frames(n) { return new Promise(function (res) { var k = 0; (function f() { if (++k > n) return res(); requestAnimationFrame(f); })(); }); }
  function timeoutP(ms, v) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); }
  // An undo/redo restores a snapshot through React: diff once it has rendered.
  async function attachDiffs(results, before) {
    var idx = []; results.forEach(function (r, i) { if (r.ok && r.action && (r.action.type === 'undo' || r.action.type === 'redo')) idx.push(i); });
    if (!idx.length || !before) return results;
    await wait(160); await frames(2);
    var d = diffState(before, snapState(bridgeState()));
    return results.map(function (r, i) { return i === idx[0] ? Object.assign({}, r, { diff: d }) : r; });
  }
  async function report(res, transcript) {
    var results = (res.results || []).slice();
    var laterP = res.later || Promise.resolve([]);
    var gated = results.some(function (r) { return r.gated; });
    var early = await Promise.race([laterP.then(function (l) { return { done: true, l: l }; }, function () { return { done: true, l: [] }; }), timeoutP(SETTLE_MS, { done: false })]);
    if (early.done) results = mergeLater(results, early.l);
    results = await attachDiffs(results, res.before || preSnap); preSnap = null;
    spotlightAfter(results);   // runs alongside the reply; never waited on
    var shown = shownFor(res.say, results), spoken = spokenFor(res.say, results);
    if (gated && !early.done) { shown = 'Waiting for the unlock.'; spoken = 'Unlock it first.'; }
    if (!S.turn) S.turn = { you: transcript || '', shown: '', cards: [] };
    S.turn.shown = shown;
    hudCards(cardsOf(results));
    if (results.some(function (r) { return r.ok; })) sfx('done');
    rememberTurn(transcript, results.length ? shown : res.say, results);
    refreshTele();
    if (!early.done) {
      // Still running (a kit, an app opening, the lock prompt): report the
      // outcome when it lands, and redraw.
      laterP.then(function (l) {
        var after = mergeLater(results, l);
        if (H && H.el.classList.contains('show')) { hudCards(cardsOf(after)); var s2 = shownFor(res.say, after); if (S.turn) S.turn.shown = s2; if (H.say && !S.speaking) { H.say.textContent = s2; markOverflow(); } }
        var bad = after.filter(function (r, i) { return !r.ok && results[i].ok; });
        if (bad.length) tellLater(failSpeech(bad));
        else if (gated) tellLater('Done.', true);
      });
    }
    if (!spoken) { idle(); return; }   // background talk: stay quiet
    respond(spoken, shown, true);
  }
  // He said yes (or tapped / typed it): run what was held, and report it.
  async function runHeld(pend) {
    setMode('thinking');
    var before = snapState(bridgeState());
    try { await spotlightBefore(pend.actions); } catch (e) {}
    var r = window._THV && window._THV.runActions ? window._THV.runActions(pend.actions) : { ok: false, results: [], later: Promise.resolve([]) };
    return report({ ok: true, results: r.results, later: r.later, say: pend.say, before: before }, pend.transcript);
  }
  // Undo / redo on the device, reported like any other turn (with what it undid).
  async function localUndo(kind, transcript) {
    var b = W('bridge');
    var before = snapState(bridgeState());
    var ok = !!(b && typeof b[kind] === 'function' && b[kind]());
    if (window._THV && window._THV.refreshButtons) window._THV.refreshButtons();
    if (!S.turn) S.turn = { you: transcript || '', shown: '', cards: [] };
    return report({ ok: true, results: [{ action: { type: kind }, ok: ok, reason: ok ? '' : 'nothing' }], later: Promise.resolve([]), say: '', before: before }, transcript || '');
  }
  function showConfirm(question) {
    var h = ensureHud(); if (!h) return;
    h.cards.innerHTML = '';
    var d = document.createElement('div'); d.className = 'tn-card tn-ask';
    d.innerHTML = '<i>?</i><b>Confirm</b><button type="button" class="y" data-a="1">Yes</button><button type="button" data-a="0">No</button>';
    d.querySelectorAll('button').forEach(function (btn) { btn.onclick = function () { confirmTap(btn.getAttribute('data-a') === '1'); }; });
    h.cards.appendChild(d);
    S.turn = S.turn || { you: '', shown: '', cards: [] }; S.turn.shown = question;
    // Docked there's no room for cards: the question itself is the prompt, and
    // the yes/no go into the details popover's place, the side.
    if (h.el.classList.contains('tn-dock')) { h.more.hidden = false; h.more.innerHTML = 'Yes / No'; h.more.title = 'Answer'; }
  }
  function askYesNo() {
    // A tiny popover with the two answers.
    closePop();
    var p = document.createElement('div'); p.className = 'tn-pop'; p.setAttribute('role', 'dialog');
    p.innerHTML = '<section><h4>Confirm</h4><p>' + esc((S.turn && S.turn.shown) || 'Go ahead?') + '</p></section><section style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-a="0" class="tn-btn">No</button><button type="button" data-a="1" class="tn-btn">Yes</button></section>';
    p.querySelectorAll('button').forEach(function (btn) { btn.style.cssText = 'height:28px;padding:0 14px;background:transparent;border:1px solid #45454c;border-radius:6px;color:#dbd0f5;font:inherit;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer'; btn.onclick = function () { closePop(); confirmTap(btn.getAttribute('data-a') === '1'); }; });
    document.body.appendChild(p); POP = p; placePop(); requestAnimationFrame(function () { p.classList.add('on'); });
    document.addEventListener('pointerdown', popOutside, true); document.addEventListener('keydown', popKey, true);
  }
  function confirmTap(yes) {
    var p = S.pending; if (!p) return; S.pending = null;
    stopVoice();
    if (yes) runHeld(p); else { hudCards([]); respond('Cancelled.', 'Cancelled — nothing changed.', true); }
  }

  // ══ answering: spoken, or on screen only ═══════════════════════════════════
  // A typed turn is spoken only when his setting says so (Settings → Neo).
  function respond(spoken, shown, thenFollow) {
    shown = shown || spoken;
    if (S.turn) S.turn.shown = shown;
    if (S.typed && !SET.speakTyped) { display(shown); return; }
    speak(spoken, thenFollow, shown);
  }
  // On screen only: the whole line at once, kept up long enough to read.
  function display(text) {
    stopVoice();
    S.lastSaid = '';
    var spans = sayWords(text); lightTo(spans, spans.length); markOverflow();
    S.holdUntil = Date.now() + Math.min(14000, 3600 + String(text).split(/\s+/).length * 300);
    if (S.running) { if (S.typed && /\?\s*$/.test(text)) reopenAsk(); idle(); hideSoon(900); return; }
    if (S.mode !== 'error') setMode('note');
    if (S.typed && /\?\s*$/.test(text)) reopenAsk();
    hideSoon(0);
  }
  function tellLater(text, good) {
    if (!text) return;
    if (!good) sfx('error');
    if (S.running && (S.mode === 'thinking' || S.mode === 'speaking')) { S.afterSay = S.afterSay ? S.afterSay + ' ' + text : text; return; }
    if (S.running) speak(text, false); else hudNote(text, good ? 'note' : 'error', 5200);
  }

  // ══ spotlight: show each change on screen, then go back ════════════════════
  var SPOT_MAX = 4, SPOT_PRE_MS = 450, SPOT_STEP_MS = 1200, SPOT_HOLD_MS = 1400, SPOT_FADE_MS = 160;
  var SP = { run: 0, saved: null, rings: [], raf: 0, armed: false };
  var GOAL_TAB = { shortTermGoals: 'short', longTermGoals: 'long' };
  function spotStops(targets) {
    var stops = [], at = {};
    (targets || []).forEach(function (t) {
      if (!t || !t.box || (t.box === 'calendar' && !t.date)) return;
      var k = t.box === 'calendar' ? 'd:' + t.date : 'b:' + t.box;
      if (!(k in at)) { if (stops.length >= SPOT_MAX) return; at[k] = stops.length; stops.push({ key: k, box: t.box, date: t.box === 'calendar' ? t.date : null, ids: [], gone: [] }); }
      var s = stops[at[k]], list = t.gone ? s.gone : s.ids;
      if (t.id && list.indexOf(t.id) < 0) list.push(t.id);
    });
    return stops;
  }
  function spotBefore(pv) {
    return spotStops((pv || []).filter(function (p) { return p && p.ok; }).map(function (p) {
      var t = p.action && p.action.type, gone = t === 'remove_task' || t === 'move_task' || t === 'clear' || t === 'clear_completed';
      if (p.from) return { box: p.from.box, date: p.from.date, id: p.from.id, gone: gone };
      return p.ref ? { box: p.ref.box, date: p.ref.date, id: null } : null;
    }));
  }
  function spotAfter(results) {
    return spotStops((results || []).filter(function (r) { return r && r.ok && r.ref && r.action && r.action.type !== 'remove_task'; })
      .map(function (r) { return { box: r.ref.box, date: r.ref.date || null, id: r.ref.id }; }));
  }
  function spotBridge() { var b = W('bridge'); return onTony() && b && b.goToDate ? b : null; }
  function spotVisible() { var tv = document.getElementById('task-view'); return !!(tv && getComputedStyle(tv).display !== 'none'); }
  function isMobStrip() { var s = document.querySelector(P.mobStrip); return !!(s && s.offsetParent !== null); }
  function spotSave(b) {
    var st = b.getState() || {};
    return { date: st.selectedDate, week: (st.week || []).map(function (w) { return w.date; }), goalTab: st.goalTab, mobDay: st.mobDay, scrollY: window.scrollY, changed: false };
  }
  async function spotSwitch(fn) {
    var tv = document.getElementById('task-view');
    if (reduced || !tv) { fn(); await frames(2); return; }
    tv.style.transition = 'opacity ' + SPOT_FADE_MS + 'ms ease'; tv.style.opacity = '0.25';
    await wait(SPOT_FADE_MS);
    fn(); await frames(2);
    tv.style.opacity = '1';
    await wait(SPOT_FADE_MS);
    tv.style.transition = ''; tv.style.opacity = '';
  }
  async function spotGo(b, stop, run) {
    var st = b.getState() || {}, sw = null;
    if (stop.box === 'calendar' && stop.date) {
      var dates = (st.week || []).map(function (w) { return w.date; }), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stop.date);
      var idx = dates.indexOf(stop.date);
      if (idx < 0 && m) sw = function () { b.goToDate(+m[1], +m[2] - 1, +m[3]); };
      if (isMobStrip() && b.mobDay) {
        var wantIdx = idx >= 0 ? idx : (new Date(+m[1], +m[2] - 1, +m[3]).getDay() + 6) % 7;
        if (wantIdx !== st.mobDay) { var prev = sw; sw = function () { if (prev) prev(); b.mobDay(wantIdx); }; }
      }
    } else if (GOAL_TAB[stop.box] && st.goalTab !== GOAL_TAB[stop.box] && b.goalsTab) {
      sw = function () { b.goalsTab(GOAL_TAB[stop.box]); };
    }
    if (sw) { SP.saved.changed = true; await spotSwitch(sw); }
    return run === SP.run;
  }
  function spotFind(id) {
    var els = document.querySelectorAll('#root [data-dkey="' + String(id).replace(/["\\]/g, '') + '"]');
    for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) return els[i]; }
    return null;
  }
  function spotRing(id, kind) {
    var el = spotFind(id); if (!el) return null;
    var d = document.createElement('div');
    d.className = 'tn-spot' + (kind === 'gone' ? ' tn-spot-gone' : '');
    d.style.borderRadius = getComputedStyle(el).borderRadius || '6px';
    document.body.appendChild(d);
    var ring = { id: id, el: d, out: false };
    spotPlace(ring, el.getBoundingClientRect());
    SP.rings.push(ring);
    requestAnimationFrame(function () { d.classList.add('on'); });
    spotTrack();
    return ring;
  }
  function spotPlace(ring, r) {
    var p = 3, s = ring.el.style;
    s.left = (r.left - p) + 'px'; s.top = (r.top - p) + 'px'; s.width = (r.width + p * 2) + 'px'; s.height = (r.height + p * 2) + 'px';
  }
  function spotTrack() {
    if (SP.raf) return;
    var f = function () {
      SP.raf = 0;
      SP.rings.forEach(function (ring) {
        if (ring.out) return;
        var el = spotFind(ring.id);
        if (el) spotPlace(ring, el.getBoundingClientRect()); else spotDrop(ring);
      });
      if (SP.rings.length) SP.raf = requestAnimationFrame(f);
    };
    SP.raf = requestAnimationFrame(f);
  }
  function spotDrop(ring) {
    if (ring.out) return; ring.out = true;
    ring.el.classList.remove('on'); ring.el.classList.add('out');
    setTimeout(function () { try { ring.el.remove(); } catch (e) {} SP.rings = SP.rings.filter(function (r) { return r !== ring; }); }, 260);
  }
  function spotClear() { SP.rings.slice().forEach(spotDrop); }
  function spotInterrupt(e) {
    if (e && e.target && e.target.closest && e.target.closest('#th-neo-hud, .tn-pop')) return;
    spotEnd(false);
  }
  function spotArm(on) {
    if (on === SP.armed) return; SP.armed = on;
    ['pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(function (t) {
      if (on) window.addEventListener(t, spotInterrupt, { capture: true, passive: true });
      else window.removeEventListener(t, spotInterrupt, { capture: true, passive: true });
    });
  }
  async function spotEnd(restore) {
    SP.run++; spotArm(false); spotClear();
    var sv = SP.saved, b = spotBridge(); SP.saved = null;
    if (!restore || !sv || !b || !sv.changed) return;
    var st = b.getState() || {}, cur = (st.week || []).map(function (w) { return w.date; }).join();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sv.date || '');
    await spotSwitch(function () {
      if (m && cur !== sv.week.join()) b.goToDate(+m[1], +m[2] - 1, +m[3]);
      if (sv.goalTab && st.goalTab !== sv.goalTab && b.goalsTab) b.goalsTab(sv.goalTab);
      if (typeof sv.mobDay === 'number' && b.mobDay && st.mobDay !== sv.mobDay) b.mobDay(sv.mobDay);
    });
    try { window.scrollTo({ top: sv.scrollY, behavior: reduced ? 'auto' : 'smooth' }); } catch (e) {}
  }
  async function spotlightBefore(actions) {
    var b = spotBridge();
    if (!b || !window._THV || !window._THV.preview || !spotVisible()) return;
    var stops = spotBefore(window._THV.preview(actions));
    if (!stops.length) return;
    var run = ++SP.run;
    spotClear();
    if (!SP.saved) SP.saved = spotSave(b);
    spotArm(true);
    if (!(await spotGo(b, stops[0], run))) return;
    var rang = stops[0].ids.concat(stops[0].gone).map(function (id) { return spotRing(id, stops[0].gone.indexOf(id) >= 0 ? 'gone' : 'work'); }).filter(Boolean);
    if (rang.length) {
      var el = spotFind(rang[0].id); if (el) try { el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) {}
      await wait(SPOT_PRE_MS);
    }
  }
  async function spotlightAfter(results) {
    var b = spotBridge();
    if (!b || !SP.saved) return;
    var run = SP.run, stops = spotAfter(results);
    for (var i = 0; i < stops.length; i++) {
      if (run !== SP.run) return;
      if (i > 0) { spotClear(); if (!(await spotGo(b, stops[i], run))) return; }
      await frames(2);
      var first = null;
      stops[i].ids.forEach(function (id) {
        if (!SP.rings.some(function (r) { return r.id === id && !r.out; })) spotRing(id, 'done');
        if (!first) first = spotFind(id);
      });
      if (first) try { first.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) {}
      await wait(i === stops.length - 1 ? SPOT_HOLD_MS : SPOT_STEP_MS);
    }
    if (!stops.length) await wait(SPOT_HOLD_MS * 0.6);
    if (run !== SP.run) return;
    await spotEnd(true);
  }

  // ══ voice: his chosen Orca voice (his key), the device's voice as fallback ══
  var orcaKey = '', orcaOk = null, orcaMod = null, keyP = null, lastVoice = '';
  function prefetchKey() {
    if (orcaKey || keyP) return keyP;
    try { var k = localStorage.getItem(P.orcaLs) || ''; if (/^orca_sk_[\w-]{8,}$/.test(k)) { orcaKey = k; return Promise.resolve(k); } } catch (e) {}
    var load = window[P.loadKey];
    keyP = Promise.resolve(load ? load() : '').then(function (k) { if (k) orcaKey = k; else orcaOk = false; keyP = null; return k; }).catch(function () { keyP = null; orcaOk = false; return ''; });
    return keyP;
  }
  function orca() {
    if (orcaMod) return Promise.resolve(orcaMod);
    return import(new URL('../Shruti/app/orca.js', SCRIPT_URL).href).then(function (m) { orcaMod = m; return m; });
  }
  var curAudio = null, speakingViaAudio = false, speakSeq = 0;
  function stopVoice() {
    speakSeq++; S.speaking = false;
    if (curAudio) { try { curAudio.pause(); } catch (e) {} try { URL.revokeObjectURL(curAudio.src); } catch (e) {} curAudio = null; }
    speakingViaAudio = false;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
  }
  var devVoice = null;
  if (window.speechSynthesis) { try { speechSynthesis.onvoiceschanged = function () { devVoice = null; }; } catch (e) {} }

  // Speaks `text`; shows `shown` (the same words, lit as they're said, unless
  // the screen carries more than the voice — then it shows at once).
  async function speak(text, thenFollow, shown) {
    stopVoice();
    S.lastSaid = String(text || '');
    shown = shown || text;
    var karaoke = shown === text;
    var seq = speakSeq;
    var look = S.mode === 'boot' ? 'boot' : S.mode === 'error' ? null : 'speaking';
    if (S.running || S.typed) { S.mode = 'speaking'; if (look) hudMode(look); emit(); }
    else hudShow(true);
    S.speaking = true;
    var spans = sayWords(shown);
    var light = karaoke ? function (n) { lightTo(spans, n); } : function () {};
    if (!karaoke) { lightTo(spans, spans.length); markOverflow(); }
    var reask = S.typed && /\?\s*$/.test(shown);
    var done = false;
    function after() {
      if (done || seq !== speakSeq) return; done = true;
      S.speaking = false; speakingViaAudio = false; lightTo(spans, spans.length); markOverflow();
      if (S.afterSay && S.running) { var more = S.afterSay; S.afterSay = ''; speak(more, thenFollow); return; }
      S.holdUntil = Date.now() + (karaoke ? 2200 : Math.min(12000, 3000 + String(shown).split(/\s+/).length * 250));
      if (reask) reopenAsk();
      if (!S.running) { setMode('note'); hideSoon(1600); return; }
      if (thenFollow && !S.typed) { S.deafUntil = Date.now() + DEAF_MS; S.followUntil = S.deafUntil + (/\?\s*$/.test(String(text || '')) ? ASK_MS : FOLLOW_MS); setMode('follow'); }
      else idle();
    }
    var voice = SET.voice || DEFAULT_VOICE;
    if (orcaOk !== false) {
      try {
        if (!orcaKey) await prefetchKey();
        if (seq !== speakSeq) return;
        if (orcaKey) {
          var mod = await orca();
          var ac = new AbortController(), to = setTimeout(function () { ac.abort(); }, 9000);
          var r = await mod.speak({ key: orcaKey, text: text, voice: voice, signal: ac.signal });
          clearTimeout(to);
          if (seq !== speakSeq) return;
          orcaOk = true; lastVoice = voiceName(voice); refreshTele();
          var el = new Audio(URL.createObjectURL(r.audio));
          curAudio = el;
          if (S.ctx && S.anOut && S.ctx.state !== 'closed') { try { S.ctx.createMediaElementSource(el).connect(S.anOut); speakingViaAudio = true; } catch (e) {} }
          var words = r.words || null;
          el.ontimeupdate = function () {
            var ct = el.currentTime, n = 0;
            if (words && words.length) { for (var i = 0; i < words.length; i++) if (words[i][0] <= ct) n = i + 1; n = Math.round(n * spans.length / words.length); }
            else n = Math.ceil(spans.length * ct / (el.duration || 1));
            light(n);
          };
          el.onended = after; el.onerror = after;
          await el.play();
          setTimeout(after, 4000 + String(text).split(/\s+/).length * 600);   // never left deaf
          return;
        }
      } catch (e) {
        if (seq !== speakSeq) return;
        if (e && e.code === 'key') orcaOk = false;
        console.warn('[tony-neo] Orca voice unavailable, using the device voice', e && e.message);
      }
    }
    lastVoice = 'Device'; refreshTele();
    if (!window.speechSynthesis) { light(spans.length); setTimeout(after, 1800); return; }
    try {
      var u = new SpeechSynthesisUtterance(text);
      if (!devVoice) devVoice = pickVoiceFrom(speechSynthesis.getVoices(), voice);
      if (devVoice) { u.voice = devVoice; u.lang = devVoice.lang; } else u.lang = 'en-GB';
      u.rate = 1.0; u.pitch = 0.95;
      var starts = []; String(text).replace(/\S+/g, function (m, i) { starts.push(i); return m; });
      u.onboundary = function (ev) { var n = 0; while (n < starts.length && starts[n] <= ev.charIndex) n++; light(n); };
      var w = 0, rev = setInterval(function () { if (done) return clearInterval(rev); w = Math.min(spans.length, w + 1); if (karaoke && (!spans[w - 1] || !spans[w - 1].classList.contains('lit'))) light(w); }, 330);
      u.onend = function () { clearInterval(rev); after(); }; u.onerror = u.onend;
      speechSynthesis.speak(u);
      setTimeout(function () { clearInterval(rev); after(); }, 2500 + String(text).split(/\s+/).length * 450);
    } catch (e) { after(); }
  }
  // Settings → Voice → Test: a sample in the chosen voice. → {ok, via}
  async function previewVoice(id) {
    id = VOICE_GENDER[id] ? id : (SET.voice || DEFAULT_VOICE);
    var line = 'Neo online, Tony. This is ' + voiceName(id) + '.';
    try {
      if (!orcaKey) await prefetchKey();
      if (orcaKey) {
        var mod = await orca();
        var r = await mod.speak({ key: orcaKey, text: line, voice: id });
        var a = new Audio(URL.createObjectURL(r.audio));
        a.onended = function () { try { URL.revokeObjectURL(a.src); } catch (e) {} };
        await a.play();
        return { ok: true, via: 'orca' };
      }
    } catch (e) { console.warn('[tony-neo] voice test', e && e.message); }
    try {
      if (!window.speechSynthesis) return { ok: false, via: 'none' };
      var u = new SpeechSynthesisUtterance(line), v = pickVoiceFrom(speechSynthesis.getVoices(), id);
      if (v) { u.voice = v; u.lang = v.lang; }
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      return { ok: true, via: 'device' };
    } catch (e) { return { ok: false, via: 'none' }; }
  }

  // ══ apps and sites on his PC (the A1 Prep Bridge, 127.0.0.1:8781) ══════════
  function onPc() {
    if (W('up') === true) return true;
    return /Windows/i.test((navigator && navigator.userAgent) || '');
  }
  var BROWSERS = /^(brave|google chrome|chrome|microsoft edge|edge|firefox|mozilla firefox|opera|vivaldi)\b/i;
  var LQ = null;
  function queueLaunch(app, url) {
    if (!onPc()) {
      if (app) return { ok: false, reason: 'off_pc' };
      var w = webUrl(url); if (!w) return { ok: false, reason: 'invalid' };
      var tab = null; try { tab = window.open(w, '_blank'); if (tab) tab.opener = null; } catch (e) { tab = null; }
      return tab ? true : { ok: false, reason: 'blocked', say: 'The browser blocked the new tab. Allow pop-ups for this site.' };
    }
    var hit = null, u = '';
    if (app) { hit = matchApp(app, W('pcApps')); if (!hit) return { ok: false, reason: 'not_found' }; }
    else { u = webUrl(url); if (!u) return { ok: false, reason: 'invalid' }; }
    if (!LQ) { LQ = { items: [] }; setTimeout(flushLaunch, 0); }
    return new Promise(function (res) { LQ.items.push({ app: hit, url: u, done: res }); });
  }
  function flushLaunch() {
    var q = LQ; LQ = null; if (!q) return;
    var ids = [], urls = [], names = {};
    q.items.forEach(function (it) {
      if (it.app) { if (ids.indexOf(it.app.id) < 0) ids.push(it.app.id); names[it.app.id] = it.app.name; }
      else if (urls.indexOf(it.url) < 0) urls.push(it.url);
    });
    var go = bridgeLaunch();
    Promise.resolve(go ? go(ids, urls) : null).catch(function () { return null; }).then(function (res) {
      var down = res ? '' : launchIssue(null, [], W('err'), {});
      q.items.forEach(function (it) {
        if (!res) return it.done({ ok: false, reason: 'bridge_down', say: down });
        var key = it.app ? it.app.id : it.url, label = it.app ? it.app.name : it.url;
        var bad = (res.unknown || []).indexOf(key) >= 0 || (res.failed || []).indexOf(label) >= 0;
        it.done(bad ? { ok: false, reason: 'failed', say: label === it.url ? 'That site didn\'t open.' : label + ' didn\'t open.' } : true);
      });
    });
  }
  // His launcher: the prep bridge's open call, batched to its caps (3 apps / 5 sites).
  function bridgeLaunch() {
    var open = W('openLocal'); if (typeof open !== 'function') return null;
    return function (appIds, urls) {
      var a = (appIds || []).slice(), u = (urls || []).slice(), all = { ok: true, opened: [], unknown: [], failed: [] };
      function step() {
        if (!a.length && !u.length) return Promise.resolve(all);
        return Promise.resolve(open(a.splice(0, 3), u.splice(0, 5))).then(function (j) {
          if (!j || !j.ok) return null;
          ['opened', 'unknown', 'failed'].forEach(function (k) { all[k] = all[k].concat(j[k] || []); });
          return step();
        });
      }
      return step();
    };
  }
  // /api/close and /api/running on his PC's bridge. Resolve to its answer, or null.
  function bridgeCall(path, body, ms) {
    if (!/Windows/i.test(navigator.userAgent || '')) return Promise.resolve(null);
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ac ? setTimeout(function () { ac.abort(); }, ms || 8000) : null;
    var opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' };
    if (ac) opts.signal = ac.signal;
    return fetch('http://127.0.0.1:8781' + path, opts).then(function (r) { return r.json(); })
      .then(function (j) { if (t) clearTimeout(t); window[P.up] = !!(j && j.ok); return (j && j.ok) ? j : null; },
            function () { if (t) clearTimeout(t); window[P.up] = false; return null; });
  }
  function bridgeClose(appIds, force, browser) { return bridgeCall('/api/close', { apps: (appIds || []).slice(0, 12), force: force === true, browser: browser === true }, 30000); }
  function bridgeRunning() { return bridgeCall('/api/running', null, 20000).then(function (j) { return j ? (j.running || []) : null; }); }
  var CQ = null;
  function queueClose(app, force) {
    if (!onPc()) return { ok: false, reason: 'off_pc' };
    var hit = matchApp(app, W('pcApps')); if (!hit) return { ok: false, reason: 'not_found' };
    if (!CQ) { CQ = { items: [] }; setTimeout(flushClose, 0); }
    return new Promise(function (res) { CQ.items.push({ app: hit, force: !!force, done: res }); });
  }
  function closeNote(name, res) {
    if (!res) return null;
    if ((res.closed || []).indexOf(name) >= 0) return '';
    if ((res.notRunning || []).indexOf(name) >= 0) return { ok: false, reason: 'not_running', say: name + ' wasn\'t running.' };
    if ((res.stillOpen || []).indexOf(name) >= 0) return { ok: false, reason: 'still_open', say: name + ' wants to save; left open. Say "force quit ' + name + '" to close it.' };
    return { ok: false, reason: 'failed', say: name + ' wouldn\'t close.' };
  }
  function flushClose() {
    var q = CQ; CQ = null; if (!q) return;
    [false, true].forEach(function (force) {
      var mine = q.items.filter(function (it) { return it.force === force; });
      if (!mine.length) return;
      var ids = [], browser = false;
      mine.forEach(function (it) { if (ids.indexOf(it.app.id) < 0) ids.push(it.app.id); if (BROWSERS.test(it.app.name)) browser = true; });
      Promise.resolve(bridgeClose(ids, force, browser)).catch(function () { return null; }).then(function (res) {
        var down = res ? '' : launchIssue(null, [], W('err'), {});
        mine.forEach(function (it) {
          if (!res) return it.done({ ok: false, reason: 'bridge_down', say: down });
          var n = closeNote(it.app.name, res);
          it.done(n === '' ? true : n);
        });
      });
    });
  }
  function listWords(a) { a = (a || []).slice(0, 6); return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function closeAll(except, force) {
    if (!onPc()) return { ok: false, reason: 'off_pc' };
    var keep = (except || []).map(function (n) { return matchApp(n, W('pcApps')); }).filter(Boolean).map(function (a) { return a.id; });
    return Promise.resolve(bridgeRunning()).then(function (list) {
      if (!list) return { ok: false, reason: 'bridge_down', say: launchIssue(null, [], W('err'), {}) };
      var todo = list.filter(function (a) { return keep.indexOf(a.id) < 0 && !BROWSERS.test(a.name); });
      if (!todo.length) return { ok: true, say: 'Nothing else was open.' };
      return Promise.resolve(bridgeClose(todo.map(function (a) { return a.id; }), !!force, false)).then(function (res) {
        if (!res) return { ok: false, reason: 'bridge_down', say: launchIssue(null, [], W('err'), {}) };
        var left = (res.stillOpen || []), bad = (res.failed || []);
        var line = (res.closed || []).length ? 'Closed ' + listWords(res.closed) + '.' : '';
        if (left.length) line += ' ' + listWords(left) + (left.length > 1 ? ' want' : ' wants') + ' to save; left open.';
        if (bad.length) line += ' ' + listWords(bad) + ' wouldn\'t close.';
        return (left.length || bad.length) ? { ok: false, reason: 'still_open', say: line.trim() } : { ok: true, say: line.trim() };
      });
    }).catch(function () { return { ok: false, reason: 'bridge_down', say: launchIssue(null, [], W('err'), {}) }; });
  }
  function refreshRunning() {
    if (!onPc()) return;
    var r = W('running');
    if (r && Date.now() - r.at < 20000) return;
    Promise.resolve(bridgeRunning()).then(function (list) {
      if (Array.isArray(list)) window[P.running] = { at: Date.now(), names: list.map(function (a) { return a.name; }) };
    }).catch(function () {});
  }
  window._thNeoLaunch = queueLaunch;
  window._thNeoClose = queueClose;
  window._thNeoCloseAll = closeAll;

  // ══ the rest of his TaskHub, for his bridge (_thVoice) ═════════════════════
  // Every entry answers true, a promise of its outcome, or {ok:false, reason}.
  function escH(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Timer commands, one at a time (the timer component's own API: _vdTimerExec).
  var TQ = [], tBusy = false;
  function timerRun(cmd, arg) { return new Promise(function (res) { TQ.push({ cmd: cmd, arg: arg, res: res }); pump(); }); }
  function pump() {
    if (tBusy || !TQ.length) return;
    tBusy = true;
    var t0 = Date.now();
    (function waitT() {
      var ex = window._vdTimerExec;
      if (ex) {
        var job = TQ.shift();
        try { ex(job.cmd, job.arg); job.res(true); } catch (e) { job.res(false); }
        var t1 = Date.now();
        (function fresh() { if (window._vdTimerExec !== ex || Date.now() - t1 > 400) { tBusy = false; pump(); } else setTimeout(fresh, 30); })();
        return;
      }
      if (Date.now() - t0 > 4000) { TQ.shift().res(false); tBusy = false; pump(); return; }
      setTimeout(waitT, 50);
    })();
  }
  function findByName(list, q, key) {
    q = normWords(q); if (!q) return null;
    var n = function (x) { return normWords(x[key]); };
    return list.filter(function (x) { return n(x) === q; })[0]
      || list.filter(function (x) { return (' ' + n(x) + ' ').indexOf(' ' + q + ' ') >= 0 || (' ' + q + ' ').indexOf(' ' + n(x) + ' ') >= 0; })[0]
      || null;
  }
  function allPlans() {
    var PC = window.PlansCore; if (!PC || !PC.bucket) return [];
    var b = PC.bucket(), seen = {}, out = [];
    ['mine', 'overdue', 'confirmed', 'proposed', 'ideas', 'archive'].forEach(function (k) { (b[k] || []).forEach(function (p) { if (p && !seen[p.id]) { seen[p.id] = 1; out.push(p); } }); });
    return out;
  }
  function planGated(fn) {
    var G = window.Guardian, lk = P.lockTH;
    if (!window.alGate || !G || !G.mustBlock || !G.mustBlock(lk)) return fn();
    var p = new Promise(function (res) { window.alGate(lk, function () { res(fn()); }, function () { res({ ok: false, reason: 'locked' }); }); setTimeout(function () { res({ ok: false, reason: 'locked' }); }, 120000); });
    p.gated = true; return p;
  }
  var HEADER_PROGS = { tradehub: 'tradeboard', tradeboard: 'tradeboard', warroom: 'warroom', 'war room': 'warroom', keychain: 'keychain', vault: 'keychain' };
  var NEO_OPS = {
    onPc: onPc,
    timer: timerRun,
    prep: function (item, dk) {
      var req = W('prepReq');
      if (!req) return Promise.resolve(null);
      if (!(W('prepBusy') || {})[item.id]) return req(item, dk);
      var t0 = Date.now();
      return new Promise(function (res) {
        (function waitP() {
          if (!(W('prepBusy') || {})[item.id]) return res((W('prepKits') || {})[item.id] || null);
          if (Date.now() - t0 > 90000) return res(null);
          setTimeout(waitP, 500);
        })();
      });
    },
    lockApp: function (t) {
      var id = P.locks[t], G = window.Guardian;
      if (!id || !G || !G.lockNow) return { ok: false, reason: 'invalid' };
      var st = null; try { st = G.status(id); } catch (e) {}
      if (!st || !st.hasLock) return { ok: false, reason: 'no_lock' };
      G.lockNow(id); return true;
    },
    openLink: function (label) {
      var links = (window._navGetLinks ? window._navGetLinks('tony') : []) || [];
      var hit = findByName(links, label, 'label');
      if (hit && window._navOpenLink) { window._navOpenLink('tony', hit.id); return true; }
      var prog = HEADER_PROGS[normWords(label)];
      if (prog && window._tonyNav) { window._tonyNav(prog); return true; }
      return { ok: false, reason: 'not_found' };
    },
    // A new page in T's Notebook (tj), through Notebook's public API only.
    journalEntry: function (text, title) {
      if (!text) return { ok: false, reason: 'invalid' };
      var NB = window.Notebook; if (!NB || !NB.putPage) return { ok: false, reason: 'no_bridge' };
      var d = new Date();
      var page = { id: 'neo' + d.getTime().toString(36), title: String(title || '').trim() || ('Note · ' + d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })),
        data: { html: String(text).split(/\n+/).map(function (p) { return '<p>' + escH(p) + '</p>'; }).join('') }, tags: [], folder: null };
      return Promise.race([NB.putPage(P.nb, page).then(function (p) { return p ? true : { ok: false, reason: 'failed' }; }), timeoutP(10000, { ok: false, reason: 'journal_not_ready' })])
        .catch(function () { return { ok: false, reason: 'journal_not_ready' }; });
    },
    // Plans he shares with Veda: only through PlansCore, only as Tony, inside his TaskHub lock.
    plan: function (op, a) {
      var PC = window.PlansCore;
      if (!PC || !onTony()) return { ok: false, reason: 'no_bridge' };
      if (op === 'add') {
        var title = String(a.title || '').trim(); if (!title) return { ok: false, reason: 'invalid' };
        var dt = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : null, tm = /^\d{2}:\d{2}$/.test(a.time || '') ? a.time : null;
        return planGated(function () { PC.addIdea(title, String(a.notes || a.text || ''), dt, tm); return true; });
      }
      var p = findByName(allPlans(), (a.match || {}).title || a.title, 'title');
      if (!p) return { ok: false, reason: 'not_found' };
      return planGated(function () {
        var q = PC.get(p.id) || p;
        if (op === 'propose') { if (q.stage === 'proposed' || q.stage === 'confirmed') return { ok: false, reason: 'already' }; return PC.promote(q.id); }
        if (op === 'confirm') {
          if (q.stage !== 'proposed') return { ok: false, reason: 'not_waiting' };
          if (q.confirms && q.confirms.tony) return { ok: false, reason: 'already' };
          return Promise.resolve(PC.confirmPlan(q.id)).then(function (v) { return v === 'ok' ? (q.date ? true : { ok: true, say: 'It has no date yet.' }) : v; });
        }
        if (op === 'decline') { if (q.stage !== 'proposed') return { ok: false, reason: 'not_waiting' }; PC.declinePlan(q.id, String(a.reason || '')); return true; }
        if (op === 'cancel_request') { if (q.stage !== 'confirmed') return { ok: false, reason: 'not_confirmed' }; PC.requestCancel(q.id, String(a.reason || '')); return true; }
        if (op === 'done') { if (q.stage !== 'confirmed') return { ok: false, reason: 'not_confirmed' }; PC.markDone(q.id); return true; }
        return { ok: false, reason: 'invalid' };
      });
    },
    // What Neo may be asked about beyond tasks.
    state: function (base, extra) {
      var out = {}, now = new Date(), today = dkey(now), soon = dkey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14));
      try {
        out.plans = allPlans().slice(0, 30).map(function (p) {
          var o = { title: p.title, stage: p.stage };
          if (p.date) o.date = p.date; if (p.time) o.time = p.time;
          if (p.stage === 'proposed' && p.confirms) o.waitingOn = !p.confirms.veda ? 'veda' : (!p.confirms.tony ? 'tony' : null);
          if (p.cancelReq && p.cancelReq.by) o.cancelRequestedBy = p.cancelReq.by;
          return o;
        });
      } catch (e) {}
      try { out.links = ['TradeHub', 'WarRoom', 'Keychain'].concat(((window._navGetLinks ? window._navGetLinks('tony') : []) || []).map(function (l) { return l.label; }).filter(Boolean).slice(0, 30)); } catch (e) {}
      try {
        out.marketCal = ((extra && extra.marketCal) || []).filter(function (e) { return e && e.date >= today && e.date <= soon; }).slice(0, 40)
          .map(function (e) { var o = { date: e.date, title: e.title, kind: e.kind }; if (e.when) o.when = e.when; return o; });
      } catch (e) {}
      try {
        var kits = W('prepKits') || {}, tm = dkey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
        out.prepKits = [];
        [today, tm].forEach(function (k) {
          ((base.data || {})[k] || []).forEach(function (t) {
            var kit = t && t.aiPrep && kits[t.id]; if (!kit) return;
            var o = { task: t.title, date: k, summary: clip(kit.summary, 300) };
            if (kit.draft && kit.draft.kind && kit.draft.kind !== 'none') o.draft = { kind: kit.draft.kind, to: kit.draft.to || '', subject: clip(kit.draft.subject, 140), body: clip(kit.draft.body, 900) };
            out.prepKits.push(o);
          });
        });
        out.prepKits = out.prepKits.slice(0, 8);
      } catch (e) {}
      var ts = window._vdTimerState;
      if (ts && base.timerOpen) out.timer = { secondsLeft: Math.round(ts.left), running: !!ts.running, mode: ['work', 'short break', 'long break'][ts.mode] || 'work' };
      var pr = W('running');
      if (pr && Date.now() - pr.at < 120000) out.pcRunning = pr.names.slice(0, 60);
      return out;
    },
  };
  window._thNeoOps = NEO_OPS;

  function cancel() {
    S.pending = null;
    stopVoice();
    stopCaptions();
    closePop();
    if (S.running) { S.chunks = []; S.vad = null; idle(); }
    S.holdUntil = 0;
    hudShow(false);
  }

  // ══ Talk: the mic button — no wake phrase ══════════════════════════════════
  function talk() {
    if (!onTony()) return false;
    if (S.mode === 'capture') { finishCapture(); return true; }   // tap again: send now
    if (S.mode === 'thinking' || S.starting) return false;
    if (S.mode === 'speaking') stopVoice();
    try { if (window.speechSynthesis) { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
    if (S.running) { sfx('wake'); refreshRunning(); beginCapture(0.25, false); return true; }
    S.talk = true; S.talkStart = true; emit();
    sync();
    return true;
  }

  // ══ Type: the composer ═════════════════════════════════════════════════════
  var ASKD = { el: null, kb: null, draft: '' };
  function askEl() {
    if (ASKD.el || !document.body) return ASKD.el;
    ensureStyles();
    var ov = document.createElement('div');
    ov.id = 'tn-ask'; ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML = '<div class="tn-ask-box" role="dialog" aria-modal="true" aria-label="Ask Neo">' +
      '<div class="tn-ask-head"><span class="tn-ask-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="12" cy="12" r="10" stroke-width="1.6" stroke-dasharray="9.5 3.6"/><circle cx="12" cy="12" r="6" stroke-width="1.2" opacity=".75"/><circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/></svg>Ask Neo</span>' +
      '<button type="button" class="tn-ask-x" aria-label="Close" title="Close">✕</button></div>' +
      '<div class="tn-ask-wrap"><textarea rows="3" spellcheck="true" autocomplete="off" aria-label="Your request" placeholder="Add gym tomorrow at 6, remind me at 5:45 · Brief me · Undo"></textarea></div>' +
      '<div class="tn-ask-foot"><span class="tn-ask-hint"><kbd>' + (isMac() ? '⌘' : 'Ctrl') + '</kbd>+<kbd>Enter</kbd> to send · <kbd>Enter</kbd> for a new line · lists work</span>' +
      '<button type="button" class="tn-ask-send">Send</button></div></div>';
    document.body.appendChild(ov);
    var ta = ov.querySelector('textarea');
    ov.querySelector('.tn-ask-x').onclick = closeAsk;
    ov.querySelector('.tn-ask-send').onclick = sendAsk;
    ta.addEventListener('input', function () { ASKD.draft = ta.value; askGrow(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAsk(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeAsk(); }
    });
    if (window.A1Resize) { try { var g = window.A1Resize.grip('the message box'); ov.querySelector('.tn-ask-wrap').appendChild(g); window.A1Resize.attach(ta, g, 'tn-ask', askGrow); } catch (e) {} }
    ASKD.el = ov;
    return ov;
  }
  function isMac() { return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || ''); }
  function askGrow() { var ta = ASKD.el && ASKD.el.querySelector('textarea'); if (!ta || ta.getAttribute('data-user-h')) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, Math.round(innerHeight * 0.42)) + 'px'; }
  function askKeyboard(on) {
    var vv = window.visualViewport; if (!vv) return;
    if (on && !ASKD.kb) {
      ASKD.kb = function () { document.documentElement.style.setProperty('--tn-kb', Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px'); };
      vv.addEventListener('resize', ASKD.kb); vv.addEventListener('scroll', ASKD.kb); ASKD.kb();
    } else if (!on && ASKD.kb) {
      vv.removeEventListener('resize', ASKD.kb); vv.removeEventListener('scroll', ASKD.kb); ASKD.kb = null;
      document.documentElement.style.setProperty('--tn-kb', '0px');
    }
  }
  function openAsk(placeholder) {
    if (!onTony()) return false;
    var ov = askEl(); if (!ov) return false;
    var ta = ov.querySelector('textarea');
    if (placeholder) ta.placeholder = placeholder; else ta.placeholder = 'Add gym tomorrow at 6, remind me at 5:45 · Brief me · Undo';
    ta.value = ASKD.draft || '';
    ov.classList.add('show'); ov.setAttribute('aria-hidden', 'false');
    askKeyboard(true);
    setTimeout(function () { try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} askGrow(); }, 60);
    return true;
  }
  function closeAsk() {
    var ov = ASKD.el; if (!ov || !ov.classList.contains('show')) return;
    ov.classList.remove('show'); ov.setAttribute('aria-hidden', 'true');
    askKeyboard(false);
    try { ov.querySelector('textarea').blur(); } catch (e) {}
  }
  function reopenAsk() { setTimeout(function () { if (onTony()) openAsk('Reply to Neo…'); }, 350); }
  // popups.js closes the composer on an outside click by clicking its ✕ (the
  // draft is kept). Escape also closes it.
  function sendAsk() {
    var ov = ASKD.el; if (!ov) return;
    var ta = ov.querySelector('textarea'), text = String(ta.value || '').trim();
    if (!text) { ta.focus(); return; }
    ASKD.draft = ''; ta.value = '';
    closeAsk();
    // Not done (busy, offline): the words wait in the composer for another go.
    ask(text).then(function (r) { if (!r || r.ok === false) ASKD.draft = text; });
  }
  // A typed request: the same path as a spoken one, from the words he typed.
  var asking = false;
  async function ask(text) {
    text = String(text || '').trim();
    if (!text) return { ok: false, error: 'empty' };
    if (!onTony()) return { ok: false, error: 'not_tony' };
    if (asking || S.mode === 'thinking') return { ok: false, error: 'busy' };
    asking = true;
    try {
      stopVoice(); closePop();
      if (S.mode === 'capture') { S.chunks = []; S.vad = null; stopCaptions(); }
      S.typed = true;
      S.turn = { you: text, shown: '', cards: [] };
      if (S.pending && Date.now() - S.pending.at < 120000) {
        var pend = S.pending;
        if (isYes(text)) { S.pending = null; hudShow(true); showYou(text); await runHeld(pend); return { ok: true }; }
        if (isNo(text)) { S.pending = null; hudShow(true); showYou(text); hudCards([]); respond('Cancelled.', 'Cancelled — nothing changed.', false); return { ok: true }; }
        S.pending = null;
      }
      if (isUndo(text) || isRedo(text)) { setMode('thinking'); showYou(text); await localUndo(isUndo(text) ? 'undo' : 'redo', text); return { ok: true }; }
      setMode('thinking'); showYou(text);
      var res = null;
      try {
        if (!window._THV || !window._THV.request) throw new Error('TaskHub is not ready');
        res = await window._THV.request(Object.assign({ transcript: text }, extraFor()), { silent: true, hold: guardTurn, before: beforeRun });
      } catch (e) { console.warn('[tony-neo]', e); res = { ok: false, error: 'network' }; }
      if (res && res.dropped) { display('Already done.'); return { ok: true }; }
      await handle(res, text);
      return { ok: !!(res && res.ok), error: res && res.error };
    } finally { asking = false; }
  }

  // ══ Settings → Tony's Neo AI (rendered into index.html's Settings panel) ════
  function renderSettings(box) {
    if (!box) return;
    ensureStyles();
    // A flat list (A1's select popup draws options, not groups): name · accent · voice.
    var vopts = VOICES.map(function (v) {
      return '<option value="' + esc(v.id) + '"' + (v.id === SET.voice ? ' selected' : '') + '>' + esc(v.name) + ' · ' + esc(LOCALE_NAME[v.locale] || v.locale) + ' · ' + v.gender + '</option>';
    }).join('');
    box.innerHTML = '<div class="tns">' +
      '<div class="thset-row tns-row tns-wrap"><div class="tns-txt"><span class="thset-label">Microphone</span><span class="tns-sub" id="tns-mic-sub">Matched by name on each device.</span></div>' +
      '<div class="tns-ctl"><select class="thset-input" id="tns-mic" aria-label="Microphone"><option value="">System default</option></select></div></div>' +
      '<div class="thset-row tns-row tns-wrap"><div class="tns-txt"><span class="thset-label">Voice</span><span class="tns-sub" id="tns-voice-sub">Neural voices through Orca, with your key.</span></div>' +
      '<div class="tns-ctl"><select class="thset-input" id="tns-voice" aria-label="Voice">' + vopts + '</select><button type="button" class="thset-mini" id="tns-test">Test</button></div></div>' +
      '<div class="thset-row tns-row"><div class="tns-txt"><span class="thset-label">Speak typed replies</span><span class="tns-sub">Off: typed requests answer on screen only.</span></div>' +
      '<button type="button" class="tns-sw" id="tns-typed" role="switch" aria-label="Speak typed replies" aria-checked="' + (SET.speakTyped ? 'true' : 'false') + '"></button></div>' +
      '<div class="tns-foot">Synced to all your devices.</div></div>';
    var mic = box.querySelector('#tns-mic'), micSub = box.querySelector('#tns-mic-sub');
    var voice = box.querySelector('#tns-voice'), test = box.querySelector('#tns-test'), vsub = box.querySelector('#tns-voice-sub');
    var sw = box.querySelector('#tns-typed');
    function fillMics(asked) {
      listMics().then(function (devs) {
        var labelled = devs.filter(function (d) { return d.label; });
        var html = '<option value="">System default</option>';
        labelled.forEach(function (d) { html += '<option value="' + esc(d.label) + '">' + esc(d.label) + '</option>'; });
        var here = !SET.micLabel || labelled.some(function (d) { return d.label === SET.micLabel; });
        if (!here) html += '<option value="' + esc(SET.micLabel) + '">' + esc(SET.micLabel) + ' (not on this device)</option>';
        if (devs.length && !labelled.length && !asked) html += '<option value="__ask">Show this device\'s microphones…</option>';
        mic.innerHTML = html; mic.value = SET.micLabel || '';
        micSub.textContent = !here ? 'Not on this device — the default is used here.' : 'Matched by name on each device.';
        micSub.classList.toggle('warn', !here);
      });
    }
    mic.onchange = function () {
      if (mic.value === '__ask') {
        mic.value = SET.micLabel || '';
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); fillMics(true); }).catch(function () { micSub.textContent = 'Microphone access was refused.'; micSub.classList.add('warn'); });
        return;
      }
      setSettings({ micLabel: mic.value });
      try { localStorage.removeItem(MIC_LS); } catch (e) {}
      if (S.running) { teardown(); sync(); }
      fillMics(true);
    };
    voice.onchange = function () { setSettings({ voice: voice.value }); };
    test.onclick = function () {
      test.disabled = true;
      previewVoice(voice.value).then(function (r) {
        test.disabled = false;
        if (r.via === 'device') { vsub.textContent = 'No Orca key found (Shruti keeps it): the device voice speaks instead.'; vsub.classList.add('warn'); }
        else if (!r.ok) { vsub.textContent = 'Couldn\'t play a sample here.'; vsub.classList.add('warn'); }
        else { vsub.textContent = 'Neural voices through Orca, with your key.'; vsub.classList.remove('warn'); }
      });
    };
    sw.onclick = function () { var on = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', on ? 'true' : 'false'); setSettings({ speakTyped: on }); };
    // Another device changed them while this panel is open.
    var onRemote = function () {
      if (!box.isConnected) { window.removeEventListener('th-neo-settings', onRemote); return; }
      if (voice.value !== SET.voice) voice.value = SET.voice;
      sw.setAttribute('aria-checked', SET.speakTyped ? 'true' : 'false');
      if ((mic.value || '') !== (SET.micLabel || '')) fillMics(true);
    };
    window.addEventListener('th-neo-settings', onRemote);
    fillMics(false);
  }

  // ══ on / off + watcher ═════════════════════════════════════════════════════
  function setOn(on) {
    on = !!on;
    var was = S.on;
    S.on = on;
    try { on ? localStorage.setItem(P.pref, '1') : localStorage.removeItem(P.pref); } catch (e) {}
    if (on) {
      try { if (window.speechSynthesis) { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
      if (!was) S.greet = true;
      if (S.running && !S.model) { teardown(); }   // a Talk session without the model: restart with the wake word
      sync();
    } else {
      S.talk = false; S.talkStart = false;
      teardown();
      hudShow(false);
    }
    emit();
  }
  function shouldRun() { return (S.on || S.talk) && onTony() && !document.hidden; }
  function sync() {
    if (!onTony()) { closeAsk(); if (H && H.el.classList.contains('show') && !S.running) hudShow(false); }
    if (shouldRun()) { if (!S.running) start(); }
    else if (S.running || S.starting) { S.talk = false; S.talkStart = false; teardown(); hudShow(false); emit(); }
  }
  document.addEventListener('visibilitychange', sync);
  setInterval(sync, 1000);   // profile switches (Tony ⇄ Veda ⇄ picker) have no event
  try { ensureStyles(); } catch (e) {}

  window._thNeo = {
    isOn: function () { return S.on; },
    setOn: setOn,
    toggle: function () { setOn(!S.on); },
    mode: function () { return S.mode; },
    cancel: cancel,
    talk: talk,
    ask: ask,
    openAsk: openAsk,
    closeAsk: closeAsk,
    settings: function () { return Object.assign({}, SET); },
    setSettings: setSettings,
    voices: function () { return VOICES.slice(); },
    previewVoice: previewVoice,
    renderSettings: renderSettings,
    _test: { fixCaption: fixCaption, tidyText: tidyText, spotStops: spotStops, spotBefore: spotBefore, spotAfter: spotAfter, spotlightBefore: spotlightBefore, spotlightAfter: spotlightAfter, spot: SP, skel: skel, isWake: isWake, vadStep: vadStep, threshold: threshold, encodeWav: encodeWav, rms: rms, GRAMMAR: GRAMMAR, MODEL_URL: MODEL_URL, DEFAULT_VOICE: DEFAULT_VOICE,
      cardFor: cardFor, failCard: failCard, failLine: failLine, failSpeech: failSpeech, spokenFor: spokenFor, shownFor: shownFor, diffState: diffState, diffLine: diffLine, snapState: snapState,
      needsConfirm: needsConfirm, guardTurn: guardTurn, overlap: overlap, isReplay: isReplay, isYes: isYes, isNo: isNo, isUndo: isUndo, isRedo: isRedo,
      mergeLater: mergeLater, queueClose: queueClose, closeNote: closeNote, closeAll: closeAll, timerRun: timerRun, ops: NEO_OPS, onPc: onPc,
      greeting: greeting, matchApp: matchApp, bridgeLaunch: bridgeLaunch, webUrl: webUrl, launchIssue: launchIssue, queueLaunch: queueLaunch, dayStats: dayStats, pickVoiceFrom: pickVoiceFrom, spokenTime: spokenTime,
      cleanSettings: cleanSettings, applyRemote: applyRemote, micDeviceId: micDeviceId, sync: sync, state: S, P: P, placeHud: function () { if (H) placeHud(H); }, hud: function () { return H; } },
  };
})();

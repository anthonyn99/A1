/* ════════════════════════════════════════════════════════════════════════════
   Neo — Veda's hands-free TaskHub assistant.  Docs: docs/TaskHub/neo-assistant.md

   VEDA ONLY. Nothing here runs unless window._activeProfile === 'veda'; on
   Tony's TaskHub (or the profile picker) the mic is released and Neo sleeps.

   Pipeline (all free):
     mic ─► Vosk (on-device, WASM; fixed word list) hears "Hey Neo"
         ─► record until she stops talking (loudness end-point, with a 1.5 s
            pre-roll so "Neo, add milk" in one breath keeps its first words);
            a second, free-form Vosk recognizer shows live captions meanwhile
         ─► window._THV.sendAudio()  — the SAME engine and Gemini route as the
            mic button (personal-ai /taskhub/parse, Veda's own key), so every
            action it can do, Neo can do
         ─► the reply in Ryan's voice (Orca's Edge neural voices, her own Orca
            key — the one Shruti keeps), falling back to the device's voice;
            then a short follow-up window listens without the wake word.

   The look: a holographic HUD in her mauve — an arc-reactor orb whose waveform
   follows her voice and Neo's, live captions, the reply typed out word by word
   in time with the voice, an action card per change, and a telemetry strip.
   It is Neo's own overlay; the rest of her TaskHub's look is untouched.

   Brave blocks the browser's built-in SpeechRecognition, which is why the wake
   word runs in Vosk instead. Vosk keeps its model in IndexedDB (keyed by the
   model URL) so the ~41 MB download happens once per device.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window._vdNeo) return;

  var VOSK_SRC = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';
  var MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
  var FONTS = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap';
  var PREF_KEY = 'vd_neo_on';
  var ORCA_KEY_LS = 'shruti.veda.orcaKey';        // Shruti's cache of HER Orca key (read-only here)
  var VOICE = 'en-GB-RyanNeural';
  var SCRIPT_URL = (document.currentScript && document.currentScript.src) ||
    ((typeof location !== 'undefined' ? String(location.href) : '').replace(/[^/]*$/, '') + 'TaskHub/veda-assistant.js');

  // Mauve, as hologram.
  var C = { core: '#E6D9F0', ring: '#C9B3D9', accent: '#8D769A', glow: 'rgba(141,118,154,.55)', hot: '#F4ECFA', red: '#d27a8a' };

  // Words Vosk may choose between. Only "hey neo" wakes; "neo" on its own and the
  // near-sounding decoys give similar speech somewhere else to land, so "neo",
  // "new", "no", "video" don't fire it. Every word here is in the small model's vocabulary.
  var GRAMMAR = ['neo', 'hey neo', 'okay neo', 'new', 'no', 'know', 'now', 'leo', 'neon', 'nemo', 'knee', 'video', 'oh', 'hey', '[unk]'];

  var PRE_ROLL_S = 1.5;      // audio kept from before the wake word fired
  var END_SILENCE_MS = 1100; // she stopped talking
  var NO_SPEECH_MS = 6000;   // woke but nothing followed
  var MAX_CAPTURE_MS = 30000;
  var FOLLOW_MS = 10000;     // after a reply: listen without the wake word
  var ASK_MS = 16000;        // …longer when Neo has just asked her something
  var DEAF_MS = 700;         // …starting this long after Neo stops talking

  // ══ pure helpers (tested in tests/veda-assistant.test.js) ══════════════════
  // The wake phrase is "Hey Neo" (Veda's call, 2026-11-05): "hey" right before
  // "neo". A bare "neo" (or "okay neo") is heard but doesn't wake it.
  function isWake(text) {
    var w = String(text || '').toLowerCase().split(/\s+/).filter(function (t) { return t && t !== '[unk]'; });
    for (var i = 1; i < w.length; i++) if (w[i] === 'neo' && w[i - 1] === 'hey') return true;
    return false;
  }
  function rms(buf) { var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / (buf.length || 1)); }
  function threshold(floor) { return Math.max(0.012, floor * 2.8); }
  // One step of the end-point detector. st = {speech:bool, silentMs, elapsedMs}
  // → 'go' (keep recording) | 'end' (she finished) | 'none' (nothing was said).
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

  var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  var NUMW = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
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

  // The day at a glance, from Veda's bridge state. Used by the telemetry strip
  // and the boot greeting.
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
  function greeting(st, now) {
    now = now || new Date();
    var h = now.getHours(), s = dayStats(st, now);
    var open = h < 5 ? 'Working late, Veda.' : h < 12 ? 'Good morning, Veda.' : h < 17 ? 'Good afternoon, Veda.' : 'Good evening, Veda.';
    var line = open + ' Neo online.';
    if (!s.total) return line + ' Your day is clear.';
    if (!s.left) return line + ' Everything on today\'s list is done. Splendid.';
    line += ' ' + (s.left <= 12 ? NUMW[s.left].replace(/^./, function (c) { return c.toUpperCase(); }) : s.left) + (s.left === 1 ? ' task remains' : ' tasks remain') + ' today';
    if (s.next) line += '; next up, ' + s.next.title + ' at ' + spokenTime(s.next.time);
    return line + '.';
  }

  // One action → one HUD card {icon, label, detail}, or null for nothing to show.
  function cardFor(a) {
    if (!a || !a.type) return null;
    var m = a.match || {}, t = a.title || m.title || '';
    var when = [fmtDate(a.date), a.time ? a.time : ''].filter(Boolean).join(' · ');
    switch (a.type) {
      case 'add_task':
        if (a.box === 'dailyHabits') return { icon: '✦', label: 'HABIT ADDED', detail: t };
        if (a.box === 'shortTermGoals' || a.box === 'longTermGoals') return { icon: '◆', label: 'GOAL ADDED', detail: t };
        return { icon: '✓', label: (a.kind === 'event' || a.time) ? 'EVENT ADDED' : 'TASK ADDED', detail: [t || (a.altSeqTitles || []).join(' / '), when].filter(Boolean).join(' · ') + (a.notify ? ' · 🔔' : '') };
      case 'edit_task': return { icon: '✎', label: 'UPDATED', detail: t };
      case 'remove_task': return { icon: '✕', label: 'REMOVED', detail: t };
      case 'toggle_task': return { icon: a.done === false ? '○' : '✓', label: a.done === false ? 'UNCHECKED' : 'COMPLETED', detail: t };
      case 'move_task': return { icon: '➜', label: 'MOVED', detail: [t, fmtDate(a.toDate)].filter(Boolean).join(' → ') };
      case 'swap': return { icon: '⇄', label: 'SWAPPED', detail: [(a.first || {}).title, (a.second || {}).title].filter(Boolean).join(' ⇄ ') };
      case 'reorder': return { icon: '↕', label: 'REORDERED', detail: t };
      case 'clear': return { icon: '✕', label: 'CLEARED', detail: fmtDate(a.date) || a.box || '' };
      case 'shift_range': return { icon: '⇥', label: 'SHIFTED', detail: (a.days > 0 ? '+' : '') + a.days + ' DAY' + (Math.abs(a.days) === 1 ? '' : 'S') + ' · ' + [fmtDate(a.from), fmtDate(a.to)].filter(Boolean).join(' – ') };
      case 'clear_completed': return { icon: '✓', label: 'CLEANED UP', detail: 'COMPLETED ITEMS' };
      case 'go_to_date': return { icon: '◎', label: 'NAVIGATING', detail: fmtDate(a.date) };
      case 'set_edit_mode': return { icon: '✎', label: 'EDIT MODE', detail: a.on ? 'ON' : 'OFF' };
      case 'refresh_quote': return { icon: '❝', label: 'NEW QUOTE', detail: '' };
      case 'timer_set': return { icon: '⏱', label: 'TIMER', detail: pad2(a.minutes || 0) + ':00' };
      case 'timer_start': return { icon: '⏱', label: 'TIMER', detail: 'RUNNING' };
      case 'timer_stop': return { icon: '⏱', label: 'TIMER', detail: 'PAUSED' };
      case 'timer_reset': return { icon: '⏱', label: 'TIMER', detail: 'RESET' };
      case 'timer_open': return { icon: '⏱', label: 'TIMER', detail: 'OPEN' };
      case 'timer_close': return { icon: '⏱', label: 'TIMER', detail: 'CLOSED' };
      case 'undo': return { icon: '↶', label: 'UNDONE', detail: '' };
      case 'redo': return { icon: '↷', label: 'REDONE', detail: '' };
      case 'rules_add': return { icon: '☐', label: 'RULE ADDED', detail: t };
      case 'rules_edit': return { icon: '☐', label: 'RULE UPDATED', detail: (a.set || {}).title || t };
      case 'rules_remove': return { icon: '☐', label: 'RULE REMOVED', detail: t };
      case 'rules_gate': return { icon: '☐', label: 'RULES CHECK', detail: a.on === false ? 'OFF' : 'ON' };
      case 'open_app': return { icon: '◎', label: 'OPENING', detail: String(a.target || '').toUpperCase() };
      case 'reels_shuffle': return { icon: '▶', label: 'NEW REEL', detail: '' };
      case 'prep_task': return { icon: '✦', label: 'AI PREP', detail: t };
      case 'assistant_off': return { icon: '⏻', label: 'STANDING DOWN', detail: '' };
      case 'open_pc_app': return { icon: '⧉', label: 'LAUNCHING', detail: a.name || t };
      case 'open_site': { var host = String(a.url || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').split('/')[0]; return { icon: '◎', label: 'OPENING', detail: host }; }
      case 'close_pc_app': return { icon: '⊗', label: a.force ? 'FORCE QUIT' : 'CLOSING', detail: a.name || t };
      case 'close_all_pc_apps': return { icon: '⊗', label: 'CLOSING ALL', detail: (a.except && a.except.length) ? 'EXCEPT ' + a.except.join(', ') : '' };
      case 'prep_off': return { icon: '✦', label: 'AI PREP OFF', detail: t };
      case 'prep_open': return { icon: '✦', label: 'STARTING', detail: t };
      case 'prep_show': return { icon: '✦', label: 'PREP PANEL', detail: t };
      case 'clear_reminder': return { icon: '🔕', label: 'REMINDER CLEARED', detail: t };
      case 'timer_mode': return { icon: '⏱', label: 'TIMER', detail: String(a.mode || '').toUpperCase() };
      case 'timer_add': return { icon: '⏱', label: 'TIMER', detail: (a.minutes > 0 ? '+' : '') + a.minutes + ' MIN' };
      case 'rules_run': return { icon: '☐', label: 'RULES CHECK', detail: 'NOW' };
      case 'rules_check': return { icon: '☑', label: 'RULE TICKED', detail: t };
      case 'rules_move': return { icon: '☐', label: 'RULE MOVED', detail: t };
      case 'open_link': return { icon: '◎', label: 'OPENING', detail: String(a.label || t).toUpperCase() };
      case 'gita_next': return { icon: '❝', label: 'NEXT LESSON', detail: '' };
      case 'gita_prev': return { icon: '❝', label: 'PREVIOUS LESSON', detail: '' };
      case 'gita_open': return { icon: '❝', label: 'LESSON', detail: String(a.lesson || '') };
      case 'week_view': return { icon: '▤', label: 'WEEK', detail: a.collapsed === false ? 'EXPANDED' : 'COLLAPSED' };
      case 'goals_tab': return { icon: '◆', label: 'GOALS', detail: /long/i.test(a.tab || '') ? 'LONG TERM' : 'SHORT TERM' };
      case 'month_shift': return { icon: '◎', label: 'MONTH', detail: (a.by > 0 ? 'NEXT' : 'PREVIOUS') };
      case 'lock_app': return { icon: '🔒', label: 'LOCKED', detail: String(a.target || '').toUpperCase() };
      case 'journal_entry': return { icon: '✎', label: 'JOURNAL ENTRY', detail: a.title || clip(a.text, 30) };
      case 'start_class': return { icon: '▶', label: 'CLASS', detail: a.name || t };
      case 'plan_add': return { icon: '✧', label: 'PLAN IDEA', detail: t };
      case 'plan_propose': return { icon: '✧', label: 'PLAN PROPOSED', detail: t };
      case 'plan_confirm': return { icon: '✧', label: 'PLAN CONFIRMED', detail: t };
      case 'plan_decline': return { icon: '✧', label: 'PLAN DECLINED', detail: t };
      case 'plan_cancel_request': return { icon: '✧', label: 'CANCEL ASKED', detail: t };
      case 'plan_done': return { icon: '✧', label: 'PLAN DONE', detail: t };
    }
    return null;
  }

  // ══ saying only what actually happened ═════════════════════════════════════
  // The engine reports every action as {action, ok, reason}. A failed one never
  // gets a ✓ card or the model's "Done": it gets a red card and its own line.
  function actName(a) {
    a = a || {}; var m = a.match || {};
    return String(a.name || a.title || m.title || a.label || (a.first || {}).title || '').trim();
  }
  var BAD_CARD = {
    not_found: 'COULDN\'T FIND', no_bridge: 'OUT OF REACH', off_pc: 'PC ONLY', locked: 'LOCKED', no_reminder: 'NO REMINDER',
    not_flagged: 'NO AI PREP', prep_failed: 'PREP FAILED', not_running: 'NOT RUNNING', still_open: 'LEFT OPEN', bridge_down: 'BRIDGE DOWN',
    blocked: 'BLOCKED', too_soon: 'TOO SOON', out_of_order: 'OUT OF ORDER', one_at_a_time: 'ONE AT A TIME', bioFailed: 'NOT VERIFIED',
  };
  function failCard(r) {
    var a = (r && r.action) || {};
    var base = cardFor(a) || { detail: actName(a) };
    return { icon: '✕', label: 'COULDN\'T ' + (BAD_CARD[r.reason] ? '· ' + BAD_CARD[r.reason] : 'DO IT'), detail: base.detail || actName(a), bad: true };
  }
  // One failed result → the line Neo says about it.
  function failLine(r) {
    if (!r || r.ok) return '';
    if (r.say) return r.say;
    var a = r.action || {}, ty = a.type || '', t = actName(a);
    switch (r.reason) {
      case 'not_found':
        if (/^rules_/.test(ty)) return 'I\'m afraid I can\'t find a rule like ' + (t || 'that') + '.';
        if (/^plan_/.test(ty)) return 'I can\'t find a plan called ' + (t || 'that') + '.';
        if (ty === 'open_pc_app' || ty === 'close_pc_app') return 'I couldn\'t find ' + (t || 'that app') + ' on your PC, I\'m afraid.';
        if (ty === 'open_link') return 'There\'s no link called ' + (t || 'that') + ' in your header.';
        if (ty === 'start_class') return 'I can\'t find a class called ' + (t || 'that') + '.';
        if (ty === 'gita_open') return 'There\'s no lesson ' + (a.lesson || 'by that number') + ', I\'m afraid.';
        if (ty === 'shift_range' || ty === 'clear_completed') return 'There was nothing there to change.';
        return t ? 'I\'m afraid I couldn\'t find a task called ' + t + '.' : 'I\'m afraid I couldn\'t find that one.';
      case 'off_pc': return /^close_/.test(ty) ? 'I can only close apps on your PC, Veda.' : 'I can only open apps from your PC, Veda.';
      case 'locked': return 'It stayed locked, so I\'ve left everything as it was.';
      case 'no_reminder': return (t || 'That one') + ' has no reminder to clear.';
      case 'not_flagged': return (t || 'That task') + ' has no AI prep yet. Ask me to turn it on first.';
      case 'prep_failed': return 'I couldn\'t prepare ' + (t || 'that task') + ' just now, I\'m afraid. I\'ll try again shortly.';
      case 'no_lock': return 'That has no lock set up, so there\'s nothing to lock.';
      case 'too_soon': return 'Give that rule a moment on screen first.';
      case 'out_of_order': return 'The rules go in order, Veda. Tick the next one first.';
      case 'one_at_a_time': return 'The checklist goes one rule at a time, I\'m afraid. Tell me each one as you read it.';
      case 'already': return /^plan_/.test(ty) ? 'You\'ve already done that for ' + (t || 'that plan') + '.' : 'That one is already ticked.';
      case 'not_open': return 'The rules checklist isn\'t open.';
      case 'no_rules': return 'You have no rules to check yet.';
      case 'not_waiting': return (t || 'That plan') + ' isn\'t waiting on you.';
      case 'not_confirmed': return (t || 'That plan') + ' isn\'t confirmed yet.';
      case 'bioFailed': return 'The fingerprint check didn\'t pass, so I haven\'t confirmed it.';
      case 'journal_not_ready': return 'Your journal hasn\'t loaded yet. Open it once, then ask me again.';
      case 'invalid': return 'I didn\'t quite follow that one, I\'m afraid.';
      case 'no_bridge': return 'That one is beyond my reach here, I\'m afraid.';
    }
    return t ? 'I couldn\'t manage ' + t + ', I\'m afraid.' : 'I couldn\'t manage that one, I\'m afraid.';
  }
  function failSpeech(results) {
    var seen = {}, out = [];
    (results || []).forEach(function (r) { var l = failLine(r); if (l && !seen[l]) { seen[l] = 1; out.push(l); } });
    return out.join(' ');
  }
  // What Neo says once the actions have run. The model wrote `say` before
  // anything ran, so it is only trusted for the actions that worked:
  //   nothing returned (a question)  → the model's answer
  //   everything worked             → the model's line
  //   nothing worked                → only the failures (never "Done")
  //   some worked                   → the model's line, then the failures
  function compose(say, results) {
    results = results || [];
    say = String(say || '').trim();
    if (!results.length) return say;
    var bad = results.filter(function (r) { return !r.ok; });
    if (!bad.length) return say || 'Done.';
    var fl = failSpeech(bad);
    if (bad.length === results.length) return fl;
    return (say ? say + ' ' : 'The rest is done. ') + fl;
  }

  // ══ asking first ═══════════════════════════════════════════════════════════
  // Bulk deletions, range shifts and "close everything" are said back as a
  // question; nothing runs until she says yes. → {question} | null
  var BOXN = { dailyHabits: 'daily habits', shortTermGoals: 'short-term goals', longTermGoals: 'long-term goals' };
  function cap1(s) { return String(s).replace(/^./, function (c) { return c.toUpperCase(); }); }
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
    return q.length ? { question: 'Shall I ' + q.join(', and ') + '?' } : null;
  }
  // Before anything runs: is this really a new request from her?
  //  · Neo hearing itself: the transcript is mostly the line Neo just said
  //    (the device voice isn't removed by the mic's echo cancellation).
  //  · a replay: every action re-adds what the previous turn just added, and she
  //    didn't say "again" / "another". The model, shown the previous turn and
  //    given silence or noise, re-emits it; that is the "Call Ashton" loop.
  // → {drop: reason} | the ask-first question | null.
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
    if (S.lastSaid && overlap(tr, S.lastSaid) >= 0.6) return { drop: 'echo' };
    var prev = S.prev && Date.now() - S.prev.at < PREV_MS ? S.prev.data : null;
    if (isReplay(acts, prev, tr)) return { drop: 'replay' };
    return needsConfirm(acts, st);
  }
  function isYes(t) { return /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|confirm(ed)?|please( do)?|affirmative|correct|right)\b/i.test(String(t || '')); }
  function isNo(t) { return /^\s*(no|nope|nah|don'?t|do not|cancel|stop|never ?mind|leave it|wait)\b/i.test(String(t || '')); }

  // What people call an app → its Start-menu name (normalised: lower case, spaces).
  var APP_ALIASES = {
    'vs code': 'visual studio code', 'vscode': 'visual studio code', 'code': 'visual studio code',
    'chrome': 'google chrome', 'google': 'google chrome', 'explorer': 'file explorer', 'files': 'file explorer',
    'teams': 'microsoft teams', 'edge': 'microsoft edge', 'store': 'microsoft store', 'settings': 'settings',
    'terminal': 'terminal', 'cmd': 'command prompt', 'calc': 'calculator', 'ppt': 'powerpoint', 'powerpoint': 'powerpoint',
  };
  // A spoken app name → one of her PC's apps ({id,name} from dashboards/veda_pc_apps,
  // which her PC's StudyOS bridge publishes). Exact name, then a name that starts
  // with it, then one containing it, then the best word overlap. null when nothing fits.
  function matchApp(name, apps) {
    // "_" stays part of a word, so "chrome_proxy" never passes for Chrome.
    var norm = function (s) { return String(s).toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9+#_]+/g, ' ').trim(); };
    var q = norm(name || '');
    if (!q) return null;
    var list = (apps || []).filter(function (a) { return a && a.id && a.name; });
    var i, n;
    for (i = 0; i < list.length; i++) if (norm(list[i].name) === q) return list[i];
    var alias = APP_ALIASES[q];
    if (alias) for (i = 0; i < list.length; i++) if (norm(list[i].name) === alias) return list[i];
    // Her words as whole words of an app's name; the shortest such name wins
    // ("Chrome" → Google Chrome, not Chrome Remote Desktop; "Zoom" → Zoom Workplace).
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
  // What Neo says when a launch went wrong ('' when it didn't).
  function launchIssue(res, missing, bridgeErr, names) {
    if (missing && missing.length) return 'I couldn\'t find ' + missing.join(' or ') + ' on your PC, I\'m afraid.';
    if (!res) {
      if (/blocked/.test(bridgeErr || '')) return 'Your browser is blocking me from reaching your PC, Veda. Allow local network access for this site, then ask again.';
      return 'Your PC\'s launcher isn\'t answering, Veda. Start StudyOS Bridge from the Start menu, and I\'ll try again.';
    }
    // unknown holds the ids it never knew; failed holds the NAMES of what Windows refused.
    var bad = (res.unknown || []).map(function (id) { return names[id] || 'one of them'; }).concat(res.failed || []);
    return bad.length ? bad.join(' and ') + (bad.length > 1 ? ' didn\'t' : ' didn\'t') + ' open, I\'m afraid.' : '';
  }

  // The device voice when Orca can't speak: British male first, like Ryan.
  function pickVoiceFrom(vs) {
    vs = vs || [];
    var prefs = ['Microsoft Ryan Online', 'Microsoft Thomas Online', 'Google UK English Male', 'Daniel', 'Microsoft George', 'Arthur', 'Oliver'];
    for (var i = 0; i < prefs.length; i++) { var p = prefs[i], hit = vs.find(function (v) { return String(v.name).indexOf(p) === 0; }); if (hit) return hit; }
    return vs.find(function (v) { return /^en[-_]GB/i.test(v.lang) && /male|man|guy/i.test(v.name) && !/female|woman/i.test(v.name); })
      || vs.find(function (v) { return /^en[-_]GB/i.test(v.lang); })
      || vs.find(function (v) { return /^en/i.test(v.lang); }) || null;
  }

  // ══ state ══════════════════════════════════════════════════════════════════
  var S = {
    on: false, running: false, starting: false,
    mode: 'off',            // off | loading | wake | capture | thinking | speaking | follow
    stream: null, ctx: null, src: null, proc: null, sr: 48000, anMic: null, anOut: null,
    model: null, rec: null, cap: null,
    ring: [], ringLen: 0, chunks: [], vad: null, followUntil: 0,
    floor: 0.006, greet: false, level: 0, afterSay: '',
    capText: '',            // what the caption recognizer heard this capture (for a spoken yes / no)
    pending: null,          // actions held for a yes / no: {actions, say, transcript, at}
    lastSaid: '',           // Neo's last spoken line, so it never acts on hearing itself
    deafUntil: 0,           // follow mode ignores the mic until then (its own voice's tail)
    capFollow: false,       // this capture began in follow mode (no wake phrase)
    prev: null,             // the last turn, sent with the next for follow-ups: {at, data}
    history: [],            // the conversation so far (oldest first, ≤ HISTORY_N turns): [{at, data}]
  };
  try { S.on = localStorage.getItem(PREF_KEY) === '1'; } catch (e) {}
  var reduced = false; try { reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function isVeda() { return window._activeProfile === 'veda'; }
  function emit() { try { window.dispatchEvent(new CustomEvent('vd-neo-change', { detail: { on: S.on, mode: S.mode } })); } catch (e) {} }
  function setMode(m) { S.mode = m; hudMode(m); emit(); }
  function bridgeState() { try { return window._vdVoice && window._vdVoice.getState ? window._vdVoice.getState() : null; } catch (e) { return null; } }

  // ══ styles (injected at load: the header button animates from them too) ═══
  var styled = false;
  function ensureStyles() {
    if (styled || !document.head) return; styled = true;
    var st = document.createElement('style'); st.id = 'vd-neo-style';
    st.textContent = [
      '#vd-neo-hud{--vn-core:' + C.core + ';--vn-ring:' + C.ring + ';--vn-acc:' + C.accent + ';--vn-glow:' + C.glow + ';',
      ' position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:100000;width:min(620px,calc(100vw - 32px));',
      ' transform:translate(-50%,24px) scale(.97);opacity:0;pointer-events:none;transition:opacity .28s ease,transform .38s cubic-bezier(.2,.9,.25,1.1);',
      " font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--vn-core);}",
      '#vd-neo-hud.show{opacity:1;transform:translate(-50%,0) scale(1);pointer-events:auto;}',
      '#vd-neo-hud .vn-glass{position:relative;overflow:hidden;border-radius:18px;padding:14px 16px 12px;',
      ' background:linear-gradient(160deg,rgba(30,22,38,.78),rgba(14,11,18,.82));border:1px solid rgba(201,179,217,.28);',
      ' box-shadow:0 0 0 1px rgba(141,118,154,.25),0 0 34px rgba(141,118,154,.32),inset 0 0 40px rgba(141,118,154,.10);',
      ' -webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);}',
      // scan lines + a slow sweep + corner brackets
      '#vd-neo-hud .vn-scan{position:absolute;inset:0;pointer-events:none;opacity:.22;mix-blend-mode:screen;',
      ' background:repeating-linear-gradient(0deg,rgba(230,217,240,.08) 0 1px,transparent 1px 3px);}',
      '#vd-neo-hud .vn-sweep{position:absolute;left:0;right:0;height:60px;top:-60px;pointer-events:none;mix-blend-mode:screen;',
      ' background:linear-gradient(180deg,transparent,rgba(201,179,217,.10),transparent);animation:vnSweep 4.5s linear infinite;}',
      '#vd-neo-hud .vn-br{position:absolute;width:14px;height:14px;border:1.5px solid var(--vn-ring);opacity:.7;pointer-events:none;}',
      '#vd-neo-hud .vn-br.a{top:7px;left:7px;border-right:0;border-bottom:0;border-top-left-radius:6px}',
      '#vd-neo-hud .vn-br.b{top:7px;right:7px;border-left:0;border-bottom:0;border-top-right-radius:6px}',
      '#vd-neo-hud .vn-br.c{bottom:7px;left:7px;border-right:0;border-top:0;border-bottom-left-radius:6px}',
      '#vd-neo-hud .vn-br.d{bottom:7px;right:7px;border-left:0;border-top:0;border-bottom-right-radius:6px}',
      // header row
      '#vd-neo-hud .vn-top{position:relative;display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:2px;color:rgba(230,217,240,.62);}',
      "#vd-neo-hud .vn-brand{font-family:Orbitron,'JetBrains Mono',sans-serif;font-weight:700;font-size:12px;letter-spacing:4px;color:var(--vn-core);text-shadow:0 0 10px var(--vn-glow);}",
      "#vd-neo-hud .vn-state{font-family:Orbitron,'JetBrains Mono',sans-serif;font-weight:500;color:var(--vn-ring);}",
      '#vd-neo-hud .vn-state::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--vn-ring);box-shadow:0 0 8px var(--vn-ring);}',
      '#vd-neo-hud.m-capture .vn-state::before{background:' + C.red + ';box-shadow:0 0 10px ' + C.red + ';animation:vnBlink 1s steps(2) infinite;}',
      '#vd-neo-hud .vn-clock{margin-left:auto;}',
      '#vd-neo-hud .vn-x{background:none;border:1px solid rgba(201,179,217,.25);color:rgba(230,217,240,.7);border-radius:6px;width:22px;height:22px;font-size:11px;line-height:1;cursor:pointer;padding:0;}',
      '#vd-neo-hud .vn-x:hover{border-color:var(--vn-ring);color:var(--vn-core);box-shadow:0 0 8px var(--vn-glow);}',
      // body: orb + text
      '#vd-neo-hud .vn-main{position:relative;display:flex;align-items:center;gap:16px;margin-top:8px;min-height:150px;}',
      '#vd-neo-hud .vn-orb{flex:0 0 150px;width:150px;height:150px;position:relative;}',
      '#vd-neo-hud canvas{width:150px;height:150px;display:block;}',
      '#vd-neo-hud .vn-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;}',
      '#vd-neo-hud .vn-you{font-size:12px;color:rgba(230,217,240,.6);min-height:16px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
      '#vd-neo-hud .vn-you:not(:empty)::before{content:"YOU › ";color:var(--vn-acc);letter-spacing:1px;}',
      "#vd-neo-hud .vn-say{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:15px;line-height:1.5;color:var(--vn-core);min-height:22px;text-shadow:0 0 12px rgba(201,179,217,.35);}",
      '#vd-neo-hud .vn-say .w{opacity:.18;transition:opacity .18s,text-shadow .3s;}',
      '#vd-neo-hud .vn-say .w.lit{opacity:1;}',
      '#vd-neo-hud .vn-say .w.now{text-shadow:0 0 14px ' + C.hot + ';}',
      '#vd-neo-hud .vn-tick{font-size:10px;letter-spacing:1.5px;color:rgba(201,179,217,.55);white-space:nowrap;overflow:hidden;height:14px;}',
      // action cards
      '#vd-neo-hud .vn-cards{position:relative;display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
      '#vd-neo-hud .vn-card{display:flex;align-items:center;gap:8px;max-width:100%;padding:6px 10px;border-radius:8px;font-size:11px;letter-spacing:1px;',
      ' background:rgba(141,118,154,.14);border:1px solid rgba(201,179,217,.32);box-shadow:inset 0 0 12px rgba(141,118,154,.15);',
      ' opacity:0;transform:translateY(8px);animation:vnCard .42s cubic-bezier(.2,.9,.25,1.15) forwards;}',
      '#vd-neo-hud .vn-card b{font-weight:600;color:var(--vn-core);white-space:nowrap;}',
      '#vd-neo-hud .vn-card i{font-style:normal;color:var(--vn-ring);font-size:13px;text-shadow:0 0 8px var(--vn-glow);}',
      '#vd-neo-hud .vn-card span{color:rgba(230,217,240,.75);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#vd-neo-hud .vn-card.bad{background:rgba(210,122,138,.12);border-color:rgba(210,122,138,.5);}',
      '#vd-neo-hud .vn-card.bad i,#vd-neo-hud .vn-card.bad b{color:' + C.red + ';text-shadow:0 0 8px rgba(210,122,138,.5);}',
      '#vd-neo-hud .vn-ask button{font:inherit;font-size:11px;letter-spacing:1.5px;padding:3px 10px;border-radius:6px;cursor:pointer;background:transparent;color:var(--vn-core);border:1px solid rgba(201,179,217,.45);}',
      '#vd-neo-hud .vn-ask button:hover{border-color:var(--vn-ring);box-shadow:0 0 8px var(--vn-glow);}',
      // telemetry
      '#vd-neo-hud .vn-tele{position:relative;display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px dashed rgba(201,179,217,.18);',
      ' font-size:10px;letter-spacing:1.5px;color:rgba(230,217,240,.5);}',
      '#vd-neo-hud .vn-tele b{color:var(--vn-ring);font-weight:600;}',
      '#vd-neo-hud .vn-glitch{animation:vnGlitch .6s steps(6) 1;}',
      '#vd-neo-hud.m-error .vn-glass{border-color:rgba(210,122,138,.5);}',
      // phone: a bottom sheet, orb on top
      '@media (max-width:600px){#vd-neo-hud{left:0;right:0;width:auto;bottom:0;transform:translateY(30px);}',
      ' #vd-neo-hud.show{transform:translateY(0);}',
      ' #vd-neo-hud .vn-glass{border-radius:20px 20px 0 0;padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));}',
      ' #vd-neo-hud .vn-main{flex-direction:column;align-items:stretch;gap:8px;}',
      ' #vd-neo-hud .vn-orb{align-self:center;flex-basis:auto;width:128px;height:128px;}#vd-neo-hud canvas{width:128px;height:128px;}',
      ' #vd-neo-hud .vn-say{font-size:14px;text-align:center;}#vd-neo-hud .vn-you{text-align:center;}#vd-neo-hud .vn-tick{text-align:center;}',
      ' #vd-neo-hud .vn-cards{justify-content:center;}#vd-neo-hud .vn-tele{justify-content:center;}}',
      // docked: in the Gita quote banner's slot (Veda's TaskHub) while Neo is up. Dressed as the
      // banner itself (its border, left accent, type); no scanlines, brackets or glitch, just
      // a row of voice-level bars. Banner and Neo crossfade.
      'body.vn-docked #vr-root .thwx-band > .gita-banner{display:none;}',
      'body.vn-undock #vr-root .thwx-band > .gita-banner{animation:vnIn .35s ease;}',
      '#vd-neo-hud.vn-dock{position:relative;left:auto;right:auto;bottom:auto;z-index:auto;width:auto;flex:1 1 auto;min-width:0;display:none;transform:none;opacity:1;transition:none;',
      " font-family:'IBM Plex Mono',ui-monospace,monospace;}",
      '#vd-neo-hud.vn-dock.show{display:block;transform:none;animation:vnIn .35s ease;}',
      '#vd-neo-hud.vn-dock .vn-glass{height:100%;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:6px 12px;border-radius:6px;',
      ' background:linear-gradient(90deg,rgba(141,118,154,.07),rgba(141,118,154,.05) 50%,rgba(141,118,154,.07));',
      ' border:1px solid rgba(141,118,154,.25);border-left:3px solid ' + C.accent + ';box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;}',
      '#vd-neo-hud.vn-dock .vn-scan,#vd-neo-hud.vn-dock .vn-sweep,#vd-neo-hud.vn-dock .vn-br,#vd-neo-hud.vn-dock .vn-tick,#vd-neo-hud.vn-dock .vn-tele,#vd-neo-hud.vn-dock .vn-clock{display:none;}',
      '#vd-neo-hud.vn-dock .vn-glitch{animation:none;}',
      '#vd-neo-hud.vn-dock .vn-main{order:1;flex:1 1 auto;min-width:0;margin-top:0;min-height:0;gap:12px;flex-direction:row;align-items:center;}',
      '#vd-neo-hud.vn-dock .vn-orb{flex:0 0 64px;width:64px;height:26px;align-self:center;}#vd-neo-hud.vn-dock canvas{width:64px;height:26px;}',
      '#vd-neo-hud.vn-dock .vn-text{gap:2px;}',
      '#vd-neo-hud.vn-dock .vn-you{font-size:10.5px;min-height:0;-webkit-line-clamp:1;text-align:left;color:#76777C;}',
      '#vd-neo-hud.vn-dock .vn-you:not(:empty)::before{content:"you  ";color:' + C.accent + ';letter-spacing:0;}',
      '#vd-neo-hud.vn-dock .vn-you:empty{display:none;}',
      '#vd-neo-hud .vn-you.vn-heard{color:rgba(230,217,240,.85);}#vd-neo-hud.vn-dock .vn-you.vn-heard{color:#A9AAB0;}',
      '#vd-neo-hud.vn-dock .vn-say{font-family:var(--font-accent,inherit);font-size:12.5px;line-height:1.45;min-height:0;text-align:left;color:#D8D3DC;text-shadow:none;',
      ' display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '#vd-neo-hud.vn-dock .vn-say:empty{display:none;}',
      '#vd-neo-hud.vn-dock .vn-say .w{opacity:.3;transition:opacity .25s ease;}#vd-neo-hud.vn-dock .vn-say .w.lit{opacity:1;}#vd-neo-hud.vn-dock .vn-say .w.now{text-shadow:none;}',
      '#vd-neo-hud.vn-dock .vn-cards{margin-top:2px;flex-wrap:nowrap;overflow:hidden;justify-content:flex-start;gap:6px;}#vd-neo-hud.vn-dock .vn-cards:empty{display:none;}',
      '#vd-neo-hud.vn-dock .vn-card{padding:2px 8px;font-size:9.5px;letter-spacing:.5px;flex-shrink:0;border-radius:4px;background:transparent;border:1px solid rgba(141,118,154,.3);box-shadow:none;}',
      '#vd-neo-hud.vn-dock .vn-card i{color:' + C.accent + ';text-shadow:none;font-size:11px;}#vd-neo-hud.vn-dock .vn-card b{color:#AFB0B5;font-weight:600;}#vd-neo-hud.vn-dock .vn-card span{color:#76777C;}',
      '#vd-neo-hud.vn-dock .vn-card.bad{background:transparent;}#vd-neo-hud.vn-dock .vn-card.bad i,#vd-neo-hud.vn-dock .vn-card.bad b{text-shadow:none;}',
      '#vd-neo-hud.vn-dock .vn-top{order:2;flex:0 0 auto;flex-direction:column;align-items:flex-end;gap:6px;font-size:9px;letter-spacing:1.5px;color:#76777C;}',
      "#vd-neo-hud.vn-dock .vn-brand{font-family:inherit;font-size:9px;font-weight:600;letter-spacing:1.5px;color:#76777C;text-shadow:none;}",
      "#vd-neo-hud.vn-dock .vn-state{font-family:inherit;font-weight:600;color:" + C.ring + ";}",
      '#vd-neo-hud.vn-dock .vn-state::before{width:5px;height:5px;margin-right:6px;box-shadow:none;background:' + C.accent + ';}',
      '#vd-neo-hud.vn-dock.m-capture .vn-state::before{background:' + C.ring + ';box-shadow:none;animation:vnBreathe 1.4s ease-in-out infinite;}',
      '#vd-neo-hud.vn-dock .vn-x{width:18px;height:18px;font-size:9px;border-color:rgba(141,118,154,.3);color:#76777C;}',
      '#vd-neo-hud.vn-dock .vn-x:hover{border-color:' + C.accent + ';color:#AFB0B5;box-shadow:none;}',
      '@keyframes vnIn{from{opacity:0}to{opacity:1}}',
      // header button: a mini reactor
      '.vd-neo-btn .vnb{width:15px;height:15px;display:block;overflow:visible;}',
      '.vd-neo-btn .vnb .r1{transform-origin:12px 12px;}',
      '.vd-neo-btn.on .vnb .r1{animation:vnSpin 9s linear infinite;}',
      '.vd-neo-btn.on .vnb .c{animation:vnBreathe 3.2s ease-in-out infinite;}',
      '.vd-neo-btn.busy .vnb .r1{animation:vnSpin 1.1s linear infinite;}',
      '@keyframes vnSpin{to{transform:rotate(360deg)}}',
      '@keyframes vnBreathe{0%,100%{opacity:.55}50%{opacity:1}}',
      '@keyframes vnBlink{50%{opacity:.25}}',
      '@keyframes vnSweep{to{top:110%}}',
      '@keyframes vnCard{to{opacity:1;transform:none}}',
      '@keyframes vnGlitch{0%{clip-path:inset(0 0 60% 0);transform:translateX(-3px)}20%{clip-path:inset(40% 0 20% 0);transform:translateX(3px)}40%{clip-path:inset(10% 0 70% 0);transform:translateX(-2px)}60%{clip-path:inset(70% 0 0 0);transform:translateX(2px)}80%{clip-path:inset(0 0 0 0);transform:translateX(-1px)}100%{clip-path:none;transform:none}}',
      '@media (prefers-reduced-motion:reduce){#vd-neo-hud .vn-sweep{display:none}.vd-neo-btn .vnb .r1,.vd-neo-btn .vnb .c{animation:none!important}#vd-neo-hud .vn-glitch{animation:none}#vd-neo-hud .vn-card{animation-duration:.01s}}',
    ].join('\n');
    document.head.appendChild(st);
  }
  var fontsLoaded = false;
  function loadFonts() {
    if (fontsLoaded || !document.head) return; fontsLoaded = true;
    try { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = FONTS; document.head.appendChild(l); } catch (e) {}
  }

  // ══ HUD ════════════════════════════════════════════════════════════════════
  var H = null;   // {el, canvas, g, state, clock, you, say, tick, cards, tele}
  function ensureHud() {
    if (H || !document.body) return H;
    ensureStyles(); loadFonts();
    var el = document.createElement('div');
    el.id = 'vd-neo-hud';
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="vn-glass"><div class="vn-scan"></div><div class="vn-sweep"></div>' +
      '<i class="vn-br a"></i><i class="vn-br b"></i><i class="vn-br c"></i><i class="vn-br d"></i>' +
      '<div class="vn-top"><span class="vn-brand">NEO</span><span class="vn-state">ONLINE</span><span class="vn-clock"></span>' +
      '<button type="button" class="vn-x" aria-label="Cancel" title="Cancel">✕</button></div>' +
      '<div class="vn-main"><div class="vn-orb"><canvas></canvas></div>' +
      '<div class="vn-text"><div class="vn-you"></div><div class="vn-say"></div><div class="vn-tick"></div><div class="vn-cards"></div></div></div>' +
      '<div class="vn-tele"></div></div>';
    document.body.appendChild(el);
    H = { el: el, canvas: el.querySelector('canvas'), state: el.querySelector('.vn-state'), clock: el.querySelector('.vn-clock'),
      you: el.querySelector('.vn-you'), say: el.querySelector('.vn-say'), tick: el.querySelector('.vn-tick'),
      cards: el.querySelector('.vn-cards'), tele: el.querySelector('.vn-tele') };
    el.querySelector('.vn-x').onclick = function () { cancel(); };
    return H;
  }
  var hideTimer = null, boot = 0;
  var LABEL = { loading: 'INITIALISING', boot: 'ONLINE', capture: 'LISTENING', thinking: 'PROCESSING', speaking: 'RESPONDING', follow: 'STANDING BY', error: 'FAULT', note: 'NOTICE' };
  // Where the HUD sits: in place of the Gita quote banner when that's on screen
  // (Veda's TaskHub), else the floating panel at the bottom. The banner is
  // React's, so it's hidden by a body class and the HUD goes in beside it.
  function placeHud(h) {
    var b = document.querySelector('#vr-root .thwx-band > .gita-banner'), dock = false;
    if (b) { var r = b.getBoundingClientRect(); dock = r.width > 0 && r.bottom > 0 && r.top < (window.innerHeight || 0); }
    if (dock) { if (h.el.previousElementSibling !== b) b.parentNode.insertBefore(h.el, b.nextSibling); }
    else if (h.el.parentNode !== document.body) document.body.appendChild(h.el);
    h.el.classList.toggle('vn-dock', dock);
    document.body.classList.toggle('vn-docked', dock);
  }
  function hudShow(on) {
    var h = ensureHud(); if (!h) return;
    clearTimeout(hideTimer);
    if (on) { if (!h.el.classList.contains('show') || !h.el.isConnected) { placeHud(h); h.el.classList.add('show'); refreshTele(); startAnim(); } }
    else if (h.el.classList.contains('show')) { h.el.classList.remove('show'); var bd = document.body.classList; if (bd.contains('vn-docked')) { bd.remove('vn-docked'); bd.add('vn-undock'); setTimeout(function () { bd.remove('vn-undock'); }, 400); } }
  }
  function hudMode(m) {
    var h = ensureHud(); if (!h) return;
    ['loading', 'boot', 'capture', 'thinking', 'speaking', 'follow', 'error', 'note'].forEach(function (k) { h.el.classList.toggle('m-' + k, k === m); });
    if (LABEL[m]) {
      if (h.state.textContent !== LABEL[m]) { h.state.textContent = LABEL[m]; h.state.classList.remove('vn-glitch'); void h.state.offsetWidth; if (!reduced && !h.el.classList.contains('vn-dock')) h.state.classList.add('vn-glitch'); }
      hudShow(true);
    }
    if (m === 'capture') { h.you.textContent = ''; h.you.classList.remove('vn-heard'); h.say.innerHTML = ''; h.cards.innerHTML = ''; }
    if (m === 'thinking') startTicker(); else stopTicker();
    if (m === 'wake' || m === 'off') hideTimer = setTimeout(function () { hudShow(false); }, m === 'off' ? 0 : 900);
  }
  function hudNote(text, kind, ms) {
    var h = ensureHud(); if (!h) return;
    hudMode(kind || 'note');
    h.you.textContent = ''; h.cards.innerHTML = '';
    h.say.innerHTML = ''; h.say.textContent = text;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (S.mode === 'wake' || S.mode === 'off') hudShow(false); }, ms || 3400);
  }
  function hudCards(actions) {
    var h = ensureHud(); if (!h) return;
    h.cards.innerHTML = '';
    // Cards, or actions (each → cardFor). A failed action's card is red (failCard).
    (actions || []).map(function (x) { return x && x.icon && !x.type ? x : cardFor(x); }).filter(Boolean).slice(0, 6).forEach(function (c, i) {
      var d = document.createElement('div'); d.className = 'vn-card' + (c.bad ? ' bad' : ''); d.style.animationDelay = (i * 90) + 'ms';
      d.innerHTML = '<i></i><b></b><span></span>';
      d.querySelector('i').textContent = c.icon; d.querySelector('b').textContent = c.label;
      d.querySelector('span').textContent = clip(c.detail, 46);
      if (!c.detail) d.querySelector('span').remove();
      h.cards.appendChild(d);
    });
  }
  function refreshTele() {
    var h = H; if (!h) return;
    var now = new Date();
    h.clock.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ' · ' + DOW[now.getDay()] + ' ' + pad2(now.getDate()) + ' ' + MON[now.getMonth()];
    var s = dayStats(bridgeState(), now);
    var parts = ['TASKS <b>' + s.done + '/' + s.total + '</b>'];
    parts.push('NEXT · <b>' + (s.next ? esc(clip(s.next.title, 22)) + ' ' + s.next.time : '—') + '</b>');
    if (s.habits) parts.push('HABITS <b>' + s.habitsDone + '/' + s.habits + '</b>');
    parts.push('VOICE <b>' + (lastVoice || (orcaOk === false ? 'DEVICE' : 'RYAN')) + '</b>');
    h.tele.innerHTML = parts.map(function (p) { return '<span>' + p + '</span>'; }).join('');
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var tickTimer = null;
  function startTicker() {
    var h = H; if (!h) return; stopTicker();
    var hex = '0123456789ABCDEF', line = '';
    tickTimer = setInterval(function () {
      var seg = ''; for (var i = 0; i < 4; i++) seg += hex[Math.floor(Math.random() * 16)];
      line = (line + ' ' + seg + (Math.random() < .25 ? ' ◇ PARSE' : Math.random() < .2 ? ' ◇ CTX' : '')).slice(-90);
      h.tick.textContent = '› ' + line;
    }, 90);
  }
  function stopTicker() { clearInterval(tickTimer); tickTimer = null; if (H) H.tick.textContent = ''; }

  // The reply, as word spans lit in time with the voice.
  function sayWords(text) {
    var h = ensureHud(); if (!h) return [];
    h.say.innerHTML = '';
    return String(text).split(/\s+/).filter(Boolean).map(function (w) {
      var s = document.createElement('span'); s.className = 'w'; s.textContent = w + ' '; h.say.appendChild(s); return s;
    });
  }
  function lightTo(spans, n) {
    for (var i = 0; i < spans.length; i++) { spans[i].classList.toggle('lit', i < n); spans[i].classList.toggle('now', i === n - 1); }
  }

  // Docked: a quiet row of rounded bars, tall where her voice (or Neo's) is loud.
  // Mirrored from the middle out; no glow. Idle is a low, slow breath.
  function drawBars(cv, dpr, t, m) {
    var w = cv.clientWidth || 64, ht = cv.clientHeight || 26;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(ht * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(ht * dpr); }
    var g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, ht);
    g.globalCompositeOperation = 'source-over'; g.shadowBlur = 0;
    var n = 11, gap = (w - 2) / (n - 1), mid = (n - 1) / 2, live = m === 'capture' || m === 'follow' || m === 'speaking';
    g.lineCap = 'round'; g.lineWidth = 2;
    for (var i = 0; i < n; i++) {
      var d = Math.abs(i - mid), v = smooth[Math.min(63, 4 + Math.round(d * 5))];
      var idle = reduced ? 0.12 : 0.1 + 0.06 * Math.sin(t * 1.6 - d * 0.6);
      if (m === 'thinking' && !reduced) idle = 0.12 + 0.25 * Math.max(0, Math.sin(t * 4 - i * 0.55));
      var a = live ? Math.max(idle, Math.min(1, v * 1.6)) * (1 - d / (mid + 3)) : idle;
      var len = Math.max(2, a * (ht - 4));
      g.globalAlpha = 0.45 + 0.55 * Math.min(1, a * 1.4); g.strokeStyle = C.ring;
      var x = 1 + i * gap; g.beginPath(); g.moveTo(x, ht / 2 - len / 2); g.lineTo(x, ht / 2 + len / 2); g.stroke();
    }
    g.globalAlpha = 1;
  }

  // ── the arc-reactor orb ─────────────────────────────────────────────────────
  var now0 = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
  var raf = 0, bins = new Uint8Array(64), smooth = new Float32Array(64), t0 = now0();
  function startAnim() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    var h = H; if (!h || !h.el.classList.contains('show')) return;
    var cv = h.canvas, dpr = Math.min(2, window.devicePixelRatio || 1), size = cv.clientWidth || 150, docked = h.el.classList.contains('vn-dock');
    if (!docked && (cv.width !== Math.round(size * dpr) || cv.height !== cv.width)) { cv.width = cv.height = Math.round(size * dpr); }
    var g = cv.getContext('2d'); if (!g) return;
    var t = (now - t0) / 1000, m = S.mode;
    // sound in: her voice while listening, Neo's while speaking, a synthetic
    // shimmer otherwise (device speech can't be analysed)
    var an = m === 'capture' || m === 'follow' ? S.anMic : (m === 'speaking' && speakingViaAudio ? S.anOut : null);
    var lvl = 0;
    if (an) { try { var fb = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(fb); for (var i = 0; i < 64; i++) bins[i] = fb[Math.min(fb.length - 1, 2 + Math.floor(i * (fb.length * 0.55) / 64))]; } catch (e) {} }
    else for (var j = 0; j < 64; j++) bins[j] = m === 'speaking' ? 90 + 70 * Math.max(0, Math.sin(t * 9 + j * 0.7) * Math.sin(t * 3.3 + j * 0.23)) : m === 'thinking' ? 40 + 40 * Math.max(0, Math.sin(t * 6 - j * 0.4)) : 18 + 10 * Math.sin(t * 2 + j * 0.5);
    for (var k = 0; k < 64; k++) { smooth[k] += (bins[k] / 255 - smooth[k]) * 0.35; lvl += smooth[k]; }
    lvl /= 64; S.level = lvl;
    if (docked) { drawBars(cv, dpr, (now - t0) / 1000, m); raf = requestAnimationFrame(frame); return; }
    var speed = reduced ? 0.12 : ({ capture: 0.45, thinking: 2.2, speaking: 0.7, follow: 0.3, loading: 1.4, boot: 1 }[m] || 0.35);
    var bootP = Math.min(1, (now - boot) / 1100);
    var s = size / 150, c = (cv.width / dpr) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.globalCompositeOperation = 'lighter';
    var flicker = m === 'error' ? (0.45 + 0.55 * (Math.random() > 0.15 ? 1 : 0.2)) : 1;
    g.globalAlpha = flicker;
    g.lineCap = 'round';
    // outer tick ring
    var rot1 = t * speed * 0.35;
    g.strokeStyle = C.ring; g.shadowColor = C.glow; g.shadowBlur = 8 * s;
    for (var a = 0; a < 72 * bootP; a++) {
      var ang = rot1 + a * Math.PI * 2 / 72, long = a % 6 === 0, r0 = 66 * s, r1 = (long ? 73 : 69.5) * s;
      g.globalAlpha = flicker * (long ? 0.9 : 0.42); g.lineWidth = (long ? 1.6 : 1) * s;
      g.beginPath(); g.moveTo(c + Math.cos(ang) * r0, c + Math.sin(ang) * r0); g.lineTo(c + Math.cos(ang) * r1, c + Math.sin(ang) * r1); g.stroke();
    }
    // three arc segments, counter-rotating
    var rot2 = -t * speed * 0.8;
    g.globalAlpha = flicker * 0.85; g.lineWidth = 2.2 * s; g.strokeStyle = C.core;
    for (var q = 0; q < 3; q++) { var st0 = rot2 + q * Math.PI * 2 / 3; g.beginPath(); g.arc(c, c, 60 * s, st0, st0 + (Math.PI * 2 / 3 - 0.55) * bootP); g.stroke(); }
    // waveform bars
    g.lineWidth = 2 * s; g.strokeStyle = C.ring; g.shadowBlur = 10 * s;
    for (var b = 0; b < 64; b++) {
      var an2 = b * Math.PI * 2 / 64 - Math.PI / 2, len = (2 + smooth[b] * 15) * s * bootP, rb = 44 * s;
      g.globalAlpha = flicker * (0.35 + smooth[b] * 0.65);
      g.beginPath(); g.moveTo(c + Math.cos(an2) * rb, c + Math.sin(an2) * rb); g.lineTo(c + Math.cos(an2) * (rb + len), c + Math.sin(an2) * (rb + len)); g.stroke();
    }
    // inner ring + comet
    g.globalAlpha = flicker * 0.5; g.lineWidth = 1 * s; g.strokeStyle = C.ring;
    g.beginPath(); g.arc(c, c, 38 * s, 0, Math.PI * 2 * bootP); g.stroke();
    var rot3 = t * speed * 2.4;
    g.globalAlpha = flicker; g.lineWidth = 2.4 * s; g.strokeStyle = C.hot; g.shadowColor = C.core; g.shadowBlur = 14 * s;
    g.beginPath(); g.arc(c, c, 38 * s, rot3, rot3 + 0.7); g.stroke();
    // orbiting particles while processing
    if (m === 'thinking' || m === 'loading') {
      g.fillStyle = C.hot;
      for (var p = 0; p < 6; p++) { var pa = t * (1.6 + p * 0.35) + p; var pr = (52 + 6 * Math.sin(t * 2 + p)) * s; g.globalAlpha = flicker * 0.8; g.beginPath(); g.arc(c + Math.cos(pa) * pr, c + Math.sin(pa) * pr, 1.6 * s, 0, Math.PI * 2); g.fill(); }
    }
    // core
    var cr = (20 + lvl * 9 + Math.sin(t * 2.2) * 1.2) * s * (0.4 + 0.6 * bootP);
    var grd = g.createRadialGradient(c, c, 0, c, c, cr * 1.9);
    grd.addColorStop(0, 'rgba(244,236,250,.95)'); grd.addColorStop(0.35, 'rgba(201,179,217,.55)'); grd.addColorStop(1, 'rgba(141,118,154,0)');
    g.globalAlpha = flicker; g.shadowBlur = 0; g.fillStyle = grd;
    g.beginPath(); g.arc(c, c, cr * 1.9, 0, Math.PI * 2); g.fill();
    // a hexagon in the core
    g.strokeStyle = 'rgba(244,236,250,.75)'; g.lineWidth = 1.1 * s; g.beginPath();
    for (var x = 0; x <= 6; x++) { var ha = x * Math.PI / 3 + t * speed * 0.3; var hr = cr * 0.62; if (x) g.lineTo(c + Math.cos(ha) * hr, c + Math.sin(ha) * hr); else g.moveTo(c + Math.cos(ha) * hr, c + Math.sin(ha) * hr); }
    g.stroke();
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }
  setInterval(function () { if (H && H.el.classList.contains('show')) refreshTele(); }, 15000);

  // ══ sound design (synthesized, quiet) ══════════════════════════════════════
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
      if (name === 'wake') { tone(740, 1110, 0, 0.16, 'sine', 0.05); tone(1110, 1480, 0.09, 0.2, 'sine', 0.04); tone(2220, 0, 0.12, 0.25, 'triangle', 0.012); }
      else if (name === 'think') { tone(196, 220, 0, 0.22, 'sine', 0.03); }
      else if (name === 'done') { tone(1320, 0, 0, 0.09, 'sine', 0.04); tone(1760, 0, 0.08, 0.14, 'sine', 0.035); }
      else if (name === 'error') { tone(440, 260, 0, 0.32, 'triangle', 0.045); }
      else if (name === 'boot') {
        var o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(420, t + 0.7);
        f.type = 'lowpass'; f.frequency.setValueAtTime(200, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.7); f.Q.value = 6;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.03, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + 0.85);
        tone(880, 0, 0.7, 0.3, 'sine', 0.035); tone(1320, 0, 0.78, 0.35, 'sine', 0.025);
      }
    } catch (e) {}
  }

  // ══ loading Vosk ═══════════════════════════════════════════════════════════
  var voskP = null;
  function loadVosk() {
    if (window.Vosk) return Promise.resolve(window.Vosk);
    if (voskP) return voskP;
    voskP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = VOSK_SRC; s.async = true;
      s.onload = function () { window.Vosk ? res(window.Vosk) : rej(new Error('Vosk missing')); };
      s.onerror = function () { voskP = null; rej(new Error('I could not load my wake-word engine. Check the connection.')); };
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
  // Live captions. The browser's own recognizer (Chrome / Edge) is far more
  // accurate than Vosk's small model, so it leads when it works; Brave and
  // offline fall back to Vosk. Either way the words are snapped to her own
  // (task titles, habits, apps, plans) so "spotty fi" reads "Spotify".
  // The final transcript (Gemini) replaces the caption when the turn lands.
  var WS = window.SpeechRecognition || window.webkitSpeechRecognition, wsBroken = false;
  // The wake phrase as the small model mishears it ("her new", "hey know"),
  // with the noise words it puts before it ("you", "the", "uh").
  var WAKE_RE = /^\s*(?:(?:you|the|uh+|um+|hmm+|ah|oh|huh)[,.]?\s+)*(?:(?:hey|hi|hay|her|okay|ok)[,.]?\s+(?:neo|new|neil|nio|knee|know|now|leo|neon|nemo|no)|neo|nio)\b[,.!?]?\s*/i;
  function stripWake(s) { return String(s || '').replace(WAKE_RE, ''); }
  // What she sees: no wake phrase, no lone noise word, a capital, "I" not "i".
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
    S.capWs = false;
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

  // Her own words, for snapping misheard captions: titles near today, habits,
  // goals, PC apps, and the names Neo itself answers to.
  function captionVocab() {
    var out = ['Neo', 'TaskHub', 'Gita', 'Notebook', 'Shield', 'Spotify', 'YouTube', 'Canvas', 'Gmail', 'Pomodoro'];
    try {
      var st = bridgeState() || {}, data = st.data || {}, now = new Date();
      for (var d = -3; d <= 10; d++) { var t = new Date(now); t.setDate(now.getDate() + d); (data[dkey(t)] || []).forEach(function (x) { if (x && x.title) out.push(x.title); }); }
      (st.habits || []).concat(st.shortGoals || [], st.longGoals || []).forEach(function (x) { var n = x && (x.title || x.text || x.name); if (n) out.push(n); });
      (window._vdPcApps || []).forEach(function (a) { if (a && a.name) out.push(String(a.name).replace(/\.exe$/i, '')); });
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
  // A rough sound key: first letter, then the consonants, alike sounds merged.
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
  // Replace caption word runs that sound like one of her phrases. Strict, so
  // ordinary words are left alone: same first letter, close spelling, and the
  // same consonant skeleton (or very close spelling).
  // Everyday words that sound like one of her names ("should" ~ "Shield") are
  // what she said, so a run made only of them is never swapped.
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
        var P = vocab[v];
        for (var k = P.n; k <= P.n + 1 && i + k <= words.length; k++) {
          var win = words.slice(i, i + k).join(' '), wl = letters(win);
          if (wl !== P.l && allCommon(words.slice(i, i + k))) continue;
          if (!wl || wl === P.l) { if (wl === P.l && (!best || P.l.length > best.score)) best = { k: k, text: P.text, score: P.l.length, exact: true }; continue; }
          if (wl.charAt(0) !== P.l.charAt(0) || Math.abs(wl.length - P.l.length) > 3) continue;
          var sim = 1 - lev(wl, P.l) / Math.max(wl.length, P.l.length);
          if (sim >= 0.86 || (sim >= 0.6 && skel(win) === P.sk)) { if (!best || P.l.length > best.score) best = { k: k, text: P.text, score: P.l.length }; }
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
    var dev = ''; try { dev = localStorage.getItem('thv_mic_device') || ''; } catch (e) {}
    if (dev) { try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: dev } }, base) }); } catch (e) {} }
    return await navigator.mediaDevices.getUserMedia({ audio: base });
  }

  // A page that opens with Neo already on has had no tap yet, so the browser
  // keeps its audio suspended until the first one. Wait for it, quietly.
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
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser gives me no microphone, I\'m afraid.');
      var stream;
      try { stream = await openMic(); } catch (e) { throw new Error('I need the microphone, Veda. Allow it for this site, then switch me on again.'); }
      if (!S.on || !isVeda()) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
      if (ctx.state === 'suspended') armResume();
      S.stream = stream; S.ctx = ctx; S.sr = ctx.sampleRate;
      // A cached model loads in a moment; only a slow (first, ~41 MB) load shows the HUD.
      var slow = S.model ? 0 : setTimeout(function () {
        if (S.model || !S.on) return;
        boot = performance.now(); setMode('loading');
        if (H) H.say.textContent = 'Calibrating voice recognition. This first start takes a moment.';
      }, S.greet ? 0 : 1500);
      await loadModel();
      clearTimeout(slow);
      if (!S.on || !isVeda() || S.ctx !== ctx) return;
      newRecognizer();
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
      if (S.greet) {
        S.greet = false;
        boot = performance.now(); setMode('boot'); sfx('boot');
        setTimeout(function () { if (S.running && S.mode === 'boot') speak(greeting(bridgeState()), false); }, 650);
      } else setMode('wake');
    } catch (e) {
      console.warn('[neo]', e);
      teardown();
      setOn(false);
      hudNote((e && e.message) || 'I could not start, I\'m afraid.', 'error', 5600);
    } finally { S.starting = false; }
  }

  function teardown() {
    S.running = false;
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

  // ══ audio loop ═════════════════════════════════════════════════════════════
  function onAudio(e) {
    var chunk = new Float32Array(e.inputBuffer.getChannelData(0));
    var ms = chunk.length * 1000 / S.sr;
    var level = rms(chunk);
    S.ring.push(chunk); S.ringLen += chunk.length;
    while (S.ringLen - S.ring[0].length > PRE_ROLL_S * S.sr) S.ringLen -= S.ring.shift().length;

    // The manual mic button owns the conversation while it records.
    if (window._THV && window._THV.isActive && window._THV.isActive()) return;

    if (S.mode === 'wake') {
      if (level < threshold(S.floor)) S.floor = S.floor * 0.95 + level * 0.05;   // ambient noise, learned while quiet
      if (S.rec) { try { S.rec.acceptWaveformFloat(chunk, S.sr); } catch (err) {} }
    } else if (S.mode === 'capture') {
      S.chunks.push(chunk);
      if (S.cap) { try { S.cap.acceptWaveformFloat(chunk, S.sr); } catch (err) {} }
      var r = vadStep(S.vad, level, S.floor, ms);
      if (r === 'end') finishCapture();
      else if (r === 'none') { stopCaptions(); setMode('wake'); newRecognizer(); }
    } else if (S.mode === 'follow') {
      if (Date.now() < S.deafUntil) return;   // the tail of Neo's own voice
      if (level > threshold(S.floor) * 1.3) beginCapture(0.6, true);
      else if (Date.now() > S.followUntil) { setMode('wake'); newRecognizer(); }
    }
  }

  function onWake() {
    if (S.mode !== 'wake') return;
    if (window._THV && window._THV.isBusy && window._THV.isBusy()) return;
    sfx('wake');
    refreshRunning();
    beginCapture(PRE_ROLL_S, false);
  }
  function beginCapture(preSec, alreadySpeaking) {
    var keep = Math.floor(preSec * S.sr), pre = [], n = 0;
    for (var i = S.ring.length - 1; i >= 0 && n < keep; i--) { pre.unshift(S.ring[i]); n += S.ring[i].length; }
    S.chunks = pre;
    S.vad = { speech: !!alreadySpeaking, silentMs: 0, elapsedMs: 0 };
    S.capFollow = !!alreadySpeaking;   // no wake phrase: words must be heard (finishCapture)
    setMode('capture');
    startCaptions();
    if (S.cap) pre.forEach(function (c) { try { S.cap.acceptWaveformFloat(c, S.sr); } catch (e) {} });
  }

  async function finishCapture() {
    var buffers = S.chunks; S.chunks = []; S.vad = null;
    var heard = S.capText || ''; S.capText = '';
    var hadCaptions = !!S.cap, wasFollow = S.capFollow; S.capFollow = false;
    stopCaptions();
    // A follow-up has no wake phrase to prove she spoke to Neo. If the caption
    // recognizer heard no words at all (a cough, a chair, the TV, Neo's own
    // voice fading), nothing is sent: that empty audio is what the model used
    // to "hear" the last task again and add it a second time.
    if (wasFollow && !S.pending && hadCaptions && !heard.trim()) { setMode('wake'); newRecognizer(); return; }
    // A yes / no to a question Neo just asked is decided here, on the device.
    if (S.pending) {
      var pend = S.pending; S.pending = null;
      if (Date.now() - pend.at < 30000) {
        if (isYes(heard)) return runHeld(pend);
        if (isNo(heard) || !heard.trim()) { hudCards([]); speak('Very well. I\'ve left everything as it was.', true); return; }
        // Anything else is a new request: send it as usual.
      }
    }
    setMode('thinking'); sfx('think');
    var res = null;
    try {
      if (!window._THV || !window._THV.sendAudio) throw new Error('TaskHub voice is not ready');
      var wav = encodeWav(buffers, S.sr, 16000);
      var extra = { mode: 'neo' };
      // The last turn, so "…and remind me at 4" / "actually make it 5" find their item.
      if (S.prev && Date.now() - S.prev.at < PREV_MS) extra.prev = S.prev.data;
      // The whole conversation, so she can clarify, change her mind or keep talking.
      var hist = recentHistory();
      if (hist.length) extra.history = hist;
      res = await window._THV.sendAudio(b64(wav), { extra: extra, hold: guardTurn });
    } catch (e) { console.warn('[neo]', e); res = { ok: false, error: 'network' }; }
    // What Neo actually understood replaces the live guess.
    if (res && res.transcript && H) { H.you.textContent = tidyText(res.transcript); H.you.classList.add('vn-heard'); }
    if (res && res.dropped) { console.info('[neo] ignored:', res.dropped, res.transcript || ''); setMode('wake'); newRecognizer(); return; }
    if (!S.running) { if (res && res.say) speak(res.say, false); return; }   // turned off mid-request ("stop listening")
    if (!res || !res.ok) {
      sfx('error'); hudMode('error');
      speak(res && /network/i.test(res.error || '') ? 'My apologies, Veda. The connection seems to be down.' : 'My apologies. I couldn\'t manage that one. Do try again.', true);
      return;
    }
    if (res.held) {   // a bulk delete, a shift, "close everything": ask first
      S.pending = { actions: res.held.actions, say: res.say, transcript: res.transcript || '', at: Date.now() };
      showConfirm(res.held.question);
      speak(res.held.question, true);
      return;
    }
    await report(res, res.transcript || '');
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
  function cardsFor(results, say) {
    if (!results.length) { if (say && H) H.cards.innerHTML = '<div class="vn-card"><i>≡</i><b>BRIEFING</b></div>'; return; }   // a question, answered
    hudCards(results.map(function (r) { return r.ok ? cardFor(r.action) : failCard(r); }));
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
  async function report(res, transcript) {
    var results = (res.results || []).slice();
    var laterP = res.later || Promise.resolve([]);
    var gated = results.some(function (r) { return r.gated; });
    var early = await Promise.race([laterP.then(function (l) { return { done: true, l: l }; }, function () { return { done: true, l: [] }; }), timeoutP(SETTLE_MS, { done: false })]);
    if (early.done) results = mergeLater(results, early.l);
    cardsFor(results, res.say);
    if (results.some(function (r) { return r.ok; })) sfx('done');
    rememberTurn(transcript, res.say, results);
    refreshTele();
    var say;
    if (gated && !early.done) say = 'Unlock it, Veda, and I\'ll make the change.';
    else {
      say = compose(res.say, results);
      var notes = results.map(function (r) { return r.ok && r.note; }).filter(Boolean).join(' ');
      if (notes) say = (say ? say + ' ' : '') + notes;
    }
    if (!early.done) {
      // Still running (a kit being built, an app opening, the lock prompt): say
      // the outcome when it lands, and redraw the cards.
      laterP.then(function (l) {
        var after = mergeLater(results, l);
        if (H && H.el.classList.contains('show')) cardsFor(after, res.say);
        var bad = after.filter(function (r, i) { return !r.ok && results[i].ok; });
        if (bad.length) tellLater(failSpeech(bad));
        else if (gated) tellLater(res.say || 'Done.', true);
        var notes2 = after.map(function (r) { return r.ok && r.note; }).filter(Boolean).join(' ');
        if (notes2) tellLater(notes2, true);
      });
    }
    if (!say) { setMode('wake'); newRecognizer(); return; }   // background talk: stay quiet
    speak(say, true);
  }
  // She said yes (or tapped it): run what was held, and report it like any other.
  function runHeld(pend) {
    setMode('thinking');
    var r = window._THV && window._THV.runActions ? window._THV.runActions(pend.actions) : { ok: false, results: [], later: Promise.resolve([]) };
    return report({ ok: true, results: r.results, later: r.later, say: pend.say }, pend.transcript);
  }
  function showConfirm(question) {
    var h = ensureHud(); if (!h) return;
    h.cards.innerHTML = '';
    var d = document.createElement('div'); d.className = 'vn-card vn-ask';
    d.innerHTML = '<i>?</i><b>CONFIRM</b><button type="button" data-a="1">YES</button><button type="button" data-a="0">NO</button>';
    d.querySelectorAll('button').forEach(function (btn) { btn.onclick = function () { confirmTap(btn.getAttribute('data-a') === '1'); }; });
    h.cards.appendChild(d);
  }
  function confirmTap(yes) {
    var p = S.pending; if (!p) return; S.pending = null;
    stopVoice();
    if (yes) runHeld(p); else { hudCards([]); speak('Very well. I\'ve left everything as it was.', true); }
  }

  // ══ voice: Ryan through Orca, the device's voice as fallback ═══════════════
  var orcaKey = '', orcaOk = null, orcaMod = null, keyP = null, lastVoice = '';
  function prefetchKey() {
    if (orcaKey || keyP) return keyP;
    try { var k = localStorage.getItem(ORCA_KEY_LS) || ''; if (/^orca_sk_[\w-]{8,}$/.test(k)) { orcaKey = k; return Promise.resolve(k); } } catch (e) {}
    keyP = Promise.resolve(window._fbLoadVedaOrcaKey ? window._fbLoadVedaOrcaKey() : '').then(function (k) { if (k) orcaKey = k; else orcaOk = false; keyP = null; return k; }).catch(function () { keyP = null; orcaOk = false; return ''; });
    return keyP;
  }
  function orca() {
    if (orcaMod) return Promise.resolve(orcaMod);
    return import(new URL('../Shruti/app/orca.js', SCRIPT_URL).href).then(function (m) { orcaMod = m; return m; });
  }
  var curAudio = null, speakingViaAudio = false, speakSeq = 0;
  function stopVoice() {
    speakSeq++;
    if (curAudio) { try { curAudio.pause(); } catch (e) {} try { URL.revokeObjectURL(curAudio.src); } catch (e) {} curAudio = null; }
    speakingViaAudio = false;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
  }

  var devVoice = null;
  if (window.speechSynthesis) { try { speechSynthesis.onvoiceschanged = function () { devVoice = null; }; } catch (e) {} }

  async function speak(text, thenFollow) {
    stopVoice();
    S.lastSaid = String(text || '');
    var seq = speakSeq;
    // The greeting keeps the boot look ("ONLINE"); an error keeps its fault look.
    var look = S.mode === 'boot' ? 'boot' : S.mode === 'error' ? null : 'speaking';
    if (S.running) { S.mode = 'speaking'; if (look) hudMode(look); emit(); }
    var spans = sayWords(text);
    var done = false;
    function after() {
      if (done || seq !== speakSeq) return; done = true;
      speakingViaAudio = false; lightTo(spans, spans.length);
      if (S.afterSay && S.running) { var more = S.afterSay; S.afterSay = ''; speak(more, thenFollow); return; }
      if (!S.running) { setTimeout(function () { if (!S.running) hudShow(false); }, 1600); return; }
      if (thenFollow) { S.deafUntil = Date.now() + DEAF_MS; S.followUntil = S.deafUntil + (/\?\s*$/.test(String(text || '')) ? ASK_MS : FOLLOW_MS); setMode('follow'); }
      else { setMode('wake'); newRecognizer(); }
    }
    // 1) Ryan, via Orca with her own key
    if (orcaOk !== false) {
      try {
        if (!orcaKey) await prefetchKey();
        if (seq !== speakSeq) return;
        if (orcaKey) {
          var mod = await orca();
          var ac = new AbortController(), to = setTimeout(function () { ac.abort(); }, 9000);
          var r = await mod.speak({ key: orcaKey, text: text, voice: VOICE, signal: ac.signal });
          clearTimeout(to);
          if (seq !== speakSeq) return;
          orcaOk = true; lastVoice = 'RYAN'; refreshTele();
          var el = new Audio(URL.createObjectURL(r.audio));
          curAudio = el;
          if (S.ctx && S.anOut && S.ctx.state !== 'closed') { try { S.ctx.createMediaElementSource(el).connect(S.anOut); speakingViaAudio = true; } catch (e) {} }
          var words = r.words || null;
          el.ontimeupdate = function () {
            var ct = el.currentTime, n = 0;
            if (words && words.length) { for (var i = 0; i < words.length; i++) if (words[i][0] <= ct) n = i + 1; n = Math.round(n * spans.length / words.length); }
            else n = Math.ceil(spans.length * ct / (el.duration || 1));
            lightTo(spans, n);
          };
          el.onended = after; el.onerror = after;
          await el.play();
          setTimeout(after, 4000 + String(text).split(/\s+/).length * 600);   // never left deaf
          return;
        }
      } catch (e) {
        if (seq !== speakSeq) return;
        if (e && e.code === 'key') orcaOk = false;
        console.warn('[neo] Orca voice unavailable, using the device voice', e && e.message);
      }
    }
    // 2) the device's own voice
    lastVoice = 'DEVICE'; refreshTele();
    if (!window.speechSynthesis) { lightTo(spans, spans.length); setTimeout(after, 1800); return; }
    try {
      var u = new SpeechSynthesisUtterance(text);
      if (!devVoice) devVoice = pickVoiceFrom(speechSynthesis.getVoices());
      if (devVoice) { u.voice = devVoice; u.lang = devVoice.lang; } else u.lang = 'en-GB';
      u.rate = 1.0; u.pitch = 0.95;
      var starts = []; String(text).replace(/\S+/g, function (m, i) { starts.push(i); return m; });
      u.onboundary = function (ev) { var n = 0; while (n < starts.length && starts[n] <= ev.charIndex) n++; lightTo(spans, n); };
      // Voices without boundary events still reveal, at a speaking pace.
      var w = 0, rev = setInterval(function () { if (done) return clearInterval(rev); w = Math.min(spans.length, w + 1); if (!spans[w - 1] || !spans[w - 1].classList.contains('lit')) lightTo(spans, w); }, 330);
      u.onend = function () { clearInterval(rev); after(); }; u.onerror = u.onend;
      speechSynthesis.speak(u);
      setTimeout(function () { clearInterval(rev); after(); }, 2500 + String(text).split(/\s+/).length * 450);
    } catch (e) { after(); }
  }

  // ══ opening and closing apps and sites on her PC ═══════════════════════════
  // The engine's open_pc_app / open_site / close_pc_app actions land here (through
  // Veda's bridge, _vdVoice.launchPc / closePc). One command's launches are
  // batched and handed to the StudyOS bridge in one go (window._sosBridgeLaunch,
  // which splits them into the bridge's 3-apps / 5-sites requests), the same path
  // AI prep and class ▶ use; closes go to its /api/close (window._sosBridgeClose).
  //
  // Each action answers at once with {ok:false, reason} when it can't even be
  // tried (no such app, not on her PC), or a promise of its own outcome once the
  // bridge has answered, so Neo reports each one truthfully.
  // "Her PC": the bridge answering is proof; a Windows browser is the fallback.
  function onPc() {
    if (window._vdBridgeUp === true) return true;
    return /Windows/i.test((navigator && navigator.userAgent) || '');
  }
  var BROWSERS = /^(brave|google chrome|chrome|microsoft edge|edge|firefox|mozilla firefox|opera|vivaldi)\b/i;
  var LQ = null;
  function queueLaunch(app, url) {
    if (!onPc()) {
      if (app) return { ok: false, reason: 'off_pc' };
      // A website needs no bridge: on her phone it opens in a new tab.
      var w = webUrl(url); if (!w) return { ok: false, reason: 'invalid' };
      var tab = null; try { tab = window.open(w, '_blank'); if (tab) tab.opener = null; } catch (e) { tab = null; }
      return tab ? true : { ok: false, reason: 'blocked', say: 'Your browser blocked the new tab, Veda. Allow pop-ups for this site and ask again.' };
    }
    var hit = null, u = '';
    if (app) { hit = matchApp(app, window._vdPcApps); if (!hit) return { ok: false, reason: 'not_found' }; }
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
    var go = window._sosBridgeLaunch;
    Promise.resolve(go ? go(ids, urls) : null).catch(function () { return null; }).then(function (res) {
      var down = res ? '' : launchIssue(null, [], window._vdBridgeErr, {});
      q.items.forEach(function (it) {
        if (!res) return it.done({ ok: false, reason: 'bridge_down', say: down });
        var key = it.app ? it.app.id : it.url, label = it.app ? it.app.name : it.url;
        var bad = (res.unknown || []).indexOf(key) >= 0 || (res.failed || []).indexOf(label) >= 0;
        it.done(bad ? { ok: false, reason: 'failed', say: label === it.url ? 'That site didn\'t open, I\'m afraid.' : label + ' didn\'t open, I\'m afraid.' } : true);
      });
    });
  }
  var CQ = null;
  function queueClose(app, force) {
    if (!onPc()) return { ok: false, reason: 'off_pc' };
    var hit = matchApp(app, window._vdPcApps); if (!hit) return { ok: false, reason: 'not_found' };
    if (!CQ) { CQ = { items: [] }; setTimeout(flushClose, 0); }
    return new Promise(function (res) { CQ.items.push({ app: hit, force: !!force, done: res }); });
  }
  // What to say about one app after /api/close: '' when it closed.
  function closeNote(name, res) {
    if (!res) return null;
    if ((res.closed || []).indexOf(name) >= 0) return '';
    if ((res.notRunning || []).indexOf(name) >= 0) return { ok: false, reason: 'not_running', say: name + ' wasn\'t running.' };
    if ((res.stillOpen || []).indexOf(name) >= 0) return { ok: false, reason: 'still_open', say: name + ' is asking to save, so I\'ve left it open. Say "force quit ' + name + '" if you\'re sure.' };
    return { ok: false, reason: 'failed', say: name + ' wouldn\'t close, I\'m afraid.' };
  }
  function flushClose() {
    var q = CQ; CQ = null; if (!q) return;
    // One request per kind: a force quit never rides along with a graceful close.
    [false, true].forEach(function (force) {
      var mine = q.items.filter(function (it) { return it.force === force; });
      if (!mine.length) return;
      var ids = [], browser = false;
      mine.forEach(function (it) { if (ids.indexOf(it.app.id) < 0) ids.push(it.app.id); if (BROWSERS.test(it.app.name)) browser = true; });
      var go = window._sosBridgeClose;
      Promise.resolve(go ? go(ids, force, browser) : null).catch(function () { return null; }).then(function (res) {
        var down = res ? '' : launchIssue(null, [], window._vdBridgeErr, {});
        mine.forEach(function (it) {
          if (!res) return it.done({ ok: false, reason: 'bridge_down', say: down });
          var n = closeNote(it.app.name, res);
          it.done(n === '' ? true : n);
        });
      });
    });
  }
  // "Close everything (but Spotify)": what is open now, less what she kept and
  // less any browser (TaskHub runs in one), closed gracefully.
  function closeAll(except, force) {
    if (!onPc()) return { ok: false, reason: 'off_pc' };
    var keep = (except || []).map(function (n) { return matchApp(n, window._vdPcApps); }).filter(Boolean).map(function (a) { return a.id; });
    var run = window._sosBridgeRunning, go = window._sosBridgeClose;
    if (!run || !go) return { ok: false, reason: 'no_bridge' };
    return Promise.resolve(run()).then(function (list) {
      if (!list) return { ok: false, reason: 'bridge_down', say: launchIssue(null, [], window._vdBridgeErr, {}) };
      var todo = list.filter(function (a) { return keep.indexOf(a.id) < 0 && !BROWSERS.test(a.name); });
      if (!todo.length) return { ok: true, say: 'There was nothing else open to close.' };
      return Promise.resolve(go(todo.map(function (a) { return a.id; }), !!force, false)).then(function (res) {
        if (!res) return { ok: false, reason: 'bridge_down', say: launchIssue(null, [], window._vdBridgeErr, {}) };
        var left = (res.stillOpen || []), bad = (res.failed || []);
        var line = (res.closed || []).length ? 'Closed ' + listWords(res.closed) + '.' : '';
        if (left.length) line += ' ' + listWords(left) + (left.length > 1 ? ' are' : ' is') + ' asking to save, so I\'ve left ' + (left.length > 1 ? 'them' : 'it') + ' open.';
        if (bad.length) line += ' ' + listWords(bad) + ' wouldn\'t close.';
        return (left.length || bad.length) ? { ok: false, reason: 'still_open', say: line.trim() } : { ok: true, say: line.trim() };
      });
    }).catch(function () { return { ok: false, reason: 'bridge_down', say: launchIssue(null, [], window._vdBridgeErr, {}) }; });
  }
  function listWords(a) { a = (a || []).slice(0, 6); return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  // Which of her apps are open: refreshed when she wakes Neo, read into state
  // (pcRunning) for "what's open?".
  function refreshRunning() {
    if (!onPc() || !window._sosBridgeRunning) return;
    var r = window._vdPcRunning;
    if (r && Date.now() - r.at < 20000) return;
    Promise.resolve(window._sosBridgeRunning()).then(function (list) {
      if (Array.isArray(list)) window._vdPcRunning = { at: Date.now(), names: list.map(function (a) { return a.name; }) };
    }).catch(function () {});
  }
  // Say something after the current reply (or now, if Neo is quiet).
  function tellLater(text, good) {
    if (!text) return;
    if (!good) sfx('error');
    if (S.running && (S.mode === 'thinking' || S.mode === 'speaking')) { S.afterSay = S.afterSay ? S.afterSay + ' ' + text : text; return; }
    if (S.running) speak(text, false); else hudNote(text, good ? 'note' : 'error', 5200);
  }
  // The bridge's /api/close and /api/running live here, not in index.html: AI prep
  // is the page's one sanctioned caller of the local bridge (tests/reels-widget.test.js).
  /* Neo ("close Spotify", "what's open?"): the bridge's /api/close and /api/running
   * (launcher.py). Same origin gate as /api/launch, ids from its own scan only.
   * Resolve to the bridge's answer, or null when it could not be reached. */
  window._sosBridgeCall = function(path, body, ms){
    if (!/Windows/i.test(navigator.userAgent || '')) return Promise.resolve(null);
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = ac ? setTimeout(function(){ ac.abort(); }, ms || 8000) : null;
    var opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'GET' };
    if (ac) opts.signal = ac.signal;
    return fetch('http://127.0.0.1:8781' + path, opts).then(function(r){ return r.json(); })
      .then(function(j){ if (t) clearTimeout(t); window._vdBridgeUp = !!(j && j.ok); return (j && j.ok) ? j : null; },
            function(){ if (t) clearTimeout(t); window._vdBridgeUp = false; return null; });
  };
  window._sosBridgeClose = function(appIds, force, browser){
    return window._sosBridgeCall('/api/close', { apps: (appIds || []).slice(0, 12), force: force === true, browser: browser === true }, 30000);
  };
  window._sosBridgeRunning = function(){
    return window._sosBridgeCall('/api/running', null, 20000).then(function(j){ return j ? (j.running || []) : null; });
  };
  window._vdNeoLaunch = queueLaunch;
  window._vdNeoClose = queueClose;
  window._vdNeoCloseAll = closeAll;

  // ══ the rest of her TaskHub, for Veda's bridge (_vdVoice) ══════════════════
  // Kept here, not in the App: none of it needs React state, and the App
  // re-binds its bridge on every render. Every entry answers true, a promise of
  // its outcome, or {ok:false, reason}. Veda-only by construction: Tony's bridge
  // never calls _vdNeoOps.
  function timeoutP(ms, v) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); }
  function escH(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Timer commands, one at a time: each waits for the panel to mount, runs, then
  // waits for the component to re-register its hook with the new state, so
  // "set 25 and start" starts 25 minutes, never the old length.
  var TQ = [], tBusy = false;
  function timerRun(cmd, arg) { return new Promise(function (res) { TQ.push({ cmd: cmd, arg: arg, res: res }); pump(); }); }
  function pump() {
    if (tBusy || !TQ.length) return;
    tBusy = true;
    var t0 = Date.now();
    (function wait() {
      var ex = window._vdTimerExec;
      if (ex) {
        var job = TQ.shift();
        try { ex(job.cmd, job.arg); job.res(true); } catch (e) { job.res(false); }
        var t1 = Date.now();
        (function fresh() { if (window._vdTimerExec !== ex || Date.now() - t1 > 400) { tBusy = false; pump(); } else setTimeout(fresh, 30); })();
        return;
      }
      if (Date.now() - t0 > 4000) { TQ.shift().res(false); tBusy = false; pump(); return; }
      setTimeout(wait, 50);
    })();
  }
  var LOCKS = { taskhub: 'veda_taskhub', gita: 'veda_gita', notebook: 'veda_journal', journal: 'veda_journal', rules: 'veda_rules', shield: 'veda_shield' };
  function normWords(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
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
    // Plans live in her TaskHub, so they keep its lock.
    var G = window.Guardian;
    if (!window.alGate || !G || !G.mustBlock || !G.mustBlock('veda_taskhub')) return fn();
    var p = new Promise(function (res) { window.alGate('veda_taskhub', function () { res(fn()); }, function () { res({ ok: false, reason: 'locked' }); }); setTimeout(function () { res({ ok: false, reason: 'locked' }); }, 120000); });
    p.gated = true; return p;
  }
  var NEO_OPS = {
    onPc: onPc,
    timer: timerRun,
    // A kit, or null. A task whose kit is already being built waits for that one.
    prep: function (item, dk) {
      if (!window._vdPrepRequest) return Promise.resolve(null);
      if (!(window._vdPrepBusy || {})[item.id]) return window._vdPrepRequest(item, dk);
      var t0 = Date.now();
      return new Promise(function (res) {
        (function wait() {
          if (!(window._vdPrepBusy || {})[item.id]) return res((window._vdPrepKits || {})[item.id] || null);
          if (Date.now() - t0 > 90000) return res(null);
          setTimeout(wait, 500);
        })();
      });
    },
    lockApp: function (t) {
      var id = LOCKS[t], G = window.Guardian;
      if (!id || !G || !G.lockNow) return { ok: false, reason: 'invalid' };
      var st = null; try { st = G.status(id); } catch (e) {}
      if (!st || !st.hasLock) return { ok: false, reason: 'no_lock' };
      G.lockNow(id); return true;
    },
    openLink: function (label) {
      var links = (window._navGetLinks ? window._navGetLinks('veda') : []) || [];
      var hit = findByName(links, label, 'label');
      if (hit && window._navOpenLink) { window._navOpenLink('veda', hit.id); return true; }
      // Warden is her links page: it replaces this page, so Neo finishes speaking first.
      if (/^(warden|links?|my links)$/i.test(String(label || '').trim()) && window._gotoWarden) { setTimeout(window._gotoWarden, 2600); return true; }
      return { ok: false, reason: 'not_found' };
    },
    // A new page in V's Notebook, through Notebook's public API only.
    journalEntry: function (text, title) {
      if (!text) return { ok: false, reason: 'invalid' };
      var NB = window.Notebook; if (!NB || !NB.putPage) return { ok: false, reason: 'no_bridge' };
      var d = new Date();
      var page = { id: 'neo' + d.getTime().toString(36), title: String(title || '').trim() || ('Note · ' + d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })),
        data: { html: String(text).split(/\n+/).map(function (p) { return '<p>' + escH(p) + '</p>'; }).join('') }, tags: [], folder: null };
      return Promise.race([NB.putPage('bj', page).then(function (p) { return p ? true : { ok: false, reason: 'failed' }; }), timeoutP(10000, { ok: false, reason: 'journal_not_ready' })])
        .catch(function () { return { ok: false, reason: 'journal_not_ready' }; });
    },
    // StudyOS classes on her calendar → the class ▶ path (apps and sites via the bridge).
    startClass: function (name, data) {
      var seen = {}, list = [];
      Object.keys(data || {}).forEach(function (k) { (data[k] || []).forEach(function (t) { if (t && t._sosClassId && t._sosClassName && !seen[t._sosClassId]) { seen[t._sosClassId] = 1; list.push({ id: t._sosClassId, name: t._sosClassName }); } }); });
      var hit = findByName(list, name, 'name'); if (!hit) return { ok: false, reason: 'not_found' };
      if (!window._sosLaunchClassClick) return { ok: false, reason: 'no_bridge' };
      window._sosLaunchClassClick(hit.id, hit.name); return true;
    },
    // Plans shared with Tony: only through PlansCore, only as Veda (PlansCore acts
    // as the active profile), and inside the TaskHub lock.
    plan: function (op, a) {
      var PC = window.PlansCore;
      if (!PC || window._activeProfile !== 'veda') return { ok: false, reason: 'no_bridge' };
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
          if (q.confirms && q.confirms.veda) return { ok: false, reason: 'already' };
          return Promise.resolve(PC.confirmPlan(q.id)).then(function (v) { return v === 'ok' ? (q.date ? true : { ok: true, say: 'Do note it has no date yet.' }) : v; });
        }
        if (op === 'decline') { if (q.stage !== 'proposed') return { ok: false, reason: 'not_waiting' }; PC.declinePlan(q.id, String(a.reason || '')); return true; }
        if (op === 'cancel_request') { if (q.stage !== 'confirmed') return { ok: false, reason: 'not_confirmed' }; PC.requestCancel(q.id, String(a.reason || '')); return true; }
        if (op === 'done') { if (q.stage !== 'confirmed') return { ok: false, reason: 'not_confirmed' }; PC.markDone(q.id); return true; }
        return { ok: false, reason: 'invalid' };
      });
    },
    // What Neo may be asked about beyond tasks. Small, and nothing it can't say aloud.
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
      try { out.links = ((window._navGetLinks ? window._navGetLinks('veda') : []) || []).map(function (l) { return l.label; }).filter(Boolean).slice(0, 30); } catch (e) {}
      try {
        out.marketCal = ((extra && extra.marketCal) || []).filter(function (e) { return e && e.date >= today && e.date <= soon; }).slice(0, 40)
          .map(function (e) { var o = { date: e.date, title: e.title, kind: e.kind }; if (e.when) o.when = e.when; return o; });
      } catch (e) {}
      try {
        var cls = {}; Object.keys(base.data || {}).forEach(function (k) { (base.data[k] || []).forEach(function (t) { if (t && t._sosClassName) cls[t._sosClassName] = 1; }); });
        out.classes = Object.keys(cls).slice(0, 20);
      } catch (e) {}
      try {
        var kits = window._vdPrepKits || {}, tm = dkey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
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
      var pr = window._vdPcRunning;
      if (pr && Date.now() - pr.at < 120000) out.pcRunning = pr.names.slice(0, 60);
      return out;
    },
  };
  window._vdNeoOps = NEO_OPS;

  function cancel() {
    S.pending = null;
    stopVoice();
    stopCaptions();
    if (S.running) { S.chunks = []; S.vad = null; setMode('wake'); newRecognizer(); }
    hudShow(false);
  }

  // ══ on / off + watcher ═════════════════════════════════════════════════════
  function setOn(on) {
    on = !!on;
    var was = S.on;
    S.on = on;
    try { on ? localStorage.setItem(PREF_KEY, '1') : localStorage.removeItem(PREF_KEY); } catch (e) {}
    if (on) {
      // A user tap primes speech on iOS/Android, which refuse to speak otherwise.
      try { if (window.speechSynthesis) { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
      if (!was) S.greet = true;
      sync();
    } else {
      teardown();
      hudShow(false);
    }
    emit();
  }
  function shouldRun() { return S.on && isVeda() && !document.hidden; }
  function sync() {
    if (shouldRun()) { if (!S.running) start(); }
    else if (S.running || S.starting) teardown();
  }
  document.addEventListener('visibilitychange', sync);
  setInterval(sync, 1000);   // profile switches (Veda ⇄ Tony ⇄ picker) have no event
  try { ensureStyles(); } catch (e) {}

  window._vdNeo = {
    isOn: function () { return S.on; },
    setOn: setOn,
    toggle: function () { setOn(!S.on); },
    mode: function () { return S.mode; },
    cancel: cancel,
    _test: { fixCaption: fixCaption, tidyText: tidyText, skel: skel, isWake: isWake, vadStep: vadStep, threshold: threshold, encodeWav: encodeWav, rms: rms, GRAMMAR: GRAMMAR, MODEL_URL: MODEL_URL, VOICE: VOICE,
      cardFor: cardFor, failCard: failCard, failLine: failLine, failSpeech: failSpeech, compose: compose, needsConfirm: needsConfirm, guardTurn: guardTurn, overlap: overlap, isReplay: isReplay, isYes: isYes, isNo: isNo,
      mergeLater: mergeLater, queueClose: queueClose, closeNote: closeNote, closeAll: closeAll, timerRun: timerRun, ops: NEO_OPS, onPc: onPc,
      greeting: greeting, matchApp: matchApp, webUrl: webUrl, launchIssue: launchIssue, queueLaunch: queueLaunch, dayStats: dayStats, pickVoiceFrom: pickVoiceFrom, spokenTime: spokenTime, sync: sync, state: S },
  };
})();

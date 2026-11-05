/* ════════════════════════════════════════════════════════════════════════════
   Neo — Veda's hands-free TaskHub assistant.  Docs: docs/TaskHub/neo-assistant.md

   VEDA ONLY. Nothing here runs unless window._activeProfile === 'veda'; on
   Tony's TaskHub (or the profile picker) the mic is released and Neo sleeps.

   Pipeline (all free):
     mic ─► Vosk (on-device, WASM; fixed word list) hears "Neo" / "Hey Neo"
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

  // Words Vosk may choose between. Only "neo" wakes; the near-sounding decoys
  // give similar speech somewhere else to land, so "new"/"no"/"video" don't
  // fire it. Every word here is in the small model's vocabulary.
  var GRAMMAR = ['neo', 'hey neo', 'okay neo', 'new', 'no', 'know', 'now', 'leo', 'neon', 'nemo', 'knee', 'video', 'oh', 'hey', '[unk]'];

  var PRE_ROLL_S = 1.5;      // audio kept from before the wake word fired
  var END_SILENCE_MS = 1400; // she stopped talking
  var NO_SPEECH_MS = 6000;   // woke but nothing followed
  var MAX_CAPTURE_MS = 30000;
  var FOLLOW_MS = 6000;      // after a reply: listen without the wake word

  // ══ pure helpers (tested in tests/veda-assistant.test.js) ══════════════════
  function isWake(text) {
    var w = String(text || '').toLowerCase().split(/\s+/).filter(function (t) { return t && t !== '[unk]'; });
    return w.indexOf('neo') >= 0;
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
    }
    return null;
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
    floor: 0.006, greet: false, level: 0,
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
  function hudShow(on) {
    var h = ensureHud(); if (!h) return;
    clearTimeout(hideTimer);
    if (on) { if (!h.el.classList.contains('show')) { h.el.classList.add('show'); refreshTele(); startAnim(); } }
    else { h.el.classList.remove('show'); }
  }
  function hudMode(m) {
    var h = ensureHud(); if (!h) return;
    ['loading', 'boot', 'capture', 'thinking', 'speaking', 'follow', 'error', 'note'].forEach(function (k) { h.el.classList.toggle('m-' + k, k === m); });
    if (LABEL[m]) {
      if (h.state.textContent !== LABEL[m]) { h.state.textContent = LABEL[m]; h.state.classList.remove('vn-glitch'); void h.state.offsetWidth; if (!reduced) h.state.classList.add('vn-glitch'); }
      hudShow(true);
    }
    if (m === 'capture') { h.you.textContent = ''; h.say.innerHTML = ''; h.cards.innerHTML = ''; }
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
    (actions || []).map(cardFor).filter(Boolean).slice(0, 6).forEach(function (c, i) {
      var d = document.createElement('div'); d.className = 'vn-card'; d.style.animationDelay = (i * 90) + 'ms';
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

  // ── the arc-reactor orb ─────────────────────────────────────────────────────
  var now0 = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };
  var raf = 0, bins = new Uint8Array(64), smooth = new Float32Array(64), t0 = now0();
  function startAnim() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    var h = H; if (!h || !h.el.classList.contains('show')) return;
    var cv = h.canvas, dpr = Math.min(2, window.devicePixelRatio || 1), size = cv.clientWidth || 150;
    if (cv.width !== Math.round(size * dpr)) { cv.width = cv.height = Math.round(size * dpr); }
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
  // Live captions: a free-form recognizer that only lives for one capture.
  function startCaptions() {
    stopCaptions();
    if (!S.model) return;
    var done = '';
    var strip = function (s) { return String(s || '').replace(/^\s*(hey |okay )?neo\b[,.]?\s*/i, ''); };
    try {
      var r = new S.model.KaldiRecognizer(S.sr);
      r.on('partialresult', function (m) { if (S.mode === 'capture' && H && m.result) H.you.textContent = strip((done + ' ' + (m.result.partial || '')).trim()); });
      r.on('result', function (m) { if (m.result && m.result.text) { done = (done + ' ' + m.result.text).trim(); if (S.mode === 'capture' && H) H.you.textContent = strip(done); } });
      S.cap = r;
    } catch (e) { S.cap = null; }
  }
  function stopCaptions() { if (S.cap) { try { S.cap.remove(); } catch (e) {} S.cap = null; } }

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
      if (level > threshold(S.floor) * 1.3) beginCapture(0.6, true);
      else if (Date.now() > S.followUntil) { setMode('wake'); newRecognizer(); }
    }
  }

  function onWake() {
    if (S.mode !== 'wake') return;
    if (window._THV && window._THV.isBusy && window._THV.isBusy()) return;
    sfx('wake');
    beginCapture(PRE_ROLL_S, false);
  }
  function beginCapture(preSec, alreadySpeaking) {
    var keep = Math.floor(preSec * S.sr), pre = [], n = 0;
    for (var i = S.ring.length - 1; i >= 0 && n < keep; i--) { pre.unshift(S.ring[i]); n += S.ring[i].length; }
    S.chunks = pre;
    S.vad = { speech: !!alreadySpeaking, silentMs: 0, elapsedMs: 0 };
    setMode('capture');
    startCaptions();
    if (S.cap) pre.forEach(function (c) { try { S.cap.acceptWaveformFloat(c, S.sr); } catch (e) {} });
  }

  async function finishCapture() {
    var buffers = S.chunks; S.chunks = []; S.vad = null;
    stopCaptions();
    setMode('thinking'); sfx('think');
    var res = null;
    try {
      if (!window._THV || !window._THV.sendAudio) throw new Error('TaskHub voice is not ready');
      var wav = encodeWav(buffers, S.sr, 16000);
      res = await window._THV.sendAudio(b64(wav), { extra: { mode: 'neo' } });
    } catch (e) { console.warn('[neo]', e); res = { ok: false, error: 'network' }; }
    if (res && res.transcript && H) H.you.textContent = res.transcript;
    if (res && res.ok) {
      var acts = res.actions || [];
      if (acts.length) hudCards(acts);
      else if (res.say && H) H.cards.innerHTML = '<div class="vn-card"><i>≡</i><b>BRIEFING</b></div>';   // a question, answered
      if (res.n) sfx('done');
    }
    if (!S.running) { if (res && res.say) speak(res.say, false); return; }   // turned off mid-request ("stop listening")
    var say = '';
    if (res && res.ok) say = res.say || (res.n ? 'Done.' : '');
    else {
      sfx('error'); hudMode('error');
      say = res && /network/i.test(res.error || '') ? 'My apologies, Veda. The connection seems to be down.' : 'My apologies. I couldn\'t manage that one. Do try again.';
    }
    if (!say) { setMode('wake'); newRecognizer(); return; }   // background talk: stay quiet
    refreshTele();
    speak(say, true);
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
    var seq = speakSeq;
    // The greeting keeps the boot look ("ONLINE"); an error keeps its fault look.
    var look = S.mode === 'boot' ? 'boot' : S.mode === 'error' ? null : 'speaking';
    if (S.running) { S.mode = 'speaking'; if (look) hudMode(look); emit(); }
    var spans = sayWords(text);
    var done = false;
    function after() {
      if (done || seq !== speakSeq) return; done = true;
      speakingViaAudio = false; lightTo(spans, spans.length);
      if (!S.running) { setTimeout(function () { if (!S.running) hudShow(false); }, 1600); return; }
      if (thenFollow) { S.followUntil = Date.now() + FOLLOW_MS; setMode('follow'); }
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

  function cancel() {
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
    _test: { isWake: isWake, vadStep: vadStep, threshold: threshold, encodeWav: encodeWav, rms: rms, GRAMMAR: GRAMMAR, MODEL_URL: MODEL_URL, VOICE: VOICE,
      cardFor: cardFor, greeting: greeting, dayStats: dayStats, pickVoiceFrom: pickVoiceFrom, spokenTime: spokenTime, sync: sync, state: S },
  };
})();

/* ════════════════════════════════════════════════════════════════════════════
   Neo — Veda's hands-free TaskHub assistant.  Docs: docs/TaskHub/neo-assistant.md

   VEDA ONLY. Nothing here runs unless window._activeProfile === 'veda'; on
   Tony's TaskHub (or the profile picker) the mic is released and Neo sleeps.

   Pipeline (all free):
     mic ─► Vosk (on-device, WASM; fixed word list) hears "Neo" / "Hey Neo"
         ─► record until she stops talking (loudness end-point, with a 1.5 s
            pre-roll so "Neo, add milk" in one breath keeps its first words)
         ─► window._THV.sendAudio()  — the SAME engine and Gemini route as the
            mic button (personal-ai /taskhub/parse, Veda's own key), so every
            action it can do, Neo can do
         ─► speechSynthesis reads back the reply, then a short follow-up window
            listens without the wake word.

   Brave blocks the browser's built-in SpeechRecognition, which is why the wake
   word runs in Vosk instead. Vosk keeps its model in IndexedDB (keyed by the
   model URL) so the ~41 MB download happens once per device.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window._vdNeo) return;

  var VOSK_SRC = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';
  var MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
  var PREF_KEY = 'vd_neo_on';
  var ACCENT = '#8D769A';

  // Words Vosk may choose between. Only "neo" wakes; the near-sounding decoys
  // give similar speech somewhere else to land, so "new"/"no"/"video" don't
  // fire it. Every word here is in the small model's vocabulary.
  var GRAMMAR = ['neo', 'hey neo', 'okay neo', 'new', 'no', 'know', 'now', 'leo', 'neon', 'nemo', 'knee', 'video', 'oh', 'hey', '[unk]'];

  var PRE_ROLL_S = 1.5;     // audio kept from before the wake word fired
  var END_SILENCE_MS = 1400; // she stopped talking
  var NO_SPEECH_MS = 6000;  // woke but nothing followed
  var MAX_CAPTURE_MS = 30000;
  var FOLLOW_MS = 6000;     // after a reply: listen without the wake word

  // ── pure helpers (tested in tests/veda-assistant.test.js) ─────────────────
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

  // ── state ─────────────────────────────────────────────────────────────────
  var S = {
    on: false, running: false, starting: false,
    mode: 'off',            // off | loading | wake | capture | thinking | speaking | follow
    stream: null, ctx: null, src: null, proc: null, sr: 48000,
    model: null, rec: null,
    ring: [], ringLen: 0,
    cap: [], vad: null, followUntil: 0,
    floor: 0.006,
  };
  try { S.on = localStorage.getItem(PREF_KEY) === '1'; } catch (e) {}

  function isVeda() { return window._activeProfile === 'veda'; }
  function emit() { try { window.dispatchEvent(new CustomEvent('vd-neo-change', { detail: { on: S.on, mode: S.mode } })); } catch (e) {} }
  function setMode(m) { S.mode = m; pill(m); emit(); }

  // ── status pill ───────────────────────────────────────────────────────────
  var pillEl = null, pillTimer = null;
  function ensurePill() {
    if (pillEl || !document.body) return pillEl;
    var st = document.createElement('style');
    st.textContent =
      '#vd-neo-pill{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom,0px));transform:translate(-50%,16px);' +
      'z-index:100000;display:flex;align-items:center;gap:10px;padding:9px 16px;border-radius:999px;' +
      'background:#232327;color:#f4f3f0;border:1px solid ' + ACCENT + ';box-shadow:0 0 0 1px rgba(141,118,154,.42),0 0 14px rgba(141,118,154,.42);' +
      'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;max-width:min(560px,calc(100vw - 32px));opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;}' +
      '#vd-neo-pill.show{opacity:1;transform:translate(-50%,0);pointer-events:auto;}' +
      '#vd-neo-pill .vdn-dot{width:10px;height:10px;border-radius:50%;background:' + ACCENT + ';flex-shrink:0;}' +
      '#vd-neo-pill.capture .vdn-dot{background:#c0564a;animation:vdnPulse 1s ease-in-out infinite;}' +
      '#vd-neo-pill.thinking .vdn-dot{animation:vdnPulse .6s ease-in-out infinite;}' +
      '#vd-neo-pill .vdn-t{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}' +
      '#vd-neo-pill button{background:none;border:none;color:#8a8a98;font-size:15px;cursor:pointer;padding:0 0 0 4px;line-height:1;}' +
      '@keyframes vdnPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.6}}';
    document.head.appendChild(st);
    pillEl = document.createElement('div');
    pillEl.id = 'vd-neo-pill';
    pillEl.setAttribute('role', 'status');
    pillEl.innerHTML = '<span class="vdn-dot"></span><span class="vdn-t"></span><button type="button" aria-label="Cancel" title="Cancel">✕</button>';
    pillEl.querySelector('button').onclick = function () { cancel(); };
    document.body.appendChild(pillEl);
    return pillEl;
  }
  function pill(mode, text, holdMs) {
    var el = ensurePill(); if (!el) return;
    clearTimeout(pillTimer);
    var label = text || { loading: 'Neo is getting ready…', capture: 'Listening…', thinking: 'Thinking…', follow: 'Anything else?' }[mode];
    if (!label) { el.className = ''; return; }
    el.className = 'show ' + mode;
    el.querySelector('.vdn-t').textContent = label;
    if (holdMs) pillTimer = setTimeout(function () { if (S.mode === 'wake' || S.mode === 'off') el.className = ''; }, holdMs);
  }
  function note(text, ms) { pill('note', text, ms || 3200); }

  // ── loading Vosk ──────────────────────────────────────────────────────────
  var voskP = null;
  function loadVosk() {
    if (window.Vosk) return Promise.resolve(window.Vosk);
    if (voskP) return voskP;
    voskP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = VOSK_SRC; s.async = true;
      s.onload = function () { window.Vosk ? res(window.Vosk) : rej(new Error('Vosk missing')); };
      s.onerror = function () { voskP = null; rej(new Error('Could not load the wake-word engine')); };
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

  // ── mic ───────────────────────────────────────────────────────────────────
  async function openMic() {
    var base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    var dev = ''; try { dev = localStorage.getItem('thv_mic_device') || ''; } catch (e) {}
    if (dev) { try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: dev } }, base) }); } catch (e) {} }
    return await navigator.mediaDevices.getUserMedia({ audio: base });
  }

  async function start() {
    if (S.running || S.starting) return;
    S.starting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser has no microphone access');
      var stream;
      try { stream = await openMic(); } catch (e) { throw new Error('Neo needs the microphone. Allow it for this site, then turn Neo on again.'); }
      if (!S.on || !isVeda()) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
      S.stream = stream; S.ctx = ctx; S.sr = ctx.sampleRate;
      if (!S.model) setMode('loading');
      await loadModel();
      if (!S.on || !isVeda() || S.ctx !== ctx) return;
      newRecognizer();
      S.src = ctx.createMediaStreamSource(stream);
      S.proc = ctx.createScriptProcessor(4096, 1, 1);
      S.proc.onaudioprocess = onAudio;
      S.src.connect(S.proc); S.proc.connect(ctx.destination);
      S.ring = []; S.ringLen = 0;
      S.running = true;
      setMode('wake');
      if (pillEl && /loading/.test(pillEl.className)) note('Neo is listening — say "Neo".', 2600);
    } catch (e) {
      console.warn('[neo]', e);
      teardown();
      setOn(false);
      note((e && e.message) || 'Neo could not start', 5200);
    } finally { S.starting = false; }
  }

  function teardown() {
    S.running = false;
    try { S.proc && (S.proc.onaudioprocess = null); S.proc && S.proc.disconnect(); S.src && S.src.disconnect(); } catch (e) {}
    try { S.stream && S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { S.ctx && S.ctx.close(); } catch (e) {}
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
    if (S.rec) { try { S.rec.remove(); } catch (e) {} S.rec = null; }
    S.proc = S.src = S.stream = S.ctx = null;
    S.ring = []; S.cap = []; S.vad = null;
    if (S.mode !== 'off') setMode('off');
  }

  // ── audio loop ────────────────────────────────────────────────────────────
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
      S.cap.push(chunk);
      var r = vadStep(S.vad, level, S.floor, ms);
      if (r === 'end') finishCapture();
      else if (r === 'none') { setMode('wake'); newRecognizer(); note("I didn't hear anything.", 2200); }
    } else if (S.mode === 'follow') {
      if (level > threshold(S.floor) * 1.3) beginCapture(0.6, true);
      else if (Date.now() > S.followUntil) { setMode('wake'); newRecognizer(); }
    }
  }

  function chime() {
    var ctx = S.ctx; if (!ctx) return;
    try {
      var t = ctx.currentTime, g = ctx.createGain(), o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(880, t + 0.09);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.24);
    } catch (e) {}
  }

  function onWake() {
    if (S.mode !== 'wake') return;
    if (window._THV && window._THV.isBusy && window._THV.isBusy()) return;
    chime();
    beginCapture(PRE_ROLL_S, false);
  }
  function beginCapture(preSec, alreadySpeaking) {
    var keep = Math.floor(preSec * S.sr), pre = [], n = 0;
    for (var i = S.ring.length - 1; i >= 0 && n < keep; i--) { pre.unshift(S.ring[i]); n += S.ring[i].length; }
    S.cap = pre;
    S.vad = { speech: !!alreadySpeaking, silentMs: 0, elapsedMs: 0 };
    setMode('capture');
  }

  async function finishCapture() {
    var buffers = S.cap; S.cap = []; S.vad = null;
    setMode('thinking');
    var res = null;
    try {
      if (!window._THV || !window._THV.sendAudio) throw new Error('TaskHub voice is not ready');
      var wav = encodeWav(buffers, S.sr, 16000);
      res = await window._THV.sendAudio(b64(wav), { extra: { mode: 'neo' } });
    } catch (e) { console.warn('[neo]', e); res = { ok: false, error: 'network' }; }
    if (!S.running) { if (res && res.say) speak(res.say); return; }   // turned off mid-request ("stop listening")
    var say = '';
    if (res && res.ok) say = res.say || (res.n ? 'Done.' : '');
    else say = "Sorry, I couldn't do that. " + (res && /network/i.test(res.error || '') ? 'Check the connection.' : 'Try again.');
    if (!say) { setMode('wake'); newRecognizer(); return; }   // background talk: stay quiet
    speak(say, true);
  }

  // ── speaking ──────────────────────────────────────────────────────────────
  var voice = null;
  function pickVoice() {
    if (voice || !window.speechSynthesis) return voice;
    var vs = speechSynthesis.getVoices() || [];
    var prefs = ['Microsoft Aria Online', 'Microsoft Jenny Online', 'Google US English', 'Samantha', 'Microsoft Zira', 'Karen', 'Moira'];
    for (var i = 0; i < prefs.length && !voice; i++) voice = vs.find(function (v) { return v.name.indexOf(prefs[i]) === 0; }) || null;
    if (!voice) voice = vs.find(function (v) { return /^en(-|_)US/i.test(v.lang); }) || vs.find(function (v) { return /^en/i.test(v.lang); }) || null;
    return voice;
  }
  if (window.speechSynthesis) { try { speechSynthesis.onvoiceschanged = function () { voice = null; pickVoice(); }; } catch (e) {} }

  function speak(text, thenFollow) {
    if (S.running) { S.mode = 'speaking'; emit(); }
    pill('speaking', text);
    var done = false;
    function after() {
      if (done) return; done = true;
      if (!S.running) { pill('off'); return; }
      if (thenFollow) { S.followUntil = Date.now() + FOLLOW_MS; setMode('follow'); }
      else { setMode('wake'); newRecognizer(); }
    }
    if (!window.speechSynthesis) { setTimeout(after, 1800); return; }
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      u.rate = 1.03; u.pitch = 1;
      u.onend = after; u.onerror = after;
      speechSynthesis.speak(u);
      // Chrome sometimes never fires onend; don't leave Neo deaf.
      setTimeout(after, 2500 + String(text).split(/\s+/).length * 420);
    } catch (e) { after(); }
  }

  function cancel() {
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
    if (S.running) { S.cap = []; S.vad = null; setMode('wake'); newRecognizer(); }
    pill('off');
  }

  // ── on / off + watcher ────────────────────────────────────────────────────
  function setOn(on) {
    on = !!on;
    S.on = on;
    try { on ? localStorage.setItem(PREF_KEY, '1') : localStorage.removeItem(PREF_KEY); } catch (e) {}
    if (on) {
      // A user tap primes speech on iOS/Android, which refuse to speak otherwise.
      try { if (window.speechSynthesis) { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
      sync();
    } else {
      teardown();
      pill('off');
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

  window._vdNeo = {
    isOn: function () { return S.on; },
    setOn: setOn,
    toggle: function () { setOn(!S.on); },
    mode: function () { return S.mode; },
    cancel: cancel,
    _test: { isWake: isWake, vadStep: vadStep, threshold: threshold, encodeWav: encodeWav, rms: rms, GRAMMAR: GRAMMAR, MODEL_URL: MODEL_URL, sync: sync, state: S },
  };
})();

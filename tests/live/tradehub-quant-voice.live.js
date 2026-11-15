// TradeHub Quant, Phase 10: Neo Quant's voice in the real page (A1-Priv
// tradehub.html + TradeHub/neo/voice.js), with Chrome's fake microphone playing
// a WAV of "Is Nvidia a buy here?" (System.Speech) and quant-api + ORCA played
// by quant-mock.js.
//
//   1. nothing is asked of the microphone, quant-api's hearing or ORCA's voice before a press
//   2. Talk on every tab at 1280, 820 and 390: the mic button (the composer's on the Neo
//      Quant tab) records, the pink dot shows, silence sends the clip to /ai/hear (opus),
//      the question is asked, the answer is spoken (ORCA /v1/audio/speech, Sonia, worded
//      for the ear, citations gone), words light up, and the mic track is stopped after
//   3. hands-free: two turns, then it stops on its own and releases the mic
//   4. the hearing chain failing: a clear note, the typed path still answers
//   5. Control ▸ Neo Quant voice: a voice picked and the speed changed → ONE write to
//      dashboards/tradehub_neo, 1.5 s later; nothing written while nothing changes
//   6. "Hey Neo" stays off: Vosk is never loaded; no uncaught error
//
// Windows only (the WAV comes from System.Speech). Run: node tests/live/tradehub-quant-voice.live.js
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const WAV = path.join(os.tmpdir(), 'tradehub-voice-live-nvda.wav');
if (!fs.existsSync(WAV)) {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $syn=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    `$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);` +
    `$syn.SetOutputToWaveFile('${WAV}',$fmt);` +
    `$syn.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><break time="1s"/>Is Nvidia a buy here?<break time="7s"/></speak>');$syn.Dispose()`]);
}
process.env.CDP_PORT = process.env.CDP_PORT || '9351';
process.env.CDP_EXTRA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture=' + WAV, '--autoplay-policy=no-user-gesture-required'].join('\n');

const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const untilNode = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(100); } return !!f(); };

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  // Every microphone stream the page opens is kept here, so the test can see its tracks stopped.
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__streams=[]; window.__gum=[]; (function(){ var md=navigator.mediaDevices; if(!md||!md.getUserMedia) return; var g=md.getUserMedia.bind(md); md.getUserMedia=function(cn){ window.__gum.push(cn); return g(cn).then(function(s){ window.__streams.push(s); return s; }); }; })();` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, shot } = driver(c);
  const hear = () => api.posted.hear || [];
  const ai = () => api.posted.ai || [];
  const speech = () => (api.posted.orca || []).filter((x) => x.p === '/v1/audio/speech').map((x) => JSON.parse(x.body || '{}'));
  const micLive = () => js(`return window.__streams.some(function(s){ return s.getTracks().some(function(t){ return t.readyState === 'live'; }); });`);
  const mode = () => js(`var m=document.querySelector('[data-nq-mic]')||document.querySelector('[data-nq-talk]'); return m ? m.dataset.mode || 'off' : 'none';`);
  const goTab = async (id) => js(`(function(){ var vis=function(b){ return b.offsetParent; }; var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(vis); if(!t){ var bg=document.querySelector('.tb-mtop-burger'); if(bg) bg.click(); } return 1; })()`).then(() => sleep(250)).then(() => js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(function(b){return b.offsetParent;}); if(t) t.click(); return !!t;`)).then(async (r) => { await sleep(450); return r; });

  /** One spoken turn from the button `sel`: → what happened. */
  async function turn(sel, label) {
    const h0 = hear().length, a0 = ai().length, s0 = speech().length;
    await js(`[...document.querySelectorAll('${sel}')].find(function(b){ return b.getClientRects().length; }).click(); 1`);
    const listening = await until(`[...document.querySelectorAll('[data-nq-micon],[data-nq-micdot]')].some(function(d){ return !d.hidden && d.getClientRects().length; })`, 4000);
    const heardOk = await untilNode(() => hear().length > h0, 16000);
    const asked = await untilNode(() => ai().length > a0, 8000);
    const spoke = await untilNode(() => speech().length > s0, 8000);
    const back = await until(`(function(){ var m=document.querySelector('[data-nq-mic]'); return !m || (m.dataset.mode||'off')==='off'; })()`, 12000);
    await sleep(200);
    const live = await micLive();
    const clip = hear()[h0] || {}, q = ai()[a0] && ai()[a0].body, said = speech().slice(s0);
    ok(`${label}: records (pink dot), the clip goes to /ai/hear as opus, the question is asked, the answer spoken, the mic released`,
      listening && heardOk && /webm|ogg/.test(clip.mime || '') && clip.bytes > 1500 && asked && q && q.messages[q.messages.length - 1].content === 'Is NVDA a buy here?' && spoke && back && !live,
      JSON.stringify({ listening, heardOk, clip, asked, spoke, back, live }));
    return { clip, said };
  }

  console.log('\nNothing before a press');
  await size(1280, 900);
  await boot({ quant: true });
  await goTab('market');
  ok('the mic button is there beside the Halo launcher', await until(`document.querySelector('[data-nq-mic]') && !document.querySelector('[data-nq-mic]').hidden`, 15000));
  ok('no microphone, no hearing, no voice asked for before a press', (await js(`return window.__gum.length;`)) === 0 && hear().length === 0 && speech().length === 0);

  console.log('\nTalk');
  const first = await turn('[data-nq-mic]', '1280 Market');
  ok('...the clip carried the watchlist (the transcriber\'s hint)', Array.isArray(first.clip.watchlist) && first.clip.watchlist.includes('NVDA'));
  ok('...the mic asked for echo cancellation, noise suppression and auto gain', await js(`var a=window.__gum[0].audio; return !!(a.echoCancellation && a.noiseSuppression && a.autoGainControl);`));
  const s1 = first.said;
  ok('...spoken in Sonia\'s voice (the default), with word timings, worded for the ear: no citations, Nvidia named', s1.length >= 2 && s1.every((b) => b.voice === 'en-GB-SoniaNeural' && b.timestamps === true && !/\[F\d/.test(b.input)) && s1.some((b) => /Nvidia|watch/i.test(b.input)), JSON.stringify(s1.map((b) => b.input)));
  ok('...at most the brief: no more than 45 words in all', s1.map((b) => b.input).join(' ').split(/\s+/).length <= 45 + 10);
  const answered = await js(`var d=document.querySelector('[data-nq-dock]'), a=[...document.querySelectorAll('[data-nq-dock] [data-nq-a]')].pop(); return JSON.stringify({ open: !d.hidden, state: a && a.dataset.state, verdict: a && (a.querySelector('[data-nq-verdict]')||{}).textContent });`).then(JSON.parse);
  ok('...talking opened the dock: the whole answer is on screen (brief to the ear, exact on screen)', answered.open && answered.state === 'done' && !!answered.verdict, JSON.stringify(answered));
  await shot('voice-1280');

  for (const [w, hgt, tabs] of [[1280, 900, ['charts', 'neo', 'journal']], [820, 1100, ['scanner', 'paper']], [390, 844, ['market', 'neo']]]) {
    await size(w, hgt); await sleep(400);
    for (const t of tabs) {
      await goTab(t);
      const sel = t === 'neo' ? '[data-neo-tab] [data-nq-talk]' : '[data-nq-mic], [data-nq-dock] [data-nq-talk]';
      const there = await until(`[...document.querySelectorAll('${sel}')].some(function(b){ return b.getClientRects().length; })`, 5000);
      ok(`${w} px ${t}: a mic to talk with`, there);
      if (there) await turn(sel, `${w} ${t}`);
    }
    ok(`${w} px: no sideways scroll with the voice line`, await js(`return document.scrollingElement.scrollWidth <= innerWidth + 1;`));
    await shot('voice-' + w);
  }

  console.log('\nHands-free');
  await size(1280, 900); await sleep(300);
  await goTab('neo');
  const h0 = hear().length, a0 = ai().length;
  await js(`document.querySelector('[data-neo-tab] [data-nq-hands]').click(); 1`);
  ok('Hands-free on: it listens at once', await until(`document.querySelector('[data-neo-tab] [data-nq-hands]').getAttribute('aria-pressed')==='true' && (document.querySelector('[data-neo-tab] [data-nq-talk]').dataset.mode==='listening')`, 4000));
  ok('...first turn heard and asked', await untilNode(() => hear().length > h0 && ai().length > a0, 20000));
  ok('...it listens again after the reply, and the second turn is heard and asked', await untilNode(() => hear().length > h0 + 1 && ai().length > a0 + 1, 30000), JSON.stringify({ hear: hear().length - h0, ai: ai().length - a0 }));
  await js(`document.querySelector('[data-neo-tab] [data-nq-hands]').click(); 1`);
  ok('...Hands-free off: the session ends and the mic is released', await until(`document.querySelector('[data-neo-tab] [data-nq-talk]').dataset.mode==='off'`, 15000) && !(await micLive()));

  // Closing the dock during a hands-free session keeps it closed on the next turns (only a new conversation opens it).
  await goTab('market');
  const hd = hear().length;
  await js(`[...document.querySelectorAll('[data-nq-mic], [data-nq-dock] [data-nq-talk]')].find(function(b){ return b.getClientRects().length; }).click(); 1`);
  await until(`!document.querySelector('[data-nq-dock]').hidden && document.querySelector('[data-nq-mic]').dataset.mode==='listening'`, 6000);
  await js(`document.querySelector('[data-nq-dock] [data-nq-hands]').click(); document.querySelector('[data-nq-close]').click(); 1`);
  await untilNode(() => hear().length > hd + 1, 30000);
  const dockHidden = await js(`return document.querySelector('[data-nq-dock]').hidden;`);
  ok('hands-free with the dock closed by hand: the next turns leave it closed', dockHidden && hear().length > hd + 1, JSON.stringify({ dockHidden, turns: hear().length - hd, mode: await mode() }));
  await js(`window.dispatchEvent(new CustomEvent('tb-neo-open')); 1`); await sleep(300);
  await js(`document.querySelector('[data-nq-dock] [data-nq-hands]').click(); 1`);
  await until(`(document.querySelector('[data-nq-mic]').dataset.mode||'off')==='off'`, 15000);
  await goTab('neo');

  console.log('\nHearing fails');
  api.state.ai.heard = [{ fail: [{ provider: 'groq', why: 'HTTP 429' }, { provider: 'workersai', why: 'not bound' }, { provider: 'gemini', why: 'spent' }] }];
  const hf = hear().length, af = ai().length;
  await js(`document.querySelector('[data-neo-tab] [data-nq-talk]').click(); 1`);
  await untilNode(() => hear().length > hf, 16000);
  ok('every rung failing: a clear note, nothing asked, the mic released', await until(`/could not hear that \\(groq: HTTP 429/.test((document.querySelector('[data-neo-tab] [data-nq-vnote]')||{}).textContent||'')`, 6000) && ai().length === af && !(await micLive()));
  api.state.ai.heard = ['Is NVDA a buy here?'];
  await js(`var i=document.querySelector('[data-neo-tab] [data-nq-input]'); i.value='Is NVDA a buy here?'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1`);
  ok('...typing still answers (and a typed reply is not spoken by default)', await untilNode(() => ai().length > af, 8000) && await until(`[...document.querySelectorAll('[data-neo-tab] [data-nq-a]')].pop().dataset.state==='done'`, 8000));

  console.log('\nControl ▸ Neo Quant voice');
  await goTab('prompt');
  ok('the voice settings are in Control', await until(`document.querySelector('[data-nq-settings] [data-nq-voices]')`, 10000));
  const w0 = await js(`return window.__fakeFs.log.filter(function(l){ return /tradehub_neo/.test(l.path); }).length;`);
  await sleep(1800);
  ok('opening them writes nothing', (await js(`return window.__fakeFs.log.filter(function(l){ return /tradehub_neo/.test(l.path); }).length;`)) === w0);
  ok('dragging the speed slider keeps the same slider under the pointer (not rebuilt each step)', await js(`var r=document.querySelector('[data-nq-speed]'); r.value='1.05'; r.dispatchEvent(new Event('input',{bubbles:true})); r.value='1.1'; r.dispatchEvent(new Event('input',{bubbles:true})); return document.querySelector('[data-nq-speed]') === r && r.isConnected;`));
  await js(`document.querySelector('[data-nq-voice-id="en-GB-RyanNeural"] .nqs-vpick').click(); var r=document.querySelector('[data-nq-speed]'); r.value='1.2'; r.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-nq-speakmode] [data-v="always"]').click(); 1`);
  await sleep(2200);
  const writes = await js(`return JSON.stringify(window.__fakeFs.log.filter(function(l){ return /tradehub_neo/.test(l.path); }).map(function(l){ return { path: l.path, data: l.data }; }));`).then(JSON.parse);
  ok('three changes → ONE write to dashboards/tradehub_neo with all of them', writes.length === w0 + 1 && writes[writes.length - 1].path === 'dashboards/tradehub_neo' && writes[writes.length - 1].data.voice === 'en-GB-RyanNeural' && writes[writes.length - 1].data.speed === 1.2 && writes[writes.length - 1].data.speak === 'always', JSON.stringify(writes));
  ok('...the chosen voice shows as picked', await js(`return document.querySelector('[data-nq-voice-id="en-GB-RyanNeural"]').classList.contains('is-on');`));
  const p0 = speech().length;
  await js(`document.querySelector('[data-nq-preview="en-GB-LibbyNeural"]').click(); 1`);
  ok('a preview speaks a sample in that voice', await untilNode(() => speech().slice(p0).some((b) => b.voice === 'en-GB-LibbyNeural'), 6000));
  await shot('voice-settings');
  // The next spoken answer uses Ryan.
  const sR = speech().length;
  await goTab('neo');
  await turn('[data-neo-tab] [data-nq-talk]', 'after the change');
  ok('...the next answer is spoken in the chosen voice', speech().slice(sR).length > 0 && speech().slice(sR).every((b) => b.voice === 'en-GB-RyanNeural' || b.voice === 'en-GB-LibbyNeural'), JSON.stringify(speech().slice(sR).map((b) => b.voice)));

  console.log('\nWake phrase, errors');
  ok('"Hey Neo" is off by default: Vosk was never loaded', await js(`return !window.Vosk && ![...document.scripts].some(function(s){ return /vosk/.test(s.src); });`));
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

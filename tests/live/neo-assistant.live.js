// Neo, end to end, in a real browser (docs/TaskHub/neo-assistant.md).
//
// Real index.html on Veda's side and the real Vosk wake-word engine and model
// (downloaded from their CDNs). The microphone is fake: Chrome plays a WAV,
// made here with Windows' own speech synthesizer, of "Neo. Add buy milk
// tomorrow." Firestore is the fake one, and the Gemini route
// (personal-ai /taskhub/parse) is answered here, so nothing touches her real
// data or quota. Expect:
//   · Vosk hears "Neo" → Neo records → the engine posts the audio (mode 'neo')
//   · the action applies (Buy milk tomorrow) and the reply is spoken
//   · switching to Tony's TaskHub releases the mic, and his header has no Neo
//
// Windows only (the WAV comes from System.Speech). The first run downloads
// ~41 MB of model. Run: node tests/live/neo-assistant.live.js
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const WAV = path.join(os.tmpdir(), 'neo-live-test.wav');
if (!fs.existsSync(WAV)) {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $syn=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    `$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);` +
    `$syn.SetOutputToWaveFile('${WAV}',$fmt);` +
    `$syn.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><break time="4s"/>Neo.<break time="700ms"/>Add buy milk tomorrow.<break time="6s"/></speak>');$syn.Dispose()`]);
}
process.env.CDP_PORT = process.env.CDP_PORT || '9347';
process.env.CDP_EXTRA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture=' + WAV, '--autoplay-policy=no-user-gesture-required'].join('\n');

const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const t = new Date(); t.setDate(t.getDate() + 1);
const TOMORROW = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());

(async () => {
  const parsed = [];
  const c = await connect({ mock: firebaseMock({
    patterns: ['https://personal-ai.av1.workers.dev/taskhub/parse*'],
    handle(req) {
      if (!/taskhub\/parse/.test(req.url)) return null;
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      let b = {}; try { b = JSON.parse(req.postData || '{}'); } catch (e) {}
      parsed.push({ profile: b.profile, mode: b.mode, audioBytes: b.audio ? Math.floor(b.audio.length * 3 / 4) : 0 });
      return { json: { ok: true, say: 'Added buy milk for tomorrow.',
        actions: [{ type: 'add_task', box: 'calendar', date: TOMORROW, title: 'Buy milk', category: 'personal' }] } };
    },
  }) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/vedasdash': { data: {}, habits: [], hc: {}, goals: [], monthlyGoals: [], rules: [], rulesDaily: {}, savedAt: Date.now(), rev: 1 } })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoVeda && window._vdNeo', 30000)) await js(`window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda" && window._vdVoice', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1000);

  console.log('\nVeda\'s side');
  ok('Veda\'s TaskHub is open', await js(`return window._activeProfile === 'veda';`), await js(`return String(window._activeProfile);`));
  ok('the NEO button is in her header', await js(`return !!document.querySelector('#veda-root button[aria-label="Neo assistant"]');`));
  await js(`window.__spoken=[]; speechSynthesis.speak=function(u){ if(u.text) window.__spoken.push(u.text); setTimeout(function(){ u.onend && u.onend(); }, 300); }; 1`);
  await js(`document.querySelector('#veda-root button[aria-label="Neo assistant"]').click(); 1`);
  ok('the button shows Neo is on', await until(`document.querySelector('#veda-root button[aria-label="Neo assistant"]').getAttribute('aria-pressed') === 'true'`, 3000));
  const ready = await until(`window._vdNeo.mode() === 'wake' || window._vdNeo.mode() === 'capture'`, 240000);
  ok('Vosk loaded and Neo is listening for the wake word', ready, await js(`return window._vdNeo.mode() + ' / ' + ((document.querySelector('#vd-neo-pill .vdn-t')||{}).textContent||'');`));

  console.log('\n"Neo. Add buy milk tomorrow."');
  const heard = ready && await until(`window.__spoken.length > 0`, 60000);
  ok('the wake word was heard and the request was sent', parsed.length >= 1, JSON.stringify(parsed));
  ok('…as Veda, marked as a Neo capture', parsed[0] && parsed[0].profile === 'veda' && parsed[0].mode === 'neo', JSON.stringify(parsed[0]));
  ok('…with the spoken request in it (> 1 s of audio)', parsed[0] && parsed[0].audioBytes > 32000, parsed[0] && parsed[0].audioBytes);
  ok('the task was added for tomorrow', await js(`return ((window._vdVoice.getState().data||{})[${JSON.stringify(TOMORROW)}]||[]).some(function(x){return x.title==='Buy milk';});`));
  ok('the reply was spoken', heard && (await js(`return window.__spoken[0];`)) === 'Added buy milk for tomorrow.', await js(`return JSON.stringify(window.__spoken);`));

  console.log('\nTony\'s side');
  await js(`window._profileGoTony(); 1`);
  ok('switching to Tony puts Neo to sleep (mic released)', await until(`window._vdNeo.mode() === 'off'`, 4000), await js(`return window._vdNeo.mode();`));
  ok('Tony\'s header has no Neo button', !(await js(`return !!document.querySelector('#root button[aria-label="Neo assistant"]');`)));
  const before = parsed.length; await sleep(14000);   // the fake mic loops "Neo…" every ~13 s
  ok('Neo hears nothing while Tony\'s TaskHub is open', parsed.length === before, parsed.length - before);

  ok('no page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

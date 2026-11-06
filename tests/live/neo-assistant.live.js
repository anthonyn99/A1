// Neo, end to end, in a real browser (docs/TaskHub/neo-assistant.md).
//
// Real index.html on Veda's side and the real Vosk wake-word engine and model
// (downloaded from their CDNs). The microphone is fake: Chrome plays a WAV,
// made here with Windows' own speech synthesizer, of "Hey Neo. Add buy milk
// tomorrow." on a loop. Firestore is the fake one; the Gemini route
// (personal-ai /taskhub/parse) and Orca's speech route are answered here, so
// nothing touches her real data, key or quota. Expect:
//   · switching Neo on boots the HUD and greets her
//   · Vosk hears "Neo" → the HUD listens (live captions) → processes → the
//     engine posts the audio (mode 'neo') → the task is added, an action card
//     shows it, and the reply is spoken and typed out
//   · Ryan is asked for through Orca with her key; when Orca refuses, the
//     device's voice still speaks
//   · the HUD takes the Gita quote banner's place (desktop and phone)
//   · switching to Tony's TaskHub releases the mic, and his header has no Neo
// Screenshots of each state land in %TEMP%/magi-live-shots/neo-*.png.
//
// Windows only (the WAV comes from System.Speech). The first run downloads
// ~41 MB of model. Run: node tests/live/neo-assistant.live.js
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const WAV = path.join(os.tmpdir(), 'neo-live-test-hey.wav');
if (!fs.existsSync(WAV)) {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $syn=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    `$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);` +
    `$syn.SetOutputToWaveFile('${WAV}',$fmt);` +
    `$syn.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><break time="4s"/>Hey Neo.<break time="700ms"/>Add buy milk tomorrow.<break time="6s"/></speak>');$syn.Dispose()`]);
}
process.env.CDP_PORT = process.env.CDP_PORT || '9347';
process.env.CDP_ALLOW_FONTS = '1';   // the HUD's Orbitron / JetBrains Mono, for honest screenshots
process.env.CDP_EXTRA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture=' + WAV, '--autoplay-policy=no-user-gesture-required'].join('\n');

const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
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
const REPLY = 'Done. Buy milk is on tomorrow\'s list, Veda.';
// A short, quiet 16 kHz tone as WAV: what "Orca" returns for the greeting.
function toneWav(sec) {
  const n = Math.floor(16000 * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 16000) * 3000), 44 + i * 2);
  return b;
}

(async () => {
  const parsed = [], orcaCalls = [], launches = [];
  const PC_APPS = [{ id: 'aa11bb22cc33', name: 'Spotify' }, { id: 'dd44ee55ff66', name: 'Google Chrome' }, { id: '0011aa22bb33', name: 'chrome_proxy' }];
  const c = await connect({ mock: firebaseMock({
    patterns: ['https://personal-ai.av1.workers.dev/taskhub/parse*', 'https://orca.vedapatel05.workers.dev/*', 'http://127.0.0.1:8781/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      // Her PC's StudyOS bridge, faked: nothing really launches during a test.
      if (/127\.0\.0\.1:8781/.test(req.url)) {
        if (/\/api\/launch/.test(req.url)) { let b = {}; try { b = JSON.parse(req.postData || '{}'); } catch (e) {} launches.push(b); return { json: { ok: true, opened: (b.apps || []).concat(b.urls || []), unknown: [], failed: [] } }; }
        if (/\/api\/apps/.test(req.url)) return { json: { ok: true, apps: PC_APPS } };
        return { json: { ok: true } };
      }
      if (/orca\.vedapatel05/.test(req.url)) {
        let b = {}; try { b = JSON.parse(req.postData || '{}'); } catch (e) {}
        orcaCalls.push({ url: req.url, voice: b.voice, input: b.input });
        // The greeting gets a real clip (Ryan, as far as the page can tell);
        // everything after is refused, so the device-voice fallback runs too.
        if (orcaCalls.length === 1) {
          const words = String(b.input || '').split(/\s+/).map((w, i) => [i * 0.12, 0.1, w]);
          return { json: { audio: toneWav(Math.max(1.2, words.length * 0.12 + 0.3)).toString('base64'), words, engine: 'edge', voice: b.voice } };
        }
        return { status: 400, json: { error: { message: 'voice service refused (test)' } } };
      }
      if (!/taskhub\/parse/.test(req.url)) return null;
      let b = {}; try { b = JSON.parse(req.postData || '{}'); } catch (e) {}
      parsed.push({ profile: b.profile, mode: b.mode, audioBytes: b.audio ? Math.floor(b.audio.length * 3 / 4) : 0, pcApps: b.state && b.state.pcApps, onPc: b.state && b.state.onPc });
      // a beat of "processing", like the real worker. The first command adds the
      // task AND opens Spotify + YouTube on her PC; the second asks for an app she
      // doesn't have.
      const first = parsed.length === 1;
      const reply = first
        ? { ok: true, say: REPLY, transcript: 'add buy milk tomorrow', actions: [{ type: 'add_task', box: 'calendar', date: TOMORROW, title: 'Buy milk', category: 'personal' },
            { type: 'open_pc_app', name: 'Spotify' }, { type: 'open_site', url: 'https://www.youtube.com' }] }
        : { ok: true, say: 'Opening Photoshop.', transcript: 'open photoshop', actions: [{ type: 'open_pc_app', name: 'Photoshop' }] };
      return new Promise((res) => setTimeout(() => res({ json: reply }), 1600));
    },
  }) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 150; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(150); } return false; };
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(shotPath('neo-' + name), Buffer.from(r.result.data, 'base64')); };
  const mode = () => js(`return window._vdNeo.mode();`);
  // A brand-new Edge profile installs its ad-block extension, which opens an
  // "installed" tab and a sync dialog on top of ours. Our page is then hidden,
  // and Neo — correctly — sleeps while hidden. Keep our page the only one, in front.
  const http = require('http');
  const PORT = Number(process.env.CDP_PORT);
  const listTargets = () => new Promise((res) => http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res([]); } }); }).on('error', () => res([])));
  const keepFront = setInterval(async () => {
    const ts = await listTargets();
    const strays = ts.filter((x) => x.type === 'page' && !/anthonyn99\.github\.io\/A1\//.test(x.url));
    for (const s of strays) http.get(`http://127.0.0.1:${PORT}/json/close/${s.id}`).on('error', () => {});
    if (strays.length) c.send('Page.bringToFront');
  }, 700);

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    localStorage.setItem('shruti.veda.orcaKey','orca_sk_livetest_123456');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/veda_pc_apps': { apps: ${JSON.stringify(PC_APPS)}, at: Date.now() }, 'dashboards/vedasdash': { data: { ${JSON.stringify(TOMORROW)}: [] }, habits: [{id:'h1',title:'Read'},{id:'h2',title:'Walk'}], hc: {}, goals: [], monthlyGoals: [], rules: [], rulesDaily: {}, savedAt: Date.now(), rev: 1 } })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoVeda && window._vdNeo', 30000)) await js(`window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda" && window._vdVoice', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1000);

  console.log('\nVeda\'s side');
  ok('Veda\'s TaskHub is open', await js(`return window._activeProfile === 'veda';`), await js(`return String(window._activeProfile);`));
  ok('the NEO reactor button is in her header', await js(`return !!document.querySelector('#veda-root button.vd-neo-btn svg.vnb');`));
  // The device voice is a spy: it records, lights words via boundary events and ends after a beat.
  await js(`window.__spoken=[]; speechSynthesis.speak=function(u){ if(!u.text) return; window.__spoken.push({text:u.text, voice:u.voice&&u.voice.name, lang:u.lang});
    var i=0, words=u.text.split(' '), pos=0; var iv=setInterval(function(){ if(i>=words.length){clearInterval(iv); setTimeout(function(){u.onend&&u.onend();},700); return;} u.onboundary&&u.onboundary({charIndex:pos}); pos+=words[i].length+1; i++; },160); }; 1`);
  await js(`document.querySelector('#veda-root button.vd-neo-btn').click(); 1`);
  ok('the button shows Neo is on', await until(`document.querySelector('#veda-root button.vd-neo-btn').classList.contains('on')`, 3000));
  const booted = await until(`['boot','speaking'].indexOf(window._vdNeo.mode())>=0 || (window.__spoken||[]).length`, 240000);
  ok('Neo boots (after the model loads) and the HUD shows', booted && await js(`return document.getElementById('vd-neo-hud').classList.contains('show');`), await mode());
  await sleep(500); await shot('1-boot');
  for (let i = 0; i < 60 && !orcaCalls.length; i++) await sleep(100);   // the greeting follows the boot sweep
  ok('the greeting is spoken in Ryan\'s voice through Orca, with her key', orcaCalls[0] && orcaCalls[0].voice === 'en-GB-RyanNeural' && /^(Good (morning|afternoon|evening)|Working late), Veda\. Neo online\./.test(orcaCalls[0].input || ''), JSON.stringify(orcaCalls[0]));
  ok('…played as audio (not the device voice), typed out in time with it, labelled ONLINE', await until(`document.querySelectorAll('#vd-neo-hud .vn-say .w.lit').length > 3`, 8000)
    && (await js(`return (window.__spoken||[]).length;`)) === 0 && (await js(`return document.querySelector('#vd-neo-hud .vn-state').textContent;`)) === 'ONLINE',
    await js(`return JSON.stringify({spoken:window.__spoken, state:document.querySelector('#vd-neo-hud .vn-state').textContent, lit:document.querySelectorAll('#vd-neo-hud .vn-say .w.lit').length});`));
  ok("the HUD takes the quote banner's place (banner hidden, HUD in its slot)", await js(`var h=document.getElementById('vd-neo-hud'), b=document.querySelector('#vr-root .thwx-band > .gita-banner');
    return !!b && h.classList.contains('vn-dock') && h.previousElementSibling===b && getComputedStyle(b).display==='none' && h.getBoundingClientRect().height>0;`),
    await js(`var h=document.getElementById('vd-neo-hud'); return h.className+' parent='+(h.parentNode&&h.parentNode.className);`));
  ok('telemetry reads VOICE RYAN', /VOICE RYAN/.test(await js(`return document.querySelector('#vd-neo-hud .vn-tele').textContent;`)));

  console.log('\n"Neo. Add buy milk tomorrow."');
  ok('the wake word opens the listening HUD', await until(`window._vdNeo.mode() === 'capture'`, 40000), await mode());
  ok('the HUD says LISTENING', (await js(`return document.querySelector('#vd-neo-hud .vn-state').textContent;`)) === 'LISTENING');
  const capOk = await until(`/\\w{3,}/.test(document.querySelector('#vd-neo-hud .vn-you').textContent)`, 6000);
  await shot('2-listening');
  ok('live captions appear while she talks', capOk, await js(`return document.querySelector('#vd-neo-hud .vn-you').textContent;`));
  ok('…then PROCESSING', await until(`window._vdNeo.mode() === 'thinking'`, 15000), await mode());
  await sleep(500); await shot('3-processing');
  ok('the request was sent as Veda, marked as a Neo capture, with real audio', parsed[0] && parsed[0].profile === 'veda' && parsed[0].mode === 'neo' && parsed[0].audioBytes > 32000, JSON.stringify(parsed));
  ok('…then RESPONDING', await until(`window._vdNeo.mode() === 'speaking'`, 15000), await mode());
  await sleep(900); await shot('4-speaking');
  ok('the action card shows the new task', /TASK ADDED/.test(await js(`return document.querySelector('#vd-neo-hud .vn-cards').textContent;`)) && /Buy milk/.test(await js(`return document.querySelector('#vd-neo-hud .vn-cards').textContent;`)), await js(`return document.querySelector('#vd-neo-hud .vn-cards').textContent;`));
  ok('the caption becomes the clean transcript', (await js(`return document.querySelector('#vd-neo-hud .vn-you').textContent;`)) === 'add buy milk tomorrow');
  ok('the task was added for tomorrow', await js(`return ((window._vdVoice.getState().data||{})[${JSON.stringify(TOMORROW)}]||[]).some(function(x){return x.title==='Buy milk';});`));
  ok('the reply asked Orca for Ryan too', orcaCalls.some(o => o.input === REPLY && o.voice === 'en-GB-RyanNeural'), JSON.stringify(orcaCalls.map(o => o.input)));
  ok('Orca refused, so the device voice (British) spoke the reply', await until(`(window.__spoken||[]).some(function(s){return s.text===${JSON.stringify(REPLY)} && /^en-GB/.test(s.lang);})`, 8000), await js(`return JSON.stringify(window.__spoken);`));
  ok('telemetry now reads VOICE DEVICE', /VOICE DEVICE/.test(await js(`return document.querySelector('#vd-neo-hud .vn-tele').textContent;`)));
  ok('her PC\'s app names went with the request', JSON.stringify(parsed[0] && parsed[0].pcApps) === JSON.stringify(PC_APPS.map(a => a.name)) && parsed[0].onPc === true, JSON.stringify(parsed[0] && parsed[0].pcApps));
  for (let i = 0; i < 40 && !launches.length; i++) await sleep(100);
  ok('Spotify and YouTube were sent to her PC\'s launcher (by app id, once)', launches.length === 1 && JSON.stringify(launches[0].apps) === '["aa11bb22cc33"]' && JSON.stringify(launches[0].urls) === '["https://www.youtube.com/"]', JSON.stringify(launches));
  ok('cards show LAUNCHING Spotify and OPENING youtube.com', /LAUNCHING\s*Spotify/.test(await js(`return document.querySelector('#vd-neo-hud .vn-cards').textContent;`)) && /OPENING\s*youtube\.com/.test(await js(`return document.querySelector('#vd-neo-hud .vn-cards').textContent;`)),
    await js(`return document.querySelector('#vd-neo-hud .vn-cards').textContent;`));
  ok('the reply types out word by word', await until(`document.querySelectorAll('#vd-neo-hud .vn-say .w.lit').length === ${REPLY.split(' ').length}`, 8000),
    await js(`return document.querySelectorAll('#vd-neo-hud .vn-say .w.lit').length + '/' + document.querySelectorAll('#vd-neo-hud .vn-say .w').length;`));
  ok('…then STANDING BY for a follow-up', await until(`window._vdNeo.mode() === 'follow' || window._vdNeo.mode() === 'wake'`, 8000), await mode());
  await shot('5-done');

  console.log('\nOn a phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const again = await until(`window._vdNeo.mode() === 'speaking'`, 45000);   // the fake mic says "Neo…" again
  await sleep(900); await shot('6-phone');
  const sheet = await js(`var h=document.getElementById('vd-neo-hud'), r=h.getBoundingClientRect(); return JSON.stringify({dock:h.classList.contains('vn-dock'), w:Math.round(r.width), r:Math.round(r.right)});`);
  const sj = JSON.parse(sheet);
  ok("on a phone the HUD sits in the banner's slot, inside the screen", again && sj.dock && sj.w > 200 && sj.r <= 390, sheet);
  await c.send('Emulation.clearDeviceMetricsOverride');
  ok('an app she doesn\'t have: nothing is launched, and Neo says so after its reply',
    await until(`(window.__spoken||[]).some(function(s){return s.text==="I couldn't find Photoshop on your PC, I'm afraid.";})`, 15000) && launches.length === 1,
    await js(`return JSON.stringify((window.__spoken||[]).map(function(s){return s.text;}));`) + ' launches=' + launches.length);

  console.log('\nTony\'s side');
  await js(`window._profileGoTony(); 1`);
  ok('switching to Tony puts Neo to sleep (mic released)', await until(`window._vdNeo.mode() === 'off'`, 4000), await mode());
  ok('the HUD is gone', !(await js(`return document.getElementById('vd-neo-hud').classList.contains('show');`)));
  ok('…and the quote banner is back', !(await js(`return document.body.classList.contains('vn-docked');`)));
  ok('Tony\'s header has no Neo button', !(await js(`return !!document.querySelector('#root .vd-neo-btn');`)));
  const before = parsed.length; await sleep(14000);   // the fake mic loops "Neo…" every ~13 s
  ok('Neo hears nothing while Tony\'s TaskHub is open', parsed.length === before, parsed.length - before);

  ok('no page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
  clearInterval(keepFront);
  console.log(`\n${pass} passed, ${fail} failed   (screenshots: ${path.dirname(shotPath('x'))}\\neo-*.png)`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

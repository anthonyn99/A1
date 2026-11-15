// Beacon in the real index.html, real headless Edge, against the fake Firestore
// (tests/live/fake-firebase.js). Desktop, tablet and phone, both TaskHubs:
//
//   1. the page checks this device in to Tony's document, with its model,
//      TaskHub's push state and its locks, and to nobody else's
//   2. Settings ▸ Devices ▸ Manage opens the panel over Settings: this device
//      first, Tony's other devices, the neutral one, a phone known only by its
//      push token; never Veda's
//   3. it fits: no sideways scroll, a centred sheet on desktop and tablet, an
//      edge-to-edge bottom sheet on a phone, 44px action buttons on touch
//   4. Remove on the push-only phone deletes its token; Lock leaves a command
//   5. Escape closes the panel and leaves Settings open
//   6. Veda's Settings: her theme, her device and the neutral one only
//
// Screenshots: beacon-<who>-<width>.png in the shots folder (cdp.js SHOTS).
// Run: CDP_ALLOW_FONTS=1 node tests/live/beacon.live.js
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const NOW = Date.now();
const MAIN = { data: {}, habits: [], hc: {}, goals: [], monthlyGoals: [], weekKey: '2026-11-09', savedAt: NOW - 60000 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const SEED = {
  'dashboards/main': MAIN,
  'dashboards/vedasdash': MAIN,
  'dashboards/beacon_tony': { devices: {
    dev_iphone: { name: 'Tony’s iPhone', first: NOW - 90 * 864e5, seen: NOW - 3 * 60e3,
      meta: { kind: 'phone', os: 'iOS', osVer: '26', browser: 'Safari', model: 'iPhone', hint: 'iPhone 16 / 17 Pro Max', app: true },
      apps: {
        taskhub: { label: 'TaskHub', seen: NOW - 3 * 60e3, profs: { tony: NOW }, push: { perm: 'granted', on: true, coll: 'fcm_tokens', id: 'dev_iphone', route: 'tony' },
          locks: [{ id: 'tony_taskhub', label: 'TaskHub', owner: 'tony', open: true, bio: true }, { id: 'profile_tony', label: 'Tony', owner: 'tony', open: true, bio: true }] },
        magi: { label: 'MAGI', seen: NOW - 5 * 3600e3, profs: { tony: NOW }, locks: [{ id: 'tony_magi', label: 'MAGI', owner: 'tony', open: false, bio: false }] } } },
    dev_laptop: { first: NOW - 200 * 864e5, seen: NOW - 70 * 864e5,
      meta: { kind: 'laptop', os: 'Windows', osVer: '11', browser: 'Brave', model: '', hint: '', app: false },
      apps: { mylist: { label: 'MyList', seen: NOW - 70 * 864e5, profs: { tony: NOW }, push: { perm: 'denied', on: false, coll: 'fcm_tokens', id: 'dev_laptop', route: 'tony' }, locks: [] } } } } },
  'dashboards/beacon_veda': { devices: {
    dev_vedaphone: { seen: NOW - 60e3, first: NOW - 864e5, meta: { kind: 'phone', os: 'Android', osVer: '15', browser: 'Chrome', model: 'Pixel 9', app: false },
      apps: { taskhub: { label: 'TaskHub', seen: NOW - 60e3, profs: { veda: NOW }, locks: [] } } } } },
  'dashboards/beacon_neutral': { devices: {
    dev_shared: { name: 'Living room PC', seen: NOW - 2 * 864e5, first: NOW - 30 * 864e5, meta: { kind: 'desktop', os: 'Windows', osVer: '10', browser: 'Edge', model: '', app: false },
      apps: { taskhub: { label: 'TaskHub', seen: NOW - 2 * 864e5, profs: { tony: NOW, veda: NOW }, push: { perm: 'granted', on: true, coll: 'fcm_tokens', id: 'dev_shared', route: 'none' }, locks: [] } } } } },
  'fcm_tokens/dev_iphone': { token: 'T1', mainDash: 'tony', updatedAt: NOW - 3 * 60e3, ua: IPHONE_UA.slice(0, 80) },
  'fcm_tokens/dev_oldphone': { token: 'T2', mainDash: 'tony', updatedAt: NOW - 9 * 864e5, ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007) AppleWebKit/537.36' },
  'fcm_tokens/dev_vedaphone': { token: 'T3', mainDash: 'veda', updatedAt: NOW - 60e3, ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chr' },
};

const shot = async (c, name) => {
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(s.result.data, 'base64'));
};
const SR = "document.querySelector('beacon-panel') && document.querySelector('beacon-panel').shadowRoot";
async function tap(c, expr, mobile) {
  const r = JSON.parse(await evalJs(c, `const el=${expr}; if(!el) return 'null'; el.scrollIntoView({block:'center'}); const b=el.getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2});`));
  if (!r) throw new Error('nothing to tap: ' + expr);
  if (mobile) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  }
  await sleep(450);
}
const panel = (c) => evalJs(c, `const R=${SR}; if(!R) return 'null';
  const sheet=R.querySelector('.sheet'), b=sheet.getBoundingClientRect(), body=R.querySelector('[data-body]');
  const cards=[...R.querySelectorAll('[data-dev]')];
  const acts=R.querySelector('.acts .b');
  return JSON.stringify({ theme: R.querySelector('.ov').getAttribute('data-theme'),
    ids: cards.map(x=>x.getAttribute('data-dev')),
    sections: [...R.querySelectorAll('.sec .st')].map(x=>x.textContent),
    text: body.innerText,
    rect: { l: b.left, r: b.right, t: b.top, btm: b.bottom, w: b.width },
    vw: innerWidth, vh: innerHeight,
    spill: Math.max(sheet.scrollWidth - sheet.clientWidth, body.scrollWidth - body.clientWidth),
    cardSpill: cards.some(x=>{ const r=x.getBoundingClientRect(); return [...x.querySelectorAll('*')].some(e=>{ const q=e.getBoundingClientRect(); return q.width && (q.right>r.right+1 || q.left<r.left-1); }); }),
    actH: acts ? acts.getBoundingClientRect().height : 0,
    font: getComputedStyle(R.querySelector('h2')).fontFamily });`).then(JSON.parse);

// Settings, open and drawn (a late cloud render can close it right after boot).
async function openSettings(c, who) {
  for (let i = 0; i < 3; i++) {
    await evalJs(c, "var x=document.querySelector('.thset-close'); if(x&&document.getElementById('thset-overlay').style.display!=='none') x.click(); window._openSettings('" + who + "'); 1");
    for (let j = 0; j < 12; j++) {
      await sleep(250);
      if (await evalJs(c, "return !!document.getElementById('thset-dev-go') && document.getElementById('thset-overlay').style.display!=='none';")) return true;
    }
  }
  console.log('    settings state: ' + await evalJs(c, "return JSON.stringify({ov:(document.getElementById('thset-overlay')||{}).style&&document.getElementById('thset-overlay').style.display, go:!!document.getElementById('thset-dev-go'), ap:window._activeProfile});"));
  return false;
}
async function run(c, w, h, mobile) {
  console.log(`\n${w}×${h}${mobile ? ' (touch)' : ''}`);
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('td6_lastDash','tony');
    localStorage.setItem('th_device_id','dev_live1'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify(${JSON.stringify(SEED)})); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  // In-browser Babel with the cache off can take a while: wait for TaskHub, not a clock.
  for (let i = 0; i < 90; i++) {
    if (await evalJs(c, "return typeof window._profileGoTony === 'function' && typeof window._openSettings === 'function';")) break;
    await sleep(500);
  }
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._profileGoTony(); 1");
  await sleep(4500);

  const me = JSON.parse(await evalJs(c, `return JSON.stringify(((__fakeFs.docs['dashboards/beacon_tony']||{}).devices||{}).dev_live1 || null);`));
  ok('this device checked in to Tony’s document', !!(me && me.apps && me.apps.taskhub), JSON.stringify(me));
  ok('with its model and TaskHub’s push state', me && me.meta && me.meta.os === 'Windows' && me.meta.browser === 'Edge' && me.apps.taskhub.push && me.apps.taskhub.push.coll === 'fcm_tokens' && me.apps.taskhub.push.id === 'dev_live1', JSON.stringify(me && me.meta));
  const elsewhere = await evalJs(c, `return !((__fakeFs.docs['dashboards/beacon_veda']||{}).devices||{}).dev_live1 && !((__fakeFs.docs['dashboards/beacon_neutral']||{}).devices||{}).dev_live1;`);
  ok('and to nobody else’s', elsewhere);

  await openSettings(c, 'tony');
  ok('Tony’s Settings has a Devices section', await evalJs(c, "return !!document.getElementById('thset-dev-go') && /Devices/.test(document.getElementById('thset-devices').closest('.thset-sec').textContent);"));
  await tap(c, "document.getElementById('thset-dev-go')", mobile);
  await sleep(900);
  let p = await panel(c);
  ok('Manage opens the panel', p && p.theme === 'tony', JSON.stringify(p));
  ok('this device first, then Tony’s devices; the push-only phone shows', p.ids[0] === 'dev_live1' && p.ids.includes('dev_iphone') && p.ids.includes('dev_oldphone') && p.ids.includes('dev_shared'), p.ids);
  ok('the MyList-only laptop is not in the TaskHub view', !p.ids.includes('dev_laptop'), p.ids);
  ok('never Veda’s phone', !p.ids.includes('dev_vedaphone'), p.ids);
  ok('two sections: yours and neutral', p.sections.join('|') === 'Your devices|Neutral devices', p.sections);
  ok('names and words read right', /Tony’s iPhone/.test(p.text) && /Notifications on/.test(p.text) && /Living room PC/.test(p.text) && /Notifications off/.test(p.text), p.text.slice(0, 400));
  ok('no sideways scroll anywhere in it', p.spill <= 0 && !p.cardSpill, JSON.stringify({ spill: p.spill, cardSpill: p.cardSpill }));
  if (w <= 600) {
    ok('phone: an edge-to-edge bottom sheet', Math.abs(p.rect.w - p.vw) <= 1 && Math.abs(p.rect.btm - p.vh) <= 1, JSON.stringify(p.rect));
    ok('phone: 44px action buttons', p.actH >= 44, p.actH);
  } else {
    ok('a centred sheet with room around it', p.rect.l >= 15 && p.vw - p.rect.r >= 15 && Math.abs(p.rect.l - (p.vw - p.rect.r)) <= 2, JSON.stringify(p.rect));
  }
  if (process.env.CDP_ALLOW_FONTS) ok('Tony’s titles in Manrope', /Manrope/.test(p.font), p.font);
  await shot(c, `beacon-tony-${w}`);

  await tap(c, `${SR}.querySelector('[data-scope="all"]')`, mobile);
  p = await panel(c);
  ok('"All programs" adds the laptop, Inactive, notifications blocked', p.ids.includes('dev_laptop') && /Inactive/i.test(p.text) && /Notifications blocked/.test(p.text), p.text.slice(0, 600));
  await tap(c, `${SR}.querySelector('[data-dev="dev_iphone"] [data-locks]')`, mobile);
  p = await panel(c);
  ok('the lock pill opens each lock', /TaskHub\s*Unlocked/.test(p.text.replace(/\n/g, ' ')) || /Unlocked/.test(p.text), p.text.slice(0, 300));
  if (w === 1280) await shot(c, 'beacon-tony-1280-all');

  // Lock the iPhone from here.
  await tap(c, `${SR}.querySelector('[data-dev="dev_iphone"] [data-act="lock"]')`, mobile);
  await tap(c, `${SR}.querySelector('[data-dev="dev_iphone"] [data-ok]')`, mobile);
  await sleep(900);
  const cmd = await evalJs(c, `return !!(((__fakeFs.docs['dashboards/beacon_tony']||{}).cmd||{}).dev_iphone||{}).lock;`);
  ok('Lock leaves a command for the iPhone', cmd);
  p = await panel(c);
  ok('and the card shows it pending', /Lock sent/.test(p.text), p.text.slice(0, 300));
  // Remove the push-only phone.
  await tap(c, `${SR}.querySelector('[data-dev="dev_oldphone"] [data-act="remove"]')`, mobile);
  if (w <= 600) await shot(c, `beacon-tony-${w}-confirm`);
  await tap(c, `${SR}.querySelector('[data-dev="dev_oldphone"] [data-ok]')`, mobile);
  await sleep(1200);
  ok('Remove deletes its push token', await evalJs(c, "return !__fakeFs.docs['fcm_tokens/dev_oldphone'];"));
  p = await panel(c);
  ok('and the card goes', !p.ids.includes('dev_oldphone'), p.ids);

  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  ok('Escape closes the panel and leaves Settings open', await evalJs(c, "return !document.querySelector('beacon-panel') && document.getElementById('thset-overlay').style.display!=='none';"));
  ok('the page scroll lock is TaskHub’s again', await evalJs(c, "return document.documentElement.style.overflow !== 'hidden' || !!document.getElementById('thset-overlay');"));

  // Veda's side.
  await openSettings(c, 'veda');
  await tap(c, "document.getElementById('thset-dev-go')", mobile);
  await sleep(900);
  p = await panel(c);
  ok('Veda’s panel wears her theme', p && p.theme === 'veda', p && p.theme);
  ok('Veda sees her phone and the neutral PC, none of Tony’s', p.ids.includes('dev_vedaphone') && p.ids.includes('dev_shared') && !p.ids.includes('dev_iphone') && !p.ids.includes('dev_live1'), p.ids);
  ok('no sideways scroll', p.spill <= 0 && !p.cardSpill);
  if (process.env.CDP_ALLOW_FONTS) ok('her titles in Lora', /Lora/.test(p.font), p.font);
  await shot(c, `beacon-veda-${w}`);
  await tap(c, `${SR}.querySelector('[data-x]')`, mobile);
  ok('the close button closes it', await evalJs(c, "return !document.querySelector('beacon-panel');"));
  await evalJs(c, "document.querySelector('.thset-close').click(); 1");
}

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = global.__errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
  });
  const only = process.env.BEACON_ONLY ? +process.env.BEACON_ONLY : 0;
  if (!only || only === 1280) await run(c, 1280, 900, false);
  if (!only || only === 820) await run(c, 820, 1180, true);
  if (!only || only === 390) await run(c, 390, 844, true);
  const mine = errs.filter((e) => /beacon|Beacon/.test(e));
  ok('no page errors from Beacon', !mine.length, mine.join(' | '));
  if (fail) console.log('\nPage exceptions:\n' + errs.slice(0, 20).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('Page exceptions:\n' + (global.__errs || []).slice(0, 20).join('\n')); process.exit(1); });

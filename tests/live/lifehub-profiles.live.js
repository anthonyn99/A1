// There are two LifeHubs, Tony's and Veda's (2026-10-29). Every host says
// whose it mounts, and the panel's title names it: "LifeHub – Tony" or
// "LifeHub – Veda". This drives lifehub.js in a real browser on four
// stand-in hosts:
//
//   fixed-veda   StudyOS's tag: data-profile="veda"
//   fixed-tony   TradeHub's tag: data-profile="tony"
//   html-follow  MAGI's: data-profile-attr, the profile kept on <html>. Before
//                this, MAGI named no profile and showed Veda Tony's list.
//   body-follow  MyList's/Shield's: data-profile-attr on <body>, switched live
//
// Firebase is refused (cdp.js), so the lists stay local; only the mounting
// and the title are under test.
//
// Run: node tests/live/lifehub-profiles.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
// A host on its own origin, loading lifehub.js by its Pages URL like StudyOS.
const BASE = 'https://lhprof.example/';
const page = (htmlAttr, bodyAttr, tagAttrs) => `<!doctype html><html${htmlAttr}><head><meta charset="utf-8"></head>
<body${bodyAttr}><header><a1-lifehub></a1-lifehub></header>
<script src="https://anthonyn99.github.io/A1/LifeHub/lifehub.js" data-lock="#no-lock" ${tagAttrs} defer></script></body></html>`;
const PAGES = {
  'fixed-veda.html': page('', '', 'data-profile="veda"'),
  'fixed-tony.html': page('', '', 'data-profile="tony"'),
  'html-follow.html': page(' data-profile="veda"', '', 'data-profile-attr="data-profile"'),
  'body-follow.html': page('', ' data-profile="tony"', 'data-profile-attr="data-profile"'),
};
const mock = {
  patterns: [BASE + '*'],
  handle(req) {
    const f = req.url.slice(BASE.length).split('?')[0];
    return PAGES[f] ? { text: PAGES[f], type: 'text/html' } : null;
  },
};

const state = (c) => evalJs(c, `var t = null; [document].concat([...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean)).forEach(function (d) { var x = d.querySelector('.ttl'); if (x) t = x; });
  return JSON.stringify({ p: window.LifeHub && window.LifeHub.profile(), ttl: t ? t.textContent : null });`).then(JSON.parse);
const toggle = async (c) => { await evalJs(c, "var l=document.querySelector('a1-lifehub'); var b=(l.shadowRoot||l).querySelector('button'); b.click(); 1"); await sleep(700); };
const load = async (c, f) => { await c.send('Page.navigate', { url: BASE + f }); await sleep(2500); };

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setBypassServiceWorker', { bypass: true });

  for (const [f, who, title] of [['fixed-veda.html', 'veda', 'LifeHub – Veda'], ['fixed-tony.html', 'tony', 'LifeHub – Tony'], ['html-follow.html', 'veda', 'LifeHub – Veda']]) {
    await load(c, f);
    await toggle(c);
    const s = await state(c);
    ok(f + ' mounts ' + who + "'s LifeHub", s.p === who, JSON.stringify(s));
    ok(f + ' titles the panel "' + title + '"', s.ttl === title, JSON.stringify(s));
  }

  await load(c, 'body-follow.html');
  await toggle(c);
  let s = await state(c);
  ok('body-follow starts on Tony\'s LifeHub', s.p === 'tony' && s.ttl === 'LifeHub – Tony', JSON.stringify(s));
  await evalJs(c, "document.body.setAttribute('data-profile','veda'); 1"); await sleep(800);
  await toggle(c);
  s = await state(c);
  ok('switching the profile to Veda mounts hers, and the title follows', s.p === 'veda' && s.ttl === 'LifeHub – Veda', JSON.stringify(s));

  console.log(`\n${pass}/${pass + fail} checks passed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

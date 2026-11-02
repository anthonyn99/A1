/**
 * A dropped row lands without a bounce (dragsort.js), on Vault's Keychain cards.
 *
 * Every frame from the release on is recorded, for every card. The dropped
 * card must glide straight to its slot: never past it and back, never a jump
 * after it has landed. The cards it pushed aside must not move once the drop
 * is done. Tony, 2026-11-02: "when I drag and drop … it bounces before
 * landing" -- the released row jumped to its new top while its drag offset
 * eased away on top of it (a class `transition … !important` beat nudge's
 * inline `none`).
 *
 *   node tests/live/drag-land.live.js
 */
const { connect, evalJs, sleep } = require('./cdp');

const APP = 'https://anthonyn99.github.io/A1/vault.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 600) : '')); }
};
const link = (n) => ({ type: 'link', name: n, url: 'https://' + n.toLowerCase() + '.example.com' });
const CONNS = [
  { name: 'Alpha', color: '#a3c8ec', items: [link('A1'), link('A2'), link('A3')] },
  { name: 'Bravo', color: '#cfe39c', items: [link('B1'), link('B2')] },
  { name: 'Charlie', color: '#f1b0c4', items: [link('C1'), link('C2'), link('C3'), link('C4')] },
  { name: 'Delta', color: '#c3aee6', items: [link('D1')] },
];
const card = (n) => `[...document.querySelectorAll('#kc-conns-list .kc-card')].find(function(k){ return k.querySelector('.kc-card-name').textContent === '${n}'; })`;
const rect = (c, js) => evalJs(c, `var e=(${js}); if (!e) return null; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, l:r.left, t:r.top, w:r.width, h:r.height};`);

async function boot(c) {
  await c.send('Page.navigate', { url: APP + '?blank' });
  await sleep(900);
  await evalJs(c, `localStorage.clear(); localStorage.setItem('kc_connections', ${JSON.stringify(JSON.stringify(CONNS))}); localStorage.setItem('kc_colmap', '[0,0,1,1]'); return 1;`);
  await c.send('Page.navigate', { url: APP });
  for (let i = 0; i < 80; i++) {
    if (await evalJs(c, "return document.querySelectorAll('#kc-conns-list .kc-card').length === 4;").catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

// Drag `name` by (dx, dy) from its title, release, and return each card's
// path (its top-left on every frame) from the release until it has settled.
async function dropPaths(c, name, dx, dy) {
  const a = await rect(c, card(name) + '.querySelector(".kc-card-name")');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 20; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + dx * i / 20, y: a.y + dy * i / 20, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await sleep(250);
  await evalJs(c, `window.__tr = []; var t0 = performance.now(); (function f() {
      var o = {}; [].forEach.call(document.querySelectorAll('#kc-conns-list .kc-card'), function (k) { var r = k.getBoundingClientRect(); o[k.querySelector('.kc-card-name').textContent] = [Math.round(r.left), Math.round(r.top)]; });
      window.__tr.push(o); if (performance.now() - t0 < 1000) requestAnimationFrame(f); })(); return 1;`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x + dx, y: a.y + dy, button: 'left', clickCount: 1 });
  await sleep(1200);
  const tr = await evalJs(c, 'return window.__tr;');
  const paths = {};
  tr.forEach((f) => Object.keys(f).forEach((n) => (paths[n] = paths[n] || []).push(f[n])));
  return paths;
}
// Straight to the end: every frame lies between the first and the last
// position (2px slack), per axis. A bounce leaves that range.
function straight(path) {
  const s = path[0], e = path[path.length - 1];
  return path.every((p) => [0, 1].every((k) => p[k] >= Math.min(s[k], e[k]) - 2 && p[k] <= Math.max(s[k], e[k]) + 2));
}
const brief = (path) => path.filter((p, i, a) => i === 0 || p.join() !== a[i - 1].join()).map((p) => p.join(',')).join(' → ');

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  ok('vault.html boots with four cards', await boot(c));

  console.log('Released right on its slot');
  let b = await rect(c, card('Bravo')), a = await rect(c, card('Alpha') + '.querySelector(".kc-card-name")');
  let p = await dropPaths(c, 'Alpha', 0, b.t + b.h - a.t - 8);
  ok('the dropped card lands without moving past its slot and back', straight(p.Alpha), brief(p.Alpha));
  ok('the card it passed lands without a bounce', straight(p.Bravo), brief(p.Bravo));

  console.log('Released short of its slot (it has to glide the rest)');
  await boot(c);
  b = await rect(c, card('Bravo')); a = await rect(c, card('Alpha') + '.querySelector(".kc-card-name")');
  p = await dropPaths(c, 'Alpha', 30, b.y - a.y + 20);
  const end = p.Alpha[p.Alpha.length - 1];
  ok('it glides straight into its slot, no overshoot', straight(p.Alpha) && p.Alpha.length > 3, brief(p.Alpha));
  ok('…and ends exactly on its slot (under Bravo)', Math.abs(end[0] - Math.round(b.l)) <= 1, { end, bravoLeft: b.l });

  console.log('Across to the other column');
  await boot(c);
  const d = await rect(c, card('Delta'));
  a = await rect(c, card('Alpha') + '.querySelector(".kc-card-name")');
  p = await dropPaths(c, 'Alpha', d.x - a.x, d.t + d.h - a.y + 10);
  const e2 = p.Alpha[p.Alpha.length - 1];
  ok('it moved to the other column', Math.abs(e2[0] - Math.round(d.l)) <= 1, { end: e2, deltaLeft: d.l });
  ok('it lands without a bounce', straight(p.Alpha), brief(p.Alpha));
  ok('the cards left behind and pushed aside land without a bounce', ['Bravo', 'Charlie', 'Delta'].every((n) => straight(p[n])), ['Bravo', 'Charlie', 'Delta'].map((n) => n + ': ' + brief(p[n])));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

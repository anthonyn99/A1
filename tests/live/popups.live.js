/**
 * popups.js in a real browser: every popup backdrop wears TaskHub's look
 * (rgba(0,0,0,.6) + blur(7px) saturate(.9)), a click outside closes it, and a
 * press that starts inside and ends outside (selecting text) never does.
 *
 * Part 1 is a fixture with each kind of popup A1 has. Part 2 opens every
 * program and checks the file is loaded and that nothing on screen at load
 * (the page itself, a title screen) was taken for a popup.
 *
 *   node tests/live/popups.live.js
 */
const { connect, evalJs, sleep } = require('./cdp');

const BASE = 'https://anthonyn99.github.io/A1/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}
async function go(c, url, wait) {
  await c.send('Page.navigate', { url });
  await sleep(wait || 1500);
}
async function mouse(c, type, x, y) {
  await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
}
async function press(c, from, to) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await mouse(c, 'mousePressed', from.x, from.y);
  if (to) {
    for (let i = 1; i <= 5; i++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 5, y: from.y + (to.y - from.y) * i / 5, button: 'left', buttons: 1 });
    }
  }
  const end = to || from;
  await mouse(c, 'mouseReleased', end.x, end.y);
  await sleep(300);
}
const CORNER = { x: 30, y: 30 };
async function centre(c, sel) {
  return evalJs(c, `var e = document.querySelector(${JSON.stringify(sel)}); var r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
}
const shown = (c, id) => evalJs(c, `var e = document.getElementById(${JSON.stringify(id)});
  if (!e) return false; var s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden';`);
const show = (c, id) => evalJs(c, `var e = document.getElementById(${JSON.stringify(id)}); e.style.display = 'flex'; return 1`);

(async () => {
  const c = await connect();
  await c.send('Runtime.enable');

  console.log('Fixture');
  await go(c, BASE + 'tests/live/fixtures/popups.html', 1200);
  const tags = await evalJs(c, `return ['A','B','C','D','E','F','G','H','I'].map(function (id) {
    return id + ':' + document.getElementById(id).hasAttribute('data-a1-scrim'); }).join(' ')`);
  ok('backdrops tagged (A-F), clear / solid / glow layers not (G, H, I)', tags === 'A:true B:true C:true D:true E:true F:true G:false H:false I:false', tags);
  const look = await evalJs(c, `var s = getComputedStyle(document.getElementById('A'));
    return s.backgroundColor + ' | ' + (s.backdropFilter || s.webkitBackdropFilter)`);
  ok('look is TaskHub\'s exactly', look === 'rgba(0, 0, 0, 0.6) | blur(7px) saturate(0.9)', look);
  const lookD = await evalJs(c, `var s = getComputedStyle(document.getElementById('D')); return s.backgroundColor + ' | ' + s.backdropFilter`);
  ok('a stylesheet backdrop is overridden too', lookD === 'rgba(0, 0, 0, 0.6) | blur(7px) saturate(0.9)', lookD);

  // A: drag-select from inside the input out onto the backdrop.
  const inp = await centre(c, '#A-in');
  await press(c, inp, CORNER);
  ok('A: select text, let go outside -> stays open', await shown(c, 'A'));
  await press(c, CORNER, inp);
  ok('A: press outside, let go inside -> stays open', await shown(c, 'A'));
  await press(c, CORNER);
  ok('A: click outside -> its own handler closes it', !(await shown(c, 'A')));

  await show(c, 'B');
  await press(c, CORNER);
  await sleep(200);
  ok('B: no handler, closes through Escape', !(await shown(c, 'B')));

  await show(c, 'C');
  await press(c, CORNER);
  await sleep(300);
  ok('C: no handler, no Escape -> Cancel pressed', !(await shown(c, 'C')));

  await evalJs(c, `document.getElementById('D').classList.add('active'); window.__esc = 0;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.__esc++; }); return 1`);
  await sleep(400);
  await evalJs(c, `document.getElementById('D').onclick = function (e) { if (e.target === this) this.classList.remove('active'); }; return 1`);
  await press(c, CORNER);
  await sleep(300);
  ok('D: class-toggled popup closes (fading counts as closed, no extra Escape)',
    !(await evalJs(c, `document.getElementById('D').classList.contains('active')`)) && (await evalJs(c, 'window.__esc')) === 0);

  await show(c, 'E');
  await press(c, CORNER);
  await sleep(200);
  ok('E: click on a clear full-size wrapper counts as outside', !(await shown(c, 'E')));

  await show(c, 'F');
  await press(c, CORNER);
  await sleep(300);
  ok('F: data-a1-popup="keep" stays open', await shown(c, 'F'));
  await evalJs(c, `document.getElementById('F').style.display = 'none'; return 1`);

  await evalJs(c, 'added(); return 1');
  await sleep(150);
  ok('J: a popup added later is tagged', await evalJs(c, `document.getElementById('J').hasAttribute('data-a1-scrim')`));
  await press(c, CORNER);
  await sleep(300);
  ok('J: closes through its ✕', !(await evalJs(c, `!!document.getElementById('J')`)));

  // ── Every program ────────────────────────────────────────────────────────
  console.log('\nPrograms');
  const PAGES = ['index.html', 'index.html?profile=veda', 'magi/magi.html', 'MyList/mylist.html', 'Shield/shield.html', 'Shruti/shruti.html',
    'V1/StudyOS/studyos.html', 'V1/Wellness/wellness.html', 'Backup/backup-restore.html', 'Backup/backup-export.html',
    'oneinbox.html', 'tradehub.html', 'insight.html', 'vault.html', 'everwell.html', 'riftiq.html'];
  for (const p of PAGES) {
    await go(c, BASE + p, 4000);
    const r = await evalJs(c, `return JSON.stringify({ on: !!window.A1Popups,
      open: Array.prototype.filter.call(document.querySelectorAll('[data-a1-scrim]'), function (e) {
        var s = getComputedStyle(e); var b = e.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && b.width > 0;
      }).map(function (e) { return e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 40); }) })`).catch((e) => JSON.stringify({ err: String(e) }));
    const v = JSON.parse(r);
    ok(p + ': popups.js on', v.on, v);
    ok(p + ': nothing at load taken for a popup', v.open && v.open.length === 0, v.open);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

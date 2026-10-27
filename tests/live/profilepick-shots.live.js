// The suite's one profile picker (profilepick.js) in every A1 program that has
// profiles: each page loads with empty storage, the picker is brought up, and
// it is checked and screenshotted at a desktop and a phone width.
//   node tests/live/profilepick-shots.live.js
// Screenshots land in the OS temp dir (cdp.js SHOTS).
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

const PAGES = 'https://anthonyn99.github.io/A1/';
const APPS = [
  { page: 'Shruti/shruti.html', title: 'Shruti', sub: 'Read · Listen · Watch · Study', names: 'TonyVeda' },
  { page: 'index.html', title: 'TaskHub', sub: 'Plan · Remind · Journal · Reflect', names: 'TonyVeda' },
  // MyList shows its picker once its lists have loaded; the harness refuses Firebase, so open it.
  { page: 'mylist.html', title: 'MyList', sub: 'Speak · List · Shop · Cook', names: 'TonyVeda', open: 'ML.goProfileSelect()' },
  { page: 'shield.html', title: 'Shield', sub: 'Guard · Watch · Lock · Recover', names: 'TV' },
  // MAGI's gate is the lock screen too: the profile chip opens it as a picker.
  { page: 'magi.html', title: 'MAGI', sub: 'Ask · Deliberate · Decide · Build', names: 'TonyVeda', open: 'openProfilePicker()' },
];

let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); if (!cond) fails++; };

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  for (const a of APPS) {
    console.log('\n' + a.page);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: PAGES + a.page });
    await sleep(1500);
    await evalJs(c, 'try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return 1;');
    await c.send('Page.navigate', { url: PAGES + a.page });
    await sleep(3500);
    await evalJs(c, `try { if (window.Guardian && Guardian.close) Guardian.close(); } catch (e) {}
      ${a.open ? 'try { ' + a.open + '; } catch (e) {}' : ''} return 1;`);
    await sleep(1800);
    const r = JSON.parse(await evalJs(c, `
      const pk = document.querySelector('.a1-pk');
      if (!pk) return JSON.stringify({ none: true });
      const t = pk.querySelector('.pk-title');
      return JSON.stringify({
        shown: getComputedStyle(pk).display !== 'none',
        title: t.textContent, weight: getComputedStyle(t).fontWeight,
        sub: pk.querySelector('.pk-sub').textContent, ask: pk.querySelector('.pk-ask').textContent,
        names: [...pk.querySelectorAll('.pk-card .nm')].map((n) => n.textContent).join(''),
        mark: !!pk.querySelector('.pk-mark svg'),
        cardW: Math.round(pk.querySelector('.pk-card').getBoundingClientRect().width),
      });`));
    ok('the picker is up', !r.none && r.shown, JSON.stringify(r));
    if (r.none) continue;
    ok('title ' + a.title + ', weight 600', r.title === a.title && r.weight === '600', r.title + ' ' + r.weight);
    ok('its own line: ' + a.sub, r.sub === a.sub, r.sub);
    ok('"Who goes there?"', r.ask === 'Who goes there?', r.ask);
    ok('the cards: ' + a.names, r.names === a.names, r.names);
    ok('the app mark', r.mark);
    ok('176px cards', r.cardW === 176, String(r.cardW));
    const slug = a.page.replace(/\W+/g, '-');
    let shot = await c.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(shotPath('pick-' + slug + '-1280'), Buffer.from(shot.result.data, 'base64'));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    ok('no sideways scroll on a phone', await evalJs(c, 'return document.documentElement.scrollWidth <= window.innerWidth;'));
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(shotPath('pick-' + slug + '-390'), Buffer.from(shot.result.data, 'base64'));
  }
  console.log(fails ? '\n' + fails + ' failed' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// A browser that has never opened Veda's MyList must ask for her password,
// even when MyList's own lists (and the lock flags inside them) have not
// loaded. Before 2026-10-27, Guardian's first-sight adoption read MyList's
// "no lock flag" as "the old lock opened it" and let the browser in for good.
//   node tests/live/mylist-lock-firstsight.live.js
// The harness refuses Firebase, so MyList's lists never load; the lock worker
// is faked to say both profiles have a password.
const { connect, evalJs, sleep } = require('./cdp.js');

const PAGE = 'https://anthonyn99.github.io/A1/mylist.html';
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
  handle(req) {
    const m = /^https:\/\/taskhub-reminders\.av1\.workers\.dev(\/[^?]*)/.exec(req.url);
    if (!m) return null;
    if (req.method === 'OPTIONS') return { status: 204, json: null };
    const path = m[1];
    if (path === '/auth/journal/status-many') {
      const body = JSON.parse(req.postData || '{}'), locks = {};
      for (const l of body.locks || []) locks[l.journal + ':' + l.entryId] = { hasLock: true, ver: 'v-' + l.entryId };
      return { json: { ok: true, locks } };
    }
    if (path === '/auth/journal/status') return { json: { ok: true, hasLock: true, noLock: false, ver: 'v-x' } };
    return { json: { ok: false } };
  },
};

let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); if (!cond) fails++; };

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: PAGE }); await sleep(1500);
  await evalJs(c, 'try { localStorage.clear(); sessionStorage.clear(); document.cookie.split(";").forEach(function (k) { document.cookie = k.split("=")[0].trim() + "=; Max-Age=0; path=/"; }); } catch (e) {} return 1;');
  await c.send('Page.navigate', { url: PAGE }); await sleep(3000);
  ok('the lists have not loaded (no lock flags known)', await evalJs(c, 'return JSON.stringify(state.locks) === "{}";'));
  await evalJs(c, "ML.chooseProfile('veda'); return 1;"); await sleep(2500);
  const r = JSON.parse(await evalJs(c, `return JSON.stringify({
    app: getComputedStyle(document.getElementById('app')).display,
    profile: document.body.getAttribute('data-profile'),
    card: !!document.querySelector('dialog[open], .gd-dim, [class*="guardian"]'),
    adopted: Object.keys(localStorage).filter(function (k) { return /^gd\\.u\\./.test(k); }) });`));
  ok("Veda's lists stay shut", r.app === 'none' && r.profile !== 'veda', JSON.stringify(r));
  ok('no unlocked marker was written for her', !r.adopted.some((k) => /profile_veda/.test(k)), JSON.stringify(r.adopted));
  console.log(fails ? '\n' + fails + ' failed' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

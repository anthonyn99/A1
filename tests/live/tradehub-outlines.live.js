// Every button in TradeHub has a visible outline (Tony, 2026-10-27: "ALL
// buttons in this program have outlines around them"). Visits each tab (and
// Analysis's search editor, Catalysts' Debrief panel, News' Filters panel) at
// desktop and phone width, and lists every visible button-like element whose
// border is missing or transparent on all four sides.
//
// Not buttons in look, so not held to it: the page tabs (an underline marks
// them), segments inside a .tbx-seg group (the group is the outline), the News
// pulse cells (cells of one bordered strip), the Control prompt rows (a list),
// Notebook's own controls (Notebook's look), and the app header's LifeHub and
// lock buttons (apphead.js's).
//
// Run: node tests/live/tradehub-outlines.live.js [--list]   (TH_PAGE_FILE=<copy> for a copy)
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io', URL = ORIGIN + '/A1/tradehub.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 2000) : '')); }
};
const NOW = Date.now();
const day = (n) => { const d = new Date(NOW + n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const EVENTS = [{ id: 'n1', primaryTicker: 'NVDA', sectors: ['Semiconductors'], impact: { tier: 'major', score: 70 }, sentiment: { label: 'bull', score: 0.5 }, aiAnalyzed: true, ts: NOW - 600000, summary: 'Nvidia up.',
  sources: [1, 2, 3, 4, 5, 6].map((i) => ({ headline: 'Headline ' + i, url: 'https://example.com/' + i, name: 'Src' + i, ts: NOW - i * 60000 })) }];
const worker = { patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (/\/news\?/.test(req.url)) return { json: { events: EVENTS, generatedAt: NOW - 60000, cached: true } };
    return { json: { ok: true } };
  } };

const AUDIT = `
  const skip = (b) => b.closest('.tb-navtab,.tbx-seg,.nh-pulse,.ctl-pr-list,#nb-park,[id$="-root"],a1-lifehub,.tb-desktop-header,.tb-mobile-header,guardian-lock')
    || b.classList.contains('a1-grip') || b.classList.contains('dsort-grip');
  const seen = (b) => { const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const outlined = (b) => { const s = getComputedStyle(b);
    return ['Top','Right','Bottom','Left'].some(k => parseFloat(s['border'+k+'Width']) > 0 && s['border'+k+'Style'] !== 'none' && !/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(s['border'+k+'Color'])); };
  return JSON.stringify([...document.querySelectorAll('#tradeboard-root button, #tradeboard-root [role=button]')]
    .filter(b => seen(b) && !skip(b) && !b.closest('[role=button]:not(:scope)') && !outlined(b))
    .map(b => (b.className && typeof b.className === 'string' ? '.' + b.className.trim().split(/\\s+/).join('.') : b.tagName.toLowerCase()) + ' "' + (b.innerText || b.getAttribute('aria-label') || b.title || '').trim().slice(0, 30) + '"'));`;

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const tab = async (id) => { await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); if(t) t.click(); 1`); await sleep(1100); };
  const click = (sel, re) => js(`var b=[...document.querySelectorAll('${sel}')].find(x=>x.offsetParent&&${re}.test(x.innerText)); if(b) b.click(); 1`).then(() => sleep(500));
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({
      'dashboards/tradeboard_prompts': { prompts: [{ id: 'p_a', name: 'Alpha', text: 'A' }, { id: 'p_b', name: 'Bravo', text: 'B' }] },
      'dashboards/tradeboard_watchlist': { tickers: ['NVDA','MU'], trash: [] },
      'dashboards/tradeboard_news': { events: ${JSON.stringify(EVENTS)}, generatedAt: ${NOW - 60000} },
      'dashboards/market_calendar': { events: [{ id: 'c1', date: '${day(0)}', kind: 'macro', category: 'fed', name: 'FOMC', importance: 'high' }], generatedAt: ${NOW}, wlSig: 'MU,NVDA' }
    })); 1`);

  for (const [w, h, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    await c.send('Page.navigate', { url: URL });
    await until("document.querySelector('.tb-navtab')", 15000); await sleep(2500);
    const views = [
      ['portfolio', null], ['journal', null], ['catalysts', null], ['catalysts', async () => click('#tradeboard-root .tbx-actions button', /debrief/i)],
      ['prompt', null], ['news', null], ['news', async () => click('#tradeboard-root .nh-tools button', /filters/i)],
      ['analysis', null], ['analysis', async () => click('#tradeboard-root .ana-card-head button', /edit/i)],
    ];
    for (const [id, extra] of views) {
      await tab(id);
      if (extra) await extra();
      const bad = JSON.parse(await js(AUDIT));
      ok(`${label} ${id}${extra ? ' (opened)' : ''}: every button has an outline`, bad.length === 0, bad.join(' | '));
    }
  }
  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

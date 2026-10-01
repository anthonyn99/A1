// LifeHub icon finder. Browsers can't read most sites' HTML (no CORS header), so
// this reads the page and returns the icon URLs it declares (<link rel=icon>,
// apple-touch-icon, then /favicon.ico). Only public http(s) pages; returns links
// only, never page content.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { ...CORS, 'Content-Type': 'application/json' } });

function publicHost(h) {
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return !/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return h.indexOf(':') < 0 && h.indexOf('.') > 0;
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET' } });
    let u;
    try { u = new URL(new URL(req.url).searchParams.get('u') || ''); } catch (e) { return json({ error: 'bad url' }, 400); }
    if (!/^https?:$/.test(u.protocol) || !publicHost(u.hostname)) return json({ error: 'not a public web page' }, 400);
    let html = '', base = u.href;
    try {
      const r = await fetch(u.href, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 LifeHubIcon', Accept: 'text/html' }, signal: AbortSignal.timeout(6000) });
      base = r.url || base;
      if (r.ok && /html/i.test(r.headers.get('content-type') || '')) html = (await r.text()).slice(0, 400000);
    } catch (e) {}
    const main = [], apple = [];
    const re = /<link\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(m[0]), hr = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      if (!rel || !hr || !/\bicon\b/i.test(rel[1])) continue;
      let abs; try { abs = new URL(hr[1].replace(/&amp;/g, '&'), base).href; } catch (e) { continue; }
      if (abs.length > 30000) continue;
      (/apple-touch/i.test(rel[1]) ? apple : main).push(abs);
    }
    main.push(...apple, new URL('/favicon.ico', base).href);
    return json({ icons: main });
  }
};

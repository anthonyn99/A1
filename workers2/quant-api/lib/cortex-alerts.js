// N8: Neo Cortex's alerts arrive here from quant-bot's outbox (A1-Priv docs/TradeHub/quant/n4-08.md; quant-bot
// lib/outbox.js). POST /alerts/cortex { items: [{ key, type, ts, title, body, route, symbol? }] } with the shared secret
// in `x-cortex-secret` (CORTEX_SECRET on both workers; no Orca key: quant-bot holds none). The kind `cortex` and its five
// switches (cfg.cortex: trades, changes, guards, research, brief; Control ▸ Alerts ▸ Neo Cortex) decide what is pushed;
// more than BURST trades in one minute become one summary push. Then lib/alerts.js fire(): once per key, quiet hours,
// the bell (alert_fires), the push to Tony's devices.
import { readCfg, fire, standingRules, push, pageUrl, tagOf } from './alerts.js';
import { json, fail } from './http.js';

export const TYPES = ['trades', 'changes', 'guards', 'research', 'brief'];
export const BURST = 3, ITEMS_MAX = 250;   // quant-bot sends at most 200 journal rows + 30 runs + 5 briefs
const KEY_RE = /^[\w:.\-]{1,80}$/, ROUTE_RE = /^cortex:[\w:.\-]{0,80}$/;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Constant-time string compare (the secret). */
export function same(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0 && a.length > 0;
}

/** Items from the body, checked. Bad ones are dropped (never the whole batch). */
export function itemsOf(body) {
  const list = Array.isArray(body && body.items) ? body.items.slice(0, ITEMS_MAX) : [];
  return list.filter((x) => x && KEY_RE.test(String(x.key)) && TYPES.includes(x.type) && ROUTE_RE.test(String(x.route || '')) && clip(x.title, 140))
    .map((x) => ({ key: String(x.key), type: x.type, ts: Number.isFinite(x.ts) ? x.ts : null, title: clip(x.title, 140), body: clip(x.body, 400), route: String(x.route),
      symbol: /^[A-Z][A-Z0-9.\-]{0,9}$/.test(String(x.symbol || '')) ? x.symbol : null }));
}

/** A minute with more than BURST trades → one summary item (its key from the first, so a retry dedupes). */
export function fold(items, tz = 'America/Denver') {
  const byMin = new Map();
  for (const it of items) if (it.type === 'trades' && it.ts) { const m = Math.floor(it.ts / 60_000); byMin.set(m, [...(byMin.get(m) || []), it]); }
  const folded = new Set(), out = [];
  for (const [m, list] of byMin) {
    if (list.length <= BURST) continue;
    list.forEach((x) => folded.add(x));
    const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(m * 60_000));
    // The key covers every folded trade: a resent minute with one more trade is a new summary, never a silent duplicate.
    out.push({ key: 'sum:' + tagOf(list.map((x) => x.key).sort().join('|')), type: 'trades', ts: m * 60_000, symbol: null, route: 'cortex:today',
      title: `Neo Cortex: ${list.length} trades at ${at}`, body: clip(list.map((x) => x.title.replace(/^Neo Cortex:\s*/, '')).join(' · '), 400) });
  }
  return [...items.filter((x) => !folded.has(x)), ...out];
}

/** POST /alerts/cortex. */
export async function cortexAlerts(env, req, now = Date.now(), { send = push } = {}) {
  if (!env.CORTEX_SECRET) throw fail(503, 'CORTEX_SECRET is not set on quant-api');
  if (!same(req.headers.get('x-cortex-secret'), env.CORTEX_SECRET)) throw fail(401, 'bad secret');
  let body = null;
  try { body = await req.json(); } catch (e) { throw fail(400, 'a JSON body is needed'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'the body is { items: [...] }');
  const items = itemsOf(body);
  const cfg = await readCfg(env);
  if (cfg.kinds.cortex === false) return json({ ok: true, skipped: 'Neo Cortex alerts are off', fired: [] });
  const wanted = fold(items.filter((x) => cfg.cortex[x.type] !== false), cfg.quiet.tz);
  // { dry: true }: quant-bot's probe (GET /alerts/probe there): the secret, the items and the switches, nothing pushed or kept.
  if (body.dry === true) return json({ ok: true, dry: true, received: items.length, would: wanted.map((x) => x.title) });
  if (!wanted.length) return json({ ok: true, fired: [], received: items.length });
  const rule = standingRules(cfg, [], ['cortex'])[0];
  const fired = await fire(env, wanted.map((x) => ({ rule, key: 'cx:' + x.key, kind: 'cortex', symbol: x.symbol, title: x.title, body: x.body, url: pageUrl(x.route) })), cfg, now, { send });
  return json({ ok: true, fired, received: items.length });
}

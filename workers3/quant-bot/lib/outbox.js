// N8: Neo Cortex's alerts (A1-Priv docs/TradeHub/quant/n4-08.md). After each cron tick the outbox reads what is new
// since its cursor (bot_outbox): journal moves (paper entries and exits), strategy changes, guards and the kill switch,
// ended strategist runs and a ready brief, and hands them to quant-api in ONE request (POST /alerts/cortex, secret
// CORTEX_SECRET on both workers). quant-api owns the switches (Control ▸ Alerts ▸ Neo Cortex), quiet hours, the bell and
// the push to Tony's devices. Nothing new = reads only; the cursor moves only after quant-api answered.
import { nyClock } from '../core/clock.js';

export const QUANT_API = 'https://quant-api.av1-2.workers.dev';
export const READ_MAX = 200, RUN_LOOKBACK = 6 * 3_600_000;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const px = (x) => (Number(x) >= 100 ? Number(x).toFixed(2) : String(Math.round(Number(x) * 10000) / 10000));

/** A stage event's key → its stage: `stage-<id>-<ver>-<stage>-<ms>` (moves) or `…-<YYYY-MM-DD>` (shadow verdicts). */
export function stageOf(key) {
  const m = /^stage-.+-\d+-([a-z]+)-(?:\d{4}-\d{2}-\d{2}|\d+)$/.exec(key || '');
  return m ? m[1] : 'changed';
}

/** A journal row → an alert item, or null when it is not one Tony hears about. */
export function eventItem(e) {
  if (e.kind === 'entry' || e.kind === 'exit') {
    const verb = e.kind === 'entry' ? (e.side === 'short' ? 'Short' : 'Buy') : (e.side === 'short' ? 'Cover' : 'Sell');
    return { key: 'ev:' + e.id, type: 'trades', ts: e.ts, symbol: e.symbol || null,
      title: clip(`Neo Cortex: ${verb} ${e.qty ?? ''} ${e.symbol || ''}${e.price ? ' at ' + px(e.price) : ''}`.replace(/\s+/g, ' '), 140), body: clip(e.why, 400), route: 'cortex:today:' + nyClock(e.ts).date + ':' + e.id };
  }
  // Tony's own settings saves (key settings-<version>) are his doing, not a strategy change: no alert.
  if ((e.kind === 'stage' && !String(e.event_key).startsWith('conviction-')) || (e.kind === 'edit' && !String(e.event_key).startsWith('settings-'))) {
    const stage = e.kind === 'edit' ? 'edited' : stageOf(e.event_key);
    return { key: 'ev:' + e.id, type: 'changes', ts: e.ts, title: clip(`Neo Cortex: ${e.strategy || 'a strategy'} ${stage === 'edited' ? 'edited' : '→ ' + stage}`, 140), body: clip(e.why, 400), route: 'cortex:strategies' };
  }
  if (e.kind === 'guard') {
    const kill = String(e.event_key || '').startsWith('kill-');
    return { key: 'ev:' + e.id, type: 'guards', ts: e.ts, title: kill ? 'Neo Cortex: kill switch pressed' : 'Neo Cortex: guard', body: clip(e.why, 400), route: 'cortex:status' };
  }
  return null;
}

/** An ended lab run → "research ready" (or "did not run"). */
export function runItem(r) {
  let res = [];
  try { res = JSON.parse(r.results || '[]'); } catch (e) {}
  const passed = res.filter((x) => x.pass).length, refused = res.filter((x) => x.pass === false).length, retired = res.filter((x) => x.retire).length;
  const when = r.session === 'postclose' ? 'After the close' : r.session === 'premarket' ? 'Before the open' : 'Research now';
  const failed = r.outcome === 'failed';
  return { key: 'run:' + r.id, type: 'research', ts: r.ended,
    title: failed ? 'Neo Cortex: strategist did not run' : 'Neo Cortex research ready',
    body: clip(failed ? r.summary : `${when}: ${passed} passed, ${refused} refused${retired ? ', ' + retired + ' retired' : ''}${r.outcome === 'no-edge' ? ' (no edge today)' : ''}.`, 400),
    route: 'cortex:lab' };
}

export const briefItem = (b) => ({ key: 'brief:' + b.day, type: 'brief', ts: b.readyAt || b.at, title: 'Neo Cortex brief ready', body: clip(b.headline, 400), route: 'cortex:brief:' + b.day });

/** GET /alerts/probe (Tony's key): a dry batch through the real path to quant-api; nothing is pushed or kept. */
export async function probeAlerts(env, { fetchFn = fetch } = {}) {
  if (!env.CORTEX_SECRET) return new Response(JSON.stringify({ ok: false, error: 'CORTEX_SECRET is not set on quant-bot' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const items = [{ key: 'probe:' + Date.now(), type: 'brief', ts: Date.now(), title: 'Neo Cortex brief ready', body: 'probe', route: 'cortex:status' }];
  const r = await fetchFn((env.QUANT_API_URL || QUANT_API) + '/alerts/cortex', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cortex-secret': env.CORTEX_SECRET }, body: JSON.stringify({ items, dry: true }) });
  const text = await r.text();
  return new Response(JSON.stringify({ ok: r.ok, status: r.status, quantApi: (() => { try { return JSON.parse(text); } catch (e) { return text.slice(0, 200); } })() }), { status: r.ok ? 200 : 502, headers: { 'content-type': 'application/json' } });
}

/** The cron's outbox step. → { learned } | { sent, items } | { skipped } | { error }. */
export async function flushOutbox(env, at, { fetchFn = fetch } = {}) {
  const db = env.DB;
  const cur = await db.prepare('SELECT event_id, run_end, brief_day, runs_sent, at FROM bot_outbox WHERE id = 1').first();
  if (!cur) return { skipped: 'no outbox (migrations 0008, 0009)' };
  const save = (c) => db.prepare('UPDATE bot_outbox SET event_id = ?, run_end = ?, brief_day = ?, runs_sent = ?, at = ? WHERE id = 1').bind(c.event_id, c.run_end, c.brief_day, JSON.stringify(c.runs_sent), at).run();
  if (cur.at == null) {   // first run: learn where things are, send nothing
    const [ev, run, br] = await Promise.all([
      db.prepare('SELECT MAX(id) AS id FROM bot_events').first(), db.prepare('SELECT MAX(ended) AS e FROM lab_runs').first(), db.prepare('SELECT MAX(day) AS d FROM bot_briefs').first()]);
    await save({ event_id: ev?.id || 0, run_end: run?.e || 0, brief_day: br?.d || '', runs_sent: [] });
    return { learned: true };
  }
  let sentRuns = [];
  try { sentRuns = JSON.parse(cur.runs_sent || '[]'); } catch (e) {}
  // A run's `ended` comes from the PC, not from insert order: look back RUN_LOOKBACK past the newest one sent and skip the
  // ids already sent, so a late or retried post is still announced once.
  const [evs, runs, briefs] = await Promise.all([
    db.prepare('SELECT id, event_key, ts, kind, symbol, side, qty, price, strategy, why FROM bot_events WHERE id > ? ORDER BY id LIMIT ?').bind(cur.event_id, READ_MAX).all(),
    db.prepare("SELECT id, session, outcome, summary, results, ended FROM lab_runs WHERE ended > ? AND outcome != 'running' ORDER BY ended LIMIT 30").bind(cur.run_end - RUN_LOOKBACK).all(),
    db.prepare('SELECT day, body FROM bot_briefs WHERE day > ? ORDER BY day LIMIT 5').bind(cur.brief_day).all(),
  ]);
  // An unreadable brief row is skipped (and passed), never left to stop every later alert.
  const briefRows = (briefs.results || []).map((r) => { try { return JSON.parse(r.body); } catch (e) { return { day: r.day, broken: true }; } });
  const ready = briefRows.filter((b) => b.ready && !b.broken), passed = briefRows.filter((b) => b.ready || b.broken);
  // Every new journal row moves the cursor, also those that make no alert (shadow, skip); at most READ_MAX a tick.
  const evRows = evs.results || [], runRows = (runs.results || []).filter((r) => !sentRuns.includes(r.id));
  const next = {
    event_id: evRows.length ? evRows[evRows.length - 1].id : cur.event_id,
    run_end: Math.max(cur.run_end, ...runRows.map((r) => r.ended)),
    brief_day: passed.length ? passed[passed.length - 1].day : cur.brief_day,
    runs_sent: [...runRows.map((r) => r.id), ...sentRuns].slice(0, 40),
  };
  // Never cut: at most READ_MAX events + 30 runs + 5 briefs (quant-api takes ITEMS_MAX 250 and folds a burst of trades).
  const items = [...evRows.map(eventItem), ...runRows.map(runItem), ...ready.map(briefItem)].filter(Boolean);
  if (next.event_id === cur.event_id && !runRows.length && next.brief_day === cur.brief_day) return { sent: 0, items: 0 };
  if (!items.length) { await save(next); return { sent: 0, items: 0 }; }
  if (!env.CORTEX_SECRET) { await save(next); return { skipped: 'CORTEX_SECRET is not set on quant-bot', items: items.length }; }
  let res;
  try {
    res = await fetchFn((env.QUANT_API_URL || QUANT_API) + '/alerts/cortex', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cortex-secret': env.CORTEX_SECRET }, body: JSON.stringify({ items, day: nyClock(at).date }) });
  } catch (e) { return { error: e.message || String(e), items: items.length }; }   // the cursor stays: next tick tries again
  // A 5xx, or 401/403 (the two secrets differ: fixed by setting them, then these go out), keep the cursor and try next
  // tick; quant-api dedupes by key, so nothing pushes twice. Only a 400 (a malformed batch) moves on.
  if (res.status >= 500 || res.status === 401 || res.status === 403) return { error: 'quant-api ' + res.status, items: items.length };
  await save(next);
  let j = {}; try { j = await res.json(); } catch (e) {}
  return res.ok ? { sent: (j.fired || []).length, items: items.length } : { error: 'quant-api ' + res.status + (j.error ? ': ' + j.error : ''), items: items.length };
}

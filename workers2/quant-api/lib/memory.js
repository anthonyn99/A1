// Memory cards and conversation history (A1-Priv docs/TradeHub/quant/phase-08.md).
// D1 tables memory_cards, history, history_turns (migrations/0008_memory.sql).
//
//   GET    /memory?state=active|proposed|archived|all   { cards }
//   POST   /memory { card: { kind, text, source, evidence? } }
//          source 'neo' is always stored as PROPOSED; only Tony's cards are active at once
//   PATCH  /memory/:id { text?, kind?, pinned?, state?, by }
//          state 'active' needs by: 'tony' (Neo can never activate a card)
//   DELETE /memory/:id
//   POST   /memory/used { ids }      last-used times (one batch)
//   GET    /history?since&limit      conversations, newest first, with turn counts and tickers
//   GET    /history/:id              { conversation, turns }
//   GET    /history/turns?since&limit   turns newer than `since` (the page's search index)
//   POST   /history/turn { conv, title?, turn: { role, text, verdict?, facts?, tickers?, mode?, model? } }
//          ONE row per turn (the conversation row is written once, with its first turn)
//   PATCH  /history/:id { pinned?, title? }
//   DELETE /history/:id
//   DELETE /history?confirm=delete-all   every conversation and turn
// At most MEMORY_ACTIVE active cards: making one more active archives the least
// recently used unpinned card(s) in the same batch.
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';

export const MEMORY_ACTIVE = 150, MEMORY_TEXT = 240, KINDS = ['preference', 'lesson', 'fact', 'pattern'], STATES = ['active', 'proposed', 'archived'];
export const TURN_TEXT = 20_000, HISTORY_LIST = 500;
const ID_RE = /^[a-z][0-9a-z_-]{5,40}$/;

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the memory tables are not there yet (D1 migration 0008_memory.sql)');
async function guarded(p, empty) { try { return await p; } catch (e) { if (noTable(e)) { if (empty !== undefined) return empty; throw notYet(); } throw e; } }
const batch = (env, stmts) => (env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const cardOut = (r) => ({ id: r.id, kind: r.kind, text: r.text, source: r.source, evidence: r.evidence, created: r.created, lastUsed: r.last_used, pinned: !!r.pinned, state: r.state });

/** The statement that archives the least recently used unpinned active cards past the cap (run after an activation). */
const capStmt = (env) => env.DB.prepare(`UPDATE memory_cards SET state = 'archived' WHERE id IN (SELECT id FROM memory_cards WHERE state = 'active' AND pinned = 0 `
  + `ORDER BY COALESCE(last_used, created) ASC LIMIT MAX(0, (SELECT COUNT(*) FROM memory_cards WHERE state = 'active') - ?))`).bind(MEMORY_ACTIVE);

export async function getMemory(env, url) {
  const st = url.searchParams.get('state') || 'all';
  if (st !== 'all' && !STATES.includes(st)) throw fail(400, 'state must be active, proposed, archived or all');
  const q = st === 'all' ? env.DB.prepare('SELECT * FROM memory_cards ORDER BY pinned DESC, COALESCE(last_used, created) DESC LIMIT 1000')
    : env.DB.prepare('SELECT * FROM memory_cards WHERE state = ? ORDER BY pinned DESC, COALESCE(last_used, created) DESC LIMIT 1000').bind(st);
  const rows = (await guarded(q.all(), { results: [] })).results || [];
  return json({ ok: true, cards: rows.map(cardOut) });
}
function checkText(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s) throw fail(400, 'a card needs text');
  if (s.length > MEMORY_TEXT) throw fail(400, `a card is at most ${MEMORY_TEXT} characters`);
  return s;
}
export async function postMemory(env, req) {
  const b = await bodyOf(req, 4000), c = b && b.card;
  if (!c || typeof c !== 'object') throw fail(400, 'card is needed');
  if (!KINDS.includes(c.kind)) throw fail(400, 'kind must be ' + KINDS.join(', '));
  const source = c.source === 'neo' ? 'neo' : 'tony', text = checkText(c.text), id = newId('m'), now = Date.now();
  // Neo only proposes; Tony's own card is active at once.
  const state = source === 'neo' ? 'proposed' : 'active';
  const stmts = [env.DB.prepare('INSERT INTO memory_cards (id, kind, text, source, evidence, created, last_used, pinned, state) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)')
    .bind(id, c.kind, text, source, c.evidence ? String(c.evidence).slice(0, 80) : null, now, state)];
  if (state === 'active') stmts.push(capStmt(env));
  await guarded(batch(env, stmts));
  return json({ ok: true, id, state });
}
export async function patchMemory(env, req, id) {
  if (!ID_RE.test(id)) throw fail(400, 'not a card id');
  const b = (await bodyOf(req, 4000)) || {};
  const row = await guarded(env.DB.prepare('SELECT * FROM memory_cards WHERE id = ?').bind(id).first());
  if (!row) throw fail(404, 'no such card');
  const sets = [], args = [];
  if (b.text != null) { sets.push('text = ?'); args.push(checkText(b.text)); }
  if (b.kind != null) { if (!KINDS.includes(b.kind)) throw fail(400, 'kind must be ' + KINDS.join(', ')); sets.push('kind = ?'); args.push(b.kind); }
  if (b.pinned != null) { sets.push('pinned = ?'); args.push(b.pinned ? 1 : 0); }
  if (b.state != null) {
    if (!STATES.includes(b.state)) throw fail(400, 'state must be ' + STATES.join(', '));
    if (b.state === 'active' && b.by !== 'tony') throw fail(403, 'only Tony can make a card active');
    sets.push('state = ?'); args.push(b.state);
  }
  if (!sets.length) return json({ ok: true, id, changed: false });
  const stmts = [env.DB.prepare(`UPDATE memory_cards SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id)];
  if (b.state === 'active' && row.state !== 'active') stmts.push(capStmt(env));
  await batch(env, stmts);
  return json({ ok: true, id, changed: true });
}
export async function deleteMemory(env, id) {
  if (!ID_RE.test(id)) throw fail(400, 'not a card id');
  await guarded(env.DB.prepare('DELETE FROM memory_cards WHERE id = ?').bind(id).run());
  return json({ ok: true, id });
}
export async function usedMemory(env, req) {
  const b = await bodyOf(req, 20000), ids = Array.isArray(b && b.ids) ? b.ids.filter((x) => ID_RE.test(String(x))).slice(0, 50) : [];
  if (!ids.length) throw fail(400, 'ids is needed');
  await guarded(env.DB.prepare('UPDATE memory_cards SET last_used = ? WHERE id IN (SELECT value FROM json_each(?))').bind(Date.now(), JSON.stringify(ids)).run());
  return json({ ok: true, n: ids.length });
}

/* ── history ─────────────────────────────────────────────────────────────── */
export async function getHistory(env, url) {
  const since = Number(url.searchParams.get('since')) || 0, limit = Math.max(1, Math.min(HISTORY_LIST, Number(url.searchParams.get('limit')) || 200));
  const rows = (await guarded(env.DB.prepare('SELECT h.id, h.title, h.created, h.pinned, MAX(t.at) AS updated, COUNT(t.id) AS turns, GROUP_CONCAT(t.tickers, \'|\') AS tk, GROUP_CONCAT(t.verdict, \'|\') AS vd '
    + 'FROM history h LEFT JOIN history_turns t ON t.conv = h.id GROUP BY h.id HAVING COALESCE(MAX(t.at), h.created) >= ? ORDER BY COALESCE(MAX(t.at), h.created) DESC LIMIT ?').bind(since, limit).all(), { results: [] })).results || [];
  return json({ ok: true, conversations: rows.map((r) => ({
    id: r.id, title: r.title, created: r.created, updated: r.updated || r.created, pinned: !!r.pinned, turns: r.turns,
    tickers: [...new Set(String(r.tk || '').split('|').flatMap((x) => parse(x, []) || []))].slice(0, 20),
    verdicts: [...new Set(String(r.vd || '').split('|').filter(Boolean))],
  })) });
}
/** GET /history/turns?since=ms&limit= → turns newer than `since`, oldest first (the page's search index, incrementally). */
export async function getTurnsSince(env, url) {
  const since = Number(url.searchParams.get('since')) || 0, limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 2000));
  const rows = (await guarded(env.DB.prepare('SELECT t.*, h.title, h.pinned FROM history_turns t JOIN history h ON h.id = t.conv WHERE t.at > ? ORDER BY t.at ASC LIMIT ?').bind(since, limit).all(), { results: [] })).results || [];
  return json({ ok: true, turns: rows.map((t) => ({ id: t.id, conv: t.conv, title: t.title, pinned: !!t.pinned, at: t.at, role: t.role, text: t.text, verdict: t.verdict, tickers: parse(t.tickers, []) })), more: rows.length === limit });
}
export async function getConversation(env, id) {
  const conv = await guarded(env.DB.prepare('SELECT * FROM history WHERE id = ?').bind(id).first());
  if (!conv) throw fail(404, 'no such conversation');
  const turns = (await env.DB.prepare('SELECT * FROM history_turns WHERE conv = ? ORDER BY at ASC, id ASC').bind(id).all()).results || [];
  return json({ ok: true, conversation: { id: conv.id, title: conv.title, created: conv.created, pinned: !!conv.pinned },
    turns: turns.map((t) => ({ id: t.id, at: t.at, role: t.role, text: t.text, verdict: t.verdict, facts: parse(t.facts, []), tickers: parse(t.tickers, []), mode: t.mode, model: t.model })) });
}
export async function postTurn(env, req) {
  const b = await bodyOf(req, TURN_TEXT + 4000), t = b && b.turn;
  const conv = String((b && b.conv) || '');
  if (!ID_RE.test(conv)) throw fail(400, 'conv (a conversation id) is needed');
  if (!t || !['q', 'a'].includes(t.role)) throw fail(400, 'turn.role must be q or a');
  const text = String(t.text || '');
  if (!text.trim()) throw fail(400, 'turn.text is needed');
  if (text.length > TURN_TEXT) throw fail(413, `a turn is at most ${TURN_TEXT} characters`);
  const now = Number.isFinite(t.at) ? Math.min(t.at, Date.now() + 60_000) : Date.now(), id = newId('t');
  const tickers = Array.isArray(t.tickers) ? [...new Set(t.tickers.map((x) => String(x).toUpperCase()).filter((x) => /^\^?[A-Z0-9.\-]{1,12}$/.test(x)))].slice(0, 20) : [];
  const facts = Array.isArray(t.facts) ? t.facts.map(String).slice(0, 40) : [];
  // The conversation row once (no write when it is already there), then the turn: one row per turn.
  await guarded(batch(env, [
    env.DB.prepare('INSERT INTO history (id, title, created, pinned) VALUES (?, ?, ?, 0) ON CONFLICT (id) DO NOTHING').bind(conv, b.title ? String(b.title).slice(0, 120) : text.slice(0, 80), now),
    env.DB.prepare('INSERT INTO history_turns (id, conv, at, role, text, verdict, facts, tickers, mode, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, conv, now, t.role, text, t.verdict ? String(t.verdict).slice(0, 20) : null, JSON.stringify(facts), JSON.stringify(tickers), t.mode === 'voice' ? 'voice' : 'text', t.model ? String(t.model).slice(0, 60) : null),
  ]));
  return json({ ok: true, id, conv });
}
export async function patchConversation(env, req, id) {
  const b = (await bodyOf(req, 2000)) || {}, sets = [], args = [];
  if (b.pinned != null) { sets.push('pinned = ?'); args.push(b.pinned ? 1 : 0); }
  if (b.title != null) { sets.push('title = ?'); args.push(String(b.title).slice(0, 120)); }
  if (!sets.length) throw fail(400, 'pinned or title is needed');
  await guarded(env.DB.prepare(`UPDATE history SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run());
  return json({ ok: true, id });
}
export async function deleteConversation(env, id) {
  await guarded(batch(env, [env.DB.prepare('DELETE FROM history_turns WHERE conv = ?').bind(id), env.DB.prepare('DELETE FROM history WHERE id = ?').bind(id)]));
  return json({ ok: true, id });
}
export async function deleteAllHistory(env, url) {
  if (url.searchParams.get('confirm') !== 'delete-all') throw fail(400, 'confirm=delete-all is needed');
  await guarded(batch(env, [env.DB.prepare('DELETE FROM history_turns'), env.DB.prepare('DELETE FROM history')]));
  return json({ ok: true });
}

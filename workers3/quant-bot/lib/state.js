import { LIMITS, tighten } from '../core/risk-book.js';
import { nyClock } from '../core/clock.js';
import { json } from './lab.js';
import { LIFE_DEFAULTS, lifeSettings, patchLife } from './lifecycle.js';

const MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable'].map((model) => 'claude_code/' + model));
const MODES = ['off', 'shadow', 'paper'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['entry', 'exit', 'stop-move', 'skip', 'shadow', 'guard', 'edit', 'stage']);
export const DEFAULTS = {
  mode: 'shadow',
  paused: false,
  limits: LIMITS,
  strategist: { premarket: 'claude_code/opus', postclose: 'claude_code/sonnet', instructions: '' },
  lifecycle: LIFE_DEFAULTS,
};
const error = (message, status = 400) => json({ ok: false, error: message }, status);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

export async function readSettings(db) {
  const row = await db.prepare('SELECT version, at, author, reason, body FROM bot_settings ORDER BY version DESC LIMIT 1').first();
  if (!row) return { version: 0, at: null, author: null, reason: null, settings: DEFAULTS };
  const body = JSON.parse(row.body);
  return { version: row.version, at: row.at, author: row.author, reason: row.reason, settings: { ...DEFAULTS, ...body, lifecycle: lifeSettings(body.lifecycle) } };
}

export async function getSettings({ DB }, url) {
  const current = await readSettings(DB);
  if (url.searchParams.get('history') !== '1') return json({ ok: true, ...current });
  const { results } = await DB.prepare('SELECT version, at, author, reason, body FROM bot_settings ORDER BY version DESC LIMIT 20').all();
  return json({ ok: true, ...current, history: results.map(({ body, ...row }) => ({ ...row, settings: JSON.parse(body) })) });
}

function updatedSettings(current, patch) {
  if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULTS, key))) throw new Error('unknown setting');
  const next = { ...current, ...patch };
  if (!MODES.includes(next.mode) || typeof next.paused !== 'boolean') throw new Error('mode must be off, shadow or paper and paused must be boolean');
  if ('limits' in patch) {
    if (!object(patch.limits) || Object.keys(patch.limits).some((key) => !Object.hasOwn(LIMITS, key))) throw new Error('unknown risk limit');
    const risk = patch.limits;
    const flags = new Set(['shortsAllowed', 'stopRequired']);
    const safeValue = (key, value) => flags.has(key) ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value);
    for (const [key, value] of Object.entries(risk)) {
      if (key === 'styleShare') {
        if (!object(value) || Object.entries(value).some(([style, share]) => !Object.hasOwn(LIMITS.styleShare, style) || !safeValue(style, share))) throw new Error('invalid style share');
      } else if (!safeValue(key, value)) throw new Error('invalid risk limit: ' + key);
    }
    const { limits, loosened } = tighten(LIMITS, patch.limits);
    if (loosened.length || limits.riskMinPct > limits.riskMaxPct || !Number.isInteger(limits.maxPositions)) throw new Error('invalid risk limits: ' + loosened.join(', '));
    next.limits = { ...current.limits, ...Object.fromEntries(Object.keys(patch.limits).map((key) => [key, limits[key]])) };
    if (patch.limits.styleShare) next.limits.styleShare = { ...current.limits.styleShare, ...patch.limits.styleShare };
    if (next.limits.riskMinPct > next.limits.riskMaxPct) throw new Error('risk range is inverted');
  }
  if ('lifecycle' in patch) next.lifecycle = patchLife(current.lifecycle, patch.lifecycle);
  if ('strategist' in patch) {
    if (!object(patch.strategist) || Object.keys(patch.strategist).some((key) => !Object.hasOwn(DEFAULTS.strategist, key))) throw new Error('unknown strategist setting');
    next.strategist = { ...current.strategist, ...patch.strategist };
    if (!MODELS.has(next.strategist.premarket) || !MODELS.has(next.strategist.postclose) ||
        typeof next.strategist.instructions !== 'string' || next.strategist.instructions.length > 4000) {
      throw new Error('choose a Claude Code model and use up to 4,000 characters of instructions');
    }
  }
  return next;
}

export async function putSettings({ DB }, body, now = Date.now()) {
  if (!object(body?.settings) || !Number.isInteger(body.version) || !['tony', 'claude'].includes(body.author) ||
      typeof body.reason !== 'string' || !body.reason.trim()) return error('settings, version, author and reason are needed');
  const current = await readSettings(DB);
  if (body.resume === true && (await readBotState(DB)).killPending) return error('the account still has unresolved orders or positions after the kill', 409);
  if (body.version !== current.version) return error('the settings changed, reload and retry', 409);
  let next;
  try { next = updatedSettings(current.settings, body.settings); } catch (e) { return error(e.message); }
  if (body.author === 'claude') {
    if (next.mode !== current.settings.mode || next.paused !== current.settings.paused || body.resume) return error('only Tony can change the bot mode, pause or resume', 403);
    if (tighten(current.settings.limits, next.limits).loosened.length) return error('only Tony can loosen limits', 403);
    if (JSON.stringify(next.lifecycle) !== JSON.stringify(current.settings.lifecycle)) return error('only Tony can change the lifecycle rules', 403);
  }
  if (next.mode === 'paper' && current.settings.mode !== 'paper') {
    const shadow = await DB.prepare('SELECT COUNT(*) AS count FROM bot_shadow_sessions').first();
    if (body.confirmPaper !== true || Number(shadow.count) < 2) return error('paper needs two shadow sessions and Tony’s confirmation', 409);
  }
  const version = current.version + 1;
  const author = body.author, reason = body.reason.trim().slice(0, 500), stamp = JSON.stringify(next);
  const allowed = body.resume === true ? ' WHERE (SELECT kill_pending FROM bot_state WHERE id = 1) = 0' : '';
  const insert = DB.prepare('INSERT OR IGNORE INTO bot_settings (version, at, author, reason, body) SELECT ?, ?, ?, ?, ?' + allowed).bind(version, now, author, reason, stamp);
  const audit = DB.prepare('INSERT OR IGNORE INTO bot_events (event_key, ts, day, kind, why) SELECT ?, ?, ?, ?, ? WHERE changes() = 1')
    .bind('settings-' + version, now, nyClock(now).date, 'edit', reason);
  const resume = DB.prepare('UPDATE bot_state SET halted = NULL, errors = 0 WHERE id = 1 AND changes() = 1');
  const changes = await DB.batch(body.resume === true ? [insert, audit, resume] : [insert, audit]);
  if (changes[0].meta.changes !== 1) return error('the settings changed, reload and retry', 409);
  return json({ ok: true, version, at: now, author, reason, settings: next });
}

export async function logEvent(db, e) {
  if (!e?.key || !KINDS.has(e.kind) || !e.why || !Number.isFinite(e.ts)) throw new Error('invalid bot event');
  return db.prepare('INSERT OR IGNORE INTO bot_events (event_key, ts, day, kind, symbol, side, qty, price, strategy, version, why, thesis, bar_time, fired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(e.key, e.ts, nyClock(e.ts).date, e.kind, e.symbol ?? null, e.side ?? null, e.qty ?? null, e.price ?? null, e.strategy ?? null, e.version ?? null, e.why, e.thesis ?? null,
      Number.isFinite(e.barTime) ? e.barTime : null, e.fired == null ? null : e.fired ? 1 : 0).run();
}

export async function readBotState(db) {
  const row = await db.prepare('SELECT halted, last_check, snapshot, errors, kill_pending FROM bot_state WHERE id = 1').first();
  return { ...(row.snapshot ? JSON.parse(row.snapshot) : {}), halted: row.halted, lastCheck: row.last_check, errors: row.errors, killPending: row.kill_pending === 1 };
}

export async function getState({ DB }) {
  const [status, settings, shadow] = await Promise.all([
    readBotState(DB), readSettings(DB), DB.prepare('SELECT COUNT(*) AS count FROM bot_shadow_sessions').first(),
  ]);
  return json({ ok: true, ...status, mode: settings.settings.mode, paused: settings.settings.paused, settingsVersion: settings.version, shadowSessions: shadow.count });
}

export async function getToday(req, { DB }, url, now = Date.now()) {
  const day = url.searchParams.get('day') || nyClock(now).date;
  const since = Number(url.searchParams.get('since') || 0);
  if (!DAY.test(day) || !Number.isSafeInteger(since) || since < 0) return error('day must be YYYY-MM-DD and since must be a timestamp');
  const newest = await DB.prepare('SELECT MAX(id) AS id FROM bot_events WHERE day = ? AND ts >= ?').bind(day, since).first();
  const etag = '"neo-' + day + '-' + since + '-' + (newest.id || 0) + '"';
  const headers = { 'cache-control': 'no-cache', 'content-type': 'application/json; charset=utf-8', etag };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const { results } = await DB.prepare('SELECT id, ts, kind, symbol AS sym, side, qty, price, strategy, version, why, thesis FROM bot_events WHERE day = ? AND ts >= ? AND id <= ? ORDER BY ts DESC, id DESC LIMIT 200').bind(day, since, newest.id || 0).all();
  return new Response(JSON.stringify({ ok: true, day, events: results }), { headers });
}

export async function getBrief({ DB }, day) {
  if (!DAY.test(day)) return error('day must be YYYY-MM-DD');
  const row = await DB.prepare('SELECT at, body FROM bot_briefs WHERE day = ?').bind(day).first();
  return json({ ok: true, day, at: row?.at ?? null, brief: row ? JSON.parse(row.body) : null });
}

// quant-api, Phase 8 (A1-Priv docs/TradeHub/quant/phase-08.md): Google Drive
// (connect, callback, the sealed token, refresh, upload, dedupe, revisions,
// list, read, delete, disconnect), memory cards (Neo proposes, Tony accepts,
// the 150 cap), conversation history (one row per turn), the archive
// primitives (export, the 30-day move, purge) and restore into an empty
// database. The worker runs against a REAL SQLite (node:sqlite) with every
// migration applied, so the SQL itself is tested, and a fake Google.
//
// Run: node tests/quant-memory-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const MIG = path.join(__dirname, '..', 'workers2', 'quant-api', 'migrations');

/** D1's API over node:sqlite, every migration applied. `db.writes` counts rows changed. */
function realD1() {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); db.writes += Number(r.changes) || 0; return { meta: { changes: r.changes } }; },
  });
  const db = { writes: 0, sql, prepare: (q) => stmt(q), async batch(list) { sql.exec('BEGIN'); try { for (const s of list) await s.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return []; } };
  return db;
}

/* ── a fake Google ─────────────────────────────────────────────────────── */
const G = { calls: [], files: new Map(), next: 1, refreshes: 0, revoked: 0, reset() { this.calls.length = 0; } };
const res = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = (init.method || 'GET').toUpperCase();
  G.calls.push(method + ' ' + u.split('?')[0]);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const b = new URLSearchParams(String(init.body));
    if (b.get('grant_type') === 'authorization_code') return b.get('code') === 'good' ? res({ access_token: 'at1', refresh_token: 'rt-secret-123', expires_in: 3600 }) : res({ error: 'invalid_grant' }, 400);
    G.refreshes++;
    return b.get('refresh_token') === 'rt-secret-123' ? res({ access_token: 'at' + (G.refreshes + 1), expires_in: 3600 }) : res({ error: 'invalid_grant' }, 400);
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) { G.revoked++; return res({}); }
  if (u.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return res({ email: 'tony@example.com' });
  if (u.startsWith('https://upload.example/session/')) {   // the resumable session URL
    const id = u.split('/').pop(), f = G.files.get(id);
    f.body = Buffer.from(await new Response(init.body).arrayBuffer());
    return res({ id });
  }
  const auth = new Headers(init.headers || {}).get('authorization') || '';
  if (!/^Bearer at\d+$/.test(auth)) return res({ error: 'unauthenticated' }, 401);
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?fields=files')) {
    const q = decodeURIComponent(u.split('q=')[1] || ''), name = /name = '([^']+)'/.exec(q)[1], parent = /'([^']+)' in parents/.exec(q)[1];
    const hit = [...G.files.entries()].find(([, f]) => f.folder && f.name === name && f.parent === parent);
    return res({ files: hit ? [{ id: hit[0] }] : [] });
  }
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && method === 'POST') {
    const b = JSON.parse(init.body), id = 'fold' + (G.next++) + 'xxxxxxxx';
    G.files.set(id, { folder: true, name: b.name, parent: b.parents[0] });
    return res({ id });
  }
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
    const b = JSON.parse(init.body), id = 'file' + (G.next++) + 'xxxxxxxx';
    G.files.set(id, { name: b.name, parent: b.parents[0], revisions: 1, tag: !!(b.appProperties && b.appProperties.tradehub === '1') });
    return new Response('', { status: 200, headers: { location: 'https://upload.example/session/' + id } });
  }
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?pageSize=100')) {   // backups by TradeHub's app tag (a new database)
    return res({ files: [...G.files.entries()].filter(([, f]) => !f.folder && !f.trashed && /^d1-/.test(f.name) && f.tag).map(([id, f]) => ({ id, name: f.name, size: String(f.body ? f.body.length : 0), mimeType: 'application/gzip', modifiedTime: '2026-11-13T00:00:00Z' })) });
  }
  const m = /\/files\/([\w-]+)/.exec(u), id = m && m[1], f = id && G.files.get(id);
  if (method === 'GET' && u.includes('?fields=id,name,trashed')) return f ? res({ id, name: f.name, trashed: !!f.trashed, mimeType: 'application/octet-stream', appProperties: f.tag ? { tradehub: '1' } : {} }) : res({}, 404);
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files/') && method === 'PATCH') {
    if (!f) return res({}, 404);
    f.body = Buffer.from(await new Response(init.body).arrayBuffer()); f.revisions++;
    return res({ id });
  }
  if (u.includes('alt=media')) return f ? new Response(f.body, { status: 200 }) : res({}, 404);
  if (method === 'DELETE') { if (!f) return res({}, 404); G.files.delete(id); return new Response(null, { status: 204 }); }
  return res({ error: 'unexpected ' + method + ' ' + u }, 500);
};

(async () => {
  const W = (await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'worker.js')).href)).default;
  const DR = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'drive.js')).href);
  const KEY = 'orca_sk_test_memory_0123456789', OTHER = 'orca_sk_test_vedas_9876543210';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const mkEnv = () => ({ DB: realD1(), ALLOWED_KEYS: hash(KEY), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', DRIVE_KEY: crypto.randomBytes(32).toString('base64') });
  const call = async (env, p, { method = 'GET', body, key = KEY, raw = false, type } = {}) => {
    const headers = { ...(key ? { authorization: 'Bearer ' + key } : {}) };
    let b = body;
    if (body != null && !raw) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
    if (type) headers['content-type'] = type;
    const r = await W.fetch(new Request('https://quant-api.test' + p, { method, headers, body: b }), env, null);
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, body: j, text, headers: r.headers };
  };
  let env = mkEnv(), r;

  console.log('\nGoogle Drive: connect');
  r = await call(env, '/drive/health');
  ok('health: set up, not connected yet', r.status === 200 && r.body.configured && !r.body.connected);
  ok('a key quant-api does not accept is refused (another profile\'s)', (await call(env, '/drive/health', { key: OTHER })).status === 403 && (await call(env, '/drive/connect', { method: 'POST', key: OTHER })).status === 403);
  r = await call(env, '/drive/connect', { method: 'POST' });
  const consent = new URL(r.body.url), state = consent.searchParams.get('state');
  ok('connect gives Google\'s consent page: drive.file + email, offline, back to /drive/callback', consent.host === 'accounts.google.com' && /drive\.file/.test(consent.searchParams.get('scope')) && consent.searchParams.get('access_type') === 'offline' && consent.searchParams.get('redirect_uri') === 'https://quant-api.test/drive/callback' && /^\d+\.[\w-]+$/.test(state));
  r = await call(env, '/drive/callback?code=good&state=' + encodeURIComponent(state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), { key: null });
  ok('a tampered state: "Link expired", nothing kept', /Link expired/.test(r.text) && !(await env.DB.prepare("SELECT v FROM meta WHERE k = 'drive:token'").first()));
  r = await call(env, `/drive/callback?code=good&state=${encodeURIComponent(state)}`, { key: null });
  ok('the callback needs no Orca key (a browser tab) and connects', r.status === 200 && /Google Drive connected/.test(r.text) && /tony@example\.com/.test(r.text));
  const sealed = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'drive:token'").first()).v;
  ok('the refresh token is kept in D1 sealed (AES-GCM), never in the clear', /^v1\./.test(sealed) && !sealed.includes('rt-secret-123') && (await DR.open(env, sealed)).refresh_token === 'rt-secret-123');
  ok('...and nobody without DRIVE_KEY can open it', (await DR.open({ ...env, DRIVE_KEY: crypto.randomBytes(32).toString('base64') }, sealed)) === null);
  r = await call(env, '/drive/health');
  ok('health: connected, the account\'s email', r.body.connected && r.body.email === 'tony@example.com');

  console.log('\nGoogle Drive: files');
  G.reset();
  r = await call(env, '/drive/f?path=ledger/2026-11.jsonl', { method: 'PUT', raw: true, body: '{"id":"s1"}\n' });
  ok('a file lands under TradeHub/ledger/, folders made on the way', r.status === 200 && r.body.path === 'TradeHub/ledger/2026-11.jsonl' && !r.body.skipped && G.calls.filter((c) => c.startsWith('POST https://www.googleapis.com/drive/v3/files')).length === 2, JSON.stringify(r.body));
  const fid = r.body.id;
  ok('...the bytes are there', G.files.get(fid).body.toString() === '{"id":"s1"}\n');
  G.reset();
  r = await call(env, '/drive/f?path=ledger/2026-11.jsonl', { method: 'PUT', raw: true, body: '{"id":"s1"}\n' });
  ok('the same content again: not uploaded (SHA-256 dedupe), no Drive call', r.body.skipped && G.calls.length === 0);
  r = await call(env, '/drive/f?path=ledger/2026-11.jsonl', { method: 'PUT', raw: true, body: '{"id":"s1"}\n{"id":"s2"}\n' });
  ok('new content at the same path: a new revision of the same file', !r.body.skipped && r.body.id === fid && G.files.get(fid).revisions === 2);
  G.reset();
  await call(env, '/drive/f?path=ledger/2026-10.jsonl', { method: 'PUT', raw: true, body: 'x' });
  ok('a second file in a known folder: folders come from D1 (no lookup)', !G.calls.some((c) => /files$/.test(c) && c.startsWith('GET')));
  ok('paths that climb or are odd are refused', (await call(env, '/drive/f?path=../x', { method: 'PUT', raw: true, body: 'x' })).status === 400 && (await call(env, '/drive/f?path=a/<b>', { method: 'PUT', raw: true, body: 'x' })).status === 400);
  r = await call(env, '/drive/list?prefix=ledger/');
  ok('list: from D1, newest name first', r.body.files.map((f) => f.path).join() === 'TradeHub/ledger/2026-11.jsonl,TradeHub/ledger/2026-10.jsonl');
  r = await call(env, '/drive/f/' + fid);
  ok('read a file back', r.status === 200 && r.text === '{"id":"s1"}\n{"id":"s2"}\n' && r.headers.get('x-path') === 'TradeHub/ledger/2026-11.jsonl');
  DR.forget(); G.refreshes = 0;
  r = await call(env, '/drive/f/' + fid);
  ok('an expired access token is refreshed with the sealed refresh token', r.status === 200 && G.refreshes === 1);
  r = await call(env, '/drive/f/' + fid, { method: 'DELETE' });
  ok('delete: gone from Drive and from the list', r.status === 200 && !G.files.has(fid) && (await call(env, '/drive/list?prefix=ledger/')).body.files.length === 1);
  ok('a file quant-api did not make cannot be read or deleted', (await call(env, '/drive/f/someoneelsesfile123', {})).status === 404 && (await call(env, '/drive/f/someoneelsesfile123', { method: 'DELETE' })).status === 404);
  // Tony empties things in Drive by hand: a trashed folder and a trashed file are noticed, not written into.
  r = await call(env, '/drive/f?path=backtests/a.json', { method: 'PUT', raw: true, body: '{"a":1}' });
  const aId = r.body.id, btFolder = G.files.get(aId).parent;
  G.files.get(btFolder).trashed = true; G.files.get(aId).trashed = true; DR.forgetSeen(); G.reset();
  r = await call(env, '/drive/f?path=backtests/a.json', { method: 'PUT', raw: true, body: '{"a":1}' });
  ok('a trashed file is uploaded afresh (not "skipped" into the trash), into a new folder', !r.body.skipped && r.body.id !== aId && G.files.get(r.body.id).parent !== btFolder && !G.files.get(G.files.get(r.body.id).parent).trashed);
  const env0 = mkEnv(); env0.DRIVE_KEY = env.DRIVE_KEY;
  await env0.DB.prepare("INSERT INTO meta (k, v, at) VALUES ('drive:token', ?, 1)").bind(sealed).run();
  await call(env, '/drive/f?path=backup/d1-2026-11-13.json.gz', { method: 'PUT', raw: true, body: 'gz', type: 'application/gzip' });
  r = await call(env0, '/drive/list?prefix=backup/&drive=1');
  ok('a NEW database finds the backups in Drive by TradeHub\'s app tag', r.body.fromDrive && r.body.files.some((x) => /d1-2026-11-13\.json\.gz$/.test(x.path)), JSON.stringify(r.body));
  r = await call(env0, '/drive/f/' + r.body.files[0].id);
  ok('...and can read one (tagged as TradeHub\'s), so a restore by id works', r.status === 200 && r.text === 'gz');
  r = await call(env, '/drive/disconnect', { method: 'POST' });
  ok('disconnect revokes the token and forgets it', r.status === 200 && G.revoked === 1 && !(await call(env, '/drive/health')).body.connected);
  DR.forget();
  ok('...then uploads say Drive is not connected (409)', (await call(env, '/drive/f?path=x/y.json', { method: 'PUT', raw: true, body: '{}' })).status === 409);
  ok('without the secrets connect says what is missing', (await call({ ...env, GOOGLE_CLIENT_ID: '' }, '/drive/connect', { method: 'POST' })).status === 503);

  console.log('\nMemory cards');
  env = mkEnv();
  r = await call(env, '/memory', { method: 'POST', body: { card: { kind: 'lesson', text: 'Do not chase a gap over 3% at the open', source: 'neo', evidence: 't123' } } });
  const proposed = r.body.id;
  ok('Neo\'s card is stored as PROPOSED', r.body.state === 'proposed');
  r = await call(env, '/memory/' + proposed, { method: 'PATCH', body: { state: 'active', by: 'neo' } });
  ok('Neo cannot make a card active (403)', r.status === 403);
  r = await call(env, '/memory/' + proposed, { method: 'PATCH', body: { state: 'active', by: 'tony' } });
  ok('Tony accepts it: active', r.status === 200 && (await call(env, '/memory?state=active')).body.cards.some((c) => c.id === proposed));
  await call(env, '/memory/' + proposed, { method: 'PATCH', body: { text: 'Do not chase a gap over 3% in the first 5 minutes', pinned: true } });
  r = await call(env, '/memory?state=active');
  ok('...he edits and pins it', r.body.cards[0].text === 'Do not chase a gap over 3% in the first 5 minutes' && r.body.cards[0].pinned);
  r = await call(env, '/memory', { method: 'POST', body: { card: { kind: 'preference', text: 'Swing trades only on Fridays', source: 'tony' } } });
  ok('Tony\'s own card is active at once', r.body.state === 'active');
  ok('a card over 240 characters or of an unknown kind is refused', (await call(env, '/memory', { method: 'POST', body: { card: { kind: 'fact', text: 'x'.repeat(241), source: 'tony' } } })).status === 400 && (await call(env, '/memory', { method: 'POST', body: { card: { kind: 'mood', text: 'x', source: 'tony' } } })).status === 400);
  ok('a card that does not say whose it is is refused (never taken as Tony\'s)', (await call(env, '/memory', { method: 'POST', body: { card: { kind: 'fact', text: 'who?' } } })).status === 400);
  r = await call(env, '/memory/' + proposed, { method: 'DELETE' });
  ok('he deletes one', r.status === 200 && !(await call(env, '/memory')).body.cards.some((c) => c.id === proposed));
  // The 150 cap: 150 active (one pinned, the oldest), then one more.
  env = mkEnv();
  const now = Date.now(), ins = env.DB.sql.prepare("INSERT INTO memory_cards (id, kind, text, source, created, last_used, pinned, state) VALUES (?, 'fact', 'x', 'tony', ?, ?, ?, 'active')");
  for (let i = 0; i < 150; i++) ins.run('mcard' + String(i).padStart(4, '0'), now - 1e6 + i, now - 1e6 + i, i === 0 ? 1 : 0);
  r = await call(env, '/memory', { method: 'POST', body: { card: { kind: 'fact', text: 'the 151st', source: 'tony' } } });
  const act = (await call(env, '/memory?state=active')).body.cards.map((c) => c.id), arch = (await call(env, '/memory?state=archived')).body.cards.map((c) => c.id);
  ok('at most 150 active: the least recently used UNPINNED one is archived (the pinned oldest stays)', act.length === 150 && arch.join() === 'mcard0001' && act.includes('mcard0000') && act.includes(r.body.id), arch.join());
  await call(env, '/memory/used', { method: 'POST', body: { ids: ['mcard0002'] } });
  await call(env, '/memory', { method: 'POST', body: { card: { kind: 'fact', text: 'the 152nd', source: 'tony' } } });
  ok('...a card just used is kept; the next least recently used goes', (await call(env, '/memory?state=archived')).body.cards.map((c) => c.id).sort().join() === 'mcard0001,mcard0003');
  // At the cap, accepting an old proposal (or restoring an archived card) keeps THAT card: it counts as just used.
  env.DB.sql.prepare("INSERT INTO memory_cards (id, kind, text, source, created, last_used, pinned, state) VALUES ('mproposal10d', 'lesson', 'old idea', 'neo', ?, NULL, 0, 'proposed')").run(now - 10 * 86400000);
  await call(env, '/memory/mproposal10d', { method: 'PATCH', body: { state: 'active', by: 'tony' } });
  await call(env, '/memory/mcard0001', { method: 'PATCH', body: { state: 'active', by: 'tony' } });
  const act2 = (await call(env, '/memory?state=active')).body.cards.map((c) => c.id);
  ok('at the cap, an accepted proposal and a restored card stay active (an older one is archived instead)', act2.length === 150 && act2.includes('mproposal10d') && act2.includes('mcard0001'));

  console.log('\nHistory');
  env = mkEnv();
  const w0 = env.DB.writes;
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'cabcdef1', turn: { role: 'q', text: 'Is NVDA a buy here?', tickers: ['nvda'], mode: 'voice' } } });
  const w1 = env.DB.writes;
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'cabcdef1', turn: { role: 'a', text: 'WATCH: base breakout not confirmed.', verdict: 'WATCH', tickers: ['NVDA'], facts: ['f1'], model: 'groq' } } });
  const w2 = env.DB.writes;
  ok('one row per turn (the conversation row only with the first)', w1 - w0 === 2 && w2 - w1 === 1, `${w1 - w0}, ${w2 - w1}`);
  r = await call(env, '/history');
  ok('the list: title from the first question, turns, tickers, verdicts', r.body.conversations.length === 1 && r.body.conversations[0].turns === 2 && r.body.conversations[0].title === 'Is NVDA a buy here?' && r.body.conversations[0].tickers.join() === 'NVDA' && r.body.conversations[0].verdicts.join() === 'WATCH');
  r = await call(env, '/history/cabcdef1');
  ok('a conversation\'s turns in order, with mode, model, facts', r.body.turns.length === 2 && r.body.turns[0].mode === 'voice' && r.body.turns[1].model === 'groq' && r.body.turns[1].facts[0] === 'f1');
  r = await call(env, '/history/turns?after=0');
  const seq2 = r.body.turns[1].seq;
  ok('turns after a cursor, in stored order, with their conversation (the search index reads these)', r.body.turns.length === 2 && r.body.turns[0].title === 'Is NVDA a buy here?' && r.body.turns[1].verdict === 'WATCH' && (await call(env, '/history/turns?after=' + seq2)).body.turns.length === 0);
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'cabcdef1', turn: { role: 'q', text: 'from a phone whose clock is behind', at: Date.now() - 3600000 } } });
  ok('...a turn stamped EARLIER (a clock behind) still comes after the cursor: the order is the database\'s, not the clock\'s', (await call(env, '/history/turns?after=' + seq2)).body.turns.map((t) => t.text).join() === 'from a phone whose clock is behind');
  await call(env, '/history/cabcdef1', { method: 'PATCH', body: { pinned: true } });
  ok('pin', (await call(env, '/history')).body.conversations[0].pinned);
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'cold00001', turn: { role: 'q', text: 'old question', at: Date.now() - 40 * 86400000 } } });
  env.DB.sql.prepare("UPDATE history SET created = ? WHERE id = 'cold00001'").run(Date.now() - 40 * 86400000);
  env.DB.sql.prepare("UPDATE history_turns SET at = ? WHERE conv = 'cabcdef1'").run(Date.now() - 50 * 86400000);
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'cold00002', turn: { role: 'q', text: 'another old one', at: Date.now() - 45 * 86400000 } } });
  env.DB.sql.prepare("UPDATE history SET created = ? WHERE id = 'cold00002'").run(Date.now() - 45 * 86400000);
  r = await call(env, '/history/old?days=30');
  const before = r.body.before;
  ok('the 30-day rule: only the unpinned old conversations, with their turns and the cut used', r.body.conversations.map((c) => c.id).sort().join() === 'cold00001,cold00002' && r.body.conversations[0].turns.length === 1 && before > 0);
  ok('purge needs the cut', (await call(env, '/history/purge', { method: 'POST', body: { ids: ['cold00001'] } })).status === 400);
  // While the archive was busy, Tony continued cold00002: its new turn must not be purged unarchived.
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'cold00002', turn: { role: 'q', text: 'continued just now' } } });
  r = await call(env, '/history/purge', { method: 'POST', body: { ids: ['cold00001', 'cold00002', 'cabcdef1'], before } });
  const left = (await call(env, '/history')).body.conversations.map((c) => c.id).sort();
  ok('purge removes only what is still old: the pinned one stays, the one continued since stays', left.join() === 'cabcdef1,cold00002' && r.body.ids.join() === 'cold00001' && !(await env.DB.prepare("SELECT 1 AS x FROM history_turns WHERE conv = 'cold00001'").first()));
  ok('delete all needs the confirmation', (await call(env, '/history', { method: 'DELETE' })).status === 400 && (await call(env, '/history?confirm=delete-all', { method: 'DELETE' })).status === 200 && !(await call(env, '/history')).body.conversations.length);

  console.log('\nBackup and restore');
  env = mkEnv();
  env.DB.sql.exec("INSERT INTO signals (id, symbol, setup, horizon, dir, at, expires, verdict, score, regime, by, created, body, status, done) VALUES ('sx1', 'NVDA', 'orb', 'day', 'long', 1, 2, 'GO', 80, 'On', 'page', 3, '{}', 'open', 0)");
  env.DB.sql.exec("INSERT INTO meta (k, v, at) VALUES ('watchlist', '[\"NVDA\"]', 1), ('drive:token', 'v1.secret', 1)");
  await call(env, '/memory', { method: 'POST', body: { card: { kind: 'fact', text: 'kept across a restore', source: 'tony' } } });
  await call(env, '/history/turn', { method: 'POST', body: { conv: 'crestore1', turn: { role: 'q', text: 'hello' } } });
  r = await call(env, '/export/tables');
  const tables = r.body.tables;
  ok('export lists every table (not Cloudflare\'s or SQLite\'s own)', tables.some((t) => t.table === 'signals' && t.rows === 1) && tables.some((t) => t.table === 'memory_cards') && !tables.some((t) => /^(_cf_KV|d1_migrations|sqlite_)/.test(t.table)));
  ok('...the Drive token is never in a backup', tables.find((t) => t.table === 'meta').rows === 1);
  const dump = {};
  for (const t of tables) { dump[t.table] = []; for (let off = 0; ; off += 500) { const p = await call(env, `/export?table=${t.table}&offset=${off}`); dump[t.table].push(...p.body.rows); if (!p.body.more) break; } }
  const env2 = mkEnv();
  // The new database is already alive: Drive connected (its token) and a usage row, as any worker call makes.
  env2.DB.sql.exec("INSERT INTO meta (k, v, at) VALUES ('drive:token', 'v1.new', 5); INSERT INTO usage (day, service, n) VALUES ('2026-11-14', 'yahoo', 3)");
  ok('restore needs the typed confirmation', (await call(env2, '/restore', { method: 'POST', body: { table: 'signals', rows: dump.signals } })).status === 400);
  const codes = [];
  for (const [t, rows] of Object.entries(dump)) for (let i = 0; i < Math.max(1, rows.length); i += 100) codes.push((await call(env2, '/restore', { method: 'POST', body: { confirm: 'restore into an empty database', table: t, rows: rows.slice(i, i + 100), offset: i } })).status);
  ok('...on a database already alive (Drive token, usage rows) every table restores (no false "not empty")', codes.every((s) => s === 200), codes.join());
  ok('...its own Drive token is kept, never replaced from a backup', (await env2.DB.prepare("SELECT v FROM meta WHERE k = 'drive:token'").first()).v === 'v1.new');
  ok('at most 100 rows a call', (await call(mkEnv(), '/restore', { method: 'POST', body: { confirm: 'restore into an empty database', table: 'signals', rows: Array(101).fill({ id: 'x' }), offset: 0 } })).status === 400);
  const same = await (async () => { for (const t of tables) { const a = (await call(env, `/export?table=${t.table}`)).body.rows, b = (await call(env2, `/export?table=${t.table}`)).body.rows; if (JSON.stringify(a) !== JSON.stringify(b)) return t.table; } return true; })();
  ok('a backup restored into an empty database reproduces every table', same === true, same);
  r = await call(env2, '/restore', { method: 'POST', body: { confirm: 'restore into an empty database', table: 'signals', rows: dump.signals, offset: 0 } });
  ok('...and a restore over live data is refused (409)', r.status === 409);
  ok('unknown tables are refused', (await call(env, '/export?table=sqlite_master')).status === 400 && (await call(env, '/export?table=drop%20table')).status === 400);

  console.log('\nFile rules');
  const src = ['drive.js', 'memory.js', 'archive.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', f), 'utf8')).join('\n');
  ok('no KV anywhere in Phase 8\'s worker code', !/env\.(KV|[A-Z_]*KV)\b|\.put\(.*kv/i.test(src.replace(/no KV|never KV|not KV/gi, '')));
  const mig = fs.readFileSync(path.join(MIG, '0008_memory.sql'), 'utf8').replace(/--.*$/gm, '');
  ok('migration 0008 only adds', !/\b(DROP|ALTER|DELETE|UPDATE)\b/i.test(mig) && /CREATE TABLE IF NOT EXISTS memory_cards/.test(mig));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

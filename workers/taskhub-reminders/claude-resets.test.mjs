// Harness: load worker.js, expose handleClaudeResets, and run it against a fake
// Firestore. No network, no Cloudflare. Pins the three promises the endpoint
// makes: a wrong token writes nothing, an old reset's reminder is deleted when
// a new one arrives, and a reminder that already exists is never overwritten
// (an overwrite would set fired:false and ring it a second time).
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import assert from 'assert/strict';

const SP = mkdtempSync(join(tmpdir(), 'crtest-'));
let src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?\n\};/m, '');
src = src.replace('async function getGoogleAccessToken(env) {',
                  "async function getGoogleAccessToken(env) { return 'svc';");
src += '\nexport { handleClaudeResets, claudeResetList };\n';
writeFileSync(SP + '/_w.mjs', src);

// ── a fake Firestore, just the REST shapes the handler uses ─────────────────
const DOCS = new Map();   // "dashboards/x" -> fields
const LOG = [];
const ok = (body, status = 200) => ({ ok: status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  const m = String(url).match(/\/documents\/([^?]+)(\?(.*))?$/);
  const path = decodeURIComponent(m[1]);
  const q = new URLSearchParams(m[3] || '');
  const method = opts.method || 'GET';
  LOG.push(method + ' ' + path);
  if (method === 'GET') return DOCS.has(path) ? ok({ fields: DOCS.get(path) }) : ok({}, 404);
  if (method === 'DELETE') { DOCS.delete(path); return ok({}); }
  if (method === 'PATCH') { DOCS.set(path, JSON.parse(opts.body).fields); return ok({}); }
  if (method === 'POST') {
    const full = path + '/' + q.get('documentId');
    if (DOCS.has(full)) return ok({ error: { status: 'ALREADY_EXISTS' } }, 409);
    DOCS.set(full, JSON.parse(opts.body).fields);
    return ok({});
  }
  throw new Error('unexpected ' + method + ' ' + url);
};

const { handleClaudeResets, claudeResetList } = await import(pathToFileURL(SP + '/_w.mjs').href);

const KV = { deleted: 0, delete: async () => { KV.deleted++; } };
const env = { FIREBASE_PROJECT_ID: 'p', TOKEN_CACHE: KV };
const call = async (body) => {
  const req = new Request('https://x/claude-resets', { method: 'POST', body: JSON.stringify(body) });
  const r = await handleClaudeResets(req, env, '');
  return { status: r.status, body: await r.json() };
};
const reminders = () => [...DOCS.keys()].filter(k => k.startsWith('reminders/')).sort();

DOCS.set('dashboards/magi', { token: { stringValue: 'tony-secret' } });
DOCS.set('dashboards/magi_veda', { token: { stringValue: 'veda-secret' } });

const now = Date.now();
const H = 3600 * 1000;
const A = Math.round((now + 2 * H) / 60000) * 60000;
const B = Math.round((now + 7 * H) / 60000) * 60000;

// Wrong token, or another person's: nothing is written.
let r = await call({ profile: 'tony', token: 'veda-secret', resets: [{ kind: 'five_hour', at: A }] });
assert.equal(r.status, 401);
assert.deepEqual(reminders(), []);
assert.ok(!DOCS.has('dashboards/claude_resets_tony'));
r = await call({ profile: 'nobody', token: 'x', resets: [] });
assert.equal(r.status, 400);

// First reset: one reminder on Tony's dash, and the doc TaskHub renders.
r = await call({ profile: 'tony', token: 'tony-secret', notify: true, resets: [{ kind: 'five_hour', at: A }] });
assert.equal(r.status, 200, JSON.stringify(r.body));
const idA = `claude_tony_five_hour_${A / 1000}`;
assert.deepEqual(reminders(), ['reminders/' + idA]);
const remA = DOCS.get('reminders/' + idA);
assert.equal(remA.dashboard.stringValue, 'tony');
assert.equal(remA.notifyAt.stringValue, new Date(A).toISOString());
assert.equal(remA.fired.booleanValue, false);
assert.equal(DOCS.get('dashboards/claude_resets_tony').resets.arrayValue.values.length, 1);
assert.equal(KV.deleted, 1, 'a new reminder wakes the cron');

// The same post again: the reminder is NOT rewritten (it may have fired).
DOCS.get('reminders/' + idA).fired = { booleanValue: true };
r = await call({ profile: 'tony', token: 'tony-secret', notify: true, resets: [{ kind: 'five_hour', at: A }] });
assert.equal(r.status, 200);
assert.equal(DOCS.get('reminders/' + idA).fired.booleanValue, true);
assert.deepEqual(r.body.created, []);

// The next window: the old reminder goes, the new one comes.
r = await call({ profile: 'tony', token: 'tony-secret', notify: true, resets: [{ kind: 'five_hour', at: B }] });
const idB = `claude_tony_five_hour_${B / 1000}`;
assert.deepEqual(reminders(), ['reminders/' + idB]);
assert.deepEqual(r.body.deleted, [idA]);

// Notifications off: events stay, reminders go.
r = await call({ profile: 'tony', token: 'tony-secret', notify: false, resets: [{ kind: 'five_hour', at: B }] });
assert.deepEqual(reminders(), []);
assert.equal(DOCS.get('dashboards/claude_resets_tony').resets.arrayValue.values.length, 1);
assert.equal(DOCS.get('dashboards/claude_resets_tony').notify.booleanValue, false);

// Veda's go to Veda's dash, and leave Tony's alone.
r = await call({ profile: 'veda', token: 'veda-secret', resets: [{ kind: 'five_hour', at: A }, { kind: 'seven_day', at: now + 3 * 24 * H }] });
assert.equal(r.status, 200);
const vRem = reminders();
assert.equal(vRem.length, 2);
for (const k of vRem) assert.equal(DOCS.get(k).dashboard.stringValue, 'veda');
assert.equal(DOCS.get('dashboards/claude_resets_tony').resets.arrayValue.values.length, 1);

// Off: everything Veda's engine made is gone, and the doc says so.
r = await call({ profile: 'veda', token: 'veda-secret', enabled: false, resets: [{ kind: 'five_hour', at: A }] });
assert.deepEqual(reminders(), []);
assert.equal(DOCS.get('dashboards/claude_resets_veda').enabled.booleanValue, false);
assert.equal((DOCS.get('dashboards/claude_resets_veda').resets.arrayValue.values || []).length, 0);

// A reset that is already due is left for the cron to send, not deleted.
const P = now - 30 * 1000;
const idP = `claude_tony_five_hour_${Math.round(P / 1000)}`;
DOCS.set('reminders/' + idP, { fired: { booleanValue: false } });
DOCS.set('dashboards/claude_resets_tony', { resets: { arrayValue: { values: [
  { mapValue: { fields: { id: { stringValue: idP }, at: { integerValue: String(P) } } } }] } } });
r = await call({ profile: 'tony', token: 'tony-secret', resets: [] });
assert.equal(r.status, 200);
assert.ok(DOCS.has('reminders/' + idP), 'a due reminder survives the post that drops its event');
DOCS.delete('reminders/' + idP);

// The pure filter: past, far-future, unknown and duplicate kinds are dropped.
const list = claudeResetList('tony', { resets: [
  { kind: 'five_hour', at: now - 5 * 60000 },
  { kind: 'five_hour', at: A }, { kind: 'five_hour', at: B },
  { kind: 'seven_day', at: now + 30 * 24 * H },
  { kind: 'bogus', at: A }, { kind: 'seven_day', at: 'x' },
] }, now);
assert.deepEqual(list.map(x => x.at), [A]);

console.log('claude-resets: all assertions passed');

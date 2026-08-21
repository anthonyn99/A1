// Harness: load worker.js, expose handleAuth, and assert the auth-flow fixes
// against a fake KV and a fake mailer. No network, no Cloudflare.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const SP = mkdtempSync(join(tmpdir(), 'authtest-'));
let src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?\n\};/m, '');
src += '\nexport { handleAuth };\n';
writeFileSync(SP + '/_w.mjs', src);

const MAILS = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  MAILS.push({ url, to: body.email, subject: body.subject, message: body.message });
  return { ok: true, json: async () => ({ ok: true }) };
};

const { handleAuth } = await import(pathToFileURL(SP + '/_w.mjs').href);

const store = new Map();
const env = { AUTH_SETUP_KEY: 'testkey', TOKEN_CACHE: {
  get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
}};
const call = async (path, body) => {
  const res = await handleAuth(path, { method: 'POST', json: async () => body }, env, 'x');
  return { status: res.status, body: JSON.parse(await res.text()) };
};

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const J = { journal: 'applock', entryId: 'veda_links' };
let r;

console.log('\n1. set-lock / takeover');
r = await call('/auth/journal/set-lock', { ...J, password: 'realpw', hint: 'the usual' });
t('first lock succeeds (no record yet)', r.body.ok === true, r.body);
r = await call('/auth/journal/set-lock', { ...J, password: 'attacker' });
t('BLOCKS blind overwrite (the takeover hole)', r.status === 403 && r.body.error === 'needs-current', r.body);
r = await call('/auth/journal/verify', { ...J, password: 'realpw' });
t('original password still works after attempt', r.body.ok === true, r.body);
r = await call('/auth/journal/set-lock', { ...J, password: 'newpw', current: 'realpw' });
t('overwrite WITH current password succeeds', r.body.ok === true, r.body);
r = await call('/auth/journal/verify', { ...J, password: 'newpw' });
t('new password active', r.body.ok === true, r.body);

console.log('\n2. legacy change flow (verify -> remove -> set) still works');
r = await call('/auth/journal/remove-lock', { ...J, password: 'newpw' });
t('remove-lock with correct pw', r.body.ok === true, r.body);
r = await call('/auth/journal/set-lock', { ...J, password: 'rotated', hint: 'h' });
t('set-lock after remove (no record) — unchanged for every app', r.body.ok === true, r.body);

console.log('\n3. reset flow no longer leaks the code');
MAILS.length = 0;
r = await call('/auth/reset/request', { ...J, appName: 'Links', label: 'Links' });
t('response carries NO code', r.body.code === undefined, r.body);
t('response says emailed', r.body.ok === true && r.body.emailed === true, r.body);
t('mail routed to Veda by entry id, not by caller', MAILS[0] && MAILS[0].to === 'vedaapatel1605@gmail.com', MAILS[0] && MAILS[0].to);
const code = (MAILS[0].message.match(/\n    ([A-Z0-9]{6})\n/) || [])[1];
t('code present in the EMAIL only', !!code, MAILS[0].message.slice(0, 90));
r = await call('/auth/reset/confirm', { ...J, code: 'WRONGX', password: 'x' });
t('wrong code rejected', r.body.ok === false, r.body);
r = await call('/auth/reset/confirm', { ...J, code, password: 'afterreset' });
t('emailed code completes the reset', r.body.ok === true, r.body);
r = await call('/auth/journal/verify', { ...J, password: 'afterreset' });
t('password changed by reset', r.body.ok === true, r.body);

console.log('\n4. hint no longer readable by a stranger');
MAILS.length = 0;
await call('/auth/journal/set-lock', { journal: 'applock', entryId: 'tony_taskhub', password: 'p', hint: 'SECRET-HINT' });
r = await call('/auth/journal/hint', { journal: 'applock', entryId: 'tony_taskhub', appName: 'TaskHub' });
t('hint text NOT in response', JSON.stringify(r.body).includes('SECRET-HINT') === false, r.body);
t('hint mailed to Tony instead', MAILS[0] && MAILS[0].to === 'anthonypn99@gmail.com' && MAILS[0].message.includes('SECRET-HINT'), MAILS[0] && MAILS[0].to);

console.log('\n5. online guessing is throttled');
const G = { journal: 'applock', entryId: 'throttleme' };
await call('/auth/journal/set-lock', { ...G, password: 'correct' });
let blocked = 0;
for (let i = 0; i < 12; i++) {
  const rr = await call('/auth/journal/verify', { ...G, password: 'guess' + i });
  if (rr.status === 429) blocked++;
}
t('lockout kicks in during 12 wrong guesses', blocked > 0, { blocked });
r = await call('/auth/journal/verify', { ...G, password: 'correct' });
t('correct password also blocked while locked out', r.status === 429, r.body);
r = await call('/auth/reset/request', { ...G, appName: 'X' });
t('reset still reachable while password is locked out', r.body.ok === true, r.body);

console.log('\n6. owner routing — every Veda lock must reach Veda');
const route = async (body) => {
  MAILS.length = 0;
  await call('/auth/journal/set-lock', { ...body, password: 'p', hint: 'h' });
  await call('/auth/journal/hint', { ...body, appName: 'X' });
  return MAILS[0] && MAILS[0].to;
};
const VEDA = 'vedaapatel1605@gmail.com', TONY = 'anthonypn99@gmail.com';
t('bj — Veda journal, random entry id', await route({ journal: 'bj', entryId: 'ent_9f3a' }) === VEDA);
t('tj — Tony journal, random entry id', await route({ journal: 'tj', entryId: 'ent_7c2b' }) === TONY);
t('applock veda_links', await route({ journal: 'applock', entryId: 'veda_links' }) === VEDA);
t('applock veda_gita', await route({ journal: 'applock', entryId: 'veda_gita' }) === VEDA);
t('applock veda_taskhub', await route({ journal: 'applock', entryId: 'veda_taskhub' }) === VEDA);
t('applock veda_journal', await route({ journal: 'applock', entryId: 'veda_journal' }) === VEDA);
t('applock veda_shield', await route({ journal: 'applock', entryId: 'veda_shield' }) === VEDA);
t('applock profile_veda', await route({ journal: 'applock', entryId: 'profile_veda' }) === VEDA);
t('applock tony_taskhub', await route({ journal: 'applock', entryId: 'tony_taskhub' }) === TONY);
t('mylist profile_veda', await route({ journal: 'mylist', entryId: 'profile_veda' }) === VEDA);
t('mylist profile_tony', await route({ journal: 'mylist', entryId: 'profile_tony' }) === TONY);
t('explicit owner:veda overrides journal', await route({ journal: 'tj', entryId: 'x1', owner: 'veda' }) === VEDA);

// Profile passwords live under their own key (profilepw:<who>), seeded through
// the setup endpoint rather than set-lock.
MAILS.length = 0;
await call('/auth/profile/setup', { profile: 'veda', password: 'p', key: 'testkey' });
r = await call('/auth/reset/request', { profile: 'veda', appName: 'Profile' });
t('profile:veda reset mails Veda', MAILS[0] && MAILS[0].to === VEDA, [r.body, MAILS[0] && MAILS[0].to]);
MAILS.length = 0;
await call('/auth/profile/setup', { profile: 'tony', password: 'p', key: 'testkey' });
r = await call('/auth/reset/request', { profile: 'tony', appName: 'Profile' });
t('profile:tony reset mails Tony', MAILS[0] && MAILS[0].to === TONY, [r.body, MAILS[0] && MAILS[0].to]);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);

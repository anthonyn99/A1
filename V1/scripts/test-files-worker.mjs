// studyos-files Worker: DELETE must free every part of a file, with or without
// its manifest. A removed video kept its storage because the old delete found
// parts only through the manifest, which an interrupted or cancelled upload
// never wrote (2026-09-30). Runs the real worker.js against an in-memory KV.
import worker from '../workers/studyos-files/worker.js';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : JSON.stringify(extra)); }
};

function memKV() {
  const m = new Map();
  return {
    m,
    async put(k, v, o) { m.set(k, { v, meta: (o && o.metadata) || null }); },
    async get(k) { const e = m.get(k); return e ? e.v : null; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.v, metadata: e.meta } : { value: null, metadata: null }; },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const done = start + limit >= all.length;
      return { keys: page.map(name => ({ name, metadata: m.get(name).meta })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}
const call = (env, method, path, body, headers) =>
  worker.fetch(new Request('https://w.test' + path, { method, body, headers }), env);
const bytes = n => new Uint8Array(n).fill(7);

const env = { FILES: memKV() };

console.log('\nparts with NO manifest (upload stopped or was cancelled)');
for (let i = 0; i < 3; i++) await call(env, 'PUT', '/p/sf_vid/' + i, bytes(10));
t('three orphan parts stored', [...env.FILES.m.keys()].filter(k => k.startsWith('sf_vid__p')).length === 3);
let r = await (await call(env, 'DELETE', '/f/sf_vid')).json();
t('DELETE reports the parts it removed', r.ok && r.parts === 3, r);
t('no part is left', ![...env.FILES.m.keys()].some(k => k.startsWith('sf_vid')), [...env.FILES.m.keys()]);

console.log('\na normal chunked file');
for (let i = 0; i < 2; i++) await call(env, 'PUT', '/p/sf_big/' + i, bytes(10));
await call(env, 'PUT', '/m/sf_big', JSON.stringify({ parts: 2, size: 20, type: 'video/mp4', name: 'v.mp4' }));
t('it downloads whole before the delete', (await (await call(env, 'GET', '/f/sf_big')).arrayBuffer()).byteLength === 20);
r = await (await call(env, 'DELETE', '/f/sf_big')).json();
t('manifest and parts all go', r.parts === 2 && ![...env.FILES.m.keys()].some(k => k.startsWith('sf_big')), [...env.FILES.m.keys()]);

console.log('\nneighbours are untouched');
await call(env, 'PUT', '/f/sf_x__p3x', bytes(5), { 'Content-Type': 'application/pdf' });   // a real file whose name looks like a part
await call(env, 'PUT', '/p/sf_other/0', bytes(5));
await call(env, 'PUT', '/f/sf_x', bytes(5));
await call(env, 'PUT', '/p/sf_x/0', bytes(5));
r = await (await call(env, 'DELETE', '/f/sf_x')).json();
t('the deleted file and its part are gone', !env.FILES.m.has('sf_x') && !env.FILES.m.has('sf_x__p0'));
t('a file named like a part survives', env.FILES.m.has('sf_x__p3x'));
t("another file's parts survive", env.FILES.m.has('sf_other__p0'));

console.log('\nGET /keys lists StudyOS files, parts folded in, no bodies');
await call(env, 'PUT', '/p/sf_k/0', bytes(4));
await call(env, 'PUT', '/p/sf_k/1', bytes(6));
await call(env, 'PUT', '/f/reel_abc', bytes(3), { 'Content-Type': 'image/jpeg' });
const keys = await (await call(env, 'GET', '/keys')).json();
const k = (keys.files || []).find(f => f.id === 'sf_k');
t('a manifest-less file shows up with its parts', k && k.parts === 2 && k.bytes === 10 && k.manifest === false, keys);
t('non-StudyOS keys are not listed', !(keys.files || []).some(f => !f.id.startsWith('sf_')), keys);
t('no body is returned', !JSON.stringify(keys).includes('7,7'));
const rk = await (await call(env, 'GET', '/keys?prefix=reel_')).json();
t('?prefix=reel_ lists only reel thumbnails', (rk.files || []).length === 1 && rk.files[0].id === 'reel_abc' && rk.files[0].bytes === 3, rk);
const bad = await (await call(env, 'GET', '/keys?prefix=')).json();
t('any other prefix falls back to StudyOS files (sf_)', !(bad.files || []).some(f => !f.id.startsWith('sf_')), bad);
await call(env, 'DELETE', '/f/sf_k');

console.log('\nusage drops after a delete');
const u = await (await call(env, 'GET', '/usage')).json();
t('usage counts only what is left', u.bytes === 13, u);   // sf_x__p3x 5 + sf_other part 5 + reel_abc 3

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

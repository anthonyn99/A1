// ============================================================================
// vault-files — Cloudflare Worker (free, no credit card)
//
// Cross-device file storage for the Keychain (Tony) and Links (Veda) apps,
// backed by Workers KV. Each app gets its OWN KV namespace so their files are
// fully separated:
//   /keychain/f/<key>  → KEYCHAIN namespace   (Tony's Keychain)
//   /links/f/<key>     → LINKS namespace      (Veda's Links)
//
// Replaces the old base64-in-Firestore approach (capped at ~900 KB/file and
// bloated the synced doc). Only the returned URL rides in Firestore now.
//
// Routes (per bucket):
//   PUT    /<bucket>/f/<key>   → store raw body. Headers: Content-Type, X-File-Name
//   GET    /<bucket>/f/<key>   → return bytes (?dl=1 forces a download)
//   DELETE /<bucket>/f/<key>   → remove
//   GET    /health             → status
//
// KV free plan: value ≤ 25 MB, 1 GB total, ~1000 writes/day per namespace.
//
// Bindings (wrangler.toml): KEYCHAIN, LINKS  (one KV namespace each)
// ============================================================================

const MAX_BYTES = 25 * 1024 * 1024;
const BUCKETS = { keychain: 'KEYCHAIN', links: 'LINKS' };

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
    'Access-Control-Max-Age': '86400',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
function safeKey(k) {
  return /^[A-Za-z0-9._-]{1,200}$/.test(k) ? k : null;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'vault-files', keychain: !!env.KEYCHAIN, links: !!env.LINKS, time: new Date().toISOString() });
    }

    // /<bucket>/f/<key>
    const m = path.match(/^\/([a-z]+)\/f\/(.+)$/);
    if (m) {
      const bindingName = BUCKETS[m[1]];
      if (!bindingName) return json({ ok: false, error: 'unknown bucket' }, 404);
      const KV = env[bindingName];
      if (!KV) return json({ ok: false, error: bindingName + ' namespace not bound' }, 500);
      const key = safeKey(decodeURIComponent(m[2]));
      if (!key) return json({ ok: false, error: 'bad key' }, 400);

      if (req.method === 'PUT') {
        const buf = await req.arrayBuffer();
        if (buf.byteLength === 0) return json({ ok: false, error: 'empty body' }, 400);
        if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: 'too large', max: MAX_BYTES }, 413);
        const type = req.headers.get('Content-Type') || 'application/octet-stream';
        let name = 'document';
        try { name = decodeURIComponent(req.headers.get('X-File-Name') || '') || 'document'; } catch (_) {}
        await KV.put(key, buf, { metadata: { type, name } });
        return json({ ok: true, key, size: buf.byteLength });
      }

      if (req.method === 'GET') {
        const { value, metadata } = await KV.getWithMetadata(key, { type: 'arrayBuffer' });
        if (!value) return json({ ok: false, error: 'not found' }, 404);
        const type = (metadata && metadata.type) || 'application/octet-stream';
        const name = (metadata && metadata.name) || 'document';
        const headers = {
          'Content-Type': type,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...cors(),
        };
        if (url.searchParams.get('dl')) {
          headers['Content-Disposition'] =
            `attachment; filename="${name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; ` +
            `filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        return new Response(value, { status: 200, headers });
      }

      if (req.method === 'DELETE') {
        await KV.delete(key);
        return json({ ok: true, key, deleted: true });
      }

      return json({ ok: false, error: 'method not allowed' }, 405);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};

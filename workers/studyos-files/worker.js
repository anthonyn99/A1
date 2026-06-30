// ============================================================================
// studyos-files — Cloudflare Worker (free, no credit card)
//
// Cross-device file storage for StudyOS, backed by Workers KV (included in the
// free Workers plan — no R2, no Blaze, no card). Files uploaded on one device
// become viewable/downloadable on every device, because StudyOS stores the
// returned URL in its Firestore-synced metadata.
//
// Routes:
//   GET    /health        → status check
//   PUT    /f/<key>       → store a file (raw body). Headers:
//                             Content-Type  → file mime (echoed back on GET)
//                             X-File-Name   → encodeURIComponent(filename)
//   GET    /f/<key>       → return the file bytes (Content-Type from upload).
//                           add ?dl=1 to force a download (Content-Disposition).
//   DELETE /f/<key>       → remove the file.
//
// KV limits (free plan): value ≤ 25 MB, 1 GB total, ~1000 writes/day. Plenty
// for a personal study app's PDFs / slides / notes.
//
// Bindings (wrangler.toml):
//   [[kv_namespaces]] binding = "FILES"   → the KV namespace holding the files
// ============================================================================

const MAX_BYTES = 25 * 1024 * 1024; // KV hard cap per value

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

// Keys come straight from the client (StudyOS fileIds like "sf_<ts>_<rand>").
// Keep them tame so a bad request can't reach odd KV keys.
function safeKey(k) {
  return /^[A-Za-z0-9._-]{1,200}$/.test(k) ? k : null;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'studyos-files', kv: !!env.FILES, time: new Date().toISOString() });
    }

    // All file ops live under /f/<key>
    if (path.startsWith('/f/')) {
      if (!env.FILES) return json({ ok: false, error: 'KV namespace FILES not bound' }, 500);
      const key = safeKey(decodeURIComponent(path.slice(3)));
      if (!key) return json({ ok: false, error: 'bad key' }, 400);

      // ── Upload ──────────────────────────────────────────────────────────
      if (req.method === 'PUT') {
        const buf = await req.arrayBuffer();
        if (buf.byteLength === 0) return json({ ok: false, error: 'empty body' }, 400);
        if (buf.byteLength > MAX_BYTES) {
          return json({ ok: false, error: 'too large', max: MAX_BYTES }, 413);
        }
        const type = req.headers.get('Content-Type') || 'application/octet-stream';
        let name = 'document';
        try { name = decodeURIComponent(req.headers.get('X-File-Name') || '') || 'document'; } catch (_) {}
        // File bytes are the value; mime + name ride along as KV metadata so GET
        // can serve them back with the right headers.
        await env.FILES.put(key, buf, { metadata: { type, name } });
        return json({ ok: true, key, size: buf.byteLength });
      }

      // ── Download / view ─────────────────────────────────────────────────
      if (req.method === 'GET') {
        const { value, metadata } = await env.FILES.getWithMetadata(key, { type: 'arrayBuffer' });
        if (!value) return json({ ok: false, error: 'not found' }, 404);
        const type = (metadata && metadata.type) || 'application/octet-stream';
        const name = (metadata && metadata.name) || 'document';
        const headers = {
          'Content-Type': type,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...cors(),
        };
        if (url.searchParams.get('dl')) {
          // RFC 5987 filename* so unicode names survive.
          headers['Content-Disposition'] =
            `attachment; filename="${name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; ` +
            `filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        return new Response(value, { status: 200, headers });
      }

      // ── Delete ──────────────────────────────────────────────────────────
      if (req.method === 'DELETE') {
        await env.FILES.delete(key);
        return json({ ok: true, key, deleted: true });
      }

      return json({ ok: false, error: 'method not allowed' }, 405);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};

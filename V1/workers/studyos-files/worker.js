// ============================================================================
// studyos-files — Cloudflare Worker (free, no credit card)
//
// Cross-device file storage for StudyOS, backed by Workers KV (included in the
// free Workers plan — no R2, no Blaze, no card). Files uploaded on one device
// become viewable/downloadable on every device, because StudyOS stores the
// returned URL in its Firestore-synced metadata.
//
// A single KV value is capped at 25 MB, which used to be a hard ceiling on what
// could sync — a big PDF just stayed on the device that made it. Files larger
// than one value are now split client-side into parts and described by a small
// manifest stored under the file's own key, so GET /f/<key> serves any size
// back as one stream. The chunking is invisible to callers: same upload key,
// same download URL.
//
// Routes:
//   GET    /health          → status check
//   GET    /usage           → { bytes, files, limit } for the storage indicator
//   GET    /keys            → { files: [{ id, bytes, parts, manifest }] } for
//                             every "sf_" file (no bodies), for the self-cleanup
//   PUT    /f/<key>         → store a whole small file (raw body). Headers:
//                               Content-Type  → file mime (echoed back on GET)
//                               X-File-Name   → encodeURIComponent(filename)
//   PUT    /p/<key>/<i>     → store part <i> of a chunked upload (raw body)
//   PUT    /m/<key>         → finalize a chunked upload; body = JSON manifest
//                               { parts, size, type, name }
//   GET    /f/<key>         → the file bytes, reassembled if chunked.
//                             add ?dl=1 to force a download (Content-Disposition).
//   DELETE /f/<key>         → remove the file and every part stored under it,
//                             found by key prefix (a manifest is not required).
//
// KV limits (free plan): value ≤ 25 MB, 1 GB total, ~1000 writes/day.
//
// Bindings (wrangler.toml):
//   [[kv_namespaces]] binding = "FILES"   → the KV namespace holding the files
// ============================================================================

const MAX_VALUE   = 24 * 1024 * 1024;        // per-KV-value ceiling we enforce (hard cap is 25 MB)
const KV_CAPACITY = 1024 * 1024 * 1024;      // free-plan total, for the usage indicator

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
// Part keys share the file's prefix so a listing can attribute them to it, and
// so DELETE can find them without the manifest if it ever goes missing.
const partKey = (key, i) => key + '__p' + i;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'studyos-files', kv: !!env.FILES, chunked: true, time: new Date().toISOString() });
    }

    if (!env.FILES) return json({ ok: false, error: 'KV namespace FILES not bound' }, 500);

    // ── Storage usage (drives the client's capacity indicator) ─────────────
    // Sizes come from the metadata written on every put, so this never has to
    // read a single file body.
    if (path === '/usage') {
      let bytes = 0, files = 0, cursor;
      do {
        const page = await env.FILES.list({ cursor, limit: 1000 });
        for (const k of page.keys) {
          const m = k.metadata || {};
          const size = typeof m.size === 'number' ? m.size : 0;
          if (m.part) { bytes += size; continue; }   // a part: bytes only, never its own "file"
          files++;                                   // a manifest, or a whole small file
          // A manifest records the FULL file size for Content-Length, but those
          // bytes are physically stored in its parts — adding both double-counts.
          if (!m.chunked) bytes += size;
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json({ ok: true, bytes, files, limit: KV_CAPACITY, maxFile: null });
    }

    // ── StudyOS file keys (for the self-cleanup) ───────────────────────────
    // Names and sizes of the StudyOS files stored here ("sf_" keys; parts are
    // folded into their file), never a body. The same list() /usage already
    // runs on every storage-meter refresh, so this adds no new kind of cost.
    // The client compares it with the files its classes point at, and deletes
    // (DELETE /f/<key>) only what nothing references.
    if (path === '/keys') {
      if (req.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);
      const files = {};
      let cursor;
      do {
        const page = await env.FILES.list({ prefix: 'sf_', cursor, limit: 1000 });
        for (const k of page.keys) {
          const m = k.metadata || {};
          const cut = k.name.search(/__p\d{1,5}$/);
          const id = cut > 0 ? k.name.slice(0, cut) : k.name;
          const f = files[id] || (files[id] = { id, bytes: 0, parts: 0, manifest: false });
          if (cut > 0) { f.parts++; f.bytes += typeof m.size === 'number' ? m.size : 0; }
          else { f.manifest = true; if (!m.chunked) f.bytes += typeof m.size === 'number' ? m.size : 0; }
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json({ ok: true, files: Object.values(files) });
    }

    // ── Upload one part of a chunked file ──────────────────────────────────
    if (path.startsWith('/p/')) {
      if (req.method !== 'PUT') return json({ ok: false, error: 'method not allowed' }, 405);
      const rest = path.slice(3);
      const slash = rest.lastIndexOf('/');
      if (slash < 1) return json({ ok: false, error: 'bad part path' }, 400);
      const key = safeKey(decodeURIComponent(rest.slice(0, slash)));
      const idx = rest.slice(slash + 1);
      if (!key || !/^\d{1,5}$/.test(idx)) return json({ ok: false, error: 'bad key or index' }, 400);
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0) return json({ ok: false, error: 'empty part' }, 400);
      if (buf.byteLength > MAX_VALUE) return json({ ok: false, error: 'part too large', max: MAX_VALUE }, 413);
      await env.FILES.put(partKey(key, Number(idx)), buf, {
        metadata: { part: true, size: buf.byteLength },
      });
      return json({ ok: true, key, part: Number(idx), size: buf.byteLength });
    }

    // ── Finalize a chunked upload ──────────────────────────────────────────
    // The manifest lands LAST and under the file's own key, so a GET only ever
    // sees a complete file: an upload interrupted halfway leaves orphan parts
    // (reclaimed by re-uploading the same fileId) but never a broken download.
    if (path.startsWith('/m/')) {
      if (req.method !== 'PUT') return json({ ok: false, error: 'method not allowed' }, 405);
      const key = safeKey(decodeURIComponent(path.slice(3)));
      if (!key) return json({ ok: false, error: 'bad key' }, 400);
      let man;
      try { man = await req.json(); } catch (_) { return json({ ok: false, error: 'bad manifest' }, 400); }
      const parts = Number(man && man.parts);
      if (!parts || parts < 1 || parts > 10000) return json({ ok: false, error: 'bad part count' }, 400);
      const meta = {
        chunked: true,
        parts,
        size: Number(man.size) || 0,
        type: String(man.type || 'application/octet-stream'),
        name: String(man.name || 'document').slice(0, 200),
      };
      await env.FILES.put(key, JSON.stringify(meta), { metadata: meta });
      return json({ ok: true, key, parts, size: meta.size, chunked: true });
    }

    // All whole-file ops live under /f/<key>
    if (path.startsWith('/f/')) {
      const key = safeKey(decodeURIComponent(path.slice(3)));
      if (!key) return json({ ok: false, error: 'bad key' }, 400);

      // ── Upload (single value) ────────────────────────────────────────────
      if (req.method === 'PUT') {
        const buf = await req.arrayBuffer();
        if (buf.byteLength === 0) return json({ ok: false, error: 'empty body' }, 400);
        if (buf.byteLength > MAX_VALUE) {
          // The client is expected to chunk instead; say so explicitly rather
          // than failing in a way that looks like a network blip.
          return json({ ok: false, error: 'too large for one value — use chunked upload', max: MAX_VALUE }, 413);
        }
        const type = req.headers.get('Content-Type') || 'application/octet-stream';
        let name = 'document';
        try { name = decodeURIComponent(req.headers.get('X-File-Name') || '') || 'document'; } catch (_) {}
        // File bytes are the value; mime + name ride along as KV metadata so GET
        // can serve them back with the right headers.
        await env.FILES.put(key, buf, { metadata: { type, name, size: buf.byteLength } });
        return json({ ok: true, key, size: buf.byteLength });
      }

      // ── Download / view ──────────────────────────────────────────────────
      if (req.method === 'GET') {
        const head = await env.FILES.getWithMetadata(key, { type: 'arrayBuffer' });
        if (!head || !head.value) return json({ ok: false, error: 'not found' }, 404);
        const metadata = head.metadata || {};
        const type = metadata.type || 'application/octet-stream';
        const name = metadata.name || 'document';
        const headers = {
          'Content-Type': type,
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...cors(),
        };
        if (url.searchParams.get('dl')) {
          // RFC 5987 filename* so unicode names survive.
          headers['Content-Disposition'] =
            `attachment; filename="${String(name).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; ` +
            `filename*=UTF-8''${encodeURIComponent(name)}`;
        }

        if (!metadata.chunked) return new Response(head.value, { status: 200, headers });

        // Chunked: stream the parts back in order. Pulling one part at a time
        // keeps peak memory at one chunk regardless of how big the file is.
        const total = Number(metadata.parts) || 0;
        if (metadata.size) headers['Content-Length'] = String(metadata.size);
        let i = 0;
        const body = new ReadableStream({
          async pull(controller) {
            if (i >= total) { controller.close(); return; }
            const part = await env.FILES.get(partKey(key, i), { type: 'arrayBuffer' });
            if (!part) { controller.error(new Error('missing part ' + i)); return; }
            i++;
            controller.enqueue(new Uint8Array(part));
          },
        });
        return new Response(body, { status: 200, headers });
      }

      // ── Delete ───────────────────────────────────────────────────────────
      // Parts are found by their key PREFIX, not only through the manifest. The
      // manifest is written last, so an upload that stopped early (or a file
      // removed while it was still uploading) had parts but no manifest, and the
      // old manifest-only delete left every one of them in KV for good: a
      // removed video kept its storage (2026-09-30). A re-upload with fewer
      // parts also left the old tail behind; the prefix catches that too.
      if (req.method === 'DELETE') {
        let parts = 0, cursor;
        do {
          const page = await env.FILES.list({ prefix: key + '__p', cursor, limit: 1000 });
          for (const k of page.keys) {
            // Exact part keys only: "sf_1__p3" must not match file "sf_1__p3x".
            if (!/__p\d{1,5}$/.test(k.name) || k.name.slice(0, k.name.lastIndexOf('__p')) !== key) continue;
            await env.FILES.delete(k.name);
            parts++;
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        await env.FILES.delete(key);
        return json({ ok: true, key, deleted: true, parts });
      }

      return json({ ok: false, error: 'method not allowed' }, 405);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};

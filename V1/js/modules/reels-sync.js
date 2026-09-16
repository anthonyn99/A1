/* ============================================================================
 * Saved-reels sync — the bridge half that has credentials
 * ============================================================================
 * Moves a harvested Instagram saved-collection from the LOCAL bridge into the
 * cloud, so TaskHub's reels widget can render it on any device.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 * The scraper (V1/tools/sos-browser/driver.py) deliberately holds no Firebase
 * credential: a process that drives a logged-in personal Instagram session is
 * exactly the process that should not also hold cloud write access. So it
 * writes outputs/reels.json and serves it over loopback, and THIS file — which
 * already runs inside an authenticated page — does the cloud write. Same split
 * as pipeline.js's fileResult: the browser automation produces bytes, the page
 * files them through the app's own sanctioned path.
 *
 * ── THE BRIDGE IS A PC-ONLY CAPABILITY ────────────────────────────────────
 * 127.0.0.1:8781 is unreachable from a phone, and from this PC when it is
 * asleep. That is not a degraded mode, it is the normal one: the widget renders
 * from the Firestore doc, and this file only refreshes it when the bridge
 * happens to be up. If the bridge is unreachable, this file does nothing at all
 * and says nothing — there is no error to report, because there is no user
 * expectation that a scraper is running.
 *
 * ── THUMBNAILS, AND THE WRITE QUOTA ──────────────────────────────────────
 * Instagram's CDN thumbnail URLs are SIGNED and expire within days, so storing
 * the URL gives a widget full of broken images. The bytes are copied once into
 * the studyos-files Worker (KV) instead, which is reachable from the phone.
 *
 * That namespace is free-plan: ~1000 writes/day, SHARED with StudyOS's own file
 * uploads. So an upload happens only for a shortcode that has no thumbnail yet,
 * never on every run, and never more than THUMB_CAP per run. A naive
 * re-upload-everything over a few hundred saved reels would burn the day's
 * quota and break StudyOS file uploads as a side effect — a failure that would
 * appear nowhere near this file.
 * ------------------------------------------------------------------------- */

const BRIDGE = () => (window.STUDYOS_CONFIG?.cloudflare?.ai?.baseUrl) || 'http://127.0.0.1:8781';
const FILES = () => (window.STUDYOS_CONFIG?.cloudflare?.filesWorker?.baseUrl) || '';

/* Matches driver.py's REELS_THUMB_CAP. Both sides cap independently: the driver
 * bounds what it records, this bounds what it uploads. */
const THUMB_CAP = 60;

/* A thumbnail is small. Anything bigger is not a grid thumbnail and is skipped
 * rather than spent — the widget falls back to a caption tile. */
const THUMB_MAX = 512 * 1024;

const thumbKeyFor = (shortcode) => `reel_${shortcode}`;

/** Is the bridge up? Resolves false rather than throwing — see the header. */
async function bridgeUp() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${BRIDGE()}/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.ok && j.reels);
  } catch (_) {
    return false;
  }
}

/** The harvested list from the bridge, or null when it is not reachable. */
async function readBridge() {
  try {
    const r = await fetch(`${BRIDGE()}/api/ig/reels`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.ok) ? j : null;
  } catch (_) {
    return null;
  }
}

/**
 * Does this thumbnail already exist in KV?
 *
 * A GET is a READ, which is effectively unmetered on the free plan, while a PUT
 * is one of ~1000 daily writes. So checking first is close to free and is what
 * keeps a re-run from costing anything.
 */
async function thumbExists(key) {
  const base = FILES();
  if (!base) return false;
  try {
    const r = await fetch(`${base}/f/${encodeURIComponent(key)}`, { method: 'GET' });
    return r.ok;
  } catch (_) {
    return false;
  }
}

/**
 * Copy one IG thumbnail into KV. Returns the key on success, null otherwise.
 *
 * Failure is never fatal and never retried in a loop: a missing thumbnail
 * degrades to a caption-only tile in the widget, which is a much better outcome
 * than spending the write quota trying again on a URL that has already expired.
 */
async function copyThumb(shortcode, src) {
  const base = FILES();
  if (!base || !src) return null;
  const key = thumbKeyFor(shortcode);
  try {
    const img = await fetch(src);
    if (!img.ok) return null;
    const blob = await img.blob();
    if (!blob.size || blob.size > THUMB_MAX) return null;
    const put = await fetch(`${base}/f/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': blob.type || 'image/jpeg',
        'X-File-Name': encodeURIComponent(`${shortcode}.jpg`),
      },
      body: blob,
    });
    if (!put.ok) return null;
    return key;
  } catch (_) {
    return null;
  }
}

/**
 * One sync pass: read the bridge, top up missing thumbnails, write the doc.
 *
 * Returns a short status object for logging. Never throws.
 */
export async function syncReels({ force = false } = {}) {
  if (!(await bridgeUp())) return { ok: false, reason: 'bridge-down' };

  const doc = await readBridge();
  if (!doc) return { ok: false, reason: 'bridge-unreadable' };

  const reels = Array.isArray(doc.reels) ? doc.reels : [];

  // ── The empty guard, again, on this side of the wire ─────────────────────
  // driver.py already refuses to persist an empty harvest over a good cache,
  // but this file can also be pointed at a bridge whose cache file was deleted.
  // Writing [] to Firestore would blank the widget on every device, so it is
  // refused here too. Two cheap guards, because the failure is not recoverable
  // from the UI.
  if (!reels.length && !force) return { ok: false, reason: 'empty-refused' };

  // ── Thumbnails: only what is missing, only up to the cap ─────────────────
  let uploaded = 0;
  for (const r of reels) {
    if (uploaded >= THUMB_CAP) break;
    if (!r.shortcode || r.thumbKey) continue;
    const key = thumbKeyFor(r.shortcode);
    if (await thumbExists(key)) { r.thumbKey = key; continue; }
    if (!r.thumbSrc) continue;
    const got = await copyThumb(r.shortcode, r.thumbSrc);
    if (got) { r.thumbKey = got; uploaded += 1; }
  }

  // thumbSrc is a signed URL that expires; it is useful only for the copy above
  // and would otherwise rot inside the synced doc, so it is dropped here. The
  // widget reads thumbKey and nothing else.
  const payload = {
    collection: doc.collection || 'all-posts',
    user: doc.user || '',
    count: reels.length,
    stoppedAt: doc.stoppedAt || '',
    filesBase: FILES(),
    reels: reels.map((r) => ({
      shortcode: r.shortcode,
      url: r.url || `https://www.instagram.com/reel/${r.shortcode}/`,
      thumbKey: r.thumbKey || '',
      caption: r.caption || '',
    })),
  };

  if (typeof window._fbSaveReels !== 'function') {
    return { ok: false, reason: 'no-saver', uploaded };
  }
  await window._fbSaveReels(payload);
  return { ok: true, count: reels.length, uploaded };
}

/**
 * Ask the bridge to run a fresh harvest.
 *
 * Deliberately NOT called on a timer by this file. Veda's choice was to
 * re-harvest only when the saved count changes, and every visit to a logged-in
 * Instagram session is a cost this design minimises — so a harvest is started
 * by an explicit action (the widget's refresh control, or the CLI), never by the
 * page merely being open.
 */
export async function requestHarvest({ user, collection } = {}) {
  if (!user) return { ok: false, reason: 'no-user' };
  if (!(await bridgeUp())) return { ok: false, reason: 'bridge-down' };
  try {
    const r = await fetch(`${BRIDGE()}/api/ig/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, collection: collection || 'all-posts' }),
    });
    const j = await r.json();
    return j && j.ok ? { ok: true, job: j.job, already: !!j.already } : { ok: false, reason: 'refused' };
  } catch (_) {
    return { ok: false, reason: 'unreachable' };
  }
}

export const _internals = { thumbKeyFor, THUMB_CAP, THUMB_MAX };

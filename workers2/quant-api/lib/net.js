// Calling an outside provider: the ledger first (skip window, cap), a
// timeout, one retry on 429 honouring Retry-After up to 2 s, and the answer
// recorded in provider health. Throws a ProviderError on any failure so the
// chain moves to the next source.

export const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const QUOTE_TIMEOUT = 4000, BARS_TIMEOUT = 10000;

export class ProviderError extends Error {
  constructor(provider, message, status) { super(message); this.provider = provider; this.status = status; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch `url` from `provider` through the ledger `L`. Returns the parsed body
 * (JSON unless opts.text). `opts.calls` = how many calls this counts as.
 */
export async function call(L, provider, url, { headers, timeout = QUOTE_TIMEOUT, method = 'GET', body, text = false, calls = 1 } = {}) {
  const why = L.blocked(provider);
  if (why) throw new ProviderError(provider, why);
  if (!L.spend(provider, calls)) throw new ProviderError(provider, 'at its daily cap');
  const t0 = Date.now();
  let r, status = null;
  try {
    for (let attempt = 0; ; attempt++) {
      r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      status = r.status;
      if (r.status !== 429 || attempt) break;
      const ra = Number(r.headers.get('retry-after'));
      if (!(ra >= 0 && ra <= 2)) break;
      await wait(ra * 1000);
    }
    if (!r.ok) throw new ProviderError(provider, 'HTTP ' + r.status, r.status);
    const out = text ? await r.text() : await r.json();
    L.note(provider, true, status, Date.now() - t0);
    return out;
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'timed out after ' + timeout + ' ms' : e.message || String(e);
    L.note(provider, false, status, Date.now() - t0, msg);
    throw e instanceof ProviderError ? e : new ProviderError(provider, msg, status);
  }
}
/** A provider answered, but not with anything usable: count it as a failure. */
export function noteBad(L, provider, msg) { L.note(provider, false, 200, null, msg); return new ProviderError(provider, msg, 200); }

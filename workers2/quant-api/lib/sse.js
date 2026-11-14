// Streaming an AI provider's answer to the page (A1-Priv docs/TradeHub/quant/phase-09.md).
//
// The worker reads a provider's stream only until the first words of text
// arrive (so an empty stream, an error or a block is caught and the chain can
// move on), then pipes the rest through untouched: no parsing per token, which
// keeps a long answer inside the free plan's CPU time. The page reads the
// provider's own chunks (neo/ai.js textOf) plus these named events:
//   event: meta   { provider, model }        a provider began answering
//   event: reset  { provider, why }          its stream was cut: discard what it wrote
//   event: done   { provider, model, firstMs, ms, tried }
//   event: fail   { tried, fallback? }       nobody answered
//
// When the page goes away (Stop, a new question, a closed tab), a write throws
// PageGone: the chain stops at once. It is never counted against a provider,
// and no other provider is asked (that would be a usage spike for nobody).
const enc = new TextEncoder();

export const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
/** One named event, as bytes. The blank lines before it close whatever the provider left open. */
export const sseEvent = (name, data) => enc.encode(`\n\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

/** The page stopped listening. */
export class PageGone extends Error { constructor() { super('the page stopped listening'); this.name = 'PageGone'; } }
export const isGone = (e) => e instanceof PageGone;

/** A streaming answer: `run(write)` writes bytes; `after()` runs when it ends (the ledger's flush). */
export function sseResponse(ctx, run, after) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  let gone = false;
  const write = async (bytes) => {
    if (gone) throw new PageGone();
    try { await w.write(bytes); } catch (e) { gone = true; throw new PageGone(); }
  };
  const work = (async () => {
    try { await run(write); }
    catch (e) { if (!isGone(e)) { try { await write(sseEvent('fail', { tried: [{ provider: 'worker', why: String((e && e.message) || e).slice(0, 200) }] })); } catch (x) {} } }
    finally {
      try { await w.close(); } catch (e) {}
      if (after) { try { await after(); } catch (e) { console.warn('ai ledger:', e.message || e); } }
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/** Cancel `reader` when `signal` aborts (a read that never ends would otherwise outlive every timer: Workers AI's stream takes no signal). */
function cancelOn(signal, reader) {
  if (!signal) return () => {};
  const f = () => { reader.cancel().catch(() => {}); };
  if (signal.aborted) f(); else signal.addEventListener('abort', f, { once: true });
  return () => signal.removeEventListener('abort', f);
}

/**
 * Read `body` until text arrives → { ok: true, head, reader } (head = the raw
 * chunks read so far, to send on) or { ok: false, why }.
 *   textOf(json)  the text one provider chunk carries ('' when none)
 *   badOf(json)   why this chunk means the answer failed (an error, a safety block), or ''
 *   onAlive()     called once, at the provider's first chunk of any kind
 *   signal        cancels the read when it aborts
 */
export async function peek(body, { textOf, badOf = () => '', onAlive = () => {}, signal = null } = {}) {
  if (!body) return { ok: false, why: 'no stream' };
  const reader = body.getReader(), dec = new TextDecoder(), head = [], off = cancelOn(signal, reader);
  let buf = '', alive = false;
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
      if (r.done) return { ok: false, why: 'the stream ended empty' };
      head.push(r.value);
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const s = line.slice(5).trim();
        if (!s || s === '[DONE]') continue;
        let j;
        try { j = JSON.parse(s); } catch (e) { continue; }
        if (!alive) { alive = true; onAlive(); }
        const bad = badOf(j);
        if (bad) { try { await reader.cancel(); } catch (e) {} return { ok: false, why: bad }; }
        if (textOf(j)) return { ok: true, head, reader };
      }
    }
  } finally { off(); }
}
/**
 * Send the rest of the stream on, untouched → '' when it ended cleanly, else why it was cut.
 * A write to a page that left throws PageGone (the provider's stream is cancelled first).
 */
export async function pipeRest(reader, write, { signal = null } = {}) {
  const off = cancelOn(signal, reader);
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (e) { return String((e && e.message) || e) || 'cut'; }
      if (r.done) return signal && signal.aborted ? 'stopped' : '';
      try { await write(r.value); } catch (e) { reader.cancel().catch(() => {}); throw e; }
    }
  } finally { off(); }
}

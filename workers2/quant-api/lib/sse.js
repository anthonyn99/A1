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
const enc = new TextEncoder();

export const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
/** One named event, as bytes. The blank lines before it close whatever the provider left open. */
export const sseEvent = (name, data) => enc.encode(`\n\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

/** A streaming answer: `run(write)` writes bytes; `after()` runs when it ends (the ledger's flush). */
export function sseResponse(ctx, run, after) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const write = (bytes) => w.write(bytes);
  const work = (async () => {
    try { await run(write); }
    catch (e) { try { await write(sseEvent('fail', { tried: [{ provider: 'worker', why: String((e && e.message) || e).slice(0, 200) }] })); } catch (x) {} }
    finally {
      try { await w.close(); } catch (e) {}
      if (after) { try { await after(); } catch (e) { console.warn('ai ledger:', e.message || e); } }
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/**
 * Read `body` until text arrives → { ok: true, head, reader } (head = the raw
 * chunks read so far, to send on) or { ok: false, why }.
 *   textOf(json)  the text one provider chunk carries ('' when none)
 *   badOf(json)   why this chunk means the answer failed (an error, a safety block), or ''
 *   onAlive()     called once, at the provider's first chunk of any kind
 */
export async function peek(body, { textOf, badOf = () => '', onAlive = () => {} } = {}) {
  if (!body) return { ok: false, why: 'no stream' };
  const reader = body.getReader(), dec = new TextDecoder(), head = [];
  let buf = '', alive = false;
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
}
/** Send the rest of the stream on, untouched → '' when it ended cleanly, else why it was cut. */
export async function pipeRest(reader, write) {
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (e) { return String((e && e.message) || e) || 'cut'; }
    if (r.done) return '';
    await write(r.value);
  }
}

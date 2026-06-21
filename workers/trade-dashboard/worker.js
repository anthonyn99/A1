/**
 * TRADE-DASHBOARD — Cloudflare Worker
 * ────────────────────────────────────────────────────────────────────────────
 * Powers the TradeBoard tab in TradeHub.
 *
 *   - Runs a user prompt through a centralized AI Router (Gemini → NIM → Groq)
 *   - Forces structured JSON output so the front-end can render it cleanly
 *   - Async build + KV cache + poll (mirrors newshub-api pattern)
 *   - Server-side rate limit (daily cap + cooldown) so keys never burn out
 *   - Prompt CRUD (set / edit / delete) stored in KV
 *
 * SECRETS (set via `wrangler secret put` — NEVER in code):
 *   GEMINI_KEY     Google AI Studio key (Gemini)
 *   NVIDIA_KEY     build.nvidia.com NIM key (nvapi-...)
 *   GROQ_KEY       Groq key (gsk_...)
 *
 * KV BINDING (wrangler.toml):  TD_KV
 *   td_report           → { status, report, error, generatedAt, model, runId }
 *   td_rate             → { day:'YYYY-MM-DD', used:N, lastRunMs:ts }
 *   td_prompts          → { prompts:[{id,name,text,createdAt,updatedAt}], activeId }
 *   td_cache:<hash>     → { report, generatedAt, model }   (short TTL)
 * ──────────────────────────────────────────────────────────────────────────── */

/* ════════════════════════════════════════════════════════════════════════════
   CONFIG
   ════════════════════════════════════════════════════════════════════════════ */
const DAILY_LIMIT     = 6;            // max fresh AI runs per UTC day
const MIN_INTERVAL_S  = 30 * 60;      // 30 min cooldown between fresh runs
const CACHE_TTL_S     = 20 * 60;      // dedup identical prompt runs for 20 min
const AI_TIMEOUT_MS   = 40 * 1000;    // per-model fetch timeout
const MAX_RETRIES     = 1;            // retries per model (keep total chain time bounded)
const MAX_OUT_TOKENS  = 16384;        // big enough for a full 10-section report

/* AI TIER CHAIN — walked top→bottom, each tier walks its own model list.
   Order = best→worst within budget/quality. Edit freely. */
const AI_CHAIN = [
  { provider: 'gemini', models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
  ]},
  { provider: 'nvidia', models: [
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'meta/llama-3.3-70b-instruct',
      'deepseek-ai/deepseek-r1',
      'qwen/qwen2.5-72b-instruct',
  ]},
  { provider: 'groq', models: [
      'llama-3.3-70b-versatile',
      'deepseek-r1-distill-llama-70b',
      'qwen-2.5-32b',
  ]},
];

/* ════════════════════════════════════════════════════════════════════════════
   FINNHUB REAL-DATA LAYER (V2)
   Injects live quotes + real earnings dates as FACTS into the prompt so the AI
   analyzes reality instead of guessing. Free tier: 60 calls/min.
   - /quote works on US stocks + ETFs (NOT raw indices), so we proxy indices with
     liquid ETFs (SPY≈S&P, QQQ≈NDX, SOXX≈semis, etc).
   - /calendar/earnings gives real upcoming earnings (date, EPS/rev estimate).
   - /calendar/economic (CPI/FOMC/jobs) is premium on many free keys; we try it
     and silently skip if 403/empty.
   ════════════════════════════════════════════════════════════════════════════ */
const FH_BASE = 'https://finnhub.io/api/v1';

// Macro proxies (ETF/quote-able) → label shown to AI.
const FH_MACRO = [
  { sym: 'SPY',  label: 'S&P 500 (SPY)' },
  { sym: 'QQQ',  label: 'NASDAQ 100 (QQQ)' },
  { sym: 'SOXX', label: 'Semis (SOXX)' },
  { sym: 'DIA',  label: 'Dow (DIA)' },
  { sym: 'IWM',  label: 'Russell 2000 (IWM)' },
  { sym: 'TLT',  label: '20Y Treasuries (TLT) — inverse of yields' },
  { sym: 'UUP',  label: 'US Dollar (UUP/DXY proxy)' },
  { sym: 'USO',  label: 'WTI Oil (USO)' },
  { sym: 'VIXY', label: 'VIX short-term (VIXY)' },
  { sym: 'GLD',  label: 'Gold (GLD)' },
];

// Watchlist tickers to fetch real quotes for (mirrors the user's prompt list).
const FH_WATCHLIST = ['NVDA','AMD','MU','INTC','WDC','SNDK','CRDO','MRVL','AVGO',
  'GOOGL','MSFT','AAPL','AMZN','META','TSLA','PLTR','CRWD','NET','SCCO','WMT','BABA','BE'];

// US market holidays (date strings YYYY-MM-DD) — extend yearly as needed.
const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19',
  '2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18',
  '2027-07-05','2027-09-06','2027-11-25','2027-12-24',
]);

async function fhFetch(path, env) {
  if (!env.FINNHUB_KEY) return null;
  const sep = path.includes('?') ? '&' : '?';
  try {
    const res = await fetch(`${FH_BASE}${path}${sep}token=${env.FINNHUB_KEY}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      globalThis.__fhLastErr = `${path} → HTTP ${res.status}`;
      return null;
    }
    return await res.json();
  } catch (e) {
    globalThis.__fhLastErr = `${path} → ${e.message}`;
    return null;
  }
}

const fhArrow = dp => dp > 0.15 ? '▲' : dp < -0.15 ? '▼' : '→';
const fhPct   = dp => (dp == null ? '?' : (dp > 0 ? '+' : '') + dp.toFixed(2) + '%');

/* QUOTES via Yahoo Finance (free, no key, allows datacenter IPs).
   Stooq bot-walls Cloudflare; Finnhub /quote is premium. Yahoo's chart endpoint
   returns JSON with current price + previous close → compute % change.
   URL: https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d */
async function stooqQuote(sym) {
  const tryHost = async host => {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeBoard/1.0)' },
    });
    if (!res.ok) { globalThis.__fhLastErr = `yahoo ${sym} HTTP ${res.status}`; return null; }
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    if (!r) return null;
    const meta = r.meta || {};
    const c = meta.regularMarketPrice;
    const pc = meta.chartPreviousClose || meta.previousClose;
    if (c == null || isNaN(c)) return null;
    const dp = pc ? ((c - pc) / pc) * 100 : 0;
    return { c, pc, dp };
  };
  try {
    return (await tryHost('query1.finance.yahoo.com')) || (await tryHost('query2.finance.yahoo.com'));
  } catch (e) { globalThis.__fhLastErr = `yahoo ${sym} ${e.message}`; return null; }
}

async function fhQuotes(symbols, env) {
  const out = {};
  const batch = 16;
  const run = async list => {
    for (let i = 0; i < list.length; i += batch) {
      const slice = list.slice(i, i + batch);
      const results = await Promise.all(slice.map(async s => [s, await stooqQuote(s)]));
      for (const [s, q] of results) if (q && q.c) out[s] = q;
      if (i + batch < list.length) await sleep(150);
    }
  };
  await run(symbols);
  // retry any that missed once (catches transient Yahoo misses like ERO).
  const missed = symbols.filter(s => !out[s]);
  if (missed.length) { await sleep(300); await run(missed); }
  return out;
}

/* Build the full real-data facts block injected into the prompt. */
async function buildMarketFacts(env) {
  if (!env.FINNHUB_KEY) return ''; // no key → skip silently, AI works without it

  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const to = new Date(today); to.setDate(to.getDate() + 14);

  // Fire the big fetches in parallel.
  const [macroQ, watchQ, earnings] = await Promise.all([
    fhQuotes(FH_MACRO.map(m => m.sym), env),
    fhQuotes(FH_WATCHLIST, env),
    fhFetch(`/calendar/earnings?from=${iso(today)}&to=${iso(to)}`, env),
  ]);

  let s = 'LIVE MARKET DATA (real quotes — use these actual numbers, do not invent):\n';
  for (const m of FH_MACRO) {
    const q = macroQ[m.sym];
    if (q) s += `  ${m.label}: $${q.c.toFixed(2)} ${fhArrow(q.dp)} ${fhPct(q.dp)}\n`;
  }
  s += '\nWATCHLIST QUOTES (real):\n';
  for (const t of FH_WATCHLIST) {
    const q = watchQ[t];
    if (q) s += `  ${t}: $${q.c.toFixed(2)} ${fhArrow(q.dp)} ${fhPct(q.dp)}\n`;
  }

  // Real earnings, filtered to watchlist + nearest dates.
  const ec = earnings?.earningsCalendar || [];
  const wl = new Set(FH_WATCHLIST);
  const relevant = ec.filter(e => wl.has((e.symbol || '').toUpperCase()))
                     .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
                     .slice(0, 15);
  if (relevant.length) {
    s += '\nREAL UPCOMING EARNINGS (watchlist, actual dates):\n';
    for (const e of relevant) {
      const eps = e.epsEstimate != null ? ` EPS est ${e.epsEstimate}` : '';
      const hr  = e.hour ? ` (${e.hour})` : '';
      s += `  ${e.date}  ${e.symbol}${hr}${eps}\n`;
    }
  }

  // Economic calendar — DETERMINISTIC (no premium API needed). Fed publishes
  // FOMC dates a year ahead (fixed); CPI/PPI/jobs follow rigid monthly patterns.
  // We try the premium Finnhub endpoint first, but always fall back to computed.
  let econLines = [];
  const eco = await fhFetch(`/calendar/economic?from=${iso(today)}&to=${iso(to)}`, env);
  const evs = eco?.economicCalendar || [];
  const usEvs = evs.filter(e => (e.country || '') === 'US' && (e.impact === 'high' || e.impact === 'medium'))
                   .sort((a, b) => (a.time || '').localeCompare(b.time || '')).slice(0, 12);
  if (usEvs.length) {
    econLines = usEvs.map(e => `  ${(e.time || '').slice(0,10)}  ${e.event}${e.estimate != null ? ` (est ${e.estimate})` : ''}`);
  } else {
    econLines = computedEconEvents(today, to).map(e => `  ${e.date}  ${e.event}`);
  }
  if (econLines.length) s += '\nUS ECONOMIC EVENTS (scheduled — real dates):\n' + econLines.join('\n') + '\n';

  // Market-moving headlines (policy/Trump/Fed/tariff/geopolitics).
  let newsBlock = '';
  try { newsBlock = await buildNewsFacts(env); } catch {}

  // Cross-feed: pull the user's already-AI-analyzed watchlist events from the
  // existing newshub-api worker, if reachable. Grounds themes in real events.
  let nhBlock = '';
  try { nhBlock = await buildNewsHubFacts(env); } catch {}

  return s + '\n' + newsBlock + nhBlock;
}

/* Pull top analyzed events from the existing newshub-api worker (cross-feed). */
async function buildNewsHubFacts(env) {
  const url = env.NEWSHUB_URL || 'https://newshub-api.av1.workers.dev/news';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return '';
    const j = await res.json();
    const events = (j.events || j.data || []).slice(0, 10);
    if (!events.length) return '';
    let s = 'ANALYZED WATCHLIST EVENTS (from your news system — use as real context):\n';
    for (const e of events) {
      const t = e.tickers ? ` [${(Array.isArray(e.tickers) ? e.tickers : [e.tickers]).join(',')}]` : '';
      const imp = e.importance || e.tier || '';
      s += `  - ${(e.headline || e.title || '').slice(0, 120)}${t}${imp ? ` (${imp})` : ''}\n`;
    }
    return s + '\n';
  } catch { return ''; }
}

/* Holiday-aware next-N trading days. */
function nextTradingDays(n) {
  const out = [];
  const d = new Date();
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    const key = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !US_MARKET_HOLIDAYS.has(key)) out.push(new Date(d));
  }
  return out;
}

/* DETERMINISTIC US economic calendar — no API needed.
   FOMC dates are published by the Fed a year ahead and never change. CPI/PPI/
   jobs follow fixed patterns. We compute events within [from, to].
   FOMC list = official 2026/2027 meeting decision days (2nd day of each meeting). */
const FOMC_DATES = [
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29',
  '2026-09-16','2026-11-04','2026-12-16',
  '2027-01-27','2027-03-17','2027-04-28','2027-06-16','2027-07-28',
  '2027-09-22','2027-11-03','2027-12-15',
];
function nthWeekdayOfMonth(year, month, weekday, n) {
  // month 0-11, weekday 0=Sun..6=Sat, n=1 for first
  const d = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (d.getUTCMonth() === month) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) return new Date(d); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}
function computedEconEvents(from, to) {
  const events = [];
  const inRange = ds => ds >= from.toISOString().slice(0,10) && ds <= to.toISOString().slice(0,10);
  const lastWeekday = (y, m, wd) => { // last <wd> of month
    const d = new Date(Date.UTC(y, m + 1, 0)); // last day
    while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  };

  // FOMC (exact)
  for (const f of FOMC_DATES) if (inRange(f)) events.push({ date: f, event: 'FOMC rate decision + Powell press conf' });

  const months = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= end) { months.push([cur.getUTCFullYear(), cur.getUTCMonth()]); cur.setUTCMonth(cur.getUTCMonth()+1); }

  const push = (d, label) => { if (d) { const ds = d.toISOString().slice(0,10); if (inRange(ds)) events.push({ date: ds, event: label }); } };

  for (const [y, m] of months) {
    push(nthWeekdayOfMonth(y, m, 5, 1), 'Jobs report (NFP + unemployment)');   // 1st Friday
    push(nthWeekdayOfMonth(y, m, 3, 2), 'CPI inflation (approx)');             // 2nd Wednesday
    push(nthWeekdayOfMonth(y, m, 4, 2), 'PPI inflation (approx)');             // 2nd Thursday
    push(nthWeekdayOfMonth(y, m, 4, 3), 'Retail sales / Jobless claims (approx)'); // 3rd Thursday-ish
    push(lastWeekday(y, m, 5), 'PCE inflation + personal income (approx)');    // last Friday
    push(nthWeekdayOfMonth(y, m, 4, 4), 'GDP estimate / Durable goods (approx)'); // 4th Thursday
    // Weekly jobless claims — every Thursday in window
    for (let n = 1; n <= 5; n++) push(nthWeekdayOfMonth(y, m, 4, n), 'Weekly initial jobless claims');
  }
  // dedup by date+event
  const seen = new Set();
  return events.filter(e => { const k = e.date + '|' + e.event; if (seen.has(k)) return false; seen.add(k); return true; })
               .sort((a,b) => a.date.localeCompare(b.date));
}

/* Market-moving headlines (policy / Trump / tariff / Fed / geopolitics) pulled
   from Finnhub general news. Gives the AI REAL current headlines to anchor the
   "themes" and "what matters next" sections instead of inventing them.
   (Truth Social has no free/stable API; general market news is the reliable
   source for policy & Trump market-moving items.) */
const NEWS_KEYWORDS = /trump|tariff|fed|powell|rate cut|inflation|cpi|opec|sanction|china|export|stimulus|shutdown|jobs report|treasury|yield/i;
async function buildNewsFacts(env) {
  if (!env.FINNHUB_KEY) return '';
  const news = await fhFetch('/news?category=general', env);
  if (!Array.isArray(news)) return '';
  const seen = new Set();
  const hits = [];
  for (const n of news) {
    const h = (n.headline || '').trim();
    if (!h || seen.has(h)) continue;
    if (!NEWS_KEYWORDS.test(h)) continue;
    seen.add(h);
    hits.push(`  - ${h}${n.source ? ` (${n.source})` : ''}`);
    if (hits.length >= 12) break;
  }
  if (!hits.length) return '';
  return 'REAL MARKET-MOVING HEADLINES (current — use to ground themes & catalysts, classify each as Major/Moderate/Minor):\n' + hits.join('\n') + '\n\n';
}

/* ════════════════════════════════════════════════════════════════════════════
   CORS + JSON helpers
   ════════════════════════════════════════════════════════════════════════════ */
const ALLOWED_ORIGINS = ['https://anthonyn99.github.io'];
function corsHeaders(req) {
  const origin = req?.headers?.get('Origin') || '';
  // Allow the prod origin, plus local testing (file:// sends Origin "null", and
  // localhost during dev). Anything else falls back to the prod origin string.
  let allow;
  if (ALLOWED_ORIGINS.includes(origin)) allow = origin;
  else if (origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) allow = origin;
  else allow = ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma',
    'Vary': 'Origin',
  };
}
function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   KV helpers
   ════════════════════════════════════════════════════════════════════════════ */
async function kvGet(env, key)        { try { return await env.TD_KV.get(key, 'json'); } catch { return null; } }
async function kvPut(env, key, v, ttl){ const o = ttl ? { expirationTtl: ttl } : undefined; await env.TD_KV.put(key, JSON.stringify(v), o); }

const todayUTC = () => new Date().toISOString().slice(0, 10);

async function getRate(env) {
  const r = await kvGet(env, 'td_rate');
  if (!r || r.day !== todayUTC()) return { day: todayUTC(), used: 0, lastRunMs: 0 };
  return r;
}
async function rateStatus(env) {
  const r = await getRate(env);
  const sinceLast = (Date.now() - (r.lastRunMs || 0)) / 1000;
  const cooldownSec = Math.max(0, Math.ceil(MIN_INTERVAL_S - sinceLast));
  return {
    usedToday: r.used, dailyLimit: DAILY_LIMIT,
    cooldownSec, minIntervalSec: MIN_INTERVAL_S,
    canRun: r.used < DAILY_LIMIT && cooldownSec <= 0,
  };
}
async function bumpRate(env) {
  const r = await getRate(env);
  r.used += 1; r.lastRunMs = Date.now();
  await kvPut(env, 'td_rate', r);
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPTS (CRUD)
   ════════════════════════════════════════════════════════════════════════════ */
async function getPrompts(env) {
  const p = await kvGet(env, 'td_prompts');
  return p || { prompts: [], activeId: null };
}

/* ════════════════════════════════════════════════════════════════════════════
   STRUCTURED-OUTPUT CONTRACT
   We wrap the user's prompt with a system instruction forcing a single JSON
   object. The schema is INTENTIONALLY GENERIC ("blocks") so ANY prompt renders:
   the AI maps its answer into typed blocks the front-end knows how to draw.
   ════════════════════════════════════════════════════════════════════════════ */
const RENDER_SCHEMA_DOC = `
You are a rendering engine. Run the user's report prompt, then return the FULL
result as ONE JSON object and NOTHING else (no markdown, no backticks, no prose
before or after). The object describes a dashboard built from typed "blocks".

TOP LEVEL:
{
  "title": string,
  "summary": string,            // 1-2 sentence top-line read
  "meta": { "bias": string, "regime": string, "goNoGo": string, "confidence": string },  // optional, omit fields you can't fill
  "blocks": Block[]
}

EACH Block is ONE of:
  { "type":"kpis", "title"?:string, "items":[{"label":string,"value":string,"tone"?:"good"|"warn"|"bad"|"neutral"}] }
  { "type":"scoreboard", "title"?:string, "items":[{"label":string,"rating":"good"|"warn"|"bad","note"?:string}] }
  { "type":"table", "title"?:string, "columns":string[], "rows":string[][], "tone"?: ("good"|"warn"|"bad"|"neutral"|null)[] }   // tone is per-row, optional
  { "type":"list", "title"?:string, "ordered"?:boolean, "items":string[] }
  { "type":"cards", "title"?:string, "items":[{"heading":string,"body":string,"tag"?:string,"tone"?:"good"|"warn"|"bad"|"neutral"}] }
  { "type":"tiers", "title"?:string, "tiers":[{"label":string,"tone"?:"good"|"warn"|"bad"|"neutral","items":string[]}] }
  { "type":"keyvalue", "title"?:string, "items":[{"k":string,"v":string}] }
  { "type":"callout", "tone":"good"|"warn"|"bad"|"neutral", "title"?:string, "body":string }

RULES:
- Choose the block type that best fits each section of the answer.
- Use "scoreboard" for 🟢/🟡/🔴 style ratings (map green→good, yellow→warn, red→bad).
- Use "tiers" for S/A/B/C tier lists.
- Keep every string concise (1 line) unless the prompt explicitly asks for more.
- Preserve the section ORDER of the user's prompt.
- The user's prompt is a TEMPLATE. Square-bracket tokens like [catalyst], [1 line],
  [Driver + reason], [list] are PLACEHOLDERS describing what to write — you must
  REPLACE them with real, specific analysis. NEVER output the literal brackets or
  template words. If you genuinely have no data for a field, write a brief best
  estimate or "N/A — no notable items", never a placeholder.
- NEVER emit an empty block (no empty tiers, empty rows, or blank items). If a
  section would be empty, fill it with your best concrete read or omit the block.
- For tier lists (S/A/B/C), put real named items/tickers/events in each tier; if a
  tier has none, give it a single item "None currently".
- Output ONLY the JSON object. It MUST be valid JSON (parseable). No trailing commas.
`.trim();

/* Build a date-context preamble so the model anchors catalysts to TODAY, not a
   guessed/stale date. Computes the next ~10 US trading days (skips weekends;
   does not account for market holidays, which is fine for guidance). */
function dateContext() {
  const now = new Date();
  const fmt = d => d.toLocaleDateString('en-US', { weekday:'short', year:'numeric', month:'short', day:'numeric', timeZone:'America/New_York' });
  const days = nextTradingDays(10).map(fmt);
  return `CURRENT DATE CONTEXT (authoritative — use this, do NOT guess dates):
Today is ${fmt(now)} (US Eastern).
The "next 10 trading days" (weekends + US market holidays excluded) = ${days[0]} through ${days[days.length-1]}.
Any calendar/catalyst dates MUST fall within or near this window. Do not output
dates from past months or far in the future. If unsure of an exact date, anchor
it to this window.\n\n`;
}

function buildMessages(userPrompt, facts) {
  return [
    { role: 'system', content: RENDER_SCHEMA_DOC },
    { role: 'user',   content: (facts || '') + dateContext() + userPrompt },
  ];
}

/* ════════════════════════════════════════════════════════════════════════════
   PROMPT CHUNKING (for staged builds)
   A long report prompt (e.g. 10 sections) is too slow for ONE Cloudflare
   invocation. We split it into chunks, run each chunk as its OWN sub-invocation
   (each gets a fresh time budget), then stitch the blocks together in order.

   Split strategy: break on top-level markdown headings ("# " or "## "). Group
   consecutive sections so each chunk is roughly balanced and under MAX_CHUNKS.
   ════════════════════════════════════════════════════════════════════════════ */
const MAX_CHUNKS    = 4;     // never fire more than this many sub-invocations
const CHUNK_TARGET  = 1800;  // ~chars per chunk target (soft)

function splitPromptIntoChunks(prompt) {
  const text = prompt.trim();
  // Split keeping the heading with its body. Match lines starting with # or ##.
  const parts = text.split(/\n(?=#{1,2}\s)/g).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [text]; // not a sectioned prompt → single chunk

  // Greedy-group sections into balanced chunks.
  const chunks = [];
  let cur = '';
  for (const sec of parts) {
    if (cur && (cur.length + sec.length) > CHUNK_TARGET && chunks.length < MAX_CHUNKS - 1) {
      chunks.push(cur); cur = sec;
    } else {
      cur = cur ? cur + '\n\n' + sec : sec;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS);
}

/* System doc for a CHUNK — same schema but tells the model it's rendering ONE
   part of a larger report, so it should NOT add a title/summary/meta, just blocks. */
const CHUNK_SCHEMA_DOC = RENDER_SCHEMA_DOC + `

IMPORTANT: You are rendering ONE PART of a larger report. Return JSON with ONLY
a "blocks" array (no title, no summary, no meta) covering the section(s) below.
{ "blocks": Block[] }`;

function buildChunkMessages(chunkPrompt, isFirst, facts) {
  // First chunk also produces title/summary/meta; later chunks are blocks-only.
  const sys = isFirst ? RENDER_SCHEMA_DOC : CHUNK_SCHEMA_DOC;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: (facts || '') + dateContext() + chunkPrompt },
  ];
}

/* ════════════════════════════════════════════════════════════════════════════
   PROVIDER ADAPTERS  — each returns raw text (expected to be JSON)
   ════════════════════════════════════════════════════════════════════════════ */
async function callGemini(model, messages, env) {
  if (!env.GEMINI_KEY) throw tagged('NO_KEY', 'gemini key not set');
  // Gemini uses its own format. Fold system → systemInstruction, user → contents.
  const sys  = messages.find(m => m.role === 'system')?.content || '';
  const user = messages.find(m => m.role === 'user')?.content   || '';
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: MAX_OUT_TOKENS, responseMimeType: 'application/json' },
  };
  const res = await fetchTO(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw httpErr(res);
  const j = await res.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!txt) throw tagged('EMPTY', 'gemini returned empty');
  return txt;
}

async function callOpenAICompat(baseUrl, key, model, messages, env, extra = {}) {
  if (!key) throw tagged('NO_KEY', 'key not set');
  const res = await fetchTO(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model, messages, temperature: 0.4, max_tokens: MAX_OUT_TOKENS,
      response_format: { type: 'json_object' }, ...extra,
    }),
  });
  if (!res.ok) throw httpErr(res);
  const j = await res.json();
  const txt = j?.choices?.[0]?.message?.content || '';
  if (!txt) throw tagged('EMPTY', 'empty completion');
  return txt;
}
const callNvidia = (model, messages, env) =>
  callOpenAICompat('https://integrate.api.nvidia.com/v1', env.NVIDIA_KEY, model, messages, env);
const callGroq = (model, messages, env) =>
  callOpenAICompat('https://api.groq.com/openai/v1', env.GROQ_KEY, model, messages, env);

/* ── small fetch utils ── */
function fetchTO(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(AI_TIMEOUT_MS) });
}
function tagged(code, msg) { const e = new Error(msg); e.code = code; return e; }
function httpErr(res) {
  const e = new Error(`HTTP ${res.status}`);
  e.status = res.status;
  e.retryAfter = parseFloat(res.headers.get('Retry-After')) || 0;
  if (res.status === 429) e.code = 'RATE_LIMIT';
  else if (res.status >= 500) e.code = 'SERVER';
  else e.code = 'HTTP';
  return e;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ════════════════════════════════════════════════════════════════════════════
   AI ROUTER  — the ONE place all AI calls go through.
   Handles: model selection, retries w/ backoff+jitter (honors Retry-After),
   429 fallback, tier walk, and JSON validation.
   ════════════════════════════════════════════════════════════════════════════ */
function dispatch(provider, model, messages, env) {
  if (provider === 'gemini') return callGemini(model, messages, env);
  if (provider === 'nvidia') return callNvidia(model, messages, env);
  if (provider === 'groq')   return callGroq(model, messages, env);
  throw tagged('NO_PROVIDER', provider);
}

/* Pull a JSON object out of a model response, tolerating stray prose/backticks.
   blocksOnly=true accepts { blocks:[...] } chunk responses without title/meta. */
function parseReport(txt, blocksOnly) {
  let s = txt.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) throw tagged('PARSE', 'no JSON object found');
  const obj = JSON.parse(s.slice(a, b + 1));
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.blocks)) throw tagged('PARSE', 'missing blocks[]');
  return obj;
}

async function aiRoute(messages, env, ctx) {
  const attempts = [];
  for (const tier of AI_CHAIN) {
    for (const model of tier.models) {
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          const txt    = await dispatch(tier.provider, model, messages, env);
          const report = parseReport(txt);
          return { report, model: `${tier.provider}:${model}`, attempts };
        } catch (e) {
          attempts.push({ model: `${tier.provider}:${model}`, code: e.code || 'ERR', msg: (e.message || '').slice(0, 120) });
          // Hard-skip this whole provider chain entry if key missing.
          if (e.code === 'NO_KEY' || e.code === 'NO_PROVIDER') break;
          // Retryable: 429 / 5xx / timeout. Back off then retry SAME model.
          const retryable = e.code === 'RATE_LIMIT' || e.code === 'SERVER' || e.name === 'TimeoutError' || e.code === 'EMPTY';
          if (retryable && retry < MAX_RETRIES) {
            const base = e.retryAfter ? e.retryAfter * 1000 : 800 * Math.pow(2, retry);
            await sleep(base + Math.random() * 400); // jitter
            continue;
          }
          break; // move to next model
        }
      }
    }
  }
  const err = tagged('ALL_FAILED', 'all AI tiers/models failed');
  err.attempts = attempts;
  throw err;
}

/* ════════════════════════════════════════════════════════════════════════════
   BUILD PIPELINE (async, fired via ctx.waitUntil)
   ════════════════════════════════════════════════════════════════════════════ */
async function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

async function runBuild(prompt, env, ctx) {
  const runId = crypto.randomUUID();
  await kvPut(env, 'td_report', { status: 'building', report: null, error: null, generatedAt: null, model: null, runId, startedAt: Date.now() });

  // dedup: identical prompt within CACHE_TTL → reuse
  const hash = await fnv1a(prompt);
  const cached = await kvGet(env, `td_cache:${hash}`);
  if (cached?.report) {
    await kvPut(env, 'td_report', { status: 'ready', report: cached.report, error: null, generatedAt: cached.generatedAt, model: cached.model + ' (cached)', runId });
    return;
  }

  const chunks = splitPromptIntoChunks(prompt);

  // Store the job with facts NOT yet fetched. A dedicated "facts" pre-stage will
  // fetch live data in its OWN invocation (own time budget), then start chunks.
  // This keeps /build itself instant so it never wall-times before staging.
  const job = { runId, hash, prompt, facts: '', factsDone: false, chunks,
                stage: 0, total: chunks.length, single: chunks.length <= 1,
                blocks: [], meta: null, title: null, summary: null, model: null,
                startedAt: Date.now() };
  await kvPut(env, 'td_job', job);
  await kickStage(env, ctx, runId, 'facts');  // first: fetch facts
}

/* Fire the next stage as a separate invocation (own time budget) via SELF binding.
   phase: 'facts' → fetch live data; 'chunk' → render one chunk. */
async function kickStage(env, ctx, runId, phase) {
  const url = `${env.WORKER_ORIGIN || 'https://trade-dashboard.av1.workers.dev'}/_stage`;
  const headers = { 'Content-Type': 'application/json', 'x-stage-secret': env.STAGE_SECRET || '' };
  const body = JSON.stringify({ runId, phase: phase || 'chunk' });
  const target = env.SELF || null;
  const doFetch = () => (target ? target.fetch(new Request(url, { method: 'POST', headers, body }))
                                : fetch(url, { method: 'POST', headers, body }));
  ctx.waitUntil(doFetch().catch(e => console.error('[kickStage]', e.message)));
}

/* PRE-STAGE: fetch live market facts in its own invocation, then start chunks
   (or run the single-chunk inline build). */
async function runFactsStage(runId, env, ctx) {
  const job = await kvGet(env, 'td_job');
  if (!job || job.runId !== runId) { console.warn('[facts] stale/missing job'); return; }

  let facts = '';
  try { facts = await buildMarketFacts(env); } catch (e) { console.error('[facts]', e.message); }
  job.facts = facts;
  job.factsDone = true;
  await kvPut(env, 'td_job', job);

  // SINGLE CHUNK → render inline right here (facts already in hand).
  if (job.single) {
    try {
      const { report, model } = await aiRoute(buildMessages(job.prompt, facts), env);
      const generatedAt = Date.now();
      await kvPut(env, 'td_report', { status: 'ready', report, error: null, generatedAt, model, runId });
      await kvPut(env, `td_cache:${job.hash}`, { report, generatedAt, model }, CACHE_TTL_S);
      await bumpRate(env);
    } catch (e) {
      await kvPut(env, 'td_report', { status: 'degraded', report: null, error: e.message || 'AI failed', generatedAt: Date.now(), model: null, runId });
    }
    return;
  }
  // MULTI CHUNK → kick chunk 0.
  await kickStage(env, ctx, runId, 'chunk');
}

/* Process ONE chunk, append its blocks, then either kick the next stage or
   finalize the report. Runs in its own invocation. */
async function runStage(runId, env, ctx) {
  const job = await kvGet(env, 'td_job');
  if (!job || job.runId !== runId) { console.warn('[stage] stale/missing job'); return; }

  const i = job.stage;
  const isFirst = i === 0;
  const chunk = job.chunks[i];

  try {
    // Inject live facts into every chunk so each section uses real numbers.
    const { report, model } = await aiRouteChunk(buildChunkMessages(chunk, isFirst, job.facts || ''), env);
    if (isFirst) {
      job.title   = report.title   || 'Report';
      job.summary = report.summary || '';
      job.meta    = report.meta    || null;
    }
    job.blocks = job.blocks.concat(Array.isArray(report.blocks) ? report.blocks : []);
    job.model  = job.model || model;
  } catch (e) {
    console.error(`[stage ${i}] failed:`, e.message);
    // keep going — a failed chunk just contributes no blocks, rest still render
  }

  job.stage = i + 1;
  await kvPut(env, 'td_job', job);

  if (job.stage < job.total) {
    await kickStage(env, ctx, runId, 'chunk');   // next chunk
  } else {
    // finalize
    const report = { title: job.title || 'Report', summary: job.summary || '', meta: job.meta || undefined, blocks: job.blocks };
    const generatedAt = Date.now();
    if (job.blocks.length === 0) {
      await kvPut(env, 'td_report', { status: 'degraded', report: null, error: 'All chunks failed to render.', generatedAt, model: null, runId });
    } else {
      await kvPut(env, 'td_report', { status: 'ready', report, error: null, generatedAt, model: job.model, runId });
      await kvPut(env, `td_cache:${job.hash}`, { report, generatedAt, model: job.model }, CACHE_TTL_S);
      await bumpRate(env);
    }
  }
}

/* Same router as aiRoute but parses chunk (blocks-only) responses. */
async function aiRouteChunk(messages, env) {
  const attempts = [];
  for (const tier of AI_CHAIN) {
    for (const model of tier.models) {
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          const txt = await dispatch(tier.provider, model, messages, env);
          const report = parseReport(txt, true);
          return { report, model: `${tier.provider}:${model}`, attempts };
        } catch (e) {
          attempts.push({ model: `${tier.provider}:${model}`, code: e.code || 'ERR' });
          if (e.code === 'NO_KEY' || e.code === 'NO_PROVIDER') break;
          const retryable = e.code === 'RATE_LIMIT' || e.code === 'SERVER' || e.name === 'TimeoutError' || e.code === 'EMPTY';
          if (retryable && retry < MAX_RETRIES) { await sleep((e.retryAfter ? e.retryAfter*1000 : 800*Math.pow(2,retry)) + Math.random()*400); continue; }
          break;
        }
      }
    }
  }
  const err = tagged('ALL_FAILED', 'all AI tiers/models failed'); err.attempts = attempts; throw err;
}

/* ════════════════════════════════════════════════════════════════════════════
   ROUTER
   ════════════════════════════════════════════════════════════════════════════ */
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

  // ── health ──
  if (path === '/' && method === 'GET') {
    return json({ ok: true, service: 'trade-dashboard', daily: DAILY_LIMIT, intervalSec: MIN_INTERVAL_S }, 200, request);
  }

  // ── debug: show the exact market facts that get injected into the prompt ──
  if (path === '/debug-data' && method === 'GET') {
    globalThis.__fhLastErr = null;
    const hasKey = !!env.FINNHUB_KEY;
    // raw fetch of SPY quote so we see the actual HTTP status/body
    let rawStatus = null, rawBody = null;
    try {
      const r = await fetch(`${FH_BASE}/quote?symbol=SPY&token=${env.FINNHUB_KEY}`, { signal: AbortSignal.timeout(8000) });
      rawStatus = r.status;
      rawBody = await r.text();
    } catch (e) { rawBody = 'fetch threw: ' + e.message; }
    let facts = '';
    try { facts = await buildMarketFacts(env); } catch (e) {}
    // also test the new Yahoo quote source directly
    let stooqTest = null, stooqStatus = null, stooqBody = null;
    try {
      const sr = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      stooqStatus = sr.status;
      stooqBody = (await sr.text()).slice(0, 200);
    } catch (e) { stooqBody = 'threw: ' + e.message; }
    try { stooqTest = await stooqQuote('SPY'); } catch (e) {}
    return json({
      ok: true,
      finnhubKeySet: hasKey,
      rawSPYStatus: rawStatus,
      rawSPYBody: (rawBody || '').slice(0, 300),
      stooqStatus, stooqBody,         // raw stooq response so we see what's wrong
      stooqSPY: stooqTest,
      lastFinnhubError: globalThis.__fhLastErr,
      factsLength: facts.length,
      factsPreview: facts.slice(0, 600),
    }, 200, request);
  }

  // ── calendar: deterministic macro (FOMC/CPI/jobs) + real earnings ──────────
  // Reliable replacement/supplement for the newshub calendar. Always returns the
  // hardcoded macro events (never empty) plus Finnhub earnings for the tickers.
  // Shape matches what TradeHub Catalysts expects: {events:[{id,name,date,kind,when}]}
  if (path === '/calendar' && method === 'GET') {
    const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '10', 10)));
    const tickers = (url.searchParams.get('tickers') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const today = new Date();
    const to = new Date(today); to.setDate(to.getDate() + days + 4);
    const iso = d => d.toISOString().slice(0, 10);
    const events = [];

    // Macro (deterministic — never empty). Each event gets:
    //   kind     → for reminder icon/logic
    //   category → SHORT uppercase tag shown as the colored label (JOBS/GROWTH/etc)
    //   name     → clean readable title
    const monShort = d => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(d.slice(5,7),10)-1];
    const prevMon  = d => ['Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov'][parseInt(d.slice(5,7),10)-1];
    function macroMeta(ev, date) {
      const pm = prevMon(date);
      if (/FOMC/i.test(ev))                 return { kind:'fed',       category:'FED',       name:'FOMC Rate Decision' };
      if (/CPI/i.test(ev))                  return { kind:'inflation', category:'INFLATION', name:`${pm} CPI Report` };
      if (/PPI/i.test(ev))                  return { kind:'inflation', category:'INFLATION', name:`${pm} PPI Report` };
      if (/PCE/i.test(ev))                  return { kind:'inflation', category:'INFLATION', name:`${pm} PCE Report` };
      if (/GDP|durable/i.test(ev))          return { kind:'growth',    category:'GROWTH',    name:`${pm} Durable Goods / GDP` };
      if (/retail/i.test(ev))               return { kind:'growth',    category:'GROWTH',    name:`${pm} Retail Sales` };
      if (/jobs report|NFP|payroll/i.test(ev)) return { kind:'jobs',   category:'JOBS',      name:`${pm} Jobs Report (NFP)` };
      if (/jobless/i.test(ev))              return { kind:'jobs',      category:'JOBS',      name:'Weekly Jobless Claims' };
      return { kind:'macro', category:'MACRO', name: ev.replace(/\s*\(approx\)/i,'') };
    }
    for (const e of computedEconEvents(today, to)) {
      const meta = macroMeta(e.event, e.date);
      events.push({ id: 'macro_' + e.date + '_' + meta.category, name: meta.name, date: e.date, kind: meta.kind, category: meta.category, when: 'bmo' });
    }

    // Earnings (Finnhub, real dates) for requested tickers
    if (tickers.length && env.FINNHUB_KEY) {
      const ec = await fhFetch(`/calendar/earnings?from=${iso(today)}&to=${iso(to)}`, env);
      const wl = new Set(tickers);
      for (const e of (ec?.earningsCalendar || [])) {
        const sym = (e.symbol || '').toUpperCase();
        if (!wl.has(sym)) continue;
        events.push({ id: 'earn_' + sym + '_' + e.date, name: sym + ' Earnings', date: e.date, kind: 'earnings', category: 'EARNINGS', when: (e.hour === 'amc' || e.hour === 'bmo') ? e.hour : 'amc', epsEstimate: e.epsEstimate ?? null });
      }
    }

    // Trim to a window a bit wider than `days` calendar days (covers ~10 trading
    // days which can reach ~14 calendar days), dedup, sort.
    const windowDays = Math.max(days, 14);
    const cutoff = iso(new Date(today.getTime() + windowDays * 86400000));
    const seen = new Set();
    const out = events.filter(e => e.date >= iso(today) && e.date <= cutoff && !seen.has(e.id) && seen.add(e.id))
                      .sort((a, b) => a.date.localeCompare(b.date));
    return json({ events: out, generatedAt: Date.now(), degraded: false, source: 'trade-dashboard' }, 200, request);
  }

  // ── rate status (cheap) ──
  if (path === '/rate-status' && method === 'GET') {
    return json(await rateStatus(request ? env : env), 200, request);
  }

  // ── poll current report ──
  if (path === '/poll' && method === 'GET') {
    const r = await kvGet(env, 'td_report');
    if (r && r.status === 'building' && r.startedAt) {
      // Staged builds run several invocations, so allow more time. We also check
      // td_job progress: if the job is advancing, it isn't stuck.
      const elapsed = Date.now() - r.startedAt;
      const job = await kvGet(env, 'td_job');
      const jobAdvancing = job && job.runId === r.runId && job.stage > 0;
      const limit = jobAdvancing ? 300000 : 150000; // 5min if staging, 2.5min otherwise
      if (elapsed > limit) {
        const stale = { ...r, status: 'degraded', error: 'Build timed out. Try again — or shorten the prompt.' };
        await kvPut(env, 'td_report', stale);
        return json(stale, 200, request);
      }
    }
    return json(r || { status: 'idle', report: null }, 200, request);
  }

  // ── build (kick async run) ──
  if (path === '/build' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    let prompt = (body.prompt || '').trim();
    // if no prompt passed, use the active saved prompt
    if (!prompt) {
      const ps = await getPrompts(env);
      const active = ps.prompts.find(p => p.id === ps.activeId) || ps.prompts[0];
      prompt = active?.text?.trim() || '';
    }
    if (!prompt) return json({ ok: false, error: 'No prompt provided or saved.' }, 400, request);

    const rs = await rateStatus(env);
    const force = body.force === true; // force still respects daily cap, skips cooldown only if cap allows
    if (rs.usedToday >= DAILY_LIMIT) return json({ ok: false, error: 'Daily limit reached.', ...rs }, 429, request);
    if (!force && rs.cooldownSec > 0) return json({ ok: false, error: `Cooldown ${rs.cooldownSec}s`, ...rs }, 429, request);

    ctx.waitUntil(runBuild(prompt, env, ctx));
    return json({ ok: true, status: 'building' }, 202, request);
  }

  // ── internal: process one staged chunk (gated by STAGE_SECRET) ──
  if (path === '/_stage' && method === 'POST') {
    if (env.STAGE_SECRET && request.headers.get('x-stage-secret') !== env.STAGE_SECRET) {
      return json({ ok: false, error: 'forbidden' }, 403, request);
    }
    const body = await request.json().catch(() => ({}));
    if (!body.runId) return json({ ok: false, error: 'runId required' }, 400, request);
    if (body.phase === 'facts') ctx.waitUntil(runFactsStage(body.runId, env, ctx));
    else                        ctx.waitUntil(runStage(body.runId, env, ctx));
    return json({ ok: true, status: 'staging' }, 202, request);
  }

  // ── prompts: list ──
  if (path === '/prompts' && method === 'GET') {
    return json({ ok: true, ...(await getPrompts(env)) }, 200, request);
  }

  // ── prompts: create/update + set active ──
  if (path === '/prompts' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const store = await getPrompts(env);
    const now = Date.now();
    if (body.id) {
      const idx = store.prompts.findIndex(p => p.id === body.id);
      if (idx === -1) return json({ ok: false, error: 'Prompt not found' }, 404, request);
      if (body.name != null) store.prompts[idx].name = body.name;
      if (body.text != null) store.prompts[idx].text = body.text;
      store.prompts[idx].updatedAt = now;
    } else {
      const entry = { id: crypto.randomUUID(), name: body.name || 'Untitled', text: body.text || '', createdAt: now, updatedAt: now };
      store.prompts.unshift(entry);
      if (body.makeActive !== false) store.activeId = entry.id;
    }
    if (body.activeId !== undefined) store.activeId = body.activeId;
    await kvPut(env, 'td_prompts', store);
    return json({ ok: true, ...store }, 200, request);
  }

  // ── prompts: delete ──
  const pm = path.match(/^\/prompts\/(.+)$/);
  if (pm && method === 'DELETE') {
    const id = pm[1];
    const store = await getPrompts(env);
    const before = store.prompts.length;
    store.prompts = store.prompts.filter(p => p.id !== id);
    if (store.prompts.length === before) return json({ ok: false, error: 'Not found' }, 404, request);
    if (store.activeId === id) store.activeId = store.prompts[0]?.id || null;
    await kvPut(env, 'td_prompts', store);
    return json({ ok: true, ...store }, 200, request);
  }

  return json({ ok: false, error: `Not found: ${method} ${path}` }, 404, request);
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (e) {
      console.error('[trade-dashboard] unhandled', e);
      return json({ ok: false, error: 'Internal error' }, 500, request);
    }
  },
};

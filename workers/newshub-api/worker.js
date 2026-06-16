// ============================================================================
// newshub-api  — Cloudflare Worker
//
// Routes:
//   GET /health         → status check
//   GET /news           → events (cached, 5min TTL)
//   GET /news?fresh=1   → force refresh, bypass cache
//
// Bindings (set via wrangler secret put / Cloudflare dashboard):
//   GEMINI_KEY, FINNHUB_KEY, MARKETAUX_KEY, STOCKDATA_KEY, ALPHAVANTAGE_KEY
//   NEWSHUB_CACHE (KV namespace)
// ============================================================================

// ── Canonical default watchlist ───────────────────────────────────────────
// MUST stay in sync with the client's TB_WATCHLIST (tradehub.html). When the
// client requests this exact set (the un-customized default), the worker uses
// the shared 'events:v1' cache key, so the cron pre-warm is actually consumed
// instead of being orphaned under a per-list key the client never reads.
const WATCHLIST = ['SNDK','MU','WDC','INTC','AMD','LMT','CRWD','BE','GOOGL','PLTR','NVDA','CRDO','TSLA','AAPL','MSFT','NET','SCCO','ERO','WMT','AMZN','BABA','LMND','EXPE','NVS','MS','XOM','CVX','VLO','CNQ'];

// Sector inference table (mirrors client TB_TICKER_SECTORS). Unknown → 'Diversified'
// so news still surfaces for tickers not listed here.
const SECTOR_LOOKUP = {
  SNDK:'Storage', MU:'Semiconductor/Memory', WDC:'Storage', INTC:'Semiconductor',
  AMD:'Semiconductor', CRDO:'Semiconductor', MRVL:'AI/Semiconductor', DRAM:'Semiconductor/Memory',
  LMT:'Defense', CRWD:'Cybersecurity', NET:'Cybersecurity', BE:'Clean Energy',
  GOOGL:'Tech/Mega-Cap', AAPL:'Tech/Mega-Cap', MSFT:'Tech/Mega-Cap',
  PLTR:'AI/Software', NVDA:'AI/Semiconductor', TSLA:'EV/Auto', SPCX:'Space/SPAC',
  SCCO:'Copper/Mining', ERO:'Copper/Mining', WMT:'Retail', AMZN:'Tech/Retail',
  BABA:'China/Tech', LMND:'InsurTech', EXPE:'Travel', NVS:'Pharma', MS:'Financials',
  XOM:'Energy', CVX:'Energy', VLO:'Refining', CNQ:'Energy',
};
function inferSector(t){ return SECTOR_LOOKUP[t] || 'Diversified'; }

// Company-name aliases so headline matching catches articles that name the
// company but not the ticker. Extend freely — unknown tickers match on symbol.
const ALIASES = {
  DRAM:['dram'], SNDK:['sandisk'], MU:['micron'], INTC:['intel'], WDC:['western digital'],
  AMD:['advanced micro'], CRWD:['crowdstrike'], BE:['bloom energy'], LMT:['lockheed'],
  GOOGL:['google','alphabet'], PLTR:['palantir'], NVDA:['nvidia'], CRDO:['credo'],
  TSLA:['tesla'], SPCX:['spacex'], AAPL:['apple'], MSFT:['microsoft'],
  NET:['cloudflare'], SCCO:['southern copper'], ERO:['ero copper'], WMT:['walmart'],
  AMZN:['amazon'], BABA:['alibaba'], MRVL:['marvell'], LMND:['lemonade'],
  EXPE:['expedia'], NVS:['novartis'], MS:['morgan stanley'], XOM:['exxon'],
  CVX:['chevron'], VLO:['valero'], CNQ:['canadian natural'],
};

// ── Dynamic watchlist support ─────────────────────────────────────────────
// On-demand /news may pass ?tickers=A,B,C — the whole pipeline runs against the
// caller's list. A request whose list equals WATCHLIST (order-independent) is
// treated as the default so it shares the cron cache.
//
// Sanitize an incoming ?tickers= list → uppercase, A-Z0-9./- only, deduped, capped.
function parseTickers(raw){
  if (!raw) return null;
  const out = [];
  const seen = new Set();
  for (let t of raw.split(',')){
    t = t.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g,'');
    if (t && t.length <= 6 && !seen.has(t)){ seen.add(t); out.push(t); }
  }
  return out.length ? out.slice(0, 40) : null;
}
// Build a sector map for an arbitrary watchlist.
function sectorsFor(wl){
  const m = {};
  for (const t of wl) m[t] = inferSector(t);
  return m;
}
// Stable cache-key suffix for a given watchlist (order-independent).
function wlHash(wl){
  return [...wl].sort().join(',');
}
// Default sector map, computed once from the canonical watchlist.
const SECTORS = sectorsFor(WATCHLIST);

const HOURS = 72;
// Fallback chain: tries in order. If one returns 429 (quota), worker skips to next.
// Quota-exhaustion state lives in KV for 1 hour so we don't waste retries.
// Unified AI fallback chain — tried in order, first available wins.
// Gemini uses Google's API; NIM entries use NVIDIA's OpenAI-compatible endpoint.
// Format: { provider: 'gemini'|'nim', model: '...' }
const AI_CHAIN = [
  { provider:'nim',    model:'meta/llama-3.3-70b-instruct' }, // PRIMARY: no daily cap, confirmed working schema
  { provider:'gemini', model:'gemini-2.5-flash-lite' },   // highest RPD Gemini — first fallback
  { provider:'gemini', model:'gemini-2.0-flash' },        // ~200 RPD
  { provider:'gemini', model:'gemini-2.5-flash' },        // best quality, thin quota
  { provider:'gemini', model:'gemini-1.5-flash' },        // last Gemini resort
  { provider:'nim',    model:'mistralai/mixtral-8x7b-instruct' }, // final AI fallback
];
// Keep these for /health display
const GEMINI_CHAIN = AI_CHAIN.filter(e=>e.provider==='gemini').map(e=>e.model);
const NIM_CHAIN    = AI_CHAIN.filter(e=>e.provider==='nim').map(e=>e.model);
const QUOTA_COOLDOWN = 3600; // 1h before retrying a model that hit 429
const BATCH_SIZE = 20;       // larger batches → fewer sequential AI calls per build
const MAX_EVENTS = 80;       // analyze the top 80 events (ranked by source corroboration).
                             // 80/20 = 4 AI calls/build — finishes well within Worker limits.
                             // 200/15 = 14 calls was too heavy: build ran past the lock TTL
                             // without caching → infinite "Building…" loop.
const CACHE_TTL = 21600;     // 6 hours — pre-warm cache survives between cron runs, so regular Refresh = free cache hit (no quota / rate-token burn)

// ─── Per-API daily budgets ────────────────────────────────────────────────
// Free tier daily caps. We track usage in KV and stop calling an API before
// it 429s, so quotas last all day. Reserve headroom (cap below true limit).
const API_BUDGETS = {
  marketaux:    { limit: 90,  key: 'budget:marketaux' },   // true 100/day
  stockdata:    { limit: 90,  key: 'budget:stockdata' },   // true 100/day
  alphavantage: { limit: 22,  key: 'budget:alphavantage' },// true 25/day
  finnhub:      { limit: 9999,key: 'budget:finnhub' },     // 60/min, effectively unlimited daily
};

function budgetDayKey(api){
  return API_BUDGETS[api].key + ':' + new Date().toISOString().slice(0,10);
}
async function getBudgetUsed(env, api){
  try { return parseInt(await env.NEWSHUB_CACHE.get(budgetDayKey(api)) || '0', 10); }
  catch(e){ return 0; }
}
async function bumpBudget(env, api, n){
  n = n || 1;
  const k = budgetDayKey(api);
  const used = await getBudgetUsed(env, api) + n;
  const now = new Date();
  const secsToMidnight = 86400 - (now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds());
  try { await env.NEWSHUB_CACHE.put(k, String(used), { expirationTtl: secsToMidnight + 60 }); } catch(e){}
  return used;
}
async function budgetAvailable(env, api){
  const used = await getBudgetUsed(env, api);
  return used < API_BUDGETS[api].limit;
}

// ─── utils ────────────────────────────────────────────────────────────────
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function ymd(d){ return d.toISOString().slice(0,10); }
function normKey(s){ return (s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
function stripUrl(u){
  if (!u) return '';
  try { const x = new URL(u); return (x.hostname + x.pathname).toLowerCase().replace(/\/+$/,''); }
  catch(e) { return (u||'').toLowerCase().split('?')[0].split('#')[0]; }
}
function isRelevant(ticker, text){
  if (!text) return false;
  const lo = text.toLowerCase();
  const re = new RegExp('\\b'+ticker.toLowerCase()+'\\b','i');
  if (re.test(text)) return true;
  for (const a of (ALIASES[ticker]||[])) if (lo.includes(a)) return true;
  return false;
}

// ─── source fetchers ──────────────────────────────────────────────────────
// Finnhub per-ticker with date range — but we run it AFTER other sources
// and only for tickers that need more coverage. Real article URLs returned
// so cross-ticker dedup works cleanly in clustering.
async function fetchFinnhub(ticker, env, fromD, toD){
  try {
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromD}&to=${toD}&token=${env.FINNHUB_KEY}`);
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    // Filter to articles that actually mention this ticker/company
    return arr
      .filter(a => a.headline && isRelevant(ticker, (a.headline||'') + ' ' + (a.summary||'')))
      .map(a => ({
        feed:'fh', ticker,
        headline: a.headline||'', summary: a.summary||'',
        url: a.url||'#', source: a.source||'Finnhub',
        ts: (a.datetime||0)*1000,
      }));
  } catch(e){ return []; }
}
// TickerTick ALLOWLIST — only pass financial/business news sources.
// Flip from blocklist to allowlist: much more reliable given TickerTick indexes everything.
const TT_ALLOWLIST = [
  // Major financial / business news
  'reuters','bloomberg','wsj','ft.com','financialtimes',
  'cnbc','marketwatch','barrons','seekingalpha','fool.com','motleyfool',
  'benzinga','thestreet','investorplace','zacks','nasdaq.com',
  'finance.yahoo','yahoo.com/finance','yahoo.com/news',
  'businesswire','prnewswire','globenewswire','accesswire','businessinsider',
  'forbes','fortune','economist','wsj.com','bloombergtax',
  // Stock/trading analysis
  'stockanalysis','macrotrends','wisesheets','simply wall','gurufocus',
  'chartmill','marketbeat','tipranks','stocknews','barchart',
  // Financial institutions / research
  'sec.gov','edgar','irs.gov','federalreserve',
  // Tech but business-focused
  'techcrunch','axios','theinfo','theinformation','arstechnica',
  'venturebeat','wired','cnet.com/tech', // cnet business/tech only
  // Broad news with financial sections
  'apnews','bbc.com/business','nytimes.com/business','washingtonpost.com/business',
  'foxbusiness','cbsnews.com/money',
];
function isTTAllowed(url, site){
  const check = ((url||'') + '|' + (site||'')).toLowerCase();
  return TT_ALLOWLIST.some(a => check.includes(a));
}

// Extract Finnhub's internal story ID from its redirect URL for cross-ticker dedup
function finnhubId(url){
  if (!url) return '';
  const m = url.match(/[?&]id=([a-f0-9]+)/i);
  return m ? m[1] : '';
}

async function fetchTickerTick(ticker, cutoff){
  try {
    const r = await fetch(`https://api.tickertick.com/feed?q=tt:${ticker.toLowerCase()}&n=20`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.stories||[])
      .filter(s => (s.time||0) >= cutoff && isTTAllowed(s.url, s.site))
      .map(s => ({
        feed:'tt', ticker,
        headline:s.title||'', summary:s.description||'',
        url:s.url||'#', source:s.site||'TickerTick', ts:s.time||0,
      }));
  } catch(e){ return []; }
}
async function fetchMarketaux(symbols, env, isoFrom){
  try {
    const r = await fetch(`https://api.marketaux.com/v1/news/all?symbols=${symbols.join(',')}&filter_entities=true&language=en&published_after=${isoFrom}&limit=3&api_token=${env.MARKETAUX_KEY}`);
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    (j.data||[]).forEach(item => {
      const ent = (item.entities||[]).filter(e=>e.symbol&&symbols.includes(e.symbol))
        .sort((a,b)=>(b.match_score||0)-(a.match_score||0))[0];
      if (!ent) return;
      out.push({
        feed:'mx', ticker:ent.symbol,
        headline:item.title||'', summary:item.description||'',
        url:item.url||'#', source:item.source||'Marketaux',
        ts:item.published_at?Date.parse(item.published_at):Date.now(),
        apiSentiment:ent.sentiment_score
      });
    });
    return out;
  } catch(e){ return []; }
}
async function fetchStockData(symbols, env, isoFrom){
  try {
    const r = await fetch(`https://api.stockdata.org/v1/news/all?symbols=${symbols.join(',')}&filter_entities=true&language=en&published_after=${isoFrom}&limit=50&api_token=${env.STOCKDATA_KEY}`);
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    (j.data||[]).forEach(item => {
      const ent = (item.entities||[]).filter(e=>e.symbol&&symbols.includes(e.symbol))
        .sort((a,b)=>(b.match_score||0)-(a.match_score||0))[0];
      if (!ent) return;
      out.push({
        feed:'sd', ticker:ent.symbol,
        headline:item.title||'', summary:item.description||'',
        url:item.url||'#', source:item.source||'StockData',
        ts:item.published_at?Date.parse(item.published_at):Date.now(),
        apiSentiment:ent.sentiment_score
      });
    });
    return out;
  } catch(e){ return []; }
}
async function fetchAlphaVantage(symbols, env, hours){
  try {
    const since = new Date(Date.now() - hours*3600*1000);
    const iso = since.toISOString();
    const timeFrom = iso.slice(0,4)+iso.slice(5,7)+iso.slice(8,10)+'T'+iso.slice(11,13)+iso.slice(14,16);
    const r = await fetch(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbols.slice(0,50).join(',')}&time_from=${timeFrom}&limit=200&apikey=${env.ALPHAVANTAGE_KEY}`);
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    (j.feed||[]).forEach(item => {
      const cands = (item.ticker_sentiment||[]).filter(t=>symbols.includes(t.ticker))
        .sort((a,b)=>parseFloat(b.relevance_score||0)-parseFloat(a.relevance_score||0));
      if (!cands.length) return;
      const tk = cands[0];
      let ts = Date.now();
      if (item.time_published){
        const s = item.time_published;
        ts = Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8), +s.slice(9,11), +s.slice(11,13), +s.slice(13,15));
      }
      const sc = parseFloat(tk.ticker_sentiment_score);
      out.push({
        feed:'av', ticker:tk.ticker,
        headline:item.title||'', summary:item.summary||'',
        url:item.url||'#', source:item.source||'AlphaVantage', ts,
        apiSentiment: isNaN(sc)?undefined:sc,
      });
    });
    return out;
  } catch(e){ return []; }
}

// ─── orchestrator ─────────────────────────────────────────────────────────
// useLimitedAPIs: when false (most cron runs), skip Marketaux/StockData/AlphaVantage
// to preserve their tiny daily quotas. Finnhub + TickerTick have no meaningful
// daily cap so they run every time. Manual force-fresh sets this true.
async function fetchAllSources(env, useLimitedAPIs, wl){
  wl = wl || WATCHLIST;
  const now = new Date();
  const cutoff = now.getTime() - HOURS*3600*1000;
  const from = new Date(cutoff);
  const fromD = ymd(from), toD = ymd(now);
  const isoFrom = from.toISOString().slice(0,19);

  // Limited-quota sources: only call if (a) allowed this run AND (b) budget remains
  let mx=[], sd=[], av=[];
  if (useLimitedAPIs){
    const [mxOk, sdOk, avOk] = await Promise.all([
      budgetAvailable(env,'marketaux'),
      budgetAvailable(env,'stockdata'),
      budgetAvailable(env,'alphavantage'),
    ]);
    const tasks = [];
    if (mxOk){ tasks.push(fetchMarketaux(wl, env, isoFrom).then(r=>{mx=r;return bumpBudget(env,'marketaux');})); }
    if (sdOk){ tasks.push(fetchStockData(wl, env, isoFrom).then(r=>{sd=r;return bumpBudget(env,'stockdata');})); }
    if (avOk){ tasks.push(fetchAlphaVantage(wl, env, HOURS).then(r=>{av=r;return bumpBudget(env,'alphavantage');})); }
    await Promise.all(tasks);
  }

  // Per-ticker: Finnhub + TickerTick (no meaningful daily cap) — always run
  const perTicker = [];
  const queue = [...wl];
  async function worker(){
    while (queue.length){
      const t = queue.shift();
      const [fh, tt] = await Promise.all([
        fetchFinnhub(t, env, fromD, toD),
        fetchTickerTick(t, cutoff),
      ]);
      perTicker.push(...fh, ...tt);
    }
  }
  await Promise.all(Array.from({length:6}, worker));

  return [...mx, ...sd, ...av, ...perTicker]
    .filter(a => a.headline && a.ts >= cutoff);
}

// ─── clustering: dedupe + merge same-event articles ───────────────────────
// Strategy:
//   Step 0 — pre-dedupe within each ticker by normalized headline (kills Finnhub
//             repetition where the same Yahoo story appears 6× under AMZN).
//   Step 1 — cluster cross-source by non-Finnhub URL (reliable canonical URL).
//   Step 2 — cluster by ticker+headline-sig (first 60 chars of norm headline).
//   Step 3 — merge URL clusters whose headline matches a sig cluster.
//   Cap sourceCount at 10 for display; real count stored separately.

const MAX_SOURCES_PER_EVENT = 10;

function clusterArticles(articles){
  articles.sort((a,b) => b.ts - a.ts);

  // ── Step 0a: per-ticker dedupe by headline ─────────────────────────────
  // Kills Finnhub repeating the same Yahoo article 6x under the same ticker.
  const seenPerTicker = new Set();
  const pass1 = [];
  for (const a of articles){
    const k = a.ticker + '|' + normKey(a.headline).slice(0,70);
    if (seenPerTicker.has(k)) continue;
    seenPerTicker.add(k);
    pass1.push(a);
  }

  // ── Step 0b: cross-ticker dedupe by URL + headline ────────────────────────
  // Precedence: mx/sd/av (relevance-scored) > tt (allowlist filtered) > fh
  pass1.sort((a,b) => {
    const p = {mx:0, sd:0, av:0, tt:1, fh:2};
    return (p[a.feed]??3) - (p[b.feed]??3) || b.ts - a.ts;
  });
  const seenGlobal = new Set();
  const deduped = [];
  for (const a of pass1){
    const urlKey = a.url && !a.url.includes('finnhub.io/api/news') ? stripUrl(a.url) : '';
    const hlKey  = normKey(a.headline).slice(0,70);

    if (urlKey && seenGlobal.has('u:'+urlKey)) continue;
    if (hlKey.length > 12 && seenGlobal.has('h:'+hlKey)) continue;

    if (urlKey)            seenGlobal.add('u:'+urlKey);
    if (hlKey.length > 12) seenGlobal.add('h:'+hlKey);
    deduped.push(a);
  }

  // ── Step 1: cluster by canonical URL (non-Finnhub) ────────────────────
  const events  = new Map();
  const claimed = new Set();
  const urlBuckets = new Map();

  for (let i=0; i<deduped.length; i++){
    const a = deduped[i];
    if (!a.url || a.url.includes('finnhub.io/api/news')) continue;
    const u = stripUrl(a.url);
    if (!u || u.length < 10) continue;
    if (urlBuckets.has(u)){
      urlBuckets.get(u).articles.push(a);
      urlBuckets.get(u).tickers.add(a.ticker);
      claimed.add(i);
    } else if (!claimed.has(i)){
      const ev = { articles:[a], tickers:new Set([a.ticker]) };
      urlBuckets.set(u, ev);
      events.set('u:'+u, ev);
      claimed.add(i);
    }
  }

  // ── Step 2: cluster remaining by headline sig (cross-ticker now ok since deduped) ──
  const sigBuckets = new Map();
  for (let i=0; i<deduped.length; i++){
    if (claimed.has(i)) continue;
    const a = deduped[i];
    const sig = normKey(a.headline).slice(0,60);
    if (!sig || sig.length < 8) continue;
    if (sigBuckets.has(sig)){
      sigBuckets.get(sig).articles.push(a);
      sigBuckets.get(sig).tickers.add(a.ticker);
      claimed.add(i);
    } else {
      const ev = { articles:[a], tickers:new Set([a.ticker]) };
      sigBuckets.set(sig, ev);
      events.set('s:'+sig, ev);
      claimed.add(i);
    }
  }

  // ── Step 3: merge URL clusters into sig clusters ──────────────────────
  for (const [k, ev] of events){
    if (!k.startsWith('u:')) continue;
    const sig = normKey(ev.articles[0].headline).slice(0,60);
    if (sigBuckets.has(sig)){
      const other = sigBuckets.get(sig);
      if (other !== ev){
        ev.articles.push(...other.articles);
        other.tickers.forEach(t => ev.tickers.add(t));
        events.delete('s:'+sig);
      }
    }
  }

  // ── Singletons ────────────────────────────────────────────────────────
  for (let i=0; i<deduped.length; i++){
    if (claimed.has(i)) continue;
    const a = deduped[i];
    events.set('lone:'+i, { articles:[a], tickers:new Set([a.ticker]) });
  }

  return [...events.values()].map((ev, idx) => {
    ev.articles.sort((a,b) => b.ts - a.ts);
    const realCount = ev.articles.length;
    return {
      id: 'evt_' + idx,
      candidateTickers: [...ev.tickers],
      sources: ev.articles.slice(0, MAX_SOURCES_PER_EVENT).map(a => ({
        name: a.source, url: a.url, headline: a.headline,
        summary: (a.summary||'').slice(0,500), feed: a.feed,
        apiSentiment: a.apiSentiment, ts: a.ts,
      })),
      sourceCount: realCount,
      ts: ev.articles[0].ts,
    };
  });
}

// ─── Gemini analyze (batched) ─────────────────────────────────────────────
// ─── mark a model as quota-blocked for QUOTA_COOLDOWN seconds ────────────
async function markModelBlocked(env, model, ctx){
  try {
    ctx.waitUntil(env.NEWSHUB_CACHE.put('quota_block:'+model, '1', { expirationTtl: QUOTA_COOLDOWN }));
  } catch(e){}
}

function buildGeminiPrompt(events, wl, sectors){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  return `You are a stock market intelligence analyst for an active trader monitoring this watchlist: ${wl.join(', ')}.

Sector map: ${Object.entries(sectors).map(([t,s])=>`${t}=${s}`).join(', ')}

TASK: For each news event below, assign the watchlist ticker it is MOST about, write a trader summary, and score its market impact.

RULES:
1. If the headline/summary is directly about a watchlist company → assign that ticker.
2. If multiple watchlist tickers are mentioned, pick the one most central to the story.
3. Only set primaryTicker to "NONE" for events with ZERO watchlist relevance.
4. Analyst upgrades/downgrades, price target changes, earnings previews, product news — ALL keep their ticker even if minor.
5. Be INCLUSIVE — minor relevant article (impactScore 10-20) is better than dropping it.

SUMMARY FORMAT — 2-4 sentences, trader-focused:
(1) What happened — include specific numbers, price targets, % moves, dollar amounts if mentioned.
(2) Why it matters — catalyst explanation, what drove the move or decision.
(3) Valuation/price angle — PT changes, P/E context, cheap/expensive relative to news.
(4) Near-term price direction — magnitude estimate (e.g. "+2-5% pop", "modest pressure", "neutral until earnings").

Return a JSON array. Each element MUST have: id, summary, sentiment ("bull"|"neutral"|"bear"), sentimentScore, impactScore, eventType, primaryTicker, additionalTickers, sectors, relevanceConfidence.

Events:
${JSON.stringify(events.map(ev => ({
  id: ev.id,
  candidateTickers: ev.candidateTickers,
  sources: ev.sources.slice(0,3).map(s => ({
    source: s.name,
    headline: s.headline,
    summary: (s.summary||'').slice(0,400),
  }))
})), null, 2)}`;
}

function buildNIMPrompt(events, wl, sectors){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  const lines = events.map(ev => {
    const src = ev.sources.slice(0,2).map(s => `  - [${s.name}] ${s.headline}. ${(s.summary||'').slice(0,200)}`).join('\n');
    return `EVENT_ID: ${ev.id}\nTICKERS: ${ev.candidateTickers.join(', ')}\nSOURCES:\n${src}`;
  }).join('\n\n---\n\n');

  return `Watchlist: ${wl.join(', ')}
Sector map: ${Object.entries(sectors).map(([t,s])=>`${t}=${s}`).join(', ')}

Analyze each news event below. For EACH event output one JSON object with EXACTLY these fields:
- id: the EVENT_ID string
- summary: 2-4 sentences — (1) what happened with specific numbers/PTs, (2) why it matters/catalyst, (3) valuation context, (4) near-term price direction
- sentiment: "bull", "neutral", or "bear"
- sentimentScore: number from -1.0 to 1.0
- impactScore: integer 0-100 (90+=critical, 75+=major, 60+=important, 40+=notable, 10+=minor)
- eventType: one of earnings/guidance/upgrade/downgrade/merger/regulatory/product/personnel/macro/valuation/other
- primaryTicker: the single most relevant watchlist ticker, or "NONE"
- additionalTickers: array of other affected watchlist tickers
- sectors: array of affected sectors
- relevanceConfidence: number 0.0-1.0

Output ONLY a JSON array containing one object per event. No markdown. No explanation. Start with [ end with ].

EVENTS:
${lines}`;
}

async function geminiBatch(events, env, ctx, wl, sectors, chainState){
  // chainState.idx is shared across the WHOLE build. Once we settle on a working
  // model (e.g. NIM) every subsequent batch reuses it — we do NOT re-walk the
  // chain from the top each batch. That re-walk was the quota killer: a single
  // refresh = ~14 batches, and if NIM hiccuped on batch 1 the old code fell to
  // Gemini on all 14, torching the daily Gemini quota in one refresh.
  chainState = chainState || { idx: 0 };
  for (; chainState.idx < AI_CHAIN.length; chainState.idx++){
    const { provider, model } = AI_CHAIN[chainState.idx];
    const blockKey = provider === 'nim'
      ? 'quota_block:nim:' + model.replace('/','_')
      : 'quota_block:' + model;

    // Cooling down from a prior 429 → advance permanently past it.
    try { const b = await env.NEWSHUB_CACHE.get(blockKey); if (b) continue; } catch(e){}

    try {
      let parsed;
      if (provider === 'gemini'){
        parsed = await callGemini(model, buildGeminiPrompt(events, wl, sectors), env, ctx, blockKey);
      } else {
        if (!env.NVIDIA_API_KEY){ console.error('NVIDIA_API_KEY not set — skipping NIM model:', model); continue; }
        parsed = await callNIM(model, buildNIMPrompt(events, wl, sectors), env, ctx, blockKey);
      }
      if (parsed && parsed.length){
        const required = ['id','summary','sentiment','impactScore','primaryTicker'];
        if (!required.every(k => k in parsed[0])){
          console.error(`${provider}/${model} bad schema, missing: [${required.filter(k=>!(k in parsed[0])).join(',')}]`);
          continue; // bad model — advance
        }
        parsed.__model = (provider === 'nim' ? 'nim:' : '') + model;
        console.log(`AI success: ${provider}/${model}, ${parsed.length} events (chain idx ${chainState.idx})`);
        return parsed; // KEEP idx — next batch reuses this same working model
      } else if (parsed !== null){
        console.error(`${provider}/${model} returned empty array`);
        // non-quota empty → advance to next model
      }
      // parsed===null means a 429/HTTP error already logged+blocked → advance
    } catch(e){
      console.error(`AI chain ${provider}/${model} exception:`, e.message);
      // advance to next model
    }
  }
  console.error('All AI models exhausted for this build');
  return [];
}

// Build the Gemini request body. v1beta REST needs camelCase keys.
// 2.5 models are *thinking* models — without thinkingBudget:0 they burn the
// output-token budget on reasoning and return MAX_TOKENS with empty content.
function geminiBody(model, prompt){
  const gc = {
    temperature: 0.2,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id:                   { type: 'STRING' },
          summary:              { type: 'STRING' },
          sentiment:            { type: 'STRING', enum: ['bull','neutral','bear'] },
          sentimentScore:       { type: 'NUMBER' },
          impactScore:          { type: 'INTEGER' },
          eventType:            { type: 'STRING' },
          primaryTicker:        { type: 'STRING' },
          additionalTickers:    { type: 'ARRAY', items: { type: 'STRING' } },
          sectors:              { type: 'ARRAY', items: { type: 'STRING' } },
          relevanceConfidence:  { type: 'NUMBER' },
        },
        required: ['id','summary','sentiment','impactScore','primaryTicker']
      }
    }
  };
  // Disable thinking on 2.5 models so structured output isn't truncated.
  if (model.startsWith('gemini-2.5')) gc.thinkingConfig = { thinkingBudget: 0 };
  return { contents: [{ parts: [{ text: prompt }] }], generationConfig: gc };
}

async function callGemini(model, prompt, env, ctx, blockKey){
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(geminiBody(model, prompt)) }
  );
  if (r.status === 429){
    console.warn(`Gemini ${model} 429 (daily quota) — blocking ${QUOTA_COOLDOWN}s`);
    await env.NEWSHUB_CACHE.put('quota_block:'+model, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
    return null;
  }
  if (!r.ok){ console.error(`Gemini ${model} HTTP ${r.status}:`, (await r.text()).slice(0,300)); return null; }
  const j = await r.json();
  const cand = j.candidates?.[0];
  const finish = cand?.finishReason;
  let text = cand?.content?.parts?.[0]?.text || '';
  if (!text){ console.error(`Gemini ${model} empty content, finishReason=${finish}`); return null; }
  if (finish && finish !== 'STOP') console.warn(`Gemini ${model} finishReason=${finish} (may be truncated)`);
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(text); }
  catch(e){ console.error(`Gemini ${model} JSON parse failed (finish=${finish}):`, text.slice(0,200)); return null; }
}

async function callNIM(model, prompt, env, ctx, blockKey){
  const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a financial analyst. Respond with valid JSON array only — no markdown, no code fences, no explanation.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 6000,
      stream: false,
    }),
  });
  if (r.status === 429){
    console.warn(`NIM ${model} 429 — blocking for ${QUOTA_COOLDOWN}s`);
    await env.NEWSHUB_CACHE.put(blockKey, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
    return null;
  }
  if (!r.ok){ console.error(`NIM ${model} ${r.status}:`, (await r.text()).slice(0,200)); return null; }
  const j = await r.json();
  let text = j.choices?.[0]?.message?.content || '';
  if (!text){ console.error(`NIM ${model} empty content`); return null; }
  // Strip markdown fences if the model added them anyway
  text = text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  const arrStart = text.indexOf('['), arrEnd = text.lastIndexOf(']');
  if (arrStart === -1 || arrEnd === -1){
    // Model echoed the prompt or returned prose — treat as failure (advance
    // chain) rather than throwing, so callers handle it uniformly.
    console.error(`NIM ${model} no JSON array (echo/prose?):`, text.slice(0,160));
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(arrStart, arrEnd+1));
    if (Array.isArray(parsed)) return parsed;
    return parsed && typeof parsed === 'object' ? [parsed] : null;
  } catch(e){
    console.error(`NIM ${model} JSON parse failed:`, text.slice(0,160));
    return null;
  }
}

function impactTier(score){
  if (score >= 90) return 'critical';
  if (score >= 75) return 'major';
  if (score >= 60) return 'important';
  if (score >= 40) return 'notable';
  return 'minor';
}

async function runPipeline(env, ctx, useLimitedAPIs, wl, sectors){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  const wlSet = new Set(wl);
  const articles = await fetchAllSources(env, useLimitedAPIs, wl);
  let events = clusterArticles(articles);

  // Pre-rank by source count as proxy for importance, cap to control AI cost
  events.sort((a,b) => b.sourceCount - a.sourceCount || b.ts - a.ts);
  events = events.slice(0, MAX_EVENTS);

  // AI-analyze in batches with auto-fallback chain.
  // chainState is shared across all batches so we don't re-walk the chain (and
  // re-burn Gemini quota) every batch — once NIM is chosen it's reused.
  const enriched = [];
  const modelsUsed = new Set();
  const chainState = { idx: 0 };
  let geminiFullyFailed = true;
  for (let i=0; i<events.length; i+=BATCH_SIZE){
    const batch = events.slice(i, i+BATCH_SIZE);
    let out = [];
    try {
      out = await geminiBatch(batch, env, ctx, wl, sectors, chainState);
      if (out && out.length) geminiFullyFailed = false;
    } catch(e){
      console.error('geminiBatch threw, skipping batch:', e.message);
      out = []; // skip this batch but DON'T crash the whole pipeline
    }
    if (out.__model) modelsUsed.add(out.__model);
    const map = new Map(out.map(o => [o.id, o]));
    for (const ev of batch){
      const ai = map.get(ev.id);
      if (ai && ai.primaryTicker && ai.primaryTicker !== 'NONE' && wlSet.has(ai.primaryTicker)){
        enriched.push({
          id: ev.id,
          primaryTicker: ai.primaryTicker,
          additionalTickers: (ai.additionalTickers||[]).filter(t=>wlSet.has(t) && t!==ai.primaryTicker),
          sectors: (ai.sectors||[]).filter(Boolean),
          eventType: ai.eventType || 'other',
          summary: ai.summary || '',
          sentiment: { label: ai.sentiment || 'neutral', score: ai.sentimentScore || 0 },
          impact: { score: ai.impactScore || 0, tier: impactTier(ai.impactScore || 0) },
          relevanceConfidence: ai.relevanceConfidence ?? 1,
          ts: ev.ts,
          sources: ev.sources.map(s => ({ name:s.name, url:s.url, headline:s.headline, feed:s.feed, ts:s.ts })),
          sourceCount: ev.sourceCount,
          aiAnalyzed: true,
        });
      }
    }
  }

  // ── Raw fallback: all AI dead → surface headlines unanalyzed ─────────────
  // Last resort so the UI always shows SOMETHING even on total AI outage.
  if (enriched.length === 0 && events.length > 0){
    console.warn('All AI unavailable — returning raw headline fallback');
    const raw = events.slice(0, 40).map(ev => {
      const primary = ev.candidateTickers?.[0] || '';
      const headline = ev.sources?.[0]?.headline || '';
      return {
        id: ev.id,
        primaryTicker: primary,
        additionalTickers: (ev.candidateTickers||[]).slice(1).filter(t=>wlSet.has(t)),
        sectors: [],
        eventType: 'other',
        summary: headline,
        sentiment: { label: 'neutral', score: 0 },
        impact: { score: Math.min(50, 20 + (ev.sourceCount||1)*5), tier: impactTier(Math.min(50, 20 + (ev.sourceCount||1)*5)) },
        relevanceConfidence: 0.5,
        ts: ev.ts,
        sources: (ev.sources||[]).map(s => ({ name:s.name, url:s.url, headline:s.headline, feed:s.feed, ts:s.ts })),
        sourceCount: ev.sourceCount,
        aiAnalyzed: false,
      };
    }).filter(e => e.primaryTicker && wlSet.has(e.primaryTicker));
    raw.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
    return { events: raw, modelsUsed: [], degraded: true };
  }

  enriched.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
  return { events: enriched, modelsUsed: [...modelsUsed], degraded: false };
}

// ─── Build pipeline + write to KV ────────────────────────────────────────
async function buildAndCache(env, ctx, useLimitedAPIs, wl, sectors, cacheKey, lockKey){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  cacheKey = cacheKey || 'events:v1';
  lockKey = lockKey || 'build:lock';
  const result = await runPipeline(env, ctx, useLimitedAPIs, wl, sectors);
  const body = JSON.stringify({
    events: result.events,
    generatedAt: Date.now(),
    watchlist: wl,
    sectors: sectors,
    modelsUsed: result.modelsUsed,
    degraded: result.degraded || false,
  });
  // ALWAYS write a result so the client poller terminates. A degraded (raw)
  // build gets a SHORT TTL so it self-heals soon (and Force fresh bypasses cache
  // entirely to retry now) — but it must be cached, or every poll re-kicks a
  // fresh build → infinite "Building…" loop.
  const ttl = result.degraded ? 600 : CACHE_TTL; // 10min for raw, 6h for good
  await env.NEWSHUB_CACHE.put(cacheKey, body, { expirationTtl: ttl });
  await env.NEWSHUB_CACHE.delete(lockKey); // release build lock
  console.log(`Pipeline done: ${result.events.length} events, degraded=${result.degraded}, ttl=${ttl}, wl=${wl.length}`);
  return body;
}

// ─── Rate limit helpers ───────────────────────────────────────────────────
// Free API quotas:
//   Gemini 2.5-flash: 250 req/day  → ~15 calls/refresh → max 16 fresh/day
//   AlphaVantage:     25 req/day   → 1 call/refresh    → max 25 fresh/day
//   StockData:        100 req/day  → 1 call/refresh    → max 100 fresh/day
//   Marketaux:        100 req/day  → 1 call/refresh    → max 100 fresh/day
//   Finnhub:          60 req/min   → 22 calls/refresh  → throttled by concurrency
//   TickerTick:       no hard limit (rate ~10/min per IP)
// Binding constraint: Gemini at 16/day. We cap at 12 forced refreshes/day
// (4 from cron warmups don't count against user quota).
// Cache TTL = 4min, so within-cache hits are free.
const DAILY_FRESH_LIMIT = 12;        // max force-fresh per calendar day
const MIN_FRESH_INTERVAL = 5 * 60;  // min 5 minutes between forced refreshes (seconds)

function utcDayKey(){
  return 'rl:day:' + new Date().toISOString().slice(0,10); // e.g. rl:day:2026-06-15
}

async function checkRateLimit(env){
  const dayKey = utcDayKey();
  const lastKey = 'rl:last_fresh';
  const [ countRaw, lastRaw ] = await Promise.all([
    env.NEWSHUB_CACHE.get(dayKey),
    env.NEWSHUB_CACHE.get(lastKey),
  ]);
  const count = parseInt(countRaw || '0', 10);
  const lastTs = parseInt(lastRaw || '0', 10);
  const nowSec = Math.floor(Date.now() / 1000);
  const secSinceLast = nowSec - lastTs;

  if (count >= DAILY_FRESH_LIMIT){
    return { blocked: true, reason: `Daily refresh limit reached (${DAILY_FRESH_LIMIT}/day). Resets at midnight UTC.`, count, limit: DAILY_FRESH_LIMIT };
  }
  if (lastTs > 0 && secSinceLast < MIN_FRESH_INTERVAL){
    const waitSec = MIN_FRESH_INTERVAL - secSinceLast;
    return { blocked: true, reason: `Too soon — wait ${Math.ceil(waitSec/60)} more minute(s) before refreshing.`, waitSec };
  }
  return { blocked: false, count, secSinceLast };
}

async function bumpRateLimit(env){
  const dayKey = utcDayKey();
  const lastKey = 'rl:last_fresh';
  const countRaw = await env.NEWSHUB_CACHE.get(dayKey);
  const count = parseInt(countRaw || '0', 10) + 1;
  const nowSec = Math.floor(Date.now() / 1000);
  // Day key expires at midnight UTC (seconds until midnight)
  const now = new Date();
  const secsUntilMidnight = 86400 - (now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds());
  await Promise.all([
    env.NEWSHUB_CACHE.put(dayKey, String(count), { expirationTtl: secsUntilMidnight + 60 }),
    env.NEWSHUB_CACHE.put(lastKey, String(nowSec), { expirationTtl: MIN_FRESH_INTERVAL + 60 }),
  ]);
  return count;
}

// ─── HTTP handler ─────────────────────────────────────────────────────────
export default {
  // Cron — pre-warms cache. Uses Finnhub+TickerTick every run (no daily cap),
  // but only spends Marketaux/StockData/AlphaVantage quota a few times/day at
  // staggered hours so they don't get exhausted.
  async scheduled(event, env, ctx){
    const CRON_RICH_HOURS = [14, 17, 20]; // 3 rich runs/day (~10am, 1pm, 4pm ET)
    const hour = new Date().getUTCHours();
    let useLimited = false;
    if (CRON_RICH_HOURS.includes(hour)){
      const richKey = 'cron:rich:' + new Date().toISOString().slice(0,13); // per-hour
      const already = await env.NEWSHUB_CACHE.get(richKey).catch(()=>null);
      if (!already){
        useLimited = true;
        ctx.waitUntil(env.NEWSHUB_CACHE.put(richKey, '1', { expirationTtl: 7200 }));
      }
    }
    ctx.waitUntil(buildAndCache(env, ctx, useLimited).catch(e => console.error('Cron failed:', e.message)));
  },

  async fetch(req, env, ctx){
    if (req.method === 'OPTIONS')
      return new Response(null, { headers: cors() });

    const url = new URL(req.url);

    // /health
    if (url.pathname === '/' || url.pathname === '/health'){
      const status = {};
      for (const m of GEMINI_CHAIN){
        try { const b = await env.NEWSHUB_CACHE.get('quota_block:'+m); status[m] = b ? 'cooling-down' : 'available'; }
        catch(e){ status[m] = 'unknown'; }
      }
      const nimStatus = {};
      for (const m of NIM_CHAIN){
        const k = 'quota_block:nim:'+m.replace('/','_');
        try { const b = await env.NEWSHUB_CACHE.get(k); nimStatus[m] = b ? 'cooling-down' : 'available'; }
        catch(e){ nimStatus[m] = 'unknown'; }
      }
      let cachedEventCount = null;
      try { const c = await env.NEWSHUB_CACHE.get('events:v1'); if(c){ const j=JSON.parse(c); cachedEventCount=j.events?.length??0; }} catch(e){}
      // Rate limit status
      const dayKey = utcDayKey();
      const countRaw = await env.NEWSHUB_CACHE.get(dayKey).catch(()=>'0');
      const lastRaw  = await env.NEWSHUB_CACHE.get('rl:last_fresh').catch(()=>null);
      return new Response(JSON.stringify({
        status:'ok', service:'newshub-api',
        watchlist: WATCHLIST.length, cacheTTL: CACHE_TTL, cachedEventCount,
        geminiChain: GEMINI_CHAIN, modelStatus: status,
        nimChain: NIM_CHAIN, nimStatus,
        rateLimit: { usedToday: parseInt(countRaw||'0'), limit: DAILY_FRESH_LIMIT, lastFreshAgo: lastRaw ? Math.max(0, Math.floor(Date.now()/1000)-parseInt(lastRaw)) : null },
      }, null, 2), { headers: { ...cors(), 'Content-Type':'application/json' } });
    }

    // /debug — source fetch only, no Gemini. Uses Finnhub+TickerTick only (no quota burn).
    if (url.pathname === '/debug'){
      try {
        const articles = await fetchAllSources(env, false);
        const events = clusterArticles(articles);
        const byTicker = {};
        articles.forEach(a => { byTicker[a.ticker] = (byTicker[a.ticker]||0)+1; });
        return new Response(JSON.stringify({
          rawArticles: articles.length, clusteredEvents: events.length, byTicker,
          topEvents: events.slice(0,10).map(e => ({ headline: e.sources[0]?.headline?.slice(0,80), tickers: e.candidateTickers, sourceCount: e.sourceCount })),
        }, null, 2), { headers: { ...cors(), 'Content-Type':'application/json' } });
      } catch(e){
        return new Response(JSON.stringify({ error: e.message }), { status:500, headers: { ...cors(), 'Content-Type':'application/json' } });
      }
    }

    // /rate-status — returns current rate limit state (cheap KV reads only)
    if (url.pathname === '/rate-status'){
      try {
        const dayKey = utcDayKey();
        const [ countRaw, lastRaw ] = await Promise.all([ env.NEWSHUB_CACHE.get(dayKey), env.NEWSHUB_CACHE.get('rl:last_fresh') ]);
        const count = parseInt(countRaw||'0', 10);
        const lastTs = parseInt(lastRaw||'0', 10);
        const nowSec = Math.floor(Date.now()/1000);
        const secSinceLast = nowSec - lastTs;
        const cooldownRemaining = Math.max(0, MIN_FRESH_INTERVAL - secSinceLast);
        const [mxU, sdU, avU] = await Promise.all([
          getBudgetUsed(env,'marketaux'), getBudgetUsed(env,'stockdata'), getBudgetUsed(env,'alphavantage'),
        ]);
        return new Response(JSON.stringify({
          usedToday: count, limit: DAILY_FRESH_LIMIT, remaining: DAILY_FRESH_LIMIT - count,
          cooldownSec: cooldownRemaining, minIntervalSec: MIN_FRESH_INTERVAL,
          apiBudgets: {
            marketaux:    { used: mxU, limit: API_BUDGETS.marketaux.limit },
            stockdata:    { used: sdU, limit: API_BUDGETS.stockdata.limit },
            alphavantage: { used: avU, limit: API_BUDGETS.alphavantage.limit },
          },
        }), { headers: { ...cors(), 'Content-Type':'application/json' } });
      } catch(e){
        return new Response(JSON.stringify({ error: e.message }), { status:500, headers: { ...cors(), 'Content-Type':'application/json' } });
      }
    }

    // /reset-exhausted — clears local quota_block cooldown flags (NOT Google's server-side daily quota)
    if (url.pathname === '/reset-exhausted'){
      try {
        const deletes = [];
        for (const m of GEMINI_CHAIN) deletes.push(env.NEWSHUB_CACHE.delete('quota_block:'+m).catch(()=>{}));
        for (const m of NIM_CHAIN) deletes.push(env.NEWSHUB_CACHE.delete('quota_block:nim:'+m.replace('/','_')).catch(()=>{}));
        await Promise.all(deletes);
        return new Response(JSON.stringify({ ok: true, cleared: [...GEMINI_CHAIN, ...NIM_CHAIN] }), { headers: { ...cors(), 'Content-Type':'application/json' } });
      } catch(e){
        return new Response(JSON.stringify({ error: e.message }), { status:500, headers: { ...cors(), 'Content-Type':'application/json' } });
      }
    }

    // /clear-cache — nukes the cached events doc so the next load forces a clean rebuild.
    // ?tickers=A,B,C clears that specific watchlist's cache instead of the default.
    if (url.pathname === '/clear-cache'){
      try {
        const ct = parseTickers(url.searchParams.get('tickers'));
        const ck = ct ? 'events:v1:' + wlHash(ct) : 'events:v1';
        const lk = ct ? 'build:lock:' + wlHash(ct) : 'build:lock';
        await env.NEWSHUB_CACHE.delete(ck);
        await env.NEWSHUB_CACHE.delete(lk);
        return new Response(JSON.stringify({ ok: true, cleared: ck }), { headers: { ...cors(), 'Content-Type':'application/json' } });
      } catch(e){
        return new Response(JSON.stringify({ error: e.message }), { status:500, headers: { ...cors(), 'Content-Type':'application/json' } });
      }
    }

    // /test-ai — fires ONE real analysis call (same schema/config as production) so we
    // can see exactly what a provider returns. ?provider=gemini|nim & ?model=<name>
    if (url.pathname === '/test-ai'){
      try {
        const provider = url.searchParams.get('provider') || 'gemini';
        const model = url.searchParams.get('model') || (provider === 'nim' ? 'meta/llama-3.3-70b-instruct' : 'gemini-2.0-flash');
        const testEvents = [{ id:'t1', candidateTickers:['NVDA'], sources:[{ name:'Test', headline:'Nvidia raises guidance, analysts lift price target to $200', summary:'Strong datacenter demand drives upside surprise.' }] }];
        const blockKey = 'test_block_ignore';
        let parsed = null;
        if (provider === 'gemini'){
          parsed = await callGemini(model, buildGeminiPrompt(testEvents), env, {waitUntil:()=>{}}, blockKey);
        } else {
          parsed = await callNIM(model, buildNIMPrompt(testEvents), env, {waitUntil:()=>{}}, blockKey);
        }
        const required = ['id','summary','sentiment','impactScore','primaryTicker'];
        const valid = parsed && parsed.length > 0 && required.every(k => k in parsed[0]);
        const missing = parsed?.[0] ? required.filter(k=>!(k in parsed[0])) : required;
        return new Response(JSON.stringify({ provider, model, valid, missing, parsed }, null, 2), { headers:{ ...cors(), 'Content-Type':'application/json' } });
      } catch(e){
        return new Response(JSON.stringify({ error: e.message }), { status:500, headers:{ ...cors(), 'Content-Type':'application/json' } });
      }
    }

    if (url.pathname !== '/news')
      return new Response('Not found', { status: 404, headers: cors() });

    const fresh = url.searchParams.get('fresh') === '1';

    // Dynamic watchlist: ?tickers=A,B,C runs the pipeline against the caller's
    // list. A list that EQUALS the canonical WATCHLIST (order-independent) is
    // treated as the default → shares the cron-warmed 'events:v1' cache instead
    // of being orphaned under a per-list key the cron never writes.
    const customTickers = parseTickers(url.searchParams.get('tickers'));
    const isCustom = !!customTickers && wlHash(customTickers) !== wlHash(WATCHLIST);
    const wl       = isCustom ? customTickers : WATCHLIST;
    const sectors  = isCustom ? sectorsFor(wl) : SECTORS;
    const cacheKey = isCustom ? 'events:v1:' + wlHash(wl) : 'events:v1';
    const lockKey  = isCustom ? 'build:lock:' + wlHash(wl) : 'build:lock';

    // ── Cache hit → return immediately (free, no rate limit) ──────────────
    if (!fresh){
      try {
        const cached = await env.NEWSHUB_CACHE.get(cacheKey);
        if (cached){
          return new Response(cached, { headers: { ...cors(), 'Content-Type':'application/json', 'X-Cache':'HIT' } });
        }
      } catch(e){}
    }

    // ── Peek mode (?cacheOnly=1) → NEVER builds ───────────────────────────
    // Used when simply opening the News tab. Returns cache if present (handled
    // above) else an empty miss — it must not kick a build, take the lock, or
    // spend any quota. Building only happens on explicit Refresh / Force fresh.
    const cacheOnly = url.searchParams.get('cacheOnly') === '1';
    if (cacheOnly){
      return new Response(JSON.stringify({ events: [], _cacheMiss: true }),
        { headers: { ...cors(), 'Content-Type':'application/json', 'X-Cache':'MISS' } });
    }

    // ── Rate limit ONLY applies to force-fresh ────────────────────────────
    // Force-fresh spends the limited-API daily budget, so it's capped. A regular
    // cache-miss build (cheap Finnhub+TickerTick + no-cap NIM) must NOT drain the
    // daily force-fresh budget — that was making normal browsing exhaust "12/day".
    if (fresh){
      const rl = await checkRateLimit(env);
      if (rl.blocked){
        try {
          const cached = await env.NEWSHUB_CACHE.get(cacheKey);
          if (cached){
            const j = JSON.parse(cached);
            j._rateLimited = true;
            j._rateLimitReason = rl.reason;
            return new Response(JSON.stringify(j), {
              headers: { ...cors(), 'Content-Type':'application/json', 'X-Cache':'HIT', 'X-Rate-Limited':'1' }
            });
          }
        } catch(e){}
        return new Response(JSON.stringify({ error: 'rate_limited', reason: rl.reason, usedToday: rl.count, limit: DAILY_FRESH_LIMIT }),
          { status: 429, headers: { ...cors(), 'Content-Type':'application/json' } });
      }
    }

    // ── Check if a build is already in progress ────────────────────────────
    const buildLock = await env.NEWSHUB_CACHE.get(lockKey).catch(()=>null);
    if (buildLock){
      // Return stale cache if available while build runs
      try {
        const cached = await env.NEWSHUB_CACHE.get(cacheKey);
        if (cached){
          return new Response(cached, { headers: { ...cors(), 'Content-Type':'application/json', 'X-Cache':'STALE', 'X-Building':'1' } });
        }
      } catch(e){}
      return new Response(JSON.stringify({ status:'building', message:'Pipeline is running. Poll /news in 15 seconds.' }),
        { status: 202, headers: { ...cors(), 'Content-Type':'application/json' } });
    }

    // ── Kick off async build ───────────────────────────────────────────────
    if (fresh) await bumpRateLimit(env); // only force-fresh counts against the daily cap
    await env.NEWSHUB_CACHE.put(lockKey, '1', { expirationTtl: 180 }); // auto-expires after 3min if build crashes

    // Force-fresh spends the limited-API quota (full quality). Regular refresh
    // uses Finnhub+TickerTick only to preserve quota.
    const useLimited = fresh;

    // Run pipeline in background — return 202 immediately so browser can poll
    ctx.waitUntil(
      buildAndCache(env, ctx, useLimited, wl, sectors, cacheKey, lockKey).catch(async(e) => {
        console.error('Build failed:', e.message);
        await env.NEWSHUB_CACHE.delete(lockKey);
      })
    );

    // If there's stale cache, return it while fresh build runs in background
    try {
      const stale = await env.NEWSHUB_CACHE.get(cacheKey);
      if (stale){
        return new Response(stale, { headers: { ...cors(), 'Content-Type':'application/json', 'X-Cache':'STALE', 'X-Building':'1' } });
      }
    } catch(e){}

    return new Response(JSON.stringify({ status:'building', message:'Pipeline started. Poll /news in 20 seconds.' }),
      { status: 202, headers: { ...cors(), 'Content-Type':'application/json' } });
  }
};

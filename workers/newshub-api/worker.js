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

const WATCHLIST = ['DRAM','SNDK','MU','INTC','WDC','AMD','CRWD','BE','GOOGL','PLTR','NVDA','CRDO','TSLA','SPCX','AAPL','MSFT','NET','SCCO','ERO','WMT','AMZN','BABA'];

const SECTORS = {
  DRAM:'Semiconductor/Memory', SNDK:'Storage', MU:'Semiconductor/Memory',
  INTC:'Semiconductor', WDC:'Storage', AMD:'Semiconductor', CRDO:'Semiconductor',
  CRWD:'Cybersecurity', NET:'Cybersecurity',
  BE:'Clean Energy',
  GOOGL:'Tech/Mega-Cap', AAPL:'Tech/Mega-Cap', MSFT:'Tech/Mega-Cap',
  PLTR:'AI/Software', NVDA:'AI/Semiconductor',
  TSLA:'EV/Auto', SPCX:'Space/SPAC',
  SCCO:'Copper/Mining', ERO:'Copper/Mining',
  WMT:'Retail', AMZN:'Tech/Retail', BABA:'China/Tech',
};

const ALIASES = {
  DRAM:['dram'], SNDK:['sandisk'], MU:['micron'], INTC:['intel'], WDC:['western digital'],
  AMD:['advanced micro'], CRWD:['crowdstrike'], BE:['bloom energy'],
  GOOGL:['google','alphabet'], PLTR:['palantir'], NVDA:['nvidia'], CRDO:['credo'],
  TSLA:['tesla'], SPCX:['spacex'], AAPL:['apple'], MSFT:['microsoft'],
  NET:['cloudflare'], SCCO:['southern copper'], ERO:['ero copper'], WMT:['walmart'],
  AMZN:['amazon'], BABA:['alibaba'],
};

const HOURS = 72;
// Fallback chain: tries in order. If one returns 429 (quota), worker skips to next.
// Quota-exhaustion state lives in KV for 1 hour so we don't waste retries.
// Unified AI fallback chain — tried in order, first available wins.
// Gemini uses Google's API; NIM entries use NVIDIA's OpenAI-compatible endpoint.
// Format: { provider: 'gemini'|'nim', model: '...' }
const AI_CHAIN = [
  { provider:'gemini', model:'gemini-2.5-flash' },        // best quality, ~20 RPD
  { provider:'gemini', model:'gemini-2.0-flash' },        // good, ~200 RPD
  { provider:'nim',    model:'meta/llama-3.3-70b-instruct' }, // strong, no daily cap
  { provider:'gemini', model:'gemini-2.5-flash-lite' },   // lighter Gemini
  { provider:'gemini', model:'gemini-1.5-flash' },        // last Gemini resort
  { provider:'nim',    model:'mistralai/mixtral-8x7b-instruct' }, // final AI fallback
];
// Keep these for /health display
const GEMINI_CHAIN = AI_CHAIN.filter(e=>e.provider==='gemini').map(e=>e.model);
const NIM_CHAIN    = AI_CHAIN.filter(e=>e.provider==='nim').map(e=>e.model);
const QUOTA_COOLDOWN = 3600; // 1h before retrying a model that hit 429
const BATCH_SIZE = 10;       // more per batch = fewer API calls
const MAX_EVENTS = 200;      // bumped — more events reach AI
const CACHE_TTL = 1800;      // 30 minutes — longer cache, fewer rebuilds

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
async function fetchAllSources(env, useLimitedAPIs){
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
    if (mxOk){ tasks.push(fetchMarketaux(WATCHLIST, env, isoFrom).then(r=>{mx=r;return bumpBudget(env,'marketaux');})); }
    if (sdOk){ tasks.push(fetchStockData(WATCHLIST, env, isoFrom).then(r=>{sd=r;return bumpBudget(env,'stockdata');})); }
    if (avOk){ tasks.push(fetchAlphaVantage(WATCHLIST, env, HOURS).then(r=>{av=r;return bumpBudget(env,'alphavantage');})); }
    await Promise.all(tasks);
  }

  // Per-ticker: Finnhub + TickerTick (no meaningful daily cap) — always run
  const perTicker = [];
  const queue = [...WATCHLIST];
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

async function geminiBatch(events, env, ctx){
  // Build the shared prompt (same for both Gemini + NIM)
  const prompt = `You are a stock market intelligence analyst for an active trader monitoring this watchlist: ${WATCHLIST.join(', ')}.

Sector map: ${Object.entries(SECTORS).map(([t,s])=>`${t}=${s}`).join(', ')}

TASK: For each news event, assign the watchlist ticker it is MOST about, write a trader summary, and score its market impact.

RULES:
1. If the headline/summary is directly about a watchlist company (mentions it by name, ticker, or product) → assign that ticker.
2. If multiple watchlist tickers are mentioned, pick the one most central to the story.
3. Only set primaryTicker to "NONE" for events that have ZERO relevance to any watchlist company — e.g. pure macro news, earnings from non-watchlist companies, general opinion pieces that only vaguely mention the sector.
4. Analyst upgrades/downgrades, price target changes, earnings previews, product news, partnerships, regulatory actions — ALL keep their ticker even if minor.
5. Be INCLUSIVE — it is better to keep a minor relevant article (impactScore 10-20) than to drop it.

SUMMARY FORMAT — 2-4 sentences, trader-focused:
(1) What happened — be specific (include numbers, price targets, % moves, dollar amounts if mentioned).
(2) Why it matters — catalyst explanation, what drove the move or decision.
(3) Valuation/price angle — is the stock cheap/expensive relative to this news? Any PT changes, P/E context, or analyst valuation commentary?
(4) Likely near-term price impact — direction and magnitude (e.g. "likely +2-5% pop", "modest pressure", "neutral until earnings").

For each event return:
- id: event id from input
- summary: 2-4 sentences per format above. Include specific numbers where available.
- sentiment: "bull" | "neutral" | "bear"
- sentimentScore: -1.0 to 1.0
- impactScore: 0-100:
   * 90-100 Critical: earnings surprise, M&A, FDA, sudden CEO exit, major guidance cut, regulatory crisis
   * 75-89 Major: earnings beat/miss, big contract, major rating change, sector-wide action
   * 60-74 Important: product launch, upgrade/downgrade, executive hire, mid-tier contract, meaningful partnership
   * 40-59 Notable: routine update, minor partnership, modest rating change, analyst note
   * 10-39 Minor: opinion piece, speculative article, peripheral mention — keep these, just score low
   * 0-9 Noise: only for genuinely irrelevant content
- eventType: "earnings"|"guidance"|"upgrade"|"downgrade"|"merger"|"regulatory"|"product"|"personnel"|"macro"|"valuation"|"other"
- primaryTicker: watchlist ticker this is most about, or "NONE" only if truly zero watchlist relevance
- additionalTickers: other watchlist tickers materially affected
- sectors: affected sectors from the map
- relevanceConfidence: 0.0-1.0

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

  // Walk the unified AI chain — Gemini and NIM interleaved
  for (const entry of AI_CHAIN){
    const { provider, model } = entry;
    const blockKey = provider === 'nim'
      ? 'quota_block:nim:' + model.replace('/','_')
      : 'quota_block:' + model;

    // Skip if cooling down
    try { const b = await env.NEWSHUB_CACHE.get(blockKey); if (b) continue; } catch(e){}

    try {
      let parsed;
      if (provider === 'gemini'){
        parsed = await callGemini(model, prompt, env, ctx, blockKey);
      } else {
        if (!env.NVIDIA_API_KEY){ console.error('NVIDIA_API_KEY not set — skipping NIM model:', model); continue; }
        parsed = await callNIM(model, prompt, env, ctx, blockKey);
      }
      if (parsed && parsed.length){
        parsed.__model = (provider === 'nim' ? 'nim:' : '') + model;
        return parsed;
      }
    } catch(e){
      console.error(`AI chain ${provider}/${model} exception:`, e.message);
      continue;
    }
  }
  console.error('All AI models exhausted');
  return [];
}

async function callGemini(model, prompt, env, ctx, blockKey){
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json',
      response_schema: {
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
    }
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }
  );
  if (r.status === 429){
    console.warn(`Gemini ${model} 429 — blocking for ${QUOTA_COOLDOWN}s`);
    // Await directly so the write completes before we return, not via fake ctx
    await env.NEWSHUB_CACHE.put('quota_block:'+model, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
    return null;
  }
  if (!r.ok){ console.error(`Gemini ${model} ${r.status}`); return null; }
  const j = await r.json();
  let text = j.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  // Strip markdown code fences if present (e.g. ```json ... ```)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(text); } catch(e){ console.error(`Gemini ${model} JSON parse failed:`, text.slice(0,200)); return null; }
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
      max_tokens: 4096,
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
  let text = j.choices?.[0]?.message?.content || '[]';
  // Strip markdown fences if the model added them anyway
  text = text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  const arrStart = text.indexOf('['), arrEnd = text.lastIndexOf(']');
  if (arrStart === -1 || arrEnd === -1) throw new Error('No JSON array in NIM response');
  return JSON.parse(text.slice(arrStart, arrEnd+1));
}

function impactTier(score){
  if (score >= 90) return 'critical';
  if (score >= 75) return 'major';
  if (score >= 60) return 'important';
  if (score >= 40) return 'notable';
  return 'minor';
}

async function runPipeline(env, ctx, useLimitedAPIs){
  const articles = await fetchAllSources(env, useLimitedAPIs);
  let events = clusterArticles(articles);

  // Pre-rank by source count as proxy for importance, cap to control AI cost
  events.sort((a,b) => b.sourceCount - a.sourceCount || b.ts - a.ts);
  events = events.slice(0, MAX_EVENTS);

  // AI-analyze in batches with auto-fallback chain
  const enriched = [];
  const modelsUsed = new Set();
  let geminiFullyFailed = true;
  for (let i=0; i<events.length; i+=BATCH_SIZE){
    const batch = events.slice(i, i+BATCH_SIZE);
    let out = [];
    try {
      out = await geminiBatch(batch, env, ctx);
      if (out && out.length) geminiFullyFailed = false;
    } catch(e){
      console.error('geminiBatch threw, skipping batch:', e.message);
      out = []; // skip this batch but DON'T crash the whole pipeline
    }
    if (out.__model) modelsUsed.add(out.__model);
    const map = new Map(out.map(o => [o.id, o]));
    for (const ev of batch){
      const ai = map.get(ev.id);
      if (ai && ai.primaryTicker && ai.primaryTicker !== 'NONE' && WATCHLIST.includes(ai.primaryTicker)){
        enriched.push({
          id: ev.id,
          primaryTicker: ai.primaryTicker,
          additionalTickers: (ai.additionalTickers||[]).filter(t=>WATCHLIST.includes(t) && t!==ai.primaryTicker),
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
        additionalTickers: (ev.candidateTickers||[]).slice(1).filter(t=>WATCHLIST.includes(t)),
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
    }).filter(e => e.primaryTicker && WATCHLIST.includes(e.primaryTicker));
    raw.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
    return { events: raw, modelsUsed: [], degraded: true };
  }

  enriched.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
  return { events: enriched, modelsUsed: [...modelsUsed], degraded: false };
}

// ─── Build pipeline + write to KV ────────────────────────────────────────
async function buildAndCache(env, ctx, useLimitedAPIs){
  const result = await runPipeline(env, ctx, useLimitedAPIs);
  const body = JSON.stringify({
    events: result.events,
    generatedAt: Date.now(),
    watchlist: WATCHLIST,
    sectors: SECTORS,
    modelsUsed: result.modelsUsed,
    degraded: result.degraded || false,
  });
  // Only cache successful AI builds — don't overwrite good cache with raw fallback
  if (!result.degraded){
    await env.NEWSHUB_CACHE.put('events:v1', body, { expirationTtl: CACHE_TTL });
  }
  await env.NEWSHUB_CACHE.delete('build:lock'); // release build lock
  console.log(`Pipeline done: ${result.events.length} events, degraded=${result.degraded}`);
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

    // /reset-exhausted — clears all quota_block keys so AI models retry immediately
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

    if (url.pathname !== '/news')
      return new Response('Not found', { status: 404, headers: cors() });

    const fresh = url.searchParams.get('fresh') === '1';
    const cacheKey = 'events:v1';

    // ── Cache hit → return immediately (free, no rate limit) ──────────────
    if (!fresh){
      try {
        const cached = await env.NEWSHUB_CACHE.get(cacheKey);
        if (cached){
          return new Response(cached, { headers: { ...cors(), 'Content-Type':'application/json', 'X-Cache':'HIT' } });
        }
      } catch(e){}
    }

    // ── Cache miss or forced fresh ── rate-limit check ────────────────────
    const rl = await checkRateLimit(env);
    if (rl.blocked){
      // If cache is available (even for fresh requests), return it with rate limit info
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

    // ── Check if a build is already in progress ────────────────────────────
    const buildLock = await env.NEWSHUB_CACHE.get('build:lock').catch(()=>null);
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
    await bumpRateLimit(env);
    await env.NEWSHUB_CACHE.put('build:lock', '1', { expirationTtl: 120 }); // auto-expires after 2min if build crashes

    // Force-fresh spends the limited-API quota (full quality). Regular refresh
    // uses Finnhub+TickerTick only to preserve quota.
    const useLimited = fresh;

    // Run pipeline in background — return 202 immediately so browser can poll
    ctx.waitUntil(
      buildAndCache(env, ctx, useLimited).catch(async(e) => {
        console.error('Build failed:', e.message);
        await env.NEWSHUB_CACHE.delete('build:lock');
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

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
//   POLYGON_KEY, TIINGO_KEY, NVIDIA_API_KEY
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
// Aliases include: company names, key CEOs/execs, major products, and sub-brands.
// More aliases = more legitimate headlines caught when ticker symbol isn't in headline.
const ALIASES = {
  DRAM:['dram'],
  SNDK:['sandisk'],
  MU:['micron','sanjay mehrotra','hbm3','hbm4'],
  INTC:['intel','pat gelsinger','lip-bu tan','gaudi','foundry','18a'],
  WDC:['western digital'],
  AMD:['advanced micro','lisa su','epyc','ryzen','instinct','mi300','mi325','mi350','rocm'],
  CRWD:['crowdstrike','falcon platform','george kurtz'],
  BE:['bloom energy','kr sridhar','fuel cell'],
  LMT:['lockheed','lockheed martin','f-35','jim taiclet','sikorsky','skunk works'],
  GOOGL:['google','alphabet','sundar pichai','youtube','waymo','deepmind','gemini model','android','pixel','google cloud','search ads'],
  PLTR:['palantir','alex karp','foundry platform','gotham','aip'],
  NVDA:['nvidia','jensen huang','blackwell','h100','h200','b100','b200','gb200','gb300','rubin','cuda','dgx','grace hopper','hopper gpu'],
  CRDO:['credo','credo technology','seet','active electrical cable'],
  TSLA:['tesla','elon musk','cybertruck','model y','model 3','model s','model x','robotaxi','cybercab','fsd','full self-driving','optimus','dojo','gigafactory','semi truck'],
  SPCX:['spacex','starship','starlink','falcon 9','dragon capsule'],
  AAPL:['apple','tim cook','iphone','ipad','macbook','vision pro','app store','apple silicon','m4 chip','apple intelligence','aapl'],
  MSFT:['microsoft','satya nadella','azure','copilot','xbox','activision','openai partnership','dynamics 365'],
  NET:['cloudflare','matthew prince','workers ai','r2 storage','warp client'],
  SCCO:['southern copper','grupo mexico','buenavista'],
  ERO:['ero copper','caraiba','tucuma','xavantina'],
  WMT:['walmart','doug mcmillon','sam\'s club','walmart+','flipkart'],
  AMZN:['amazon','aws','bezos','andy jassy','prime day','rufus','bedrock','anthropic deal','kuiper','whole foods','twitch'],
  BABA:['alibaba','jack ma','daniel zhang','eddie wu','taobao','tmall','aliexpress','alicloud','ant group','cainiao'],
  MRVL:['marvell'],
  LMND:['lemonade','daniel schreiber','shai wininger'],
  EXPE:['expedia','vrbo','hotels.com','trivago','ariane gorin'],
  NVS:['novartis','vas narasimhan','kisqali','entresto','pluvicto','cosentyx'],
  MS:['morgan stanley','ted pick','james gorman','wealth management'],
  XOM:['exxon','exxonmobil','darren woods','permian basin','pioneer natural'],
  CVX:['chevron','mike wirth','hess corp','tengizchevroil'],
  VLO:['valero','valero energy','lane riggs','crack spread'],
  CNQ:['canadian natural','canadian natural resources','tim mckay','oil sands'],
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
  { provider:'nim',    model:'mistralai/mixtral-8x7b-instruct' }, // PRIMARY: separate provider — dodges Gemini's frequent 503 overload spells
  { provider:'gemini', model:'gemini-2.0-flash' },        // fast fallback
  { provider:'gemini', model:'gemini-2.5-flash-lite' },   // fast, high RPD — but prone to 503 under load
  { provider:'gemini', model:'gemini-2.5-flash' },        // fallback
  { provider:'gemini', model:'gemini-1.5-flash' },        // fallback
  { provider:'nim',    model:'meta/llama-3.3-70b-instruct', slow:true }, // salvage only — ~107s/batch
];
// Keep these for /health display
const GEMINI_CHAIN = AI_CHAIN.filter(e=>e.provider==='gemini').map(e=>e.model);
const NIM_CHAIN    = AI_CHAIN.filter(e=>e.provider==='nim').map(e=>e.model);
const QUOTA_COOLDOWN = 3600; // 1h before retrying a model that hit 429
const BATCH_SIZE = 8;        // small batches: AI output fits the token budget and
                             // each call returns fast (12+ events truncated the
                             // JSON / timed out → null → degraded RAW every time)
const MAX_EVENTS = 72;       // top 72 events by importance (9 batches of 8) —
                             // bumped from 56 so important tail events from less
                             // active tickers still surface to AI scoring.
const PER_TICKER_CAP = 4;    // max events per ticker in the top-N, so one noisy
                             // ticker (e.g. AMZN) can't crowd out the rest of the
                             // watchlist — every ticker/sector gets its top news
const AI_CALL_TIMEOUT = 35000; // ms — Gemini Flash Lite: ~5-8s/batch. 35s = generous
                             // headroom without letting a slow model stall the build.
const AI_CONCURRENCY = 4;    // max parallel AI calls. Per-call 503/RPM retries are
                             // now bounded by AI_PHASE_BUDGET_MS, so 4-wide parallel
                             // helps the whole build finish inside the Worker budget.
const CACHE_TTL = 21600;     // 6 hours — pre-warm cache survives between cron runs, so regular Refresh = free cache hit (no quota / rate-token burn)
// Hard wall-clock budget for the AI phase of a build. Cloudflare Workers have a
// limited CPU/duration budget; under a Gemini 503 storm, per-batch retries can
// pile up and run the whole build past the limit → the build is killed and only
// raw gets cached. We stop launching NEW retries/calls once this elapses and
// just accept whatever finished, so a partial-but-analyzed result still caches.
const AI_PHASE_BUDGET_MS = 45000;

// Set at the start of each build's AI phase. callGemini/callNIM stop launching
// NEW retry attempts once Date.now() passes this, so a 503 storm can't run the
// build past the Worker budget. 0 = no deadline (e.g. /ai-test single calls).
let _aiDeadline = 0;
function aiBudgetLeft(){ return _aiDeadline === 0 || Date.now() < _aiDeadline; }

// ─── Per-API daily budgets ────────────────────────────────────────────────
// Free tier daily caps. We track usage in KV and stop calling an API before
// it 429s, so quotas last all day. Reserve headroom (cap below true limit).
const API_BUDGETS = {
  marketaux:    { limit: 90,  key: 'budget:marketaux' },   // true 100/day
  stockdata:    { limit: 90,  key: 'budget:stockdata' },   // true 100/day
  alphavantage: { limit: 22,  key: 'budget:alphavantage' },// true 25/day
  finnhub:      { limit: 9999,key: 'budget:finnhub' },     // 60/min, effectively unlimited daily
  polygon:      { limit: 9999,key: 'budget:polygon' },     // 5/min free tier; per-ticker, no hard daily cap we track
  tiingo:       { limit: 45,  key: 'budget:tiingo' },      // ~50/hour free tier — one multi-symbol call per build
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
  'forbes','fortune','economist','bloombergtax',
  // Stock/trading analysis
  'stockanalysis','macrotrends','wisesheets','simply wall','gurufocus',
  'chartmill','marketbeat','tipranks','stocknews','barchart',
  // Wire/breaking stock news (added — these are pure stock-catalyst goldmines)
  'streetinsider','thefly','briefing.com','morningstar',
  'investors.com','investing.com','schaeffersresearch','quiverquant',
  'finbold','simplywall','sharewise',
  // Financial institutions / research
  'sec.gov','edgar','irs.gov','federalreserve',
  // Tech but business-focused
  'techcrunch','axios','theinfo','theinformation','arstechnica',
  'venturebeat','wired','cnet.com/tech',
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

// ─── Polygon.io news (free tier ~5 req/min). Per-ticker; carries publisher +
// insights sentiment. Requires POLYGON_KEY secret. ───────────────────────────
async function fetchPolygon(ticker, env, isoFrom){
  if (!env.POLYGON_KEY) return [];
  try {
    const r = await fetch(`https://api.polygon.io/v2/reference/news?ticker=${ticker}&published_utc.gte=${isoFrom}Z&order=desc&limit=10&sort=published_utc&apiKey=${env.POLYGON_KEY}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results||[]).map(item => {
      // Polygon "insights" sometimes carry a per-ticker sentiment label.
      const ins = (item.insights||[]).find(x => x.ticker === ticker);
      let apiSentiment;
      if (ins?.sentiment === 'positive') apiSentiment = 0.5;
      else if (ins?.sentiment === 'negative') apiSentiment = -0.5;
      return {
        feed:'pg', ticker,
        headline: item.title||'', summary: item.description||'',
        url: item.article_url||'#', source: item.publisher?.name||'Polygon',
        ts: item.published_utc ? Date.parse(item.published_utc) : Date.now(),
        apiSentiment,
      };
    });
  } catch(e){ return []; }
}

// ─── Tiingo news — DISABLED. Free tier returns 403 on /tiingo/news (the News
// API is a paid "Power" add-on). Kept here so it's trivial to re-enable if you
// ever upgrade: set TIINGO_ENABLED and the fetcher + wiring already exist. ─────
async function fetchTiingo(symbols, env, isoFrom){
  if (!env.TIINGO_KEY || !env.TIINGO_ENABLED) return [];
  try {
    const startDate = isoFrom.slice(0,10);
    const r = await fetch(`https://api.tiingo.com/tiingo/news?tickers=${symbols.slice(0,50).join(',').toLowerCase()}&startDate=${startDate}&limit=100&sortBy=publishedDate`, {
      headers: { 'Authorization': 'Token ' + env.TIINGO_KEY, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return [];
    const j = await r.json();
    if (!Array.isArray(j)) return [];
    const upper = symbols.map(s=>s.toUpperCase());
    const out = [];
    for (const item of j){
      // Pick the first article ticker that's on our watchlist.
      const t = (item.tickers||[]).map(x=>(x||'').toUpperCase()).find(x=>upper.includes(x));
      if (!t) continue;
      out.push({
        feed:'tg', ticker:t,
        headline: item.title||'', summary: item.description||'',
        url: item.url||'#', source: item.source||'Tiingo',
        ts: item.publishedDate ? Date.parse(item.publishedDate) : Date.now(),
      });
    }
    return out;
  } catch(e){ return []; }
}

// ─── Finnhub MARKET-WIDE general news (uses existing FINNHUB_KEY, no extra key).
// One global call; we attribute each story to any watchlist ticker it mentions. ─
async function fetchFinnhubGeneral(env, wl, cutoff){
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_KEY}`);
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const a of arr){
      const ts = (a.datetime||0)*1000;
      if (ts < cutoff) continue;
      const text = (a.headline||'') + ' ' + (a.summary||'');
      // Attribute to every watchlist ticker the story actually mentions.
      for (const t of wl){
        if (isRelevant(t, text)){
          out.push({
            feed:'fg', ticker:t,
            headline:a.headline||'', summary:a.summary||'',
            url:a.url||'#', source:a.source||'Finnhub', ts,
          });
        }
      }
    }
    return out;
  } catch(e){ return []; }
}
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
  let mx=[], sd=[], av=[], tg=[], fg=[];
  if (useLimitedAPIs){
    const [mxOk, sdOk, avOk, tgOk] = await Promise.all([
      budgetAvailable(env,'marketaux'),
      budgetAvailable(env,'stockdata'),
      budgetAvailable(env,'alphavantage'),
      budgetAvailable(env,'tiingo'),
    ]);
    const tasks = [];
    if (mxOk){ tasks.push(fetchMarketaux(wl, env, isoFrom).then(r=>{mx=r;return bumpBudget(env,'marketaux');})); }
    if (sdOk){ tasks.push(fetchStockData(wl, env, isoFrom).then(r=>{sd=r;return bumpBudget(env,'stockdata');})); }
    if (avOk){ tasks.push(fetchAlphaVantage(wl, env, HOURS).then(r=>{av=r;return bumpBudget(env,'alphavantage');})); }
    if (tgOk && env.TIINGO_KEY && env.TIINGO_ENABLED){ tasks.push(fetchTiingo(wl, env, isoFrom).then(r=>{tg=r;return bumpBudget(env,'tiingo');})); }
    await Promise.all(tasks);
  }
  // Finnhub general (market-wide) runs every build — one cheap global call, no
  // meaningful daily cap, attributed to any watchlist ticker it mentions.
  fg = await fetchFinnhubGeneral(env, wl, cutoff);

  // Per-ticker: Finnhub company-news + TickerTick + Polygon (no meaningful daily
  // cap; Polygon is per-minute limited so the 6-worker pool keeps it modest).
  const perTicker = [];
  const queue = [...wl];
  async function worker(){
    while (queue.length){
      const t = queue.shift();
      const [fh, tt, pg] = await Promise.all([
        fetchFinnhub(t, env, fromD, toD),
        fetchTickerTick(t, cutoff),
        fetchPolygon(t, env, isoFrom),
      ]);
      perTicker.push(...fh, ...tt, ...pg);
    }
  }
  await Promise.all(Array.from({length:6}, worker));

  return [...mx, ...sd, ...av, ...tg, ...fg, ...perTicker]
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
    const p = {mx:0, sd:0, av:0, tg:1, pg:1, tt:2, fh:3, fg:4};
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

SUMMARY FORMAT — 2-3 concise sentences, trader-focused:
(1) What happened — key numbers, price targets, % moves, dollar amounts.
(2) Why it matters + near-term price direction (e.g. "+2-5% pop", "modest pressure", "neutral until earnings").

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
- summary: 2-3 concise sentences — (1) what happened with key numbers/PTs, (2) why it matters + near-term price direction
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
  // Two transient failure classes get retried (NOT dropped):
  //  • 429 RPM — per-minute rate (free tier). Brief backoff, retry. Only a DAILY
  //    quota 429 earns the long KV block.
  //  • 503/500/502/504 — Google-side overload ("model experiencing high demand").
  //    Very common on flash-lite under load; these used to fall straight through
  //    to `!r.ok → null` and silently drop the batch → whole build went RAW.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;
  const body = JSON.stringify(geminiBody(model, prompt));
  let r, lastBody = '';
  for (let attempt = 0; attempt < 4; attempt++){
    r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body });
    if (r.status === 429){
      lastBody = (await r.text()).slice(0, 500);
      const isDaily = /per day|PerDay|daily limit|quota.*exhaust|FreeTier.*Day/i.test(lastBody);
      if (isDaily){
        console.warn(`Gemini ${model} 429 DAILY quota — blocking ${QUOTA_COOLDOWN}s`);
        await env.NEWSHUB_CACHE.put('quota_block:'+model, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
        return null;
      }
      if (!aiBudgetLeft()) return null; // out of build budget — don't retry
      console.warn(`Gemini ${model} 429 RPM (attempt ${attempt+1}/4) — backing off`);
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); // 1s,2s,3s
      continue;
    }
    if (r.status === 503 || r.status === 500 || r.status === 502 || r.status === 504){
      if (!aiBudgetLeft()) return null; // out of build budget — don't retry
      console.warn(`Gemini ${model} ${r.status} overload (attempt ${attempt+1}/4) — backing off`);
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); // 1s,2s,3s
      continue;
    }
    break; // success or a non-retryable error
  }
  if (r.status === 429){ console.warn(`Gemini ${model} 429 persisted — dropping batch`); return null; }
  if (r.status >= 500){ console.warn(`Gemini ${model} ${r.status} overload persisted — dropping batch`); return null; }
  if (!r.ok){ console.error(`Gemini ${model} HTTP ${r.status}:`, (await r.text()).slice(0,300)); return null; }
  const j = await r.json();
  const cand = j.candidates?.[0];
  const finish = cand?.finishReason;
  let text = cand?.content?.parts?.[0]?.text || '';
  if (!text){ console.error(`Gemini ${model} empty content, finishReason=${finish}`); return null; }
  if (finish && finish !== 'STOP') console.warn(`Gemini ${model} finishReason=${finish} (may be truncated)`);
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(text); }
  catch(e){
    // Salvage a truncated array: keep whole objects up to the last complete one.
    // Truncation (finishReason=MAX_TOKENS) used to drop the entire batch to null
    // and risk the whole build going RAW. Recovering the complete leading objects
    // means most of the batch still gets analyzed.
    const salvaged = salvageJsonArray(text);
    if (salvaged && salvaged.length){
      console.warn(`Gemini ${model} salvaged ${salvaged.length} objs from truncated JSON (finish=${finish})`);
      return salvaged;
    }
    console.error(`Gemini ${model} JSON parse failed (finish=${finish}):`, text.slice(0,200));
    return null;
  }
}

// Best-effort recovery of a truncated JSON array of objects. Finds the last
// top-level "}," boundary and closes the array there. Returns [] if nothing
// usable can be recovered.
function salvageJsonArray(text){
  if (!text) return [];
  const start = text.indexOf('[');
  if (start === -1) return [];
  let depth = 0, lastObjEnd = -1, inStr = false, esc = false;
  for (let i = start; i < text.length; i++){
    const c = text[i];
    if (esc){ esc = false; continue; }
    if (c === '\\'){ esc = true; continue; }
    if (c === '"'){ inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}'){ depth--; if (depth === 0) lastObjEnd = i; }
  }
  if (lastObjEnd === -1) return [];
  try { return JSON.parse(text.slice(start, lastObjEnd + 1) + ']'); }
  catch(e){ return []; }
}

async function callNIM(model, prompt, env, ctx, blockKey){
  const nimBody = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a financial analyst. Respond with valid JSON array only — no markdown, no code fences, no explanation.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 6000,
    stream: false,
  });
  let r;
  for (let attempt = 0; attempt < 3; attempt++){
    r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.NVIDIA_API_KEY}` },
      body: nimBody,
    });
    if (r.status === 429){
      console.warn(`NIM ${model} 429 — blocking for ${QUOTA_COOLDOWN}s`);
      await env.NEWSHUB_CACHE.put(blockKey, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
      return null;
    }
    if (r.status >= 500){ // transient overload — back off and retry
      if (!aiBudgetLeft()) return null;
      console.warn(`NIM ${model} ${r.status} overload (attempt ${attempt+1}/3) — backing off`);
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (r.status >= 500){ console.warn(`NIM ${model} 5xx persisted — dropping batch`); return null; }
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

// Race a promise against a timeout. On timeout resolves null (the underlying
// fetch is abandoned). Keeps one hung AI call from stalling the whole build.
function withTimeout(promise, ms, label){
  let to;
  const timeout = new Promise(res => { to = setTimeout(() => { console.warn(`${label} timed out (${ms}ms)`); res(null); }, ms); });
  return Promise.race([ Promise.resolve(promise).finally(() => clearTimeout(to)), timeout ]);
}

// Run fn over items with a max concurrency (so we don't fire all batches at the
// AI provider at once and trip its concurrency limit). Preserves order.
async function mapLimit(items, limit, fn){
  const results = new Array(items.length);
  let next = 0;
  async function worker(){
    while (next < items.length){
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Call ONE chain entry on ONE batch. Returns a validated array tagged with
// __model, or null on any failure (quota / bad schema / timeout / no key).
async function callModel(entry, batch, env, ctx, wl, sectors){
  const { provider, model } = entry;
  const blockKey = provider === 'nim'
    ? 'quota_block:nim:' + model.replace('/','_')
    : 'quota_block:' + model;
  let parsed;
  try {
    if (provider === 'gemini'){
      parsed = await withTimeout(callGemini(model, buildGeminiPrompt(batch, wl, sectors), env, ctx, blockKey), AI_CALL_TIMEOUT, `gemini/${model}`);
    } else {
      if (!env.NVIDIA_API_KEY){ console.error('NVIDIA_API_KEY not set — skipping NIM'); return null; }
      parsed = await withTimeout(callNIM(model, buildNIMPrompt(batch, wl, sectors), env, ctx, blockKey), AI_CALL_TIMEOUT, `nim/${model}`);
    }
  } catch(e){ console.error(`callModel ${provider}/${model} threw:`, e.message); return null; }
  if (!parsed || !parsed.length) return null;
  const required = ['id','summary','sentiment','impactScore','primaryTicker'];
  if (!required.every(k => k in parsed[0])){
    console.error(`${provider}/${model} bad schema, missing: [${required.filter(k=>!(k in parsed[0])).join(',')}]`);
    return null;
  }
  parsed.__model = (provider === 'nim' ? 'nim:' : '') + model;
  return parsed;
}

// Importance heuristic used to pick which events reach the AI (and to seed
// pre-AI ordering). Favors corroboration, recency, and catalyst language.
const IMPORTANT_KW = /(upgrade|downgrade|price target|raises|cuts guidance|guidance|earnings|beats|misses|acquir|merger|lawsuit|\bsec\b|investigation|recall|partnership|contract|launch|approval|\bfda\b|deal|buyback|dividend|surge|plunge|soar|tumble|record high|all-time|breakout|guides|tariff|antitrust|\bdoj\b|export ban|export control|sanction|chip ban|layoff|restructur|bankrupt|spinoff|stock split|\bipo\b|delist|short report|hindenburg|citron|muddy waters|insider sell|insider buy|\b13f\b|breach|cyberattack|ransomware|outage|capex|production cut|opec|barrel|inventory build|pre-announce|warns|profit warning|halts|halted|suspension|class action|whistleblower|subpoena|raid|patent|infringement|spinout|stake|activist|elliott|carl icahn|buffett|berkshire)/i;
function scoreImportance(ev){
  let s = (ev.sourceCount || 1) * 12;                  // multi-source = market-moving
  const ageH = (Date.now() - (ev.ts || 0)) / 3600000;
  s += Math.max(0, 36 - ageH);                          // recency bonus (≤36h)
  const hl = ev.sources?.[0]?.headline || '';
  if (IMPORTANT_KW.test(hl)) s += 25;                   // catalyst keywords
  if (/\$\d|\d+\s?%/.test(hl)) s += 10;                 // concrete numbers / PT / %
  return s;
}

// Pick top events with PER-TICKER COVERAGE. Pass 1: take the best events but cap
// each ticker so no single ticker dominates. Pass 2: fill any remaining slots
// ignoring the cap. Guarantees breadth across the whole watchlist.
function selectTopEvents(events, max, perTickerCap){
  const scored = events
    .map(e => ({ e, s: scoreImportance(e) }))
    .sort((a,b) => b.s - a.s);
  const out = []; const perT = {}; const used = new Set();
  for (const { e } of scored){
    const t = e.candidateTickers?.[0] || '?';
    if ((perT[t] || 0) >= perTickerCap) continue;
    perT[t] = (perT[t] || 0) + 1; out.push(e); used.add(e.id);
    if (out.length >= max) return out;
  }
  for (const { e } of scored){
    if (used.has(e.id)) continue;
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

async function runPipeline(env, ctx, useLimitedAPIs, wl, sectors){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  const wlSet = new Set(wl);
  const articles = await fetchAllSources(env, useLimitedAPIs, wl);
  let events = clusterArticles(articles);

  // Rank by importance with per-ticker coverage; cap to control AI cost + time.
  events = selectTopEvents(events, MAX_EVENTS, PER_TICKER_CAP);

  // Split into batches.
  const batches = [];
  for (let i=0; i<events.length; i+=BATCH_SIZE) batches.push(events.slice(i, i+BATCH_SIZE));

  // ── DISTRIBUTE: spread batches across ALL available models (round-robin) ──
  // The old design locked ONE model and threw every batch at it — fatal on
  // free-tier per-minute (RPM) limits, where 9 rapid calls to a single model
  // 429 after the first one or two. Instead we fan batches out across every
  // non-blocked model in the chain, so each model only sees ~1-2 calls and stays
  // under its RPM. Effective throughput = sum of all models' RPM.
  const outputs = new Array(batches.length).fill(null);
  const blockKeyFor = (entry) => entry.provider === 'nim'
    ? 'quota_block:nim:' + entry.model.replace('/','_')
    : 'quota_block:' + entry.model;

  // Figure out which models are currently usable (not KV-blocked, key present).
  // Slow models (e.g. 70B at ~107s/batch) are excluded from the primary pool and
  // only used in the salvage fallback below.
  const avail = [];
  for (const entry of AI_CHAIN){
    if (entry.slow) continue;
    if (entry.provider === 'nim' && !env.NVIDIA_API_KEY) continue;
    try { if (await env.NEWSHUB_CACHE.get(blockKeyFor(entry))) continue; } catch(e){}
    avail.push(entry);
  }

  if (batches.length && avail.length){
    // Start the AI-phase clock — retries/salvage stop launching past this.
    _aiDeadline = Date.now() + AI_PHASE_BUDGET_MS;
    // Assign each batch a model round-robin, then run with bounded concurrency.
    // Concurrency 4: with per-model 503/RPM retries now bounded by the deadline,
    // more parallelism helps the whole build finish inside the Worker budget.
    const jobs = batches.map((b, i) => ({ b, i, entry: avail[i % avail.length] }));
    const ran = await mapLimit(
      jobs, AI_CONCURRENCY,
      j => callModel(j.entry, j.b, env, ctx, wl, sectors).catch(() => null)
    );
    ran.forEach((out, k) => { if (out){ outputs[jobs[k].i] = out; } });

    // ── Salvage pass: retry any dropped batches on a DIFFERENT available model.
    // Cycle the model offset so a batch that failed on model A is tried on B, C…
    // Stops early if we're out of build budget (a 503 storm shouldn't run us past
    // the Worker limit — better to cache a partial-analyzed result than be killed).
    let dropped = batches.map((b, i) => ({ b, i })).filter(x => !outputs[x.i]);
    for (let round = 1; round <= 2 && dropped.length && avail.length > 1 && aiBudgetLeft(); round++){
      const retried = await mapLimit(
        dropped, AI_CONCURRENCY,
        x => callModel(avail[(x.i + round) % avail.length], x.b, env, ctx, wl, sectors).catch(() => null)
      );
      retried.forEach((out, k) => { if (out){ outputs[dropped[k].i] = out; } });
      dropped = batches.map((b, i) => ({ b, i })).filter(x => !outputs[x.i]);
    }
    _aiDeadline = 0; // reset
  }

  // ── Merge AI output back onto events ─────────────────────────────────────
  const enriched = [];
  const modelsUsed = new Set();
  for (let bi=0; bi<batches.length; bi++){
    const out = outputs[bi];
    if (!out || !out.length) continue;
    if (out.__model) modelsUsed.add(out.__model);
    const map = new Map(out.map(o => [o.id, o]));
    for (const ev of batches[bi]){
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

  // ── Per-batch raw fallback ───────────────────────────────────────────────
  // OLD behavior was all-or-nothing: if enriched.length===0 the WHOLE build went
  // RAW. Now any batch the AI couldn't analyze falls back to raw INDIVIDUALLY,
  // so a few flaky batches don't drag fully-analyzed events into RAW too. The
  // build is only flagged degraded if the MAJORITY of events are raw.
  const enrichedIds = new Set(enriched.map(e => e.id));
  let rawCount = 0;
  for (const ev of events){
    if (enrichedIds.has(ev.id)) continue;
    const primary = ev.candidateTickers?.[0] || '';
    if (!primary || !wlSet.has(primary)) continue;
    const headline = ev.sources?.[0]?.headline || '';
    const rawScore = Math.min(50, 20 + (ev.sourceCount||1)*5);
    enriched.push({
      id: ev.id,
      primaryTicker: primary,
      additionalTickers: (ev.candidateTickers||[]).slice(1).filter(t=>wlSet.has(t)),
      sectors: [],
      eventType: 'other',
      summary: headline,
      sentiment: { label: 'neutral', score: 0 },
      impact: { score: rawScore, tier: impactTier(rawScore) },
      relevanceConfidence: 0.5,
      ts: ev.ts,
      sources: (ev.sources||[]).map(s => ({ name:s.name, url:s.url, headline:s.headline, feed:s.feed, ts:s.ts })),
      sourceCount: ev.sourceCount,
      aiAnalyzed: false,
    });
    rawCount++;
  }

  enriched.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
  // Degraded only when most of the feed is unanalyzed — drives the short cache
  // TTL so a genuinely-broken build self-heals, while a mostly-good build with a
  // couple raw stragglers keeps the normal 6h TTL.
  const degraded = enriched.length > 0 && rawCount > enriched.length / 2;
  return { events: enriched, modelsUsed: [...modelsUsed], degraded };
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

    // /nim-scan — probe candidate NVIDIA NIM models, report which are live (200)
    // vs dead (404). Lets us pick a current primary instead of guessing names.
    if (url.pathname === '/nim-scan'){
      const candidates = [
        'mistralai/mixtral-8x22b-instruct-v0.1',
        'mistralai/mistral-small-24b-instruct',
        'mistralai/mistral-nemotron',
        'meta/llama-3.1-8b-instruct',
        'meta/llama-3.1-70b-instruct',
        'meta/llama-3.3-70b-instruct',
        'qwen/qwen2.5-7b-instruct',
        'microsoft/phi-3.5-mini-instruct',
        'google/gemma-2-9b-it',
        'nvidia/llama-3.1-nemotron-70b-instruct',
      ];
      const results = {};
      for (const m of candidates){
        try {
          const rr = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method:'POST',
            headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${env.NVIDIA_API_KEY}` },
            body: JSON.stringify({ model:m, messages:[{role:'user',content:'Reply OK.'}], max_tokens:5, stream:false }),
          });
          const t = await rr.text();
          results[m] = { status: rr.status, ok: rr.ok, preview: rr.ok ? 'LIVE' : t.slice(0,120) };
        } catch(e){ results[m] = { threw: e.message }; }
      }
      return new Response(JSON.stringify(results, null, 2), { headers:{...cors(),'Content-Type':'application/json'} });
    }

    // /ai-test — calls the REAL Gemini path on one tiny synthetic batch and
    // returns the raw HTTP status + body. Lets us see WHY builds go fully raw
    // when health shows everything available (auth? body? response shape?).
    if (url.pathname === '/ai-test'){
      const out = {};
      const batch = [{
        id:'t1', candidateTickers:['NVDA'], sourceCount:1, ts:Date.now(),
        sources:[{ name:'Test', url:'#', headline:'Nvidia beats earnings, raises guidance', summary:'Test article.', feed:'fh', ts:Date.now() }],
      }];
      // Raw Gemini HTTP probe (flash-lite) — show status + first chunk of body.
      try {
        const model = 'gemini-2.5-flash-lite';
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
          { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(geminiBody(model, buildGeminiPrompt(batch, WATCHLIST, SECTORS))) }
        );
        const txt = await r.text();
        out.geminiRaw = { httpStatus:r.status, ok:r.ok, bodyPreview: txt.slice(0, 800) };
      } catch(e){ out.geminiRaw = { threw: e.message }; }
      // Full callModel path result (null = failed somewhere in parse/validate).
      try {
        const parsed = await callModel({provider:'gemini',model:'gemini-2.5-flash-lite'}, batch, env, null, WATCHLIST, SECTORS);
        out.callModelResult = parsed ? { ok:true, count:parsed.length, sample:parsed[0] } : { ok:false, note:'callModel returned null' };
      } catch(e){ out.callModelResult = { threw: e.message }; }
      // Isolate: bare callGemini (no withTimeout wrapper).
      try {
        const bare = await callGemini('gemini-2.5-flash-lite', buildGeminiPrompt(batch, WATCHLIST, SECTORS), env, null, 'quota_block:gemini-2.5-flash-lite');
        out.callGeminiBare = bare ? { ok:true, count:bare.length, sample:bare[0] } : { ok:false, note:'callGemini returned null' };
      } catch(e){ out.callGeminiBare = { threw: e.message }; }
      // Isolate: withTimeout around a trivially-resolving promise.
      try {
        const wt = await withTimeout(Promise.resolve([{id:'x',summary:'s',sentiment:'bull',impactScore:1,primaryTicker:'NVDA'}]), AI_CALL_TIMEOUT, 'selftest');
        out.withTimeoutSelfTest = wt ? { ok:true, count:wt.length } : { ok:false, note:'withTimeout returned null on instant promise!' };
      } catch(e){ out.withTimeoutSelfTest = { threw: e.message }; }
      out.geminiKeyPresent = !!env.GEMINI_KEY;
      // NIM (Mixtral) probe — this is the PRIMARY model now, so if builds are raw
      // we need to know whether NVIDIA is healthy independent of Gemini's 503s.
      try {
        const nim = await callNIM('mistralai/mixtral-8x7b-instruct', buildNIMPrompt(batch, WATCHLIST, SECTORS), env, null, 'quota_block:nim:mistralai_mixtral-8x7b-instruct');
        out.nimMixtral = nim ? { ok:true, count:nim.length, sample:nim[0] } : { ok:false, note:'callNIM returned null' };
      } catch(e){ out.nimMixtral = { threw: e.message }; }
      out.nvidiaKeyPresent = !!env.NVIDIA_API_KEY;
      // Raw NIM HTTP probe — show the actual status/body so we know WHY Mixtral
      // returns null (deprecated model name? auth? format?).
      try {
        const m = 'mistralai/mixtral-8x7b-instruct';
        const rr = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${env.NVIDIA_API_KEY}` },
          body: JSON.stringify({ model:m, messages:[{role:'user',content:'Reply with the word OK.'}], max_tokens:10, stream:false }),
        });
        const t = await rr.text();
        out.nimRaw = { httpStatus: rr.status, ok: rr.ok, bodyPreview: t.slice(0, 600) };
      } catch(e){ out.nimRaw = { threw: e.message }; }
      return new Response(JSON.stringify(out, null, 2), { headers:{...cors(),'Content-Type':'application/json'} });
    }

    // /debug — source fetch only, no Gemini. Uses Finnhub+TickerTick only (no quota burn).
    if (url.pathname === '/debug'){
      try {
        const reqTickers = parseTickers(url.searchParams.get('tickers'));
        const wl = reqTickers || WATCHLIST;
        const articles = await fetchAllSources(env, true, wl);
        const events = clusterArticles(articles);
        const byTicker = {};
        const byFeed = {};
        articles.forEach(a => {
          byTicker[a.ticker] = (byTicker[a.ticker]||0)+1;
          byFeed[a.feed] = (byFeed[a.feed]||0)+1;
        });
        return new Response(JSON.stringify({
          rawArticles: articles.length, clusteredEvents: events.length,
          byFeed,  // mx/sd/av/tg/fg/fh/tt/pg counts — confirms each source is live
          byTicker,
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
    // & ?n=8 to test a realistic multi-event batch (THIS is what the build does —
    // single-event tests hide truncation/timeout failures).
    if (url.pathname === '/test-ai'){
      try {
        const provider = url.searchParams.get('provider') || 'gemini';
        const model = url.searchParams.get('model') || (provider === 'nim' ? 'mistralai/mixtral-8x7b-instruct' : 'gemini-2.5-flash-lite');
        const n = Math.min(20, Math.max(1, parseInt(url.searchParams.get('n') || '1', 10)));
        const sampleTickers = ['NVDA','MU','AMD','TSLA','AAPL','MSFT','GOOGL','PLTR','WDC','SNDK'];
        const testEvents = Array.from({ length: n }, (_, i) => ({
          id: 't'+(i+1),
          candidateTickers: [sampleTickers[i % sampleTickers.length]],
          sources: [{ name:'Test', headline:`${sampleTickers[i % sampleTickers.length]} rises after analysts lift price target; strong demand drives upside`, summary:'Test event for batch sizing.' }],
        }));
        const blockKey = 'test_block_ignore';
        const t0 = Date.now();
        let parsed = null;
        if (provider === 'gemini'){
          parsed = await callGemini(model, buildGeminiPrompt(testEvents), env, {waitUntil:()=>{}}, blockKey);
        } else {
          parsed = await callNIM(model, buildNIMPrompt(testEvents), env, {waitUntil:()=>{}}, blockKey);
        }
        const ms = Date.now() - t0;
        const required = ['id','summary','sentiment','impactScore','primaryTicker'];
        const valid = parsed && parsed.length > 0 && required.every(k => k in parsed[0]);
        const missing = parsed?.[0] ? required.filter(k=>!(k in parsed[0])) : required;
        return new Response(JSON.stringify({
          provider, model, eventsSent: n, eventsReturned: parsed?.length ?? 0, ms, valid, missing,
          note: parsed === null ? 'NULL — call failed/empty/parse error (likely truncation or echo)' : 'ok',
          sample: parsed?.[0] || null,
        }, null, 2), { headers:{ ...cors(), 'Content-Type':'application/json' } });
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

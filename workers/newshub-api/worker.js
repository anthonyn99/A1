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
  { provider:'nim',    model:'meta/llama-3.1-8b-instruct' },  // PRIMARY: live NIM, fast (~8b), separate quota from Gemini — immune to its 503/daily-cap
  { provider:'nim',    model:'meta/llama-3.1-70b-instruct' }, // fallback: bigger NIM, still reasonable speed
  { provider:'gemini', model:'gemini-2.0-flash' },            // fast Gemini fallback
  { provider:'gemini', model:'gemini-2.5-flash-lite' },       // fast, high RPD — but daily-capped at 20/day free + prone to 503
  { provider:'gemini', model:'gemini-2.5-flash' },            // fallback
  { provider:'gemini', model:'gemini-1.5-flash' },            // fallback
  { provider:'nim',    model:'meta/llama-3.3-70b-instruct', slow:true }, // salvage only — ~107s/batch
];
// Keep these for /health display
const GEMINI_CHAIN = AI_CHAIN.filter(e=>e.provider==='gemini').map(e=>e.model);
const NIM_CHAIN    = AI_CHAIN.filter(e=>e.provider==='nim').map(e=>e.model);
const QUOTA_COOLDOWN = 3600; // 1h before retrying a model that hit 429
const BATCH_SIZE = 10;       // 10 events/batch — still fits the token budget, but
                             // fewer total batches so the AI phase completes in time
const MAX_EVENTS = 40;       // top 40 by importance (4 batches of 10). Lowered from
                             // 72: 9 batches couldn't finish inside the AI time
                             // budget, leaving most events raw → false degraded
                             // banner. 40 high-signal events all get AI-analyzed.
const PER_TICKER_CAP = 4;    // max events per ticker in the top-N, so one noisy
                             // ticker (e.g. AMZN) can't crowd out the rest of the
                             // watchlist — every ticker/sector gets its top news
const AI_CALL_TIMEOUT = 12000; // ms — MUST be < AI_PHASE_BUDGET_MS. A single call
                               // hanging near a 35s timeout blew the 20s phase
                               // budget (deadline only stops NEW calls, not
                               // in-flight ones) → most batches left raw → false
                               // degraded. 12s kills a stuck call early so the
                               // batch can salvage/fallback within budget.
                             // headroom without letting a slow model stall the build.
const AI_CONCURRENCY = 10;   // run all ~9 batches in one parallel wave (~11s total,
                             // not 3 sequential waves ~33s) so the whole build —
                             // fetch + AI — finishes inside the background waitUntil
                             // budget and the result actually gets cached.
                             // now bounded by AI_PHASE_BUDGET_MS, so 4-wide parallel
                             // helps the whole build finish inside the Worker budget.
const CACHE_TTL = 21600;     // 6 hours — pre-warm cache survives between cron runs, so regular Refresh = free cache hit (no quota / rate-token burn)
// Hard wall-clock budget for the AI phase of a build. Cloudflare Workers have a
// limited CPU/duration budget; under a Gemini 503 storm, per-batch retries can
// pile up and run the whole build past the limit → the build is killed and only
// raw gets cached. We stop launching NEW retries/calls once this elapses and
// just accept whatever finished, so a partial-but-analyzed result still caches.
const AI_PHASE_BUDGET_MS = 25000; // one ~12s wave + one ~12s salvage wave
                                  // runs in a background waitUntil with a limited
                                  // wall-clock; a 45s budget meant the build got
                                  // killed before writing cache (→ stuck "Building").
                                  // 20s + ~10s fetch fits comfortably.

// Set at the start of each build's AI phase. callGemini/callNIM stop launching
// NEW retry attempts once Date.now() passes this, so a 503 storm can't run the
// build past the Worker budget. 0 = no deadline (e.g. /ai-test single calls).
let _aiDeadline = 0;
function aiBudgetLeft(){ return _aiDeadline === 0 || Date.now() < _aiDeadline; }

// HARD subrequest budget for the AI phase. Cloudflare caps each invocation at 50
// subrequests TOTAL. The fetch phase is now in separate staged invocations, so
// the AI invocation starts fresh — but a 503/RPM retry storm across ~9 batches
// can still pile up past 50 HTTP calls and get the build KILLED (→ no cache → the
// "AI quota exhausted / RAW" symptom). We count every AI HTTP call and stop
// launching new ones past this ceiling; any unanalyzed batches fall back to raw
// individually. Ceiling < 50 leaves headroom for KV + the next-stage kick.
let _aiSubrequests = 0;
const AI_SUBREQUEST_BUDGET = 16; // ~9 batches in one wave + a little salvage; with
                                 // Finnhub-only fetch (≤30) stays under the 50 cap.
function aiCallBudgetLeft(){ return _aiSubrequests < AI_SUBREQUEST_BUDGET; }
function countAICall(){ _aiSubrequests++; }

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

  // Per-ticker: Finnhub company-news ONLY. We dropped the per-ticker TickerTick +
  // Polygon calls here: 29 tickers × 3 sources = 87 subrequests blew Cloudflare's
  // 50/invocation cap and killed the AI phase. Finnhub-only = 1 subrequest/ticker,
  // which (plus the multi-symbol sources above + general + the AI phase) keeps the
  // entire build inside one invocation's budget — no fragile staged self-invocation
  // chain. Multi-symbol breadth (Marketaux/StockData/AlphaVantage/Tiingo) is
  // retained above, so coverage stays strong.
  const perTicker = [];
  const queue = [...wl];
  async function worker(){
    while (queue.length){
      const t = queue.shift();
      const fh = await fetchFinnhub(t, env, fromD, toD);
      perTicker.push(...fh);
    }
  }
  await Promise.all(Array.from({length:6}, worker));

  return [...mx, ...sd, ...av, ...tg, ...fg, ...perTicker]
    .filter(a => a.headline && a.ts >= cutoff);
}

// ─── STAGED FETCH: fetch ONE slice of work, well under the 50-subrequest cap ──
// Cloudflare caps each Worker invocation at 50 subrequests. A full build needs
// ~87 per-ticker fetches (29 tickers × fh+tt+pg) + limited sources + AI calls,
// which blows the cap and kills the AI phase (the "quota exhausted / RAW" bug).
// The orchestrator runs this once per ticker-slice in SEPARATE self-invocations,
// each with its own fresh 50 budget, and stages the articles in KV. Quality is
// identical — same sources, same tickers — just spread across invocations.
//
// opts = { tickers:[...slice], includeGeneral:bool, includeLimited:bool }
// Subrequest cost = tickers.length*3 (+1 general) (+~3 limited) — keep tickers ≤14.
async function fetchSlice(env, wl, opts){
  const { tickers, includeGeneral, includeLimited } = opts;
  const now = new Date();
  const cutoff = now.getTime() - HOURS*3600*1000;
  const from = new Date(cutoff);
  const fromD = ymd(from), toD = ymd(now);
  const isoFrom = from.toISOString().slice(0,19);

  let mx=[], sd=[], av=[], tg=[], fg=[];

  // Limited-quota sources (multi-symbol, 1 subrequest each) — only on the slice
  // flagged includeLimited, and only on force-fresh. Scoped to the FULL watchlist
  // (these APIs take all symbols in one call) so we don't lose cross-ticker news.
  if (includeLimited){
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

  // Finnhub general (1 subrequest, market-wide) — runs on the slice flagged
  // includeGeneral, attributed to any FULL-watchlist ticker it mentions.
  if (includeGeneral){
    fg = await fetchFinnhubGeneral(env, wl, cutoff);
  }

  // Per-ticker for THIS slice only (fh+tt+pg = 3 subrequests/ticker).
  const perTicker = [];
  const queue = [...tickers];
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

// Split a watchlist into slices small enough to stay under the subrequest cap.
// 13 tickers × 3 = 39 subrequests; slice 0 also runs general (1) + limited
// sources (~3) = ~43, safely under the 50 cap. Fewer slices = shorter chain.
const TICKERS_PER_SLICE = 13;
function sliceTickers(wl){
  const out = [];
  for (let i=0; i<wl.length; i+=TICKERS_PER_SLICE) out.push(wl.slice(i, i+TICKERS_PER_SLICE));
  return out;
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
// ── Calendar config ─────────────────────────────────────────────────────────
const CAL_TTL        = 12 * 3600;   // 12h cache — macro/earnings calendar barely moves
const CAL_LOCK_TTL   = 120;         // build-lock auto-expiry
const CAL_DAYS_MAX   = 21;          // clamp the lookahead window
const CAL_MACRO_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash']; // grounded-search capable

// Only these macro releases are accepted (whitelist kills hallucinated junk).
// [regex, category]. First match wins.
const MACRO_WHITELIST = [
  [/\bcpi\b|consumer price/i,                         'inflation'],
  [/\bppi\b|producer price/i,                         'inflation'],
  [/\bpce\b|personal consumption/i,                   'inflation'],
  [/\bfomc\b|fed(eral)? (reserve|funds)|rate decision|powell|interest rate decision/i, 'fed'],
  [/nonfarm|non-farm|\bnfp\b|jobs report|payroll|unemployment rate/i, 'jobs'],
  [/jobless claims|initial claims|continuing claims/i, 'jobs'],
  [/\bgdp\b|gross domestic/i,                          'growth'],
  [/retail sales/i,                                    'growth'],
  [/\bism\b|\bpmi\b|manufacturing index|services index/i, 'growth'],
  [/durable goods/i,                                   'growth'],
];
function macroCategory(name){
  for (const [re, cat] of MACRO_WHITELIST) if (re.test(name)) return cat;
  return null; // not whitelisted → reject
}

// Today / +N days as YYYY-MM-DD in America/New_York (worker runs UTC).
function etDateStr(offsetDays = 0){
  const now = new Date(Date.now() + offsetDays * 86400000);
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

// ── Earnings via Finnhub /calendar/earnings ──────────────────────────────────
async function fetchEarningsCalendar(wl, env, fromD, toD, diag){
  if (!env.FINNHUB_KEY){ diag&&diag.push('finnhub: NO KEY'); return []; }
  try {
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${fromD}&to=${toD}&token=${env.FINNHUB_KEY}`);
    if (!r.ok){ const eb=(await r.text()).slice(0,200); diag&&diag.push('finnhub: HTTP '+r.status+' '+eb); return []; }
    const j = await r.json();
    const rows = Array.isArray(j.earningsCalendar) ? j.earningsCalendar : [];
    diag&&diag.push('finnhub: '+rows.length+' rows in window');
    const set = new Set(wl);
    const out = [];
    for (const e of rows){
      const sym = (e.symbol || '').toUpperCase();
      if (!set.has(sym)) continue;
      if (!e.date || e.date < fromD || e.date > toD) continue;
      // hour: 'bmo' before-open | 'amc' after-close | 'dmh' during
      const when = (e.hour || '').toLowerCase();
      out.push({
        kind: 'earnings',
        ticker: sym,
        name: `${sym} Earnings`,
        date: e.date,
        category: 'earnings',
        when: when || null,
        epsEst: (e.epsEstimate ?? null),
      });
    }
    return out;
  } catch(e){ console.warn('earnings cal err', e.message); return []; }
}

// ── Macro via grounded Gemini (Google Search) ────────────────────────────────
// Grounding can't be combined with responseSchema, so we ask for a JSON array in
// the text and parse + salvage it, then hard-filter against the whitelist+window.
async function fetchMacroCalendar(env, fromD, toD, diag){
  const prompt =
`You are a financial calendar API. Using Google Search, list scheduled US macroeconomic data releases and Federal Reserve events between ${fromD} and ${toD} (inclusive), US Eastern dates.

Include ONLY these release types if they fall in the window: CPI, PPI, PCE, FOMC rate decision / Fed meeting, Nonfarm Payrolls (jobs report), weekly Initial Jobless Claims, GDP, Retail Sales, ISM/PMI, Durable Goods.

Return ONLY a JSON array, no prose, no markdown fences. Each item:
{"name":"<official release name incl. month/period, e.g. 'May CPI Report'>","date":"YYYY-MM-DD"}

Use the real published schedule. If unsure of an exact date, omit that item. Dates must be within ${fromD}..${toD}.`;

  for (const model of CAL_MACRO_MODELS){
    const blocked = await env.NEWSHUB_CACHE.get('quota_block:'+model).catch(()=>null);
    if (blocked){ diag&&diag.push(model+': KV-blocked'); continue; }
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;
      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],            // grounding
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      });
      const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body });
      if (r.status === 429){
        await env.NEWSHUB_CACHE.put('quota_block:'+model, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
        diag&&diag.push(model+': 429 quota');
        continue;
      }
      if (!r.ok){ const eb=(await r.text()).slice(0,300); diag&&diag.push(model+': HTTP '+r.status+' '+eb); continue; }
      const j = await r.json();
      let text = j.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('') || '';
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      diag&&diag.push(model+': raw='+text.slice(0,400));
      let arr = null;
      try { arr = JSON.parse(text); } catch(e){ arr = salvageJsonArray(text); }
      if (!Array.isArray(arr) || !arr.length){ diag&&diag.push(model+': 0 items'); continue; }

      const seen = new Set();
      const out = [];
      for (const it of arr){
        const name = (it && it.name || '').toString().trim();
        const date = (it && it.date || '').toString().trim();
        if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (date < fromD || date > toD) continue;     // window clamp
        const cat = macroCategory(name);
        if (!cat) continue;                            // whitelist gate
        const k = name.toLowerCase()+'|'+date;
        if (seen.has(k)) continue; seen.add(k);
        out.push({ kind:'macro', ticker:null, name, date, category:cat });
      }
      diag&&diag.push(model+': kept '+out.length);
      if (out.length) return out;
    } catch(e){ diag&&diag.push(model+': EXC '+e.message); }
  }
  return [];
}

// Deterministic id so re-fetch overwrites (never dupes) downstream in Firestore.
function calEventId(ev){
  const t = ev.kind === 'earnings' ? `earnings_${ev.ticker}` : `macro_${ev.category}_${ev.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)}`;
  return `mc_${t}_${ev.date}`;
}

async function buildCalendar(wl, env, days, diag){
  const fromD = etDateStr(0);
  const toD   = etDateStr(Math.min(days, CAL_DAYS_MAX));
  const [earn, macro] = await Promise.all([
    fetchEarningsCalendar(wl, env, fromD, toD, diag),
    fetchMacroCalendar(env, fromD, toD, diag),
  ]);
  const events = [...earn, ...macro]
    .map(ev => ({ ...ev, id: calEventId(ev) }))
    .sort((a,b) => a.date.localeCompare(b.date));
  return { events, generatedAt: Date.now(), from: fromD, to: toD, degraded: !earn.length && !macro.length };
}


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
    if (!aiCallBudgetLeft()) return null; // hard subrequest cap reached — don't fire
    countAICall();
    r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body });
    if (r.status === 429){
      lastBody = (await r.text()).slice(0, 500);
      const isDaily = /per day|PerDay|daily limit|quota.*exhaust|FreeTier.*Day/i.test(lastBody);
      if (isDaily){
        console.warn(`Gemini ${model} 429 DAILY quota — blocking ${QUOTA_COOLDOWN}s`);
        await env.NEWSHUB_CACHE.put('quota_block:'+model, '1', { expirationTtl: QUOTA_COOLDOWN }).catch(()=>{});
        return null;
      }
      if (!aiBudgetLeft() || !aiCallBudgetLeft()) return null; // out of build/subrequest budget — don't retry
      console.warn(`Gemini ${model} 429 RPM (attempt ${attempt+1}/4) — backing off`);
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); // 1s,2s,3s
      continue;
    }
    if (r.status === 503 || r.status === 500 || r.status === 502 || r.status === 504){
      if (!aiBudgetLeft() || !aiCallBudgetLeft()) return null; // out of build/subrequest budget — don't retry
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
    if (!aiCallBudgetLeft()) return null; // hard subrequest cap reached — don't fire
    countAICall();
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
      if (!aiBudgetLeft() || !aiCallBudgetLeft()) return null;
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

async function runPipeline(env, ctx, useLimitedAPIs, wl, sectors, prefetchedArticles){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  const wlSet = new Set(wl);
  // prefetchedArticles: when the staged orchestrator already gathered articles in
  // separate invocations, skip fetching here (we'd blow the subrequest cap again).
  const articles = prefetchedArticles || await fetchAllSources(env, useLimitedAPIs, wl);
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
    _aiSubrequests = 0; // reset the hard subrequest counter for this build's AI phase
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
    const aiSubUsed = _aiSubrequests;
    _aiSubrequests = 0; // reset
    // Breadcrumb: how the AI phase actually went (visible via /_stage-debug).
    const succeeded = Object.keys(outputs).length;
    // Capture a real sample of what the AI returned + the event ids we expected,
    // so an id-mismatch (AI echoes wrong ids → merge finds nothing → all raw) is
    // visible.
    let dbgSample = null, dbgExpectedIds = null, dbgReturnedIds = null;
    try {
      const firstKey = Object.keys(outputs)[0];
      if (firstKey != null && outputs[firstKey]){
        dbgSample = outputs[firstKey].slice(0,2);
        dbgReturnedIds = outputs[firstKey].map(o=>o.id).slice(0,5);
        dbgExpectedIds = (batches[firstKey]||[]).map(e=>e.id).slice(0,5);
      }
    } catch(e){}
    await env.NEWSHUB_CACHE.put('stage:aistats', JSON.stringify({
      availModels: avail.map(a=>a.model||a.provider), batches: batches.length,
      succeeded, failed: batches.length - succeeded, subrequestsUsed: aiSubUsed,
      budgetMs: AI_PHASE_BUDGET_MS, concurrency: AI_CONCURRENCY, at: Date.now(),
      dbgSample, dbgExpectedIds, dbgReturnedIds,
    }), { expirationTtl: 1800 }).catch(()=>{});
  }

  // ── Merge AI output back onto events ─────────────────────────────────────
  const enriched = [];
  const modelsUsed = new Set();
  const aiRejectedIds = new Set();   // events the AI SAW and judged not relevant (NONE)
  const aiProcessedBatch = new Set(); // batch indices the AI actually returned output for
  for (let bi=0; bi<batches.length; bi++){
    const out = outputs[bi];
    if (!out || !out.length) continue;
    aiProcessedBatch.add(bi);
    if (out.__model) modelsUsed.add(out.__model);
    const map = new Map(out.map(o => [o.id, o]));
    for (const ev of batches[bi]){
      const ai = map.get(ev.id);
      if (!ai) continue; // AI didn't return this id — leave for raw fallback
      if (!ai.primaryTicker || ai.primaryTicker === 'NONE' || !wlSet.has(ai.primaryTicker)){
        // AI judged this article irrelevant to the watchlist (e.g. a Lucid/MLP
        // listicle that only name-drops a ticker). Respect that — drop it rather
        // than raw-resurrecting noise that would falsely inflate the raw count
        // (and trip the degraded banner).
        aiRejectedIds.add(ev.id);
        continue;
      }
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

  // ── Per-batch raw fallback ───────────────────────────────────────────────
  // Raw-fill any event that didn't get an AI verdict — whether its batch failed
  // entirely OR the AI returned the batch but omitted this event. EXCEPT events
  // the AI explicitly rejected as off-watchlist noise (NONE), which we drop.
  const enrichedIds = new Set(enriched.map(e => e.id));
  let rawCount = 0;
  for (let bi=0; bi<batches.length; bi++){
    for (const ev of batches[bi]){
      if (enrichedIds.has(ev.id)) continue;     // already AI-enriched
      if (aiRejectedIds.has(ev.id)) continue;    // AI said off-watchlist → drop
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
  }

  enriched.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
  // Degraded = the AI phase essentially didn't work. A feed with a healthy chunk
  // of AI-analyzed events is NOT degraded just because some low-signal tail items
  // stayed raw. Only flag degraded when fewer than 25% got analyzed (or none did).
  const aiCount = enriched.filter(e=>e.aiAnalyzed).length;
  const degraded = enriched.length > 0 && aiCount < enriched.length * 0.25;
  // Append merge results to the AI stats breadcrumb.
  try {
    const sampleOut = outputs[0] ? outputs[0].slice(0,2) : null;
    const sampleEvIds = (batches[0]||[]).slice(0,2).map(e=>e.id);
    const prev = JSON.parse(await env.NEWSHUB_CACHE.get('stage:aistats') || '{}');
    prev.enrichedAI = aiCount; prev.rawFallback = rawCount; prev.totalOut = enriched.length;
    prev.sampleAiOutput = sampleOut; prev.sampleEventIds = sampleEvIds;
    await env.NEWSHUB_CACHE.put('stage:aistats', JSON.stringify(prev), { expirationTtl: 1800 });
  } catch(e){}
  return { events: enriched, modelsUsed: [...modelsUsed], degraded };
}

// ── Windowed AI analysis (for staged AI sub-stages) ───────────────────────
// Analyzes a SUBSET of pre-clustered events (one window's worth) and returns the
// AI-enriched results. Mirrors runPipeline's analyze+merge, but scoped to a few
// batches so each invocation stays within the Worker CPU/wall + subrequest budget.
// The full event set is clustered ONCE in the prep stage and stored in KV, so ids
// are stable across window invocations.
async function aiAnalyzeWindow(env, ctx, eventsSubset, wl, sectors){
  const wlSet = new Set(wl);
  const batches = [];
  for (let i=0; i<eventsSubset.length; i+=BATCH_SIZE) batches.push(eventsSubset.slice(i, i+BATCH_SIZE));
  const outputs = {};

  const avail = [];
  for (const entry of AI_CHAIN){
    if (entry.slow) continue;
    if (entry.provider === 'nim' && !env.NVIDIA_API_KEY) continue;
    try { if (await env.NEWSHUB_CACHE.get(blockKeyFor(entry))) continue; } catch(e){}
    avail.push(entry);
  }

  if (batches.length && avail.length){
    _aiDeadline = Date.now() + AI_PHASE_BUDGET_MS;
    _aiSubrequests = 0;
    const jobs = batches.map((b, i) => ({ b, i, entry: avail[i % avail.length] }));
    const ran = await mapLimit(jobs, AI_CONCURRENCY,
      j => callModel(j.entry, j.b, env, ctx, wl, sectors).catch(() => null));
    ran.forEach((out, k) => { if (out){ outputs[jobs[k].i] = out; } });
    // One salvage round on a different model for dropped batches.
    let dropped = batches.map((b, i) => ({ b, i })).filter(x => !outputs[x.i]);
    if (dropped.length && avail.length > 1 && aiBudgetLeft()){
      const retried = await mapLimit(dropped, AI_CONCURRENCY,
        x => callModel(avail[(x.i + 1) % avail.length], x.b, env, ctx, wl, sectors).catch(() => null));
      retried.forEach((out, k) => { if (out){ outputs[dropped[k].i] = out; } });
    }
    _aiDeadline = 0; _aiSubrequests = 0;
  }

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
  return { enriched, modelsUsed: [...modelsUsed], availCount: avail.length };
}

// Build the final cached doc from clustered events + the AI-enriched results
// collected across all windows. Any event the AI didn't cover falls back to raw.
function finalizeEvents(events, enrichedList, wl){
  const wlSet = new Set(wl);
  const enriched = [...enrichedList];
  const enrichedIds = new Set(enriched.map(e => e.id));
  let rawCount = 0;
  for (const ev of events){
    if (enrichedIds.has(ev.id)) continue;
    const primary = ev.candidateTickers?.[0] || '';
    if (!primary || !wlSet.has(primary)) continue;
    const headline = ev.sources?.[0]?.headline || '';
    const rawScore = Math.min(50, 20 + (ev.sourceCount||1)*5);
    enriched.push({
      id: ev.id, primaryTicker: primary,
      additionalTickers: (ev.candidateTickers||[]).slice(1).filter(t=>wlSet.has(t)),
      sectors: [], eventType:'other', summary: headline,
      sentiment: { label:'neutral', score:0 },
      impact: { score: rawScore, tier: impactTier(rawScore) },
      relevanceConfidence: 0.5, ts: ev.ts,
      sources: (ev.sources||[]).map(s => ({ name:s.name, url:s.url, headline:s.headline, feed:s.feed, ts:s.ts })),
      sourceCount: ev.sourceCount, aiAnalyzed: false,
    });
    rawCount++;
  }
  enriched.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
  const degraded = enriched.length > 0 && rawCount > enriched.length / 2;
  return { events: enriched, degraded };
}

// Build raw (unanalyzed) events directly from staged articles — used as a last
// resort if the AI stage throws, so the feed still shows headlines instead of
// polling forever. Mirrors the per-event raw shape produced inside runPipeline.
function rawFallbackEvents(articles, wl){
  const wlSet = new Set(wl);
  let events = clusterArticles(articles);
  events = selectTopEvents(events, MAX_EVENTS, PER_TICKER_CAP);
  const out = [];
  for (const ev of events){
    const primary = ev.candidateTickers?.[0] || '';
    if (!primary || !wlSet.has(primary)) continue;
    const headline = ev.sources?.[0]?.headline || '';
    const rawScore = Math.min(50, 20 + (ev.sourceCount||1)*5);
    out.push({
      id: ev.id,
      primaryTicker: primary,
      additionalTickers: (ev.candidateTickers||[]).slice(1).filter(t=>wlSet.has(t)),
      sectors: [], eventType: 'other', summary: headline,
      sentiment: { label:'neutral', score:0 },
      impact: { score: rawScore, tier: impactTier(rawScore) },
      relevanceConfidence: 0.5, ts: ev.ts,
      sources: (ev.sources||[]).map(s => ({ name:s.name, url:s.url, headline:s.headline, feed:s.feed, ts:s.ts })),
      sourceCount: ev.sourceCount, aiAnalyzed: false,
    });
  }
  out.sort((a,b) => b.impact.score - a.impact.score || b.ts - a.ts);
  return out;
}

// Cron variant: no inbound request, so origin is passed explicitly (env.WORKER_ORIGIN).
// Builds the default watchlist into the default cache key.
async function startStagedBuildCron(env, ctx, origin, useLimitedAPIs){
  const cacheKey = 'events:v1', lockKey = 'build:lock';
  // Respect an in-progress build (e.g. a user force-fresh) — don't double-build.
  const existing = await env.NEWSHUB_CACHE.get(lockKey).catch(()=>null);
  if (existing) { console.log('Cron skipped: build already in progress'); return; }
  await env.NEWSHUB_CACHE.put(lockKey, '1', { expirationTtl: 600 });

  const wl = WATCHLIST, sectors = SECTORS;
  const buildId = cacheKey.replace(/[^a-zA-Z0-9]/g,'_') + '_' + Date.now().toString(36);
  const slices = sliceTickers(wl);
  const k = stageKeys(buildId);
  await Promise.all([
    env.NEWSHUB_CACHE.put(k.meta, JSON.stringify({
      wl, sectors, useLimited: !!useLimitedAPIs, cacheKey, lockKey,
      sliceCount: slices.length, nextSlice: 0,
    }), { expirationTtl: STAGE_TTL }),
    env.NEWSHUB_CACHE.put(k.articles, '[]', { expirationTtl: STAGE_TTL }),
  ]);
  await kickStage(env, origin, buildId, 'fetch', 0);
}

// ─── Build pipeline + write to KV ────────────────────────────────────────
// prefetchedArticles: supplied by the staged orchestrator (articles already
// gathered across separate invocations). When omitted, fetches inline — used by
// the simple/legacy path and small custom watchlists that fit under the cap.
async function buildAndCache(env, ctx, useLimitedAPIs, wl, sectors, cacheKey, lockKey, prefetchedArticles){
  wl = wl || WATCHLIST; sectors = sectors || SECTORS;
  cacheKey = cacheKey || 'events:v1';
  lockKey = lockKey || 'build:lock';
  let result;
  try {
    result = await runPipeline(env, ctx, useLimitedAPIs, wl, sectors, prefetchedArticles);
  } catch(e){
    // Capture WHY the build died (visible via /_stage-debug) and still write a
    // result so the poller stops. Without this a throw leaves no cache → stuck
    // "Building" forever.
    const info = { stage:'inline-build', msg:e.message, stack:(e.stack||'').slice(0,1000), at:Date.now() };
    await env.NEWSHUB_CACHE.put('stage:lasterror', JSON.stringify(info), { expirationTtl: 1800 }).catch(()=>{});
    console.error('inline build threw:', e.message, e.stack);
    result = { events: [], modelsUsed: [], degraded: true };
  }
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

// ─── STAGED BUILD ORCHESTRATION ───────────────────────────────────────────
// Why: one invocation can't make all fetch+AI subrequests (50-cap). So we split:
//   • N "fetch" invocations, each gathering one ticker-slice → append to KV stage
//   • 1 "ai" invocation, reading the staged articles → cluster + AI + cache
// Each invocation is triggered by the worker calling its OWN URL (self-fetch),
// giving every stage a fresh 50-subrequest budget. State passes through KV.
//
// A build is identified by a buildId; staging keys are namespaced under it and
// auto-expire so a crashed build leaves no litter.
const STAGE_TTL = 900; // 15 min — must exceed the full staged chain (fetch slices + AI prep + windows + finalize, run sequentially)

function stageKeys(buildId){
  return {
    meta:     'stage:'+buildId+':meta',     // { wl, sectors, useLimited, cacheKey, lockKey, slices, doneSlices }
    articles: 'stage:'+buildId+':articles', // accumulated raw articles (JSON array)
    events:   'stage:'+buildId+':events',   // clustered+selected events (fixed, ids stable)
    enriched: 'stage:'+buildId+':enriched', // AI-enriched results accumulated across windows
  };
}
// How many BATCHES of events each AI window invocation processes. Kept small so a
// window (≈BATCH_SIZE*AI_WINDOW_BATCHES events of NIM calls) finishes well inside
// the Worker CPU/wall budget. 9 batches → ~5 windows.
const AI_WINDOW_BATCHES = 2;

// Derive the worker's own origin from the inbound request so self-invocation
// hits the same deployment.
function selfOrigin(req){
  try { return new URL(req.url).origin; } catch(e){ return null; }
}

// Kick a staged build. Writes meta + empty articles, then fires the FIRST fetch
// stage. Returns immediately (caller already holds the build lock).
async function startStagedBuild(env, ctx, req, useLimitedAPIs, wl, sectors, cacheKey, lockKey){
  const buildId = cacheKey.replace(/[^a-zA-Z0-9]/g,'_') + '_' + Date.now().toString(36);
  const slices = sliceTickers(wl);
  const k = stageKeys(buildId);
  await Promise.all([
    env.NEWSHUB_CACHE.put(k.meta, JSON.stringify({
      wl, sectors, useLimited: !!useLimitedAPIs, cacheKey, lockKey,
      sliceCount: slices.length, nextSlice: 0,
    }), { expirationTtl: STAGE_TTL }),
    env.NEWSHUB_CACHE.put(k.articles, '[]', { expirationTtl: STAGE_TTL }),
  ]);
  // Fire the first fetch stage. Prefer the SELF binding; fall back to HTTP origin.
  // Only if NEITHER exists do we inline-build (correct, but cap-bound).
  const origin = selfOrigin(req) || env.WORKER_ORIGIN || null;
  if (!env.SELF && !origin){
    await buildAndCache(env, ctx, useLimitedAPIs, wl, sectors, cacheKey, lockKey);
    return;
  }
  await kickStage(env, origin, buildId, 'fetch', 0);
}

// Fire one stage as a fresh self-invocation. Fire-and-forget: we don't await the
// body, just the dispatch, so the current invocation can return.
// Prefer the SELF service binding (worker → itself via RPC) — a plain fetch() to
// our own workers.dev hostname loops back and 404s on many CF setups. The binding
// dispatches a genuinely fresh invocation (own 50-subrequest budget) with no
// hostname loopback. Falls back to HTTP self-fetch only if the binding is absent.
async function kickStage(env, origin, buildId, stage, sliceIdx){
  const path = `/_stage?build=${encodeURIComponent(buildId)}&stage=${stage}` +
               (sliceIdx!=null ? `&slice=${sliceIdx}` : '') +
               `&key=${encodeURIComponent(env.STAGE_SECRET||'')}`;
  const url = (env.SELF && typeof env.SELF.fetch === 'function') ? ('https://self' + path)
            : ((origin || env.WORKER_ORIGIN || '') + path);
  const doFetch = (env.SELF && typeof env.SELF.fetch === 'function')
    ? env.SELF.fetch(url, { method:'POST' })
    : fetch(url, { method:'POST' });
  // We only need the request to LAND (which starts the next invocation). We do
  // NOT want to block until the entire downstream chain finishes — otherwise the
  // first stage's invocation would stay alive for the whole multi-minute build and
  // get reaped. Race the dispatch against a short delay: long enough for the
  // subrequest to be sent, short enough not to hold this invocation.
  try {
    await Promise.race([
      doFetch.then(r => r.text().catch(()=>{})).catch(e => console.error('kick fetch err:', e.message)),
      new Promise(res => setTimeout(res, 1500)),
    ]);
  } catch(e){ console.error('kickStage dispatch failed:', e.message); }
}

// Stash a stage error so it's readable via /_stage-debug (CF runtime kills don't
// throw, but real JS errors do — this captures those).
async function stashStageError(env, stageLabel, buildId, e, count){
  const info = { stage:stageLabel, buildId, msg:e.message, stack:(e.stack||'').slice(0,800), at:Date.now(), count };
  console.error(`stage ${stageLabel} threw:`, e.message, e.stack);
  await env.NEWSHUB_CACHE.put('stage:lasterror', JSON.stringify(info), { expirationTtl: 1800 }).catch(()=>{});
}

// Write a raw-degraded result so the client poller terminates + headlines show,
// when the AI path fails. Accepts either staged articles (cluster fresh) or an
// already-clustered events array.
async function writeRawFallback(env, meta, articles, events){
  try {
    const rawEvents = events
      ? finalizeEvents(events, [], meta.wl).events
      : rawFallbackEvents(articles||[], meta.wl);
    const body = JSON.stringify({ events: rawEvents, generatedAt: Date.now(), watchlist: meta.wl, sectors: meta.sectors, modelsUsed: [], degraded: true });
    await env.NEWSHUB_CACHE.put(meta.cacheKey, body, { expirationTtl: 600 });
  } catch(e){ console.error('raw fallback write failed:', e.message); }
  await env.NEWSHUB_CACHE.delete(meta.lockKey).catch(()=>{});
}

// Delete all staging keys for a build.
async function cleanupStage(env, k){
  await Promise.all([
    env.NEWSHUB_CACHE.delete(k.meta).catch(()=>{}),
    env.NEWSHUB_CACHE.delete(k.articles).catch(()=>{}),
    env.NEWSHUB_CACHE.delete(k.events).catch(()=>{}),
    env.NEWSHUB_CACHE.delete(k.enriched).catch(()=>{}),
  ]);
}

// Handle a single stage invocation. Returns a Response (the dispatcher ignores
// the body — what matters is the side effects + the NEXT kickStage).
async function handleStage(env, ctx, req, buildId, stage, sliceIdx){
  const k = stageKeys(buildId);
  const metaRaw = await env.NEWSHUB_CACHE.get(k.meta);
  if (!metaRaw) return new Response(JSON.stringify({ error:'stage meta missing/expired', buildId }), { status:410, headers:{...cors(),'Content-Type':'application/json'} });
  const meta = JSON.parse(metaRaw);
  const wl = meta.wl, sectors = meta.sectors, useLimited = meta.useLimited;
  const slices = sliceTickers(wl);
  const origin = selfOrigin(req);

  if (stage === 'fetch'){
    const i = sliceIdx|0;
    const slice = slices[i] || [];
    // Limited sources + general are gathered ONCE, on slice 0, against the full WL.
    const got = await fetchSlice(env, wl, {
      tickers: slice,
      includeGeneral: i === 0,
      includeLimited: i === 0 && useLimited,
    });
    // Append this slice's articles to the staged accumulator (last-write-wins is
    // safe here because stages run strictly sequentially, one after the next).
    const prevRaw = await env.NEWSHUB_CACHE.get(k.articles).catch(()=>'[]');
    let prev = [];
    try { prev = JSON.parse(prevRaw||'[]'); } catch(e){ prev = []; }
    const merged = prev.concat(got);
    await env.NEWSHUB_CACHE.put(k.articles, JSON.stringify(merged), { expirationTtl: STAGE_TTL });

    const next = i + 1;
    // Dispatch the next stage WITHOUT blocking on its completion. Earlier we
    // awaited it, but env.SELF.fetch() resolves only when the callee RESPONDS —
    // and since each stage awaited ITS successor, slice 0 ended up blocking on the
    // entire downstream chain (all fetch slices + the full ~40s AI phase) in a
    // single invocation, which blew the per-invocation wall-clock and got killed
    // mid-AI → no cache written. Firing in waitUntil lets THIS invocation return
    // immediately while the SELF binding spins up the next as its own invocation.
    const nextStage = next < slices.length ? 'fetch' : 'ai';
    const nextSlice = next < slices.length ? next : null;
    ctx.waitUntil(kickStage(env, origin, buildId, nextStage, nextSlice));
    return new Response(JSON.stringify({ ok:true, stage:'fetch', slice:i, gathered:got.length, total:merged.length }),
      { headers:{...cors(),'Content-Type':'application/json'} });
  }

  // ── AI PREP: cluster + select events ONCE, store them, kick first window. ──
  // Clustering happens a single time so event ids are stable across windows.
  if (stage === 'ai'){
    let articles = [];
    try { articles = JSON.parse(await env.NEWSHUB_CACHE.get(k.articles) || '[]'); } catch(e){ articles = []; }
    try {
      let events = clusterArticles(articles);
      events = selectTopEvents(events, MAX_EVENTS, PER_TICKER_CAP);
      await Promise.all([
        env.NEWSHUB_CACHE.put(k.events, JSON.stringify(events), { expirationTtl: STAGE_TTL }),
        env.NEWSHUB_CACHE.put(k.enriched, '[]', { expirationTtl: STAGE_TTL }),
      ]);
      ctx.waitUntil(kickStage(env, origin, buildId, 'aiwin', 0));
      return new Response(JSON.stringify({ ok:true, stage:'ai-prep', events:events.length }),
        { headers:{...cors(),'Content-Type':'application/json'} });
    } catch(e){
      await stashStageError(env, 'ai-prep', buildId, e, articles.length);
      await writeRawFallback(env, meta, articles);
      ctx.waitUntil(cleanupStage(env, k));
      return new Response(JSON.stringify({ ok:false, stage:'ai-prep', err:e.message }),
        { status:500, headers:{...cors(),'Content-Type':'application/json'} });
    }
  }

  // ── AI WINDOW: analyze one slice of batches, append enriched, kick next. ──
  if (stage === 'aiwin'){
    const cursor = sliceIdx|0; // here sliceIdx = batch-window index
    let events = [], enrichedSoFar = [];
    try { events = JSON.parse(await env.NEWSHUB_CACHE.get(k.events) || '[]'); } catch(e){ events = []; }
    try { enrichedSoFar = JSON.parse(await env.NEWSHUB_CACHE.get(k.enriched) || '[]'); } catch(e){ enrichedSoFar = []; }

    const eventsPerWindow = AI_WINDOW_BATCHES * BATCH_SIZE;
    const start = cursor * eventsPerWindow;
    const windowEvents = events.slice(start, start + eventsPerWindow);
    const totalWindows = Math.ceil(events.length / eventsPerWindow);

    let winEnriched = 0, winAvail = -1;
    try {
      if (windowEvents.length){
        const res = await aiAnalyzeWindow(env, ctx, windowEvents, wl, sectors);
        winEnriched = res.enriched.length;
        winAvail = res.availCount;
        if (res.enriched.length){
          enrichedSoFar = enrichedSoFar.concat(res.enriched);
          await env.NEWSHUB_CACHE.put(k.enriched, JSON.stringify(enrichedSoFar), { expirationTtl: STAGE_TTL });
        }
      }
    } catch(e){
      // A window failing shouldn't kill the build — log + continue; missing events
      // get raw fallback at finalize.
      await stashStageError(env, 'aiwin:'+cursor, buildId, e, windowEvents.length);
    }
    // Status breadcrumb so /_stage-debug shows whether windows fire + why 0 enriched.
    await env.NEWSHUB_CACHE.put('stage:winstatus', JSON.stringify({
      buildId, window:cursor, windowEvents:windowEvents.length, availModels:winAvail,
      windowEnriched:winEnriched, totalSoFar:enrichedSoFar.length, at:Date.now(),
    }), { expirationTtl: 1800 }).catch(()=>{});

    const next = cursor + 1;
    if (next < totalWindows){
      ctx.waitUntil(kickStage(env, origin, buildId, 'aiwin', next));
    } else {
      ctx.waitUntil(kickStage(env, origin, buildId, 'aifin', null));
    }
    return new Response(JSON.stringify({ ok:true, stage:'aiwin', window:cursor, totalWindows, windowEvents:windowEvents.length }),
      { headers:{...cors(),'Content-Type':'application/json'} });
  }

  // ── AI FINALIZE: merge enriched + raw fallback → write cache, cleanup. ──
  if (stage === 'aifin'){
    let events = [], enrichedList = [];
    try { events = JSON.parse(await env.NEWSHUB_CACHE.get(k.events) || '[]'); } catch(e){ events = []; }
    try { enrichedList = JSON.parse(await env.NEWSHUB_CACHE.get(k.enriched) || '[]'); } catch(e){ enrichedList = []; }
    try {
      const { events: finalEvents, degraded } = finalizeEvents(events, enrichedList, wl);
      const anyAnalyzed = enrichedList.some(e => e.aiAnalyzed);
      const body = JSON.stringify({
        events: finalEvents, generatedAt: Date.now(), watchlist: wl, sectors,
        modelsUsed: anyAnalyzed ? ['nim/gemini'] : [], degraded,
      });
      const ttl = degraded ? 600 : CACHE_TTL;
      await env.NEWSHUB_CACHE.put(meta.cacheKey, body, { expirationTtl: ttl });
      await env.NEWSHUB_CACHE.delete(meta.lockKey).catch(()=>{});
    } catch(e){
      await stashStageError(env, 'aifin', buildId, e, enrichedList.length);
      await writeRawFallback(env, meta, null, events);
    }
    ctx.waitUntil(cleanupStage(env, k));
    return new Response(JSON.stringify({ ok:true, stage:'aifin', enriched:enrichedList.length, events:events.length }),
      { headers:{...cors(),'Content-Type':'application/json'} });
  }

  return new Response(JSON.stringify({ error:'unknown stage', stage }), { status:400, headers:{...cors(),'Content-Type':'application/json'} });
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

// Clear all local quota_block cooldown flags. Called on explicit user Force
// fresh so stale blocks (from a prior 503/429 storm, or re-set on every retry
// of a still-capped model) can't keep the build stuck on degraded RAW after the
// upstream daily quotas have actually reset. NOT called on normal cache-miss
// builds — those should respect live blocks so we don't hammer capped providers.
async function clearQuotaBlocks(env){
  const deletes = [];
  for (const m of GEMINI_CHAIN) deletes.push(env.NEWSHUB_CACHE.delete('quota_block:'+m).catch(()=>{}));
  for (const m of NIM_CHAIN)    deletes.push(env.NEWSHUB_CACHE.delete('quota_block:nim:'+m.replace('/','_')).catch(()=>{}));
  await Promise.all(deletes);
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
    // Inline build — fits one invocation now that per-ticker is Finnhub-only.
    ctx.waitUntil(buildAndCache(env, ctx, useLimited).catch(e => console.error('Cron failed:', e.message)));
  },

  async fetch(req, env, ctx){
    if (req.method === 'OPTIONS')
      return new Response(null, { headers: cors() });

    const url = new URL(req.url);

    // ── /_stage — INTERNAL staged-build worker. Called by the worker on itself,
    // once per fetch-slice + once for the AI phase, each in a fresh invocation so
    // every stage gets its own 50-subrequest budget. Secret-gated so it can't be
    // driven externally. Not for browser/client use.
    if (url.pathname === '/_stage'){
      const provided = url.searchParams.get('key') || '';
      const expected = env.STAGE_SECRET || '';
      if (!expected || provided !== expected){
        return new Response(JSON.stringify({ error:'forbidden' }), { status:403, headers:{...cors(),'Content-Type':'application/json'} });
      }
      const buildId = url.searchParams.get('build') || '';
      const stage   = url.searchParams.get('stage') || '';
      const sliceP  = url.searchParams.get('slice');
      const sliceIdx = sliceP == null ? null : parseInt(sliceP, 10);
      if (!buildId || !stage) return new Response(JSON.stringify({ error:'missing build/stage' }), { status:400, headers:{...cors(),'Content-Type':'application/json'} });
      return await handleStage(env, ctx, req, buildId, stage, sliceIdx);
    }

    // ── /_stage-status — read-only diagnostic: is staged build configured/active?
    if (url.pathname === '/_stage-status'){
      const lock = await env.NEWSHUB_CACHE.get('build:lock').catch(()=>null);
      // List staging keys (best-effort; KV list may be eventually consistent).
      let stageKeysFound = [];
      try {
        const ls = await env.NEWSHUB_CACHE.list({ prefix:'stage:' });
        stageKeysFound = (ls.keys||[]).map(x=>x.name);
      } catch(e){}
      const out = {
        stageSecretSet: !!env.STAGE_SECRET,
        workerOriginSet: !!env.WORKER_ORIGIN,
        workerOrigin: env.WORKER_ORIGIN || null,
        selfOriginFromReq: selfOrigin(req),
        tickersPerSlice: TICKERS_PER_SLICE,
        watchlistLen: WATCHLIST.length,
        expectedSlices: sliceTickers(WATCHLIST).length,
        buildLockHeld: !!lock,
        stagingKeys: stageKeysFound,
        nvidiaKeyPresent: !!env.NVIDIA_API_KEY,
        geminiKeyPresent: !!env.GEMINI_KEY,
      };
      return new Response(JSON.stringify(out, null, 2), { headers:{...cors(),'Content-Type':'application/json'} });
    }

    // ── /_stage-debug — inspect staged-build state (read-only, no secret). Shows
    // lock, recent staging keys, and tests whether the worker can self-invoke.
    if (url.pathname === '/_stage-debug'){
      // ?trigger=1&key=SECRET → clear quota blocks + start a staged build for the
      // default watchlist, WITHOUT burning the daily force-fresh budget. For testing.
      if (url.searchParams.get('trigger') === '1'){
        if ((url.searchParams.get('key')||'') !== (env.STAGE_SECRET||'')){
          return new Response(JSON.stringify({ error:'forbidden' }), { status:403, headers:{...cors(),'Content-Type':'application/json'} });
        }
        const tickersParam = url.searchParams.get('tickers');
        const tw = parseTickers(tickersParam) || WATCHLIST;
        const isCustomT = wlHash(tw) !== wlHash(WATCHLIST);
        const ck = isCustomT ? 'events:v1:' + wlHash(tw) : 'events:v1';
        const lk = isCustomT ? 'build:lock:' + wlHash(tw) : 'build:lock';
        const sc = isCustomT ? sectorsFor(tw) : SECTORS;
        await clearQuotaBlocks(env);
        await env.NEWSHUB_CACHE.delete(lk).catch(()=>{}); // clear any stale lock
        await env.NEWSHUB_CACHE.put(lk, '1', { expirationTtl: 180 });
        // AWAIT the build (don't background it): the request handler gets full
        // wall-clock, unlike a waitUntil that gets reaped at ~30s. This tells us
        // definitively whether the build completes + what it produces.
        const t0 = Date.now();
        let buildErr = null, evCount = 0, degraded = null;
        try {
          const bodyStr = await buildAndCache(env, ctx, true, tw, sc, ck, lk);
          const parsed = JSON.parse(bodyStr);
          evCount = (parsed.events||[]).length;
          degraded = parsed.degraded;
        } catch(e){ buildErr = e.message; await env.NEWSHUB_CACHE.delete(lk).catch(()=>{}); }
        return new Response(JSON.stringify({
          triggered:true, mode:'inline-sync', cacheKey:ck, tickers:tw.length,
          ms: Date.now()-t0, events: evCount, degraded, err: buildErr,
        }, null, 2), { headers:{...cors(),'Content-Type':'application/json'} });
      }
      const out = { config:{}, lock:null, stagingKeys:[], selfFetch:null };
      out.config.stageSecretSet = !!env.STAGE_SECRET;
      out.config.selfBindingPresent = !!(env.SELF && typeof env.SELF.fetch === 'function');
      out.config.workerOrigin = env.WORKER_ORIGIN || null;
      out.config.derivedOrigin = selfOrigin(req);
      out.config.watchlistLen = WATCHLIST.length;
      out.config.slices = sliceTickers(WATCHLIST).map(s=>s.length);
      try { out.lock = await env.NEWSHUB_CACHE.get('build:lock'); } catch(e){ out.lock = 'err:'+e.message; }
      try { const le = await env.NEWSHUB_CACHE.get('stage:lasterror'); out.lastError = le ? JSON.parse(le) : null; } catch(e){ out.lastError = 'err:'+e.message; }
      try { const ws = await env.NEWSHUB_CACHE.get('stage:winstatus'); out.lastWindowStatus = ws ? JSON.parse(ws) : null; } catch(e){ out.lastWindowStatus = 'err'; }
      try { const ai = await env.NEWSHUB_CACHE.get('stage:aistats'); out.aiStats = ai ? JSON.parse(ai) : null; } catch(e){ out.aiStats = 'err'; }
      // List every cached events:* key + size, so a cacheKey mismatch (build wrote
      // one key, client reads another) is immediately visible.
      try {
        const evl = await env.NEWSHUB_CACHE.list({ prefix:'events:' });
        out.eventCacheKeys = [];
        for (const key of (evl.keys||[])){
          let n = '?';
          try { const v = await env.NEWSHUB_CACHE.get(key.name); const j = JSON.parse(v); n = (j.events||[]).length + (j.degraded?' (degraded)':''); } catch(e){ n='parse-err'; }
          out.eventCacheKeys.push({ key:key.name, events:n });
        }
      } catch(e){ out.eventCacheKeys = ['err:'+e.message]; }
      try {
        const list = await env.NEWSHUB_CACHE.list({ prefix:'stage:' });
        out.stagingKeys = (list.keys||[]).map(k=>k.name);
        // Dump meta + article count for the most recent build to see chain progress.
        const metaKey = out.stagingKeys.find(n=>n.endsWith(':meta'));
        const artKey  = out.stagingKeys.find(n=>n.endsWith(':articles'));
        if (metaKey){ try { out.meta = JSON.parse(await env.NEWSHUB_CACHE.get(metaKey)); } catch(e){ out.meta = 'err:'+e.message; } }
        if (artKey){ try { const a = JSON.parse(await env.NEWSHUB_CACHE.get(artKey)||'[]'); out.articleCount = a.length; } catch(e){ out.articleCount = 'err:'+e.message; } }
        const evKey  = out.stagingKeys.find(n=>n.endsWith(':events'));
        const enKey  = out.stagingKeys.find(n=>n.endsWith(':enriched'));
        if (evKey){ try { out.stagedEventCount = JSON.parse(await env.NEWSHUB_CACHE.get(evKey)||'[]').length; } catch(e){ out.stagedEventCount='err'; } }
        if (enKey){ try { out.enrichedCount = JSON.parse(await env.NEWSHUB_CACHE.get(enKey)||'[]').length; } catch(e){ out.enrichedCount='err'; } }
      } catch(e){ out.stagingKeys = ['err:'+e.message]; }
      // Test self-invocation: can the worker fetch its own origin?
      const origin = env.WORKER_ORIGIN || selfOrigin(req);
      if (origin){
        try {
          const r = await fetch(origin + '/health', { method:'GET' });
          out.selfFetch = { ok:r.ok, status:r.status, origin };
        } catch(e){ out.selfFetch = { ok:false, threw:e.message, origin }; }
      } else {
        out.selfFetch = { ok:false, note:'no origin available' };
      }
      return new Response(JSON.stringify(out, null, 2), { headers:{...cors(),'Content-Type':'application/json'} });
    }

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

    // /build-trace — runs the REAL AI phase on actual fetched events, one batch
    // at a time (concurrency 1), reporting per batch which model was tried and
    // whether it succeeded. Caches NOTHING. Shows exactly what dies in a build.
    if (url.pathname === '/build-trace'){
      try {
        const articles = await fetchAllSources(env, true, WATCHLIST);
        let events = clusterArticles(articles);
        events = selectTopEvents(events, MAX_EVENTS, PER_TICKER_CAP);
        const batches = [];
        for (let i=0;i<events.length;i+=BATCH_SIZE) batches.push(events.slice(i,i+BATCH_SIZE));
        // Only trace the first 3 batches so we don't burn quota/time.
        const trace = [];
        const tryBatches = batches.slice(0, 3);
        _aiDeadline = Date.now() + AI_PHASE_BUDGET_MS;
        for (let bi=0; bi<tryBatches.length; bi++){
          const batchTrace = { batch: bi, size: tryBatches[bi].length, attempts: [] };
          for (const entry of AI_CHAIN){
            if (entry.slow) continue;
            if (entry.provider==='nim' && !env.NVIDIA_API_KEY) continue;
            const t0 = Date.now();
            let res, err;
            try {
              if (entry.provider==='gemini'){
                res = await callGemini(entry.model, buildGeminiPrompt(tryBatches[bi], WATCHLIST, SECTORS), env, null, 'k');
              } else {
                res = await callNIM(entry.model, buildNIMPrompt(tryBatches[bi], WATCHLIST, SECTORS), env, null, 'k');
              }
            } catch(e){ err = e.message + ' | ' + (e.stack||'').slice(0,200); }
            batchTrace.attempts.push({ model: entry.model, ok: !!res, count: res?res.length:0, ms: Date.now()-t0, err });
            if (res) break;
          }
          trace.push(batchTrace);
        }
        _aiDeadline = 0;
        return new Response(JSON.stringify({ totalBatches: batches.length, traced: trace.length, trace }, null, 2), { headers:{...cors(),'Content-Type':'application/json'} });
      } catch(e){
        return new Response(JSON.stringify({ error:e.message, stack:(e.stack||'').slice(0,400) }), { status:500, headers:{...cors(),'Content-Type':'application/json'} });
      }
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
      // NIM probe — PRIMARY model now. Confirm it returns valid analysis JSON
      // (8b models can be weak at structured output — verify before relying on it).
      try {
        const nim = await callNIM('meta/llama-3.1-8b-instruct', buildNIMPrompt(batch, WATCHLIST, SECTORS), env, null, 'quota_block:nim:meta_llama-3.1-8b-instruct');
        out.nimPrimary = nim ? { ok:true, count:nim.length, sample:nim[0] } : { ok:false, note:'callNIM(llama-3.1-8b) returned null' };
      } catch(e){ out.nimPrimary = { threw: e.message }; }
      out.nvidiaKeyPresent = !!env.NVIDIA_API_KEY;
      // Raw NIM HTTP probe — show the actual status/body so we know WHY Mixtral
      // returns null (deprecated model name? auth? format?).
      try {
        const m = 'meta/llama-3.1-8b-instruct';
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

    // ── /calendar?tickers=A,B,C&days=10 ──────────────────────────────────────
    // Earnings (Finnhub, filtered to tickers) + macro (grounded AI, whitelisted).
    // Cached 12h per watchlist+date. ?fresh=1 forces a rebuild (counts vs daily cap).
    if (url.pathname === '/calendar'){
      const days     = Math.min(parseInt(url.searchParams.get('days') || '10', 10) || 10, CAL_DAYS_MAX);
      const calFresh = url.searchParams.get('fresh') === '1';
      const calWl    = parseTickers(url.searchParams.get('tickers')) || WATCHLIST;
      const calKey   = `cal:v1:${wlHash(calWl)}:${etDateStr(0)}:${days}`;
      const calLock  = `cal:lock:${wlHash(calWl)}`;

      if (!calFresh){
        try {
          const cached = await env.NEWSHUB_CACHE.get(calKey);
          if (cached) return new Response(cached, { headers:{ ...cors(), 'Content-Type':'application/json', 'X-Cache':'HIT' } });
        } catch(e){}
      }

      if (calFresh){
        const rl = await checkRateLimit(env);
        if (rl.blocked){
          try {
            const cached = await env.NEWSHUB_CACHE.get(calKey);
            if (cached){ const j = JSON.parse(cached); j._rateLimited = true; j._rateLimitReason = rl.reason;
              return new Response(JSON.stringify(j), { headers:{ ...cors(), 'Content-Type':'application/json', 'X-Cache':'HIT', 'X-Rate-Limited':'1' } }); }
          } catch(e){}
          return new Response(JSON.stringify({ error:'rate_limited', reason: rl.reason }), { status:429, headers:{ ...cors(), 'Content-Type':'application/json' } });
        }
      }

      const calBusy = await env.NEWSHUB_CACHE.get(calLock).catch(()=>null);
      if (calBusy){
        try { const cached = await env.NEWSHUB_CACHE.get(calKey);
          if (cached) return new Response(cached, { headers:{ ...cors(), 'Content-Type':'application/json', 'X-Cache':'STALE', 'X-Building':'1' } });
        } catch(e){}
        return new Response(JSON.stringify({ status:'building', message:'Calendar building. Poll /calendar in 10s.' }),
          { status:202, headers:{ ...cors(), 'Content-Type':'application/json' } });
      }

      if (url.searchParams.get('debug') === '1'){
        const diag = [];
        const result = await buildCalendar(calWl, env, days, diag);
        return new Response(JSON.stringify({ ...result, _diag: diag, _wl: calWl }, null, 2), { headers:{ ...cors(), 'Content-Type':'application/json', 'X-Cache':'DEBUG' } });
      }

      if (calFresh) await bumpRateLimit(env);
      await env.NEWSHUB_CACHE.put(calLock, '1', { expirationTtl: CAL_LOCK_TTL });

      try {
        const result = await buildCalendar(calWl, env, days);
        const payload = JSON.stringify(result);
        if (result.events.length) ctx.waitUntil(env.NEWSHUB_CACHE.put(calKey, payload, { expirationTtl: CAL_TTL }));
        await env.NEWSHUB_CACHE.delete(calLock);
        return new Response(payload, { headers:{ ...cors(), 'Content-Type':'application/json', 'X-Cache': calFresh ? 'FRESH' : 'MISS' } });
      } catch(e){
        await env.NEWSHUB_CACHE.delete(calLock);
        return new Response(JSON.stringify({ error: e.message, events: [] }), { status:500, headers:{ ...cors(), 'Content-Type':'application/json' } });
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
    // Force-fresh is an explicit user override: it steals any existing lock and
    // rebuilds, so a stale/abandoned lock (crashed build) can't pin the feed on a
    // degraded RAW doc for the full 180s lock TTL. Normal refresh still waits.
    const buildLock = fresh ? null : await env.NEWSHUB_CACHE.get(lockKey).catch(()=>null);
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
    if (fresh){
      await bumpRateLimit(env);     // only force-fresh counts against the daily cap
      await clearQuotaBlocks(env);  // wipe stale model cooldowns so a real retry can use the full AI chain (fixes "quota exhausted / RAW" that survives past the upstream daily reset)
    }
    // Lock auto-expires if a build crashes. Staged builds run several sequential
    // self-invocations, so they get a longer lease than a single inline build.
    const fitsOneInvocationEarly = wl.length <= TICKERS_PER_SLICE;
    const lockTtl = (env.STAGE_SECRET && !fitsOneInvocationEarly) ? 600 : 180;
    await env.NEWSHUB_CACHE.put(lockKey, '1', { expirationTtl: lockTtl });

    // Force-fresh spends the limited-API quota (full quality). Regular refresh
    // uses Finnhub+TickerTick only to preserve quota.
    const useLimited = fresh;

    // ── Choose build mode ────────────────────────────────────────────────────
    // Full watchlists (29 tickers × 3 sources = 87 subrequests) blow Cloudflare's
    // 50-per-invocation cap, killing the AI phase → degraded RAW. The staged
    // orchestrator splits fetch+AI across self-invocations so each stays under the
    // cap. Small watchlists that already fit one invocation skip staging (faster,
    // fewer moving parts). If STAGE_SECRET isn't configured, fall back to inline.
    // Staging DISABLED: with per-ticker trimmed to Finnhub-only, the whole build
    // (fetch + AI) fits in one invocation under the 50-subrequest cap. The staged
    // self-invocation chain proved too fragile (handoffs between sub-stages failed
    // unpredictably), so we run inline. Set STAGE_FORCE_ON=1 to re-enable staging.
    const fitsOneInvocation = true;
    const canStage = env.STAGE_FORCE_ON === '1' && !!env.STAGE_SECRET && (!!env.SELF || !!selfOrigin(req) || !!env.WORKER_ORIGIN);

    if (canStage && !fitsOneInvocation){
      ctx.waitUntil(
        startStagedBuild(env, ctx, req, useLimited, wl, sectors, cacheKey, lockKey)
          .catch(async(e) => { console.error('Staged build failed to start:', e.message); await env.NEWSHUB_CACHE.delete(lockKey); })
      );
    } else {
      // Inline single-invocation build (small list, or staging unavailable).
      ctx.waitUntil(
        buildAndCache(env, ctx, useLimited, wl, sectors, cacheKey, lockKey).catch(async(e) => {
          console.error('Build failed:', e.message);
          await env.NEWSHUB_CACHE.delete(lockKey);
        })
      );
    }

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

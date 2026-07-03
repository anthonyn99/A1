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
  COF:'Financials', FCX:'Copper/Mining', MMM:'Industrials', SMH:'Semiconductor',
  VMC:'Materials/Construction',
};
// Runtime overlay: AI-derived sectors hydrated from KV (meta:TICKER) for tickers
// not in the static table above. Merged via hydrateMeta() before each build so
// inferSector() and the Gemini prompt see real sectors for newly-added tickers.
const SECTOR_DERIVED = {};
function inferSector(t){ return SECTOR_LOOKUP[t] || SECTOR_DERIVED[t] || 'Diversified'; }

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
  COF:['capital one','richard fairbank','discover financial','venture x'],
  FCX:['freeport','freeport-mcmoran','freeport mcmoran','grasberg','kathleen quirk'],
  MMM:['3m','3m company','william brown','post-it','scotch tape','solventum'],
  SMH:['vaneck semiconductor','semiconductor etf','soxx','philadelphia semiconductor','sox index'],
  VMC:['vulcan materials','vulcan','aggregates','crushed stone','tom hill'],
};
// AI-derived aliases (from KV meta:TICKER) merged in at build time by hydrateMeta().
const ALIASES_DERIVED = {};
function aliasesFor(t){ return ALIASES[t] || ALIASES_DERIVED[t] || []; }

// ── Industry / supply-chain THEME attribution ──────────────────────────────
// isRelevant() only catches articles that name a ticker or its company alias.
// But the BIGGEST moves often come from news that names NONE of our companies:
// a rival's capex cut, an industry supply glut, a commodity swing, an export
// control. "SK Hynix slows memory expansion" / "Korea memory output cut" tanks
// SNDK/MU/WDC without naming any of them — so the old filter dropped it.
//
// THEMES bridges that gap. If an article hits a theme's keywords it is
// attributed to every watchlist ticker that theme affects. Clustering then
// folds the multi-attribution into one event and the AI scores its impact.
// Keep keywords SPECIFIC (industry/supply/pricing/policy terms) so we widen
// coverage of real sector news without dragging in generic noise.
const THEMES = [
  // Memory / NAND / DRAM / HBM supply + pricing (SNDK, MU, WDC)
  { tickers:['SNDK','MU','WDC'], kw:[
    /\bsk[\s-]?hynix\b/, /\bhynix\b/, /\bkioxia\b/, /\bymtc\b/, /\bmicron\b/,
    /\bnand\b/, /\bdram\b/, /\bhbm\d?\b/, /\bflash memory\b/, /\bnand flash\b/,
    /\bmemory (chip|chips|price|prices|pricing|market|glut|shortage|demand|supply|capex|expansion|output|production|oversupply|undersupply)\b/,
    /\bchip (glut|oversupply|shortage)\b/, /\bssd (price|pricing|shortage)\b/,
    /\bsamsung (electronics|memory|semiconductor|semiconductors|chip|chips)\b/,
  ] },
  // Broad semiconductor supply / equipment / trade policy (semis on the list).
  // SMH is the VanEck semis ETF — broad semi news moves it directly.
  { tickers:['INTC','AMD','NVDA','CRDO','MU','MRVL','SMH'], kw:[
    /\btsmc\b/, /\btaiwan semiconductor\b/, /\basml\b/, /\bapplied materials\b/,
    /\bchip (export|exports|tariff|tariffs|ban|bans|curb|curbs|control|controls)\b/,
    /\bsemiconductor (tariff|tariffs|export|exports|subsid|shortage|glut)\b/,
    /\bchips act\b/, /\beuv\b/, /\bwafer (fab|price|prices|shortage)\b/,
    /\bfoundry (capacity|price|prices|demand|utilization)\b/, /\bsemiconductor index\b/,
  ] },
  // Copper / industrial metals (SCCO, ERO, FCX)
  { tickers:['SCCO','ERO','FCX'], kw:[
    /\bcopper (price|prices|demand|supply|market|futures|inventories|smelter|smelting|output)\b/,
    /\blme copper\b/, /\bcodelco\b/, /\bfreeport\b/, /\bcomex copper\b/,
  ] },
  // Crude / refining (XOM, CVX, VLO, CNQ)
  { tickers:['XOM','CVX','VLO','CNQ'], kw:[
    /\bopec\b/, /\bopec\+/, /\bcrude oil\b/, /\bbrent crude\b/, /\bwti crude\b/,
    /\boil price\b/, /\boil prices\b/, /\brefining margin\b/, /\bcrack spread\b/,
    /\b(oil|crude) (output|supply|production) cut\b/,
  ] },
  // Defense spending (LMT)
  { tickers:['LMT'], kw:[
    /\bpentagon budget\b/, /\bdefense (budget|spending|appropriation|appropriations)\b/,
    /\bndaa\b/, /\bdefense contract\b/, /\bmissile (order|deal|defense)\b/,
  ] },
];
// AI-derived per-ticker theme keywords (compiled regexes), hydrated from KV
// meta:TICKER by hydrateMeta(). Mirrors the static THEMES above but keyed by a
// single ticker, so a newly-added ticker gets industry/supply-chain read-through
// (a rival's capex, a commodity swing, a policy shift) with no hardcoding.
const THEME_KW_DERIVED = {};
// Turn an AI keyword phrase into a safe whole-phrase regex. Rejects too-short /
// too-long / un-compilable strings so noise keywords can't broaden everything.
function kwToRegex(s){
  s = String(s||'').toLowerCase().trim();
  if (s.length < 3 || s.length > 60) return null;
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp('\\b' + esc + '\\b'); } catch(e){ return null; }
}
// Return the set of watchlist tickers an article maps to via theme keywords.
function themeTickers(text, wl){
  if (!text) return [];
  const lo = text.toLowerCase();
  const hits = new Set();
  for (const th of THEMES){
    if (th.kw.some(re => re.test(lo))){
      for (const t of th.tickers) if (wl.includes(t)) hits.add(t);
    }
  }
  // AI-derived per-ticker themes — only for tickers in this watchlist.
  for (const t of wl){
    if (hits.has(t)) continue;
    const res = THEME_KW_DERIVED[t];
    if (res && res.some(re => re.test(lo))) hits.add(t);
  }
  return [...hits];
}
// Broaden a fetched batch: for each article, emit extra copies tagged to any
// theme-linked watchlist ticker it didn't already carry. Marked theme:true so
// clustering/finalize can give sector news a NONE-reject safety net.
function broadenByTheme(articles, wl){
  const extra = [];
  for (const a of articles){
    const tix = themeTickers((a.headline||'') + ' ' + (a.summary||''), wl);
    for (const t of tix){
      if (t === a.ticker) continue;
      extra.push({ ...a, ticker:t, theme:true });
    }
  }
  return extra;
}

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

// ── AI sector auto-derivation ──────────────────────────────────────────────
// Any ticker NOT in the static SECTOR_LOOKUP gets classified by Gemini ONCE,
// then cached in KV (meta:TICKER, 30d). This is what lets a freshly-added ticker
// flow through the WHOLE system — UI chip, News sector filter + Gemini prompt,
// alias matching — without anyone hardcoding it. The Control tab calls
// GET /sectors on add; the news pipeline calls hydrateMeta() to overlay the
// cached results before building.
const META_TTL = 30 * 24 * 3600;          // 30 days — sector/company identity is stable
const SECTOR_VOCAB = [
  'Semiconductor','AI/Semiconductor','Semiconductor/Memory','Storage','AI/Software',
  'Tech/Mega-Cap','Tech/Retail','Cybersecurity','Clean Energy','EV/Auto','Space/SPAC',
  'Copper/Mining','Materials/Construction','Industrials','Energy','Refining','Retail',
  'Financials','InsurTech','China/Tech','Pharma','Travel','Defense','Diversified',
];
// Ask Gemini to classify a batch of unknown tickers.
// Returns { TICKER:{sector,name,aliases[],themeKw[]} }.
async function aiClassifyTickers(tickers, env){
  if (!tickers.length || !env.GEMINI_KEY) return {};
  const prompt = `You are a stock-market reference engine. For each US-listed ticker below, return its GICS-style sector label, official company/fund name, search aliases, and industry "theme" keywords.
Tickers: ${tickers.join(', ')}
Pick the "sector" from this controlled vocabulary when one fits; otherwise return a concise 1-2 word sector of your own:
${SECTOR_VOCAB.join(', ')}
"aliases": 3-7 lowercase strings a news headline might use instead of the ticker — company short name, CEO last name, flagship product/brand, common nicknames. No generic words.
"themeKw": 4-8 lowercase industry/supply-chain phrases that MOVE THIS STOCK even when the company is NOT named — e.g. a key commodity ("copper prices"), a rival/supplier ("tsmc"), an end-market or policy term ("data center capex", "auto tariffs"), a pricing/supply term ("memory glut"). Be SPECIFIC — these are matched as whole phrases in news text, so generic words like "market" or "stock" cause false positives and must be avoided. For a sector ETF, use the broad terms that move the whole sector.
If a ticker is an ETF, set sector to the sector it tracks (e.g. a semiconductor ETF -> "Semiconductor").
Return ONLY a JSON array; each element: {"ticker","sector","name","aliases","themeKw"}.`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: { type:'ARRAY', items:{ type:'OBJECT', properties:{
        ticker:{type:'STRING'}, sector:{type:'STRING'}, name:{type:'STRING'},
        aliases:{ type:'ARRAY', items:{type:'STRING'} },
        themeKw:{ type:'ARRAY', items:{type:'STRING'} },
      }, required:['ticker','sector'] } },
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const clean = arr => Array.isArray(arr)
    ? arr.map(a=>String(a).toLowerCase().trim()).filter(a=>a&&a.length>=3&&a.length<=40).slice(0,8)
    : [];
  const out = {};
  for (const model of ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.0-flash']){
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body });
      if (!r.ok) continue;
      const j = await r.json();
      let text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) continue;
      for (const e of arr){
        const t = (e.ticker||'').toUpperCase().trim();
        if (!t || !e.sector) continue;
        out[t] = {
          sector: String(e.sector).slice(0,40),
          name: String(e.name||'').slice(0,80),
          aliases: clean(e.aliases).slice(0,7),
          themeKw: clean(e.themeKw),
        };
      }
      if (Object.keys(out).length) return out;
    } catch(e){ /* try next model */ }
  }
  return out;
}
// Resolve sector/meta for a list of tickers: static table → KV cache → AI (cached).
// Returns { TICKER:{sector,name,aliases} } for everything resolvable. Tickers that
// stay unresolved (AI down) simply fall back to 'Diversified' downstream.
async function resolveMeta(tickers, env){
  const result = {};
  const missing = [];
  for (const t of tickers){
    if (SECTOR_LOOKUP[t]){ result[t] = { sector: SECTOR_LOOKUP[t], name:'', aliases: ALIASES[t]||[] }; continue; }
    let cached = null;
    try { cached = await env.NEWSHUB_CACHE.get('meta:'+t, 'json'); } catch(e){}
    if (cached && cached.sector){ result[t] = cached; continue; }
    missing.push(t);
  }
  if (missing.length){
    const ai = await aiClassifyTickers(missing, env);
    for (const t of missing){
      const m = ai[t];
      if (m && m.sector){
        result[t] = m;
        try { await env.NEWSHUB_CACHE.put('meta:'+t, JSON.stringify(m), { expirationTtl: META_TTL }); } catch(e){}
      }
    }
  }
  return result;
}
// Overlay cached/derived sectors + aliases into the runtime maps so inferSector(),
// the Gemini prompt, and isRelevant() all see real values for added tickers.
// Read-only against KV (NO AI calls) — keeps the build hot path cheap; the AI
// classification happens up front via the /sectors endpoint when a ticker is added.
async function hydrateMeta(wl, env){
  for (const t of wl){
    if (SECTOR_LOOKUP[t]) continue;
    if (SECTOR_DERIVED[t]) continue;            // already hydrated this isolate
    let cached = null;
    try { cached = await env.NEWSHUB_CACHE.get('meta:'+t, 'json'); } catch(e){}
    if (cached && cached.sector){
      SECTOR_DERIVED[t] = cached.sector;
      if (Array.isArray(cached.aliases) && cached.aliases.length) ALIASES_DERIVED[t] = cached.aliases;
      if (Array.isArray(cached.themeKw) && cached.themeKw.length){
        const res = cached.themeKw.map(kwToRegex).filter(Boolean);
        if (res.length) THEME_KW_DERIVED[t] = res;
      }
    }
  }
}
// Hydrate then build the sector map — use in build entry points so custom lists
// with newly-added tickers get their real (AI-derived) sectors, not 'Diversified'.
async function sectorsForLive(wl, env){
  await hydrateMeta(wl, env);
  return sectorsFor(wl);
}

const HOURS = 72;   // news lookback = 3 days.
// Fallback chain: tries in order. If one returns 429 (quota), worker skips to next.
// Quota-exhaustion state lives in KV for 1 hour so we don't waste retries.
// Unified AI fallback chain — tried in order, first available wins.
// Gemini uses Google's API; NIM entries use NVIDIA's OpenAI-compatible endpoint.
// Format: { provider: 'gemini'|'nim', model: '...' }
const AI_CHAIN = [
  { provider:'gemini', model:'gemini-3.5-flash' },            // PRIMARY: newest/strongest free Flash, thinkingLevel:low keeps it quick
  { provider:'gemini', model:'gemini-3.1-flash-lite' },       // newest Flash-Lite — 2.5-flash quality, very high RPD
  { provider:'gemini', model:'gemini-2.5-flash' },            // proven fast Flash fallback
  { provider:'gemini', model:'gemini-2.5-flash-lite' },       // high-RPD lite fallback
  { provider:'gemini', model:'gemini-2.0-flash' },            // older Gemini fallback
  { provider:'nim',    model:'meta/llama-3.1-8b-instruct' },  // cross-provider fallback: live NIM, fast (~8b), separate quota — immune to Gemini 503/daily-cap
  { provider:'nim',    model:'meta/llama-3.1-70b-instruct' }, // bigger NIM fallback
  { provider:'nim',    model:'meta/llama-3.3-70b-instruct', slow:true }, // salvage only — ~107s/batch
];
// Keep these for /health display
const GEMINI_CHAIN = AI_CHAIN.filter(e=>e.provider==='gemini').map(e=>e.model);
const NIM_CHAIN    = AI_CHAIN.filter(e=>e.provider==='nim').map(e=>e.model);
const QUOTA_COOLDOWN = 3600; // 1h before retrying a model that hit 429
const BATCH_SIZE = 8;        // 8 events/batch — best balance: model returns most
                             // of them, and 5 batches finish fast in one wave.
const MAX_EVENTS = 56;       // 7 batches of 8. Raised from 40 once the strong-
                             // primary-first AI pass made batches reliable (each
                             // first-pass call returns its full batch), so more
                             // events get analyzed without extra salvage churn.
const PER_TICKER_CAP = 6;    // max events per ticker in the top-N, so one noisy
                             // ticker (e.g. AMZN) can't crowd out the rest of the
                             // watchlist — every ticker/sector gets its top news.
                             // 6 (was 4) keeps more depth on a heavy-news ticker
                             // (earnings day) while breadth fill still runs after.
// Per-ticker Finnhub company-news is the richest per-company source but costs one
// subrequest each, so it dominates the 50/invocation budget. Cap it; the always-on
// multi-symbol sources (Marketaux/StockData/AlphaVantage/TickerTick) cover any
// overflow tickers on larger custom watchlists. The default WL (29) is under this.
const FINNHUB_PER_TICKER_CAP = 34;
const AI_CALL_TIMEOUT = 12000; // ms — MUST be < AI_PHASE_BUDGET_MS. A single call
                               // hanging near a 35s timeout blew the 20s phase
                               // budget (deadline only stops NEW calls, not
                               // in-flight ones) → most batches left raw → false
                               // degraded. 12s kills a stuck call early so the
                               // batch can salvage/fallback within budget.
                             // headroom without letting a slow model stall the build.
const AI_CONCURRENCY = 12;   // fire all ~10 small batches in one parallel wave
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
const AI_SUBREQUEST_BUDGET = 12; // RICH builds add limited-API globals, so the fetch
                                 // phase runs ~28-30 subreq on a ~23-ticker list. The
                                 // OLD value (24) put fetch+AI at ~52 — JUST over the
                                 // 50/invocation cap, so a cold "new day" rich build
                                 // (no cache to mask it) got HARD-KILLED before writing
                                 // a result → 6am cron produced nothing AND force-fresh
                                 // re-kick-looped forever. 16 lands the total at ~44-46,
                                 // safely under 50. First-pass AI is only ~5 calls, so
                                 // quality is unaffected; only deep salvage retries trim.
// AI gets the subrequest budget left after the fetch phase. Fetch now uses ~35 on
// the default 29-ticker force-fresh build (29 per-ticker Finnhub + general +
// Marketaux + StockData + AlphaVantage + 1 bulk TickerTick + 1 EDGAR), so 12 for
// AI lands the total at ~47, safely under 50. The strong-primary-first pass needs
// only ~7 calls for 7 batches, leaving headroom for salvage.
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
  for (const a of aliasesFor(ticker)) if (lo.includes(a)) return true;
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
  // "Why the stock moved" explainer desks — exactly the catchy Robinhood-style
  // headlines ("Why Sandisk Stock Just Dropped", "What's Behind the Memory Split").
  // 247wallst + wccftech are TickerTick-indexed but were missing from this list.
  '247wallst','wccftech','kiplinger','marketrealist',
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
// TickerTick BULK — one query for the whole watchlist via its (or tt:a tt:b…)
// syntax instead of one call per ticker. Free, no key. Stories arrive tagged with
// their ticker(s); we keep only allowlisted financial publishers within the window
// and attribute each to its first watchlist ticker. ≤30 tickers/query → the
// default 29-ticker WL is a SINGLE subrequest (vs 29 in the old per-ticker path).
async function fetchTickerTickBulk(wl, cutoff){
  const wlSet = new Set(wl.map(t => t.toUpperCase()));
  const out = [];
  const CHUNK = 30;
  for (let i=0; i<wl.length; i+=CHUNK){
    const terms = wl.slice(i, i+CHUNK).map(t => 'tt:' + t.toLowerCase());
    const q = terms.length === 1 ? terms[0] : `(or ${terms.join(' ')})`;
    try {
      const r = await fetch(`https://api.tickertick.com/feed?q=${encodeURIComponent(q)}&n=150`);
      if (!r.ok) continue;
      const j = await r.json();
      for (const s of (j.stories||[])){
        if ((s.time||0) < cutoff) continue;
        if (!isTTAllowed(s.url, s.site)) continue;
        const tk = (s.tickers||[]).map(x => (x||'').toUpperCase()).find(x => wlSet.has(x));
        if (!tk) continue;
        out.push({
          feed:'tt', ticker:tk,
          headline:s.title||'', summary:s.description||'',
          url:s.url||'#', source:s.site||'TickerTick', ts:s.time||0,
        });
      }
    } catch(e){}
  }
  return out;
}

// ─── SEC EDGAR 8-K material filings (free, no key) ─────────────────────────────
// 8-Ks are the canonical source of MATERIAL corporate events (earnings, M&A, exec
// changes, restatements, bankruptcies). One market-wide "getcurrent" atom call
// returns the most recent filings WITH their item codes in the summary, so we get
// descriptive headlines and event types from a SINGLE subrequest — no per-filing
// fetches. We map each filing's CIK back to a watchlist ticker via SEC's
// ticker→CIK table (cached in KV for a week; one cold fetch ~weekly).
const EDGAR_HEADERS = { 'User-Agent': 'tradehub-newshub research anthonypn99@gmail.com', 'Accept-Encoding':'gzip, deflate' };
const EDGAR_8K_ITEMS = {
  '1.01':'Material Definitive Agreement','1.02':'Termination of Material Agreement',
  '1.03':'Bankruptcy or Receivership','1.05':'Material Cybersecurity Incident',
  '2.01':'Completion of Acquisition/Disposition','2.02':'Results of Operations (Earnings)',
  '2.03':'Material Financial Obligation','2.04':'Triggering Event on Financial Obligation',
  '2.05':'Costs from Exit/Disposal','2.06':'Material Impairment',
  '3.01':'Delisting / Listing-Standard Notice','3.02':'Unregistered Equity Sale',
  '3.03':'Modification of Security-Holder Rights','4.01':'Change in Accountant',
  '4.02':'Non-Reliance on Prior Financials (Restatement)','5.01':'Change in Control',
  '5.02':'Executive/Director Change','5.03':'Bylaw/Charter Amendment',
  '5.07':'Shareholder Vote Results','7.01':'Reg FD Disclosure',
  '8.01':'Other Material Event','9.01':'Financial Statements & Exhibits',
};
// ticker(UPPER) → CIK(int). KV-cached 7 days; rebuilt from SEC on miss.
async function loadCikMap(env){
  try { const c = await env.NEWSHUB_CACHE.get('edgar:cikmap'); if (c) return JSON.parse(c); } catch(e){}
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: EDGAR_HEADERS });
    if (!r.ok) return {};
    const j = await r.json();
    const map = {};
    for (const k in j){ const row = j[k]; if (row && row.ticker) map[String(row.ticker).toUpperCase()] = row.cik_str; }
    await env.NEWSHUB_CACHE.put('edgar:cikmap', JSON.stringify(map), { expirationTtl: 7*86400 }).catch(()=>{});
    return map;
  } catch(e){ return {}; }
}
async function fetchEdgar8K(env, wl, cutoff){
  try {
    const cikMap = await loadCikMap(env);
    const cik2tk = {};                       // "CIK without leading zeros" → ticker
    for (const t of wl){ const c = cikMap[t.toUpperCase()]; if (c != null) cik2tk[String(c)] = t.toUpperCase(); }
    if (!Object.keys(cik2tk).length) return [];
    const r = await fetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=100&output=atom', { headers: EDGAR_HEADERS });
    if (!r.ok) return [];
    const xml = await r.text();
    const out = [];
    for (const e of xml.split('<entry>').slice(1)){
      const title = ((e.match(/<title>([\s\S]*?)<\/title>/)||[])[1] || '').trim();
      const cikM = title.match(/\((\d{4,10})\)/);
      if (!cikM) continue;
      const tk = cik2tk[String(parseInt(cikM[1], 10))];
      if (!tk) continue;                     // not a watchlist filer
      const upd = (e.match(/<updated>([^<]+)<\/updated>/)||[])[1];
      const ts = upd ? Date.parse(upd) : Date.now();
      if (ts < cutoff) continue;
      const href = (e.match(/href="([^"]+)"/)||[])[1] || 'https://www.sec.gov';
      const summaryRaw = (e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)||[])[1] || '';
      const items = [...summaryRaw.matchAll(/Item\s+(\d+\.\d+)/g)].map(m => m[1]);
      const labels = items.map(c => EDGAR_8K_ITEMS[c] || ('Item ' + c));
      const company = title.replace(/^8-K\s*-\s*/,'').replace(/\s*\(\d{4,10}\)\s*\(Filer\)\s*$/,'').trim();
      out.push({
        feed:'ec', ticker:tk,
        headline:`${company} filed SEC 8-K — ${labels.length ? labels.join('; ') : 'material event'}`,
        summary:`Official SEC 8-K filing. Items: ${items.length ? items.map((c,i)=>`${c} (${labels[i]})`).join(', ') : 'unspecified'}.`,
        url:href, source:'SEC EDGAR', ts,
      });
    }
    return out;
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

// ─── Finnhub real-time quotes (free, 60/min). One call per ticker; the /quotes
// route KV-caches the whole map ~60s so repeated News opens don't re-hit the API.
// Powers the client's "Top Movers" strip + per-card % change (price-move
// correlation). Returns null for invalid/empty symbols so they're skipped. ─────
async function fetchQuote(ticker, env){
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${env.FINNHUB_KEY}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || (j.c === 0 && j.pc === 0)) return null; // no data / bad symbol
    return { c:j.c, d:j.d, dp:j.dp, h:j.h, l:j.l, o:j.o, pc:j.pc, t:j.t };
  } catch(e){ return null; }
}
async function fetchQuotes(wl, env){
  const out = {};
  const queue = [...wl];
  async function worker(){
    while (queue.length){
      const t = queue.shift();
      const q = await fetchQuote(t, env);
      if (q) out[t] = q;
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, wl.length || 1) }, worker));
  return out;
}

// Source tiers (all 1 subrequest each unless noted), tuned to pack maximum
// coverage under Cloudflare's 50-subrequest/invocation cap:
//   ALWAYS-ON (every build): Finnhub general + per-ticker Finnhub, TickerTick
//     (bulk, free), SEC EDGAR 8-K (free), Marketaux + StockData (generous ~90/day
//     caps, budget-gated). These give broad multi-ticker + material-filing coverage
//     even on a normal cache-miss refresh — no more "Finnhub-only" blind spot.
//   RICH-ONLY (useLimitedAPIs = force-fresh / cron rich tick): AlphaVantage (scarce
//     25/day) + Tiingo (paid, disabled), reserved so their tiny quotas survive.
async function fetchAllSources(env, useLimitedAPIs, wl){
  wl = wl || WATCHLIST;
  const now = new Date();
  const cutoff = now.getTime() - HOURS*3600*1000;
  const from = new Date(cutoff);
  const fromD = ymd(from), toD = ymd(now);
  const isoFrom = from.toISOString().slice(0,19);

  let mx=[], sd=[], av=[], tg=[], fg=[], tt=[], ec=[];
  const tasks = [];
  // ── Broad multi-symbol wires — run on EVERY build, budget-gated. ──
  const [mxOk, sdOk] = await Promise.all([ budgetAvailable(env,'marketaux'), budgetAvailable(env,'stockdata') ]);
  if (mxOk){ tasks.push(fetchMarketaux(wl, env, isoFrom).then(r=>{mx=r;return bumpBudget(env,'marketaux');})); }
  if (sdOk){ tasks.push(fetchStockData(wl, env, isoFrom).then(r=>{sd=r;return bumpBudget(env,'stockdata');})); }
  // ── Scarce-quota wires — only on rich/force-fresh builds. ──
  if (useLimitedAPIs){
    const [avOk, tgOk] = await Promise.all([ budgetAvailable(env,'alphavantage'), budgetAvailable(env,'tiingo') ]);
    if (avOk){ tasks.push(fetchAlphaVantage(wl, env, HOURS).then(r=>{av=r;return bumpBudget(env,'alphavantage');})); }
    if (tgOk && env.TIINGO_KEY && env.TIINGO_ENABLED){ tasks.push(fetchTiingo(wl, env, isoFrom).then(r=>{tg=r;return bumpBudget(env,'tiingo');})); }
  }
  // ── Free always-on breadth + canonical filings (each 1 subrequest). ──
  tasks.push(fetchFinnhubGeneral(env, wl, cutoff).then(r=>{fg=r;}));   // market-wide, attributed
  tasks.push(fetchTickerTickBulk(wl, cutoff).then(r=>{tt=r;}));        // 1 bulk OR-query for the WL
  tasks.push(fetchEdgar8K(env, wl, cutoff).then(r=>{ec=r;}));          // SEC 8-K material events
  await Promise.all(tasks);

  // ── Per-ticker Finnhub company-news (richest per-company source). One
  // subrequest each, so it dominates the budget — capped at FINNHUB_PER_TICKER_CAP;
  // the multi-symbol wires + TickerTick above cover any overflow on big custom
  // watchlists. The default 29-ticker WL is under the cap (all fetched).
  const fhTickers = wl.slice(0, FINNHUB_PER_TICKER_CAP);
  const perTicker = [];
  const queue = [...fhTickers];
  async function worker(){
    while (queue.length){
      const t = queue.shift();
      const fh = await fetchFinnhub(t, env, fromD, toD);
      perTicker.push(...fh);
    }
  }
  await Promise.all(Array.from({length:6}, worker));

  const all = [...mx, ...sd, ...av, ...tg, ...fg, ...tt, ...ec, ...perTicker]
    .filter(a => a.headline && a.ts >= cutoff);
  // Theme broadening: re-attribute sector/supply-chain articles to every
  // affected watchlist ticker (e.g. an SK-Hynix memory story → SNDK+MU+WDC),
  // so big industry news that names none of our companies still surfaces.
  return [...all, ...broadenByTheme(all, wl)];
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

  const all = [...mx, ...sd, ...av, ...tg, ...fg, ...perTicker]
    .filter(a => a.headline && a.ts >= cutoff);
  return [...all, ...broadenByTheme(all, wl)];
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

  // ── Accumulate every ticker seen per URL / per headline-sig BEFORE dedup ──
  // Step 0b drops same-URL duplicates (keeping one feed), which would otherwise
  // erase the multi-ticker attribution that theme broadening + general news
  // create. We stash the full ticker set per URL and per headline so the final
  // event can reclaim ALL affected tickers (so a memory story surfaces as
  // SNDK+MU+WDC, not just whichever copy survived dedup).
  const urlTix = new Map(), sigTix = new Map();
  const themedKeys = new Set();   // url/sig keys that came from a theme match
  for (const a of pass1){
    const uk = a.url && !a.url.includes('finnhub.io/api/news') ? stripUrl(a.url) : '';
    const sg = normKey(a.headline).slice(0,60);
    if (uk){ if(!urlTix.has(uk)) urlTix.set(uk,new Set()); urlTix.get(uk).add(a.ticker); if(a.theme) themedKeys.add('u:'+uk); }
    if (sg && sg.length>=8){ if(!sigTix.has(sg)) sigTix.set(sg,new Set()); sigTix.get(sg).add(a.ticker); if(a.theme) themedKeys.add('s:'+sg); }
  }

  // ── Step 0b: cross-ticker dedupe by URL + headline ────────────────────────
  // Precedence: mx/sd/av (relevance-scored) > tt (allowlist filtered) > fh
  pass1.sort((a,b) => {
    const p = {ec:0, mx:0, sd:0, av:0, tg:1, pg:1, tt:2, fh:3, fg:4};
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
    // Reclaim every ticker this event's URLs/headlines were attributed to
    // pre-dedup, and flag the event as themed if any contributing copy was a
    // theme (sector) match.
    const tix = new Set(ev.tickers);
    let themed = false;
    for (const a of ev.articles){
      const uk = a.url && !a.url.includes('finnhub.io/api/news') ? stripUrl(a.url) : '';
      const sg = normKey(a.headline).slice(0,60);
      if (uk && urlTix.has(uk)){ urlTix.get(uk).forEach(t=>tix.add(t)); if(themedKeys.has('u:'+uk)) themed=true; }
      if (sg && sigTix.has(sg)){ sigTix.get(sg).forEach(t=>tix.add(t)); if(themedKeys.has('s:'+sg)) themed=true; }
    }
    return {
      id: 'evt_' + idx,
      candidateTickers: [...tix],
      themed,
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
3. INDUSTRY / SUPPLY-CHAIN / COMPETITOR / COMMODITY / MACRO news counts as RELEVANT even when it names NONE of the watchlist companies. A rival's capex cut, a supply glut or shortage, a commodity price swing, an export control, or a sector-wide pricing move directly drives our names — assign it to the affected watchlist ticker(s) in candidateTickers, do NOT mark it NONE. Example: "SK Hynix slows memory expansion" / "Korea memory output cut" → assign MU/SNDK/WDC, it is the REASON those stocks moved.
4. When candidateTickers is non-empty, primaryTicker MUST be one of them unless the story has truly zero connection to any. Only use "NONE" for genuine off-watchlist noise.
5. Analyst upgrades/downgrades, price target changes, earnings previews, product news — ALL keep their ticker even if minor.
6. Be INCLUSIVE — minor relevant article (impactScore 10-20) is better than dropping it.
7. SCORE BY REAL MARKET IMPACT, not by whether the company is named. A sector-wide supply/pricing/policy shift that is actively moving the stock is major-to-critical (impactScore 70-95), even if our company is not in the headline. Do not under-score industry news just because it is indirect.

SUMMARY FORMAT — 2-3 concise sentences, trader-focused:
(1) What happened — key numbers, price targets, % moves, dollar amounts.
(2) Why it matters + near-term price direction (e.g. "+2-5% pop", "modest pressure", "neutral until earnings").

Return a JSON array. Each element MUST have: id, summary, sentiment ("bull"|"neutral"|"bear"), sentimentScore, impactScore, eventType, primaryTicker, additionalTickers, sectors, relevanceConfidence.

CRITICAL: Return EXACTLY one object for EVERY event id below — never skip or omit any. If an event is irrelevant, still include it with primaryTicker "NONE". The array length MUST equal the number of events provided.

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

Analyze each news event below. INDUSTRY / SUPPLY-CHAIN / COMPETITOR / COMMODITY / MACRO news is RELEVANT even when it names none of the watchlist companies — a rival's capex cut, a supply glut/shortage, a commodity move, or an export control drives our names directly. If candidateTickers (TICKERS) is non-empty, primaryTicker MUST be one of them unless there is zero connection; only use "NONE" for true off-watchlist noise. Score by REAL market impact: a sector-wide shift actively moving the stock is major-to-critical (70-95) even if indirect. For EACH event output one JSON object with EXACTLY these fields:
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

CRITICAL: You MUST return EXACTLY ${events.length} objects — one for every EVENT_ID listed below, in the same order. Do not skip, merge, or omit any event. If an event seems irrelevant, still include it with primaryTicker "NONE". The array length MUST equal ${events.length}.

EVENTS:
${lines}`;
}

// Build the Gemini request body. v1beta REST needs camelCase keys.
// 2.5 models are *thinking* models — without thinkingBudget:0 they burn the
// output-token budget on reasoning and return MAX_TOKENS with empty content.
// ── Calendar config ─────────────────────────────────────────────────────────
const CAL_TTL        = 12 * 3600;   // 12h cache — macro/earnings calendar barely moves
const CAL_LOCK_TTL   = 120;         // build-lock auto-expiry
const CAL_DAYS_MAX   = 31;          // clamp the lookahead window (front-end asks for 30)
const CAL_MACRO_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash']; // grounded-search capable, newest first

// Only these macro releases are accepted (whitelist kills hallucinated junk).
// [regex, category]. First match wins.
const MACRO_WHITELIST = [
  [/\bcpi\b|consumer price/i,                         'inflation'],
  [/\bppi\b|producer price/i,                         'inflation'],
  [/\bpce\b|personal consumption/i,                   'inflation'],
  [/\bfomc\b|fed(eral)? (reserve|funds)|rate decision|powell|interest rate decision|fomc minutes/i, 'fed'],
  [/nonfarm|non-farm|\bnfp\b|jobs report|payroll|unemployment rate/i, 'jobs'],
  [/\bjolts\b|job openings|labor turnover/i,           'jobs'],
  [/\badp\b|adp (national )?employment/i,              'jobs'],
  [/jobless claims|initial claims|continuing claims/i, 'jobs'],
  [/\bgdp\b|gross domestic/i,                          'growth'],
  [/retail sales/i,                                    'growth'],
  [/\bism\b|\bpmi\b|manufacturing index|services index|chicago business barometer/i, 'growth'],
  [/durable goods/i,                                   'growth'],
  [/consumer confidence|conference board/i,            'sentiment'],
  [/michigan|consumer sentiment/i,                     'sentiment'],
  [/housing starts|building permits|existing home|new home sales|home sales/i, 'housing'],
  [/trade balance|trade deficit|international trade/i, 'trade'],
];
function macroCategory(name){
  for (const [re, cat] of MACRO_WHITELIST) if (re.test(name)) return cat;
  return null; // not whitelisted → reject
}

// Market-impact tier for a macro release, by standard consensus (Forex Factory /
// Investing.com-style). high = can move indices; medium = watched; low = minor.
// Order matters: FOMC Minutes (medium) must be tested before FOMC decision (high).
function macroImportance(name){
  const n = name || '';
  if (/fomc minutes/i.test(n)) return 'medium';
  if (/\bcpi\b|consumer price|nonfarm|non-farm|\bnfp\b|jobs report|\bfomc\b|rate decision|powell|\bpce\b|personal consumption|\bgdp\b|gross domestic/i.test(n)) return 'high';
  if (/\bppi\b|producer price|retail sales|\bjolts\b|job openings|\bism\b|\badp\b|jobless claims|initial claims|consumer confidence/i.test(n)) return 'medium';
  return 'low'; // michigan, chicago pmi, durable goods, housing, home sales, trade
}

// ── AUTHORITATIVE macro release calendar ─────────────────────────────────────
// Hardcoded from OFFICIAL published schedules (BLS, BEA, Federal Reserve) so
// dates are CONCRETE and correct — never AI-guessed. This is the source of truth;
// grounded Gemini is only a supplement for anything not covered here.
// Sources:
//   CPI/PPI/Jobs → bls.gov/schedule  •  PCE/GDP → bea.gov + PFEI 2026 schedule
//   FOMC → federalreserve.gov  (decision day = 2nd day of each meeting)
// Each entry: 'YYYY-MM-DD': releases that day. `m` = reference-month label helper.
// NOTE: maintained for 2026; update when the agencies publish 2027.
const MACRO_RELEASES_2026 = {
  // Employment Situation / Jobs report (NFP) — BLS
  jobs: ['2026-01-09','2026-02-11','2026-03-06','2026-04-03','2026-05-08','2026-06-05','2026-07-02','2026-08-07','2026-09-04','2026-10-02','2026-11-06','2026-12-04'],
  // CPI — BLS
  cpi:  ['2026-01-13','2026-02-13','2026-03-11','2026-04-10','2026-05-12','2026-06-10','2026-07-14','2026-08-12','2026-09-11','2026-10-14','2026-11-10','2026-12-10'],
  // PPI — BLS (typically day after CPI; verified pattern)
  ppi:  ['2026-01-15','2026-02-19','2026-03-12','2026-04-14','2026-05-14','2026-06-11','2026-07-16','2026-08-13','2026-09-15','2026-10-15','2026-11-13','2026-12-11'],
  // Personal Income & Outlays = PCE — BEA (PFEI 2026)
  pce:  ['2026-01-29','2026-02-26','2026-03-27','2026-04-30','2026-05-28','2026-06-25','2026-07-30','2026-08-26','2026-09-30','2026-10-29','2026-11-25','2026-12-23'],
  // GDP — BEA (advance/2nd/3rd estimates, PFEI 2026)
  gdp:  ['2026-01-29','2026-02-26','2026-03-27','2026-04-30','2026-05-28','2026-06-25','2026-07-30','2026-08-26','2026-09-30','2026-10-29','2026-11-25','2026-12-23'],
  // Retail Sales — Census (mid-month, ~15th-17th)
  retail: ['2026-01-16','2026-02-17','2026-03-16','2026-04-15','2026-05-15','2026-06-16','2026-07-16','2026-08-14','2026-09-16','2026-10-16','2026-11-17','2026-12-15'],
  // FOMC rate decision (2nd day of meeting) — Federal Reserve
  fomc: ['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09'],
  // JOLTS (Job Openings & Labor Turnover) — BLS. Released ~10am ET, reports the
  // month from ~2 months prior. 2026 schedule is irregular (shutdown-shifted in
  // H1); forward dates confirmed via BLS/TradingCalendar. Past months left sparse
  // since only the forward 30-day window is ever surfaced.
  jolts: ['2026-02-03','2026-05-05','2026-06-02','2026-06-30','2026-08-04','2026-09-01','2026-09-29','2026-11-03','2026-12-01'],
};
const MON_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// Set of years we have hardcoded (auto-derived from the table above, so adding a
// new year's dates anywhere in MACRO_RELEASES_2026 automatically marks that year
// as "trusted" — no other code to touch). Years NOT in this set fall back to AI.
const HARDCODED_YEARS = new Set(
  Object.values(MACRO_RELEASES_2026).flat().map(d => String(d).slice(0,4))
);
// Reference month label: most reports cover the PRIOR month; GDP covers a quarter.
function prevMonthLabel(dateStr){
  const m = parseInt(dateStr.slice(5,7),10) - 1; // 0-based this month
  const pm = (m + 11) % 12; // previous month
  return MON_NAMES[pm];
}
function gdpQuarterLabel(dateStr){
  // BEA releases a given quarter's estimates over the following ~3 months.
  const m = parseInt(dateStr.slice(5,7),10); const y = parseInt(dateStr.slice(0,4),10);
  if (m>=1 && m<=3)  return `Q4 ${y-1}`;
  if (m>=4 && m<=6)  return `Q1 ${y}`;
  if (m>=7 && m<=9)  return `Q2 ${y}`;
  return `Q3 ${y}`;
}
// ── Date helpers for rule-based (computed) releases ──────────────────────────
// UTC-safe (worker runs UTC; all calendar dates are bare YYYY-MM-DD ET dates).
function addDaysIso(iso, n){ const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); }
function isoDow(iso){ return new Date(iso + 'T00:00:00Z').getUTCDay(); } // 0=Sun … 6=Sat

// Federal holidays (BLS/Census/Conference Board are closed these days, which is
// what shifts business-day-anchored releases — NOT the NYSE calendar, which
// differs on Columbus/Veterans Day & Good Friday). Reuses the nth-weekday and
// Sat→Fri / Sun→Mon observance helpers defined for the market-holiday block.
const _fedHolCache = {};
function fedHolidaySet(Y){
  if (_fedHolCache[Y]) return _fedHolCache[Y];
  const s = new Set();
  const ny = mktObserve(Y,1,1,false); if (ny) s.add(ny);          // New Year's Day
  s.add(mktIso(Y,1,  mktNthDow(Y,1,1,3)));                         // MLK — 3rd Mon Jan
  s.add(mktIso(Y,2,  mktNthDow(Y,2,1,3)));                         // Washington — 3rd Mon Feb
  s.add(mktIso(Y,5,  mktLastDow(Y,5,1)));                          // Memorial — last Mon May
  s.add(mktObserve(Y,6,19,false));                                // Juneteenth
  s.add(mktObserve(Y,7,4,false));                                 // Independence Day
  s.add(mktIso(Y,9,  mktNthDow(Y,9,1,1)));                         // Labor — 1st Mon Sep
  s.add(mktIso(Y,10, mktNthDow(Y,10,1,2)));                        // Columbus — 2nd Mon Oct
  s.add(mktObserve(Y,11,11,false));                               // Veterans Day
  s.add(mktIso(Y,11, mktNthDow(Y,11,4,4)));                        // Thanksgiving — 4th Thu Nov
  s.add(mktObserve(Y,12,25,false));                               // Christmas Day
  return (_fedHolCache[Y] = s);
}
function isFedBiz(Y,M,d,hol){ const w = mktDow(Y,M,d); return w>=1 && w<=5 && !hol.has(mktIso(Y,M,d)); }
function nthBusinessDay(Y,M,n){ const hol = fedHolidaySet(Y); const dim = new Date(Date.UTC(Y,M,0)).getUTCDate(); let c=0; for (let d=1; d<=dim; d++){ if (isFedBiz(Y,M,d,hol) && ++c===n) return mktIso(Y,M,d); } return null; }
function lastBusinessDay(Y,M){ const hol = fedHolidaySet(Y); const dim = new Date(Date.UTC(Y,M,0)).getUTCDate(); for (let d=dim; d>=1; d--){ if (isFedBiz(Y,M,d,hol)) return mktIso(Y,M,d); } return null; }

// Rule-based macro releases that follow a fixed scheduling rule (so they're exact
// by construction — no hand-maintained date table needed). Only emitted for years
// we treat as hardcoded (matches the CPI/jobs table); 2027+ falls back to grounded
// Gemini + the "hardcode next year" banner, same as the rest of the calendar.
function computedMacro(fromD, toD){
  const out = [];
  const inWin = d => d && d >= fromD && d <= toD;
  const add = (date, name, category) => { if (inWin(date)) out.push({ kind:'macro', ticker:null, name, date, category }); };
  const y0 = +fromD.slice(0,4), y1 = +toD.slice(0,4);
  for (let Y=y0; Y<=y1; Y++){
    if (!HARDCODED_YEARS.has(String(Y))) continue;
    const m0 = (Y===y0) ? +fromD.slice(5,7) : 1;
    const m1 = (Y===y1) ? +toD.slice(5,7)   : 12;
    for (let M=m0; M<=m1; M++){
      const lbl = MON_NAMES[M-1];
      const prevLbl = MON_NAMES[(M+10)%12];
      add(nthBusinessDay(Y,M,1), `${prevLbl} ISM Manufacturing PMI`, 'growth');  // 1st business day
      add(nthBusinessDay(Y,M,3), `${prevLbl} ISM Services PMI`,      'growth');  // 3rd business day
      add(mktIso(Y,M,mktLastDow(Y,M,2)), `${lbl} Consumer Confidence`, 'sentiment'); // last Tue
      add(mktIso(Y,M,mktNthDow(Y,M,5,2)), `${lbl} Michigan Sentiment (Prelim)`, 'sentiment'); // 2nd Fri
      add(mktIso(Y,M,mktLastDow(Y,M,5)),  `${lbl} Michigan Sentiment (Final)`,  'sentiment'); // last Fri
      add(lastBusinessDay(Y,M), `${lbl} Chicago PMI`, 'growth'); // last business day
    }
  }
  // ADP National Employment — the Wednesday immediately preceding each NFP
  // (usually 2 days before a Friday NFP; 1 day before in holiday-shifted weeks).
  for (const d of MACRO_RELEASES_2026.jobs){ let adp = addDaysIso(d, -1); while (isoDow(adp) !== 3) adp = addDaysIso(adp, -1); add(adp, `${prevMonthLabel(d)} ADP Employment`, 'jobs'); }
  // FOMC Minutes — released exactly 3 weeks after each rate decision (a Wednesday).
  for (const d of MACRO_RELEASES_2026.fomc){ add(addDaysIso(d, 21), 'FOMC Minutes', 'fed'); }
  // Initial Jobless Claims — every Thursday in the window.
  for (let d = fromD; d <= toD; d = addDaysIso(d, 1)){ if (isoDow(d)===4) add(d, 'Initial Jobless Claims', 'jobs'); }
  return out;
}

// Build authoritative events that fall within [fromD, toD].
function authoritativeMacro(fromD, toD){
  const out = [];
  const inWin = d => d >= fromD && d <= toD;
  const add = (date, name, category) => { if (inWin(date)) out.push({ kind:'macro', ticker:null, name, date, category }); };
  for (const d of MACRO_RELEASES_2026.jobs)   add(d, `${prevMonthLabel(d)} Jobs Report (NFP)`, 'jobs');
  for (const d of MACRO_RELEASES_2026.cpi)    add(d, `${prevMonthLabel(d)} CPI Report`, 'inflation');
  for (const d of MACRO_RELEASES_2026.ppi)    add(d, `${prevMonthLabel(d)} PPI Report`, 'inflation');
  for (const d of MACRO_RELEASES_2026.pce)    add(d, `${prevMonthLabel(d)} PCE Report`, 'inflation');
  for (const d of MACRO_RELEASES_2026.gdp)    add(d, `${gdpQuarterLabel(d)} GDP`, 'growth');
  for (const d of MACRO_RELEASES_2026.retail) add(d, `${prevMonthLabel(d)} Retail Sales`, 'growth');
  for (const d of MACRO_RELEASES_2026.fomc)   add(d, 'FOMC Rate Decision', 'fed');
  // JOLTS — released ~5-6 weeks after its reference month; label that month.
  for (const d of MACRO_RELEASES_2026.jolts)  add(d, `${MON_NAMES[+addDaysIso(d,-38).slice(5,7)-1]} JOLTS Job Openings`, 'jobs');
  // Rule-based releases (ISM, Consumer Confidence, Michigan, Chicago PMI, ADP,
  // FOMC Minutes, jobless claims) — computed, exact by construction.
  out.push(...computedMacro(fromD, toD));
  return out;
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

// ── Earnings cross-check via AlphaVantage EARNINGS_CALENDAR ───────────────────
// Second independent source. Returns a bulk CSV of expected report dates for the
// next ~3 months; we filter to the watchlist + window. Used to CONFIRM Finnhub
// dates (both sources agree → confirmed) and to fill tickers Finnhub misses.
// Free tier is ~25 req/day — fine since /calendar is cached 12h.
async function fetchEarningsAlphaVantage(wl, env, fromD, toD, diag){
  if (!env.ALPHAVANTAGE_KEY){ diag&&diag.push('av-earn: NO KEY'); return []; }
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${env.ALPHAVANTAGE_KEY}`);
    if (!r.ok){ diag&&diag.push('av-earn: HTTP '+r.status); return []; }
    const csv = await r.text();
    // Rate-limit / info responses come back as JSON, not CSV.
    if (csv.trimStart().startsWith('{')){ diag&&diag.push('av-earn: non-csv (rate/info)'); return []; }
    const set = new Set(wl);
    const out = [];
    const lines = csv.split('\n');
    for (let i = 1; i < lines.length; i++){       // skip header row
      const line = lines[i];
      const c = line.indexOf(',');
      if (c < 0) continue;
      const sym = line.slice(0, c).trim().toUpperCase();
      if (!set.has(sym)) continue;
      // First YYYY-MM-DD on the line is reportDate (name field may contain commas).
      const m = line.match(/\d{4}-\d{2}-\d{2}/);
      const date = m ? m[0] : null;
      if (!date || date < fromD || date > toD) continue;
      out.push({ ticker: sym, date });
    }
    diag&&diag.push('av-earn: '+out.length+' in-window matches');
    return out;
  } catch(e){ diag&&diag.push('av-earn: EXC '+e.message); return []; }
}

// ── Macro via grounded Gemini (Google Search) ────────────────────────────────
// Grounding can't be combined with responseSchema, so we ask for a JSON array in
// the text and parse + salvage it, then hard-filter against the whitelist+window.
async function fetchMacroCalendar(env, fromD, toD, diag){
  const prompt =
`You are a financial calendar API. Using Google Search, list scheduled US macroeconomic data releases and Federal Reserve events between ${fromD} and ${toD} (inclusive), US Eastern dates.

Include ONLY these release types if they fall in the window: CPI, PPI, PCE, FOMC rate decision / Fed meeting, FOMC Minutes, Nonfarm Payrolls (jobs report), ADP Employment, JOLTS Job Openings, weekly Initial Jobless Claims, GDP, Retail Sales, ISM/PMI, Durable Goods, Consumer Confidence, Michigan Consumer Sentiment, Housing Starts, Building Permits, Existing Home Sales, New Home Sales, Trade Balance.

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

// ── US market holidays (NYSE/Nasdaq) — COMPUTED, never needs updating ─────────
// Full closures + half-days (1 PM ET early close), derived from NYSE rules:
// nth-weekday-of-month, Easter computus for Good Friday, and Sat→Fri / Sun→Mon
// observance (New Year is NOT observed when it lands on a Saturday). Surfaced as
// calendar events so Catalysts + both TaskHubs show which days the market is
// closed and why. Mirror of the same logic in tradehub.html (market clock).
function mktDow(y,m,d){return new Date(Date.UTC(y,m-1,d)).getUTCDay();}
function mktNthDow(y,m,wd,n){let c=0;for(let d=1;d<=31;d++){if(mktDow(y,m,d)===wd&&++c===n)return d;}return null;}
function mktLastDow(y,m,wd){const dim=new Date(Date.UTC(y,m,0)).getUTCDate();for(let d=dim;d>=1;d--)if(mktDow(y,m,d)===wd)return d;}
function mktIso(y,m,d){return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
function mktEaster(Y){const a=Y%19,b=Math.floor(Y/100),c=Y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);return [Math.floor((h+l-7*m+114)/31),((h+l-7*m+114)%31)+1];}
function mktObserve(y,m,d,isNY){const w=mktDow(y,m,d);if(w===6)return isNY?null:mktIso(y,m,d-1);if(w===0)return mktIso(y,m,d+1);return mktIso(y,m,d);}
function mktComputeYear(Y){
  const H={},HD={};
  const ny=mktObserve(Y,1,1,true); if(ny)H[ny]="New Year's Day";
  H[mktIso(Y,1,mktNthDow(Y,1,1,3))]='MLK Jr. Day';
  H[mktIso(Y,2,mktNthDow(Y,2,1,3))]="Presidents' Day";
  const [em,ed]=mktEaster(Y); const gf=new Date(Date.UTC(Y,em-1,ed)); gf.setUTCDate(gf.getUTCDate()-2);
  H[mktIso(gf.getUTCFullYear(),gf.getUTCMonth()+1,gf.getUTCDate())]='Good Friday';
  H[mktIso(Y,5,mktLastDow(Y,5,1))]='Memorial Day';
  if(Y>=2022)H[mktObserve(Y,6,19,false)]='Juneteenth';
  H[mktObserve(Y,7,4,false)]='Independence Day';
  H[mktIso(Y,9,mktNthDow(Y,9,1,1))]='Labor Day';
  const tg=mktNthDow(Y,11,4,4); H[mktIso(Y,11,tg)]='Thanksgiving Day';
  const xm=mktObserve(Y,12,25,false); H[xm]='Christmas Day';
  HD[mktIso(Y,11,tg+1)]='Day after Thanksgiving';
  const j4=mktDow(Y,7,4); if(j4>=2&&j4<=5)HD[mktIso(Y,7,3)]='Independence Day Eve';
  const d24=mktDow(Y,12,24); if(d24>=1&&d24<=5&&xm!==mktIso(Y,12,24))HD[mktIso(Y,12,24)]='Christmas Eve';
  return {H,HD};
}
const _mktHolCache={};
function mktHolYear(Y){return _mktHolCache[Y]||(_mktHolCache[Y]=mktComputeYear(Y));}

// Holiday/half-day events within [fromD, toD] (inclusive). Computed across the
// years the window spans, so only the next ~30 days surface.
function marketHolidayEvents(fromD, toD, diag){
  const out = [];
  for (let Y = +fromD.slice(0,4); Y <= +toD.slice(0,4); Y++){
    const { H, HD } = mktHolYear(Y);
    for (const [date, name] of Object.entries(H)){
      if (date < fromD || date > toD) continue;
      out.push({ kind:'holiday', ticker:null, category:'holiday', date, name:`${name} — Market Closed` });
    }
    for (const [date, name] of Object.entries(HD)){
      if (date < fromD || date > toD) continue;
      out.push({ kind:'holiday', ticker:null, category:'holiday', date, name:`${name} — Early Close (1 PM ET)` });
    }
  }
  diag && diag.push('holidays: '+out.length+' in window');
  return out;
}

// Deterministic id so re-fetch overwrites (never dupes) downstream in Firestore.
function calEventId(ev){
  const t = ev.kind === 'earnings' ? `earnings_${ev.ticker}`
          : ev.kind === 'holiday'  ? 'holiday'
          : `macro_${ev.category}_${ev.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)}`;
  return `mc_${t}_${ev.date}`;
}

// Live watchlist resolver for CRON builds. The front-end pushes TB_WL (the
// Control-tab list) to POST /watchlist → stored at KV 'wl:current'. Cron reads
// it and replicates the /news + /calendar key logic EXACTLY, so the warmed
// cache lands on the same key the app will request. Falls back to WATCHLIST.
async function resolveCronWatchlist(env){
  let saved = null;
  try {
    const raw = await env.NEWSHUB_CACHE.get('wl:current');
    if (raw){ const j = JSON.parse(raw);
      if (Array.isArray(j) && j.length) saved = j;
      else if (Array.isArray(j?.tickers) && j.tickers.length) saved = j.tickers; }
  } catch(e){}
  const isCustom = !!saved && wlHash(saved) !== wlHash(WATCHLIST);
  const wl = isCustom ? saved : WATCHLIST;
  return {
    wl,
    sectors:  isCustom ? await sectorsForLive(wl, env) : SECTORS,
    cacheKey: isCustom ? 'events:v1:' + wlHash(wl) : 'events:v1',
    lockKey:  isCustom ? 'build:lock:' + wlHash(wl): 'build:lock',
  };
}

// Cron helper: build the Catalysts calendar and write it to the SAME cache key
// the /calendar endpoint reads, so the tab loads instantly on open (Wed/Sun).
// Uses the live TB_WL (wl:current) + days=30 — the front-end requests days=30,
// so the pre-warm key MUST use the same window or the warmed cache is never hit.
async function prewarmCalendar(env){
  const { wl } = await resolveCronWatchlist(env);
  const days   = 30;
  const calKey = `cal:v1:${wlHash(wl)}:${etDateStr(0)}:${days}`;
  const calLock= `cal:lock:${wlHash(wl)}`;
  await env.NEWSHUB_CACHE.put(calLock, '1', { expirationTtl: CAL_LOCK_TTL });
  try {
    const result = await buildCalendar(wl, env, days);
    if (result && result.events && result.events.length){
      await env.NEWSHUB_CACHE.put(calKey, JSON.stringify(result), { expirationTtl: CAL_TTL });
      // Push to Firebase so TaskHub weekly view updates without needing TradeHub open.
      // Writes to dashboards/market_calendar — same doc the TradeHub Catalysts tab writes.
      await pushMarketCalToFirebase(result).catch(e => console.warn('[cron] firebase push failed:', e.message));
    }
    return result;
  } finally {
    await env.NEWSHUB_CACHE.delete(calLock);
  }
}

// Firestore REST write — no SDK needed, just fetch().
// Public API key + project (same values embedded in the front-end).
const FB_PROJECT  = 'task-dashboard-d2b53';
const FB_API_KEY  = 'AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4';
const FB_DOC_PATH = 'dashboards/market_calendar';

function encodeFirestoreValue(v){
  if(v === null || v === undefined) return { nullValue: null };
  if(typeof v === 'boolean') return { booleanValue: v };
  if(typeof v === 'number' && Number.isInteger(v)) return { integerValue: String(v) };
  if(typeof v === 'number') return { doubleValue: v };
  if(typeof v === 'string') return { stringValue: v };
  if(Array.isArray(v)) return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  if(typeof v === 'object'){
    const fields = {};
    for(const [k,val] of Object.entries(v)){ if(val != null) fields[k] = encodeFirestoreValue(val); }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

async function pushMarketCalToFirebase(result){
  const now = Date.now();
  const events = result.events || [];
  const fields = {
    events:      encodeFirestoreValue(events),
    generatedAt: { integerValue: String(now) },
    savedAt:     { integerValue: String(now) },
  };
  const url = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/${FB_DOC_PATH}?key=${FB_API_KEY}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(12000),
  });
  if(!r.ok){ const t = await r.text().catch(()=>''); throw new Error(`Firestore ${r.status}: ${t.slice(0,120)}`); }
  console.log(`[cron] pushed ${events.length} calendar events to Firebase`);
}

async function buildCalendar(wl, env, days, diag){
  const fromD = etDateStr(0);
  const toD   = etDateStr(Math.min(days, CAL_DAYS_MAX));

  // 1) AUTHORITATIVE macro from hardcoded official schedules (CONCRETE dates).
  const authMacro = authoritativeMacro(fromD, toD);
  diag && diag.push('authoritative macro: ' + authMacro.length + ' events');

  // 2) Earnings (Finnhub, real) + Gemini macro (supplement only) + AlphaVantage
  //    earnings as an independent cross-check source.
  const [earn, aiMacro, avEarn] = await Promise.all([
    fetchEarningsCalendar(wl, env, fromD, toD, diag),
    fetchMacroCalendar(env, fromD, toD, diag),
    fetchEarningsAlphaVantage(wl, env, fromD, toD, diag),
  ]);

  // 2b) Cross-check earnings dates across the two sources. Both agreeing on the
  //     exact day = confirmed; single-source or conflicting dates = estimated
  //     (front-end shows an "EST" tag). AV-only tickers fill Finnhub's gaps.
  const avByTicker = new Map();
  for (const a of avEarn){ if(!avByTicker.has(a.ticker)) avByTicker.set(a.ticker, new Set()); avByTicker.get(a.ticker).add(a.date); }
  const finnTickers = new Set(earn.map(e => e.ticker));
  for (const e of earn){ const d = avByTicker.get(e.ticker); e.confirmed = !!(d && d.has(e.date)); }
  for (const a of avEarn){
    if (finnTickers.has(a.ticker)) continue;   // Finnhub already has this name
    earn.push({ kind:'earnings', ticker:a.ticker, name:`${a.ticker} Earnings`, date:a.date, category:'earnings', when:null, epsEst:null, confirmed:false });
  }
  diag && diag.push('earnings: '+earn.filter(e=>e.confirmed).length+' confirmed / '+earn.length+' total');

  // 3) Merge: authoritative wins. The hardcoded table only covers certain YEARS
  //    (see HARDCODED_YEARS). For those years, AI guesses of hardcoded release
  //    types are DROPPED (real date wins). For years we DON'T hardcode yet (e.g.
  //    2027+), we KEEP the AI's macro so the calendar still works automatically —
  //    but we flag those as approximate so they're visibly not-yet-verified.
  // Release types we provide authoritatively (hardcoded dates OR computed rules).
  // AI versions of these are dropped in hardcoded years so our exact ones win.
  // NOT listed (so AI's real-dated versions survive): durable goods, housing
  // starts/permits, home sales, trade balance — those have no fixed rule and
  // aren't hardcoded, so grounded Gemini supplies them.
  const HARDCODED_NAME = /\bcpi\b|\bppi\b|\bpce\b|personal consumption|\bgdp\b|gross domestic|nonfarm|non-farm|\bnfp\b|jobs report|\bfomc\b|rate decision|powell|retail sales|\bjolts\b|job openings|\badp\b|\bism\b|chicago pmi|chicago business|consumer confidence|consumer sentiment|michigan|jobless claims|initial claims/i;
  const authKey = new Set(authMacro.map(e => e.category + '|' + e.date));
  const extraMacro = [];
  for (const e of aiMacro){
    const yr = e.date.slice(0,4);
    const yearIsHardcoded = HARDCODED_YEARS.has(yr);
    // For a hardcoded year, drop AI's version of any release type we hardcode.
    if (yearIsHardcoded && HARDCODED_NAME.test(e.name)) continue;
    if (authKey.has(e.category + '|' + e.date)) continue; // already covered exactly
    // Flag AI-sourced events in non-hardcoded years as approximate.
    if (!yearIsHardcoded && HARDCODED_NAME.test(e.name)) {
      extraMacro.push({ ...e, approx: true, name: /\(approx\)/i.test(e.name) ? e.name : (e.name + ' (approx)') });
    } else {
      extraMacro.push(e); // durable goods / housing / home sales / trade — AI-sourced every year
    }
  }

  const macro = [...authMacro, ...extraMacro];
  // 4) Market holidays / half-days in-window — so Catalysts + both TaskHubs show
  //    which upcoming days the market is closed (and why).
  const holidays = marketHolidayEvents(fromD, toD, diag);
  const events = [...earn, ...macro, ...holidays]
    .map(ev => ({ ...ev, id: calEventId(ev), ...(ev.kind === 'macro' ? { importance: macroImportance(ev.name) } : {}) }))
    .sort((a,b) => a.date.localeCompare(b.date));
  return { events, generatedAt: Date.now(), from: fromD, to: toD, degraded: !earn.length && !events.length };
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
  // Keep thinking minimal so fast structured output isn't truncated. Gemini 3.x
  // uses thinkingLevel (can't fully disable → "low"); 2.5 uses thinkingBudget:0.
  if (model.startsWith('gemini-3')) gc.thinkingConfig = { thinkingLevel: 'low' };
  else if (model.startsWith('gemini-2.5')) gc.thinkingConfig = { thinkingBudget: 0 };
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
  // Validate PER-ELEMENT and keep the good ones. Previously we checked only
  // parsed[0] and nuked the ENTIRE batch if that single element was incomplete —
  // so one malformed first item dropped 6 good events to raw, causing the
  // intermittent "0 enriched → degraded" runs. Now a bad item is skipped while
  // the rest survive.
  const valid = parsed.filter(o => o && required.every(k => k in o));
  if (!valid.length){
    console.error(`${provider}/${model} no valid items (sample missing: [${parsed[0]?required.filter(k=>!(k in parsed[0])).join(','):'empty'}])`);
    return null;
  }
  valid.__model = (provider === 'nim' ? 'nim:' : '') + model;
  return valid;
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
  // SEC 8-K filings are material by definition — make sure they survive selection
  // even when phrased without catalyst keywords. Earnings/M&A/exec/restatement
  // items get a bigger bump than routine disclosures.
  if ((ev.sources||[]).some(s => s.feed === 'ec')){
    const ehl = (ev.sources||[]).find(s=>s.feed==='ec')?.headline || hl;
    s += /Earnings|Acquisition|Director|Bankruptcy|Restatement|Control|Delisting|Cybersecurity|Material Definitive/i.test(ehl) ? 35 : 18;
  }
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
  const tickerOf = e => e.candidateTickers?.[0] || '?';

  // Pass 1 — GUARANTEE COVERAGE: take the single highest-importance event for
  // EACH ticker first, so every watchlist name that has news appears in the feed.
  // Without this, on a big list (e.g. 29 tickers) the ~10 hottest megacaps fill
  // all `max` slots in importance order and freshly-added / quieter tickers
  // (COF, FCX, MMM, SMH, VMC…) get nothing. This is the fix for "force-fresh
  // didn't pick up the new tickers."
  for (const { e } of scored){
    const t = tickerOf(e);
    if (t === '?' || perT[t]) continue;     // already have this ticker's best
    perT[t] = 1; out.push(e); used.add(e.id);
    if (out.length >= max) return out;
  }
  // Pass 2 — fill remaining slots by importance, up to perTickerCap per ticker.
  for (const { e } of scored){
    if (used.has(e.id)) continue;
    const t = tickerOf(e);
    if ((perT[t] || 0) >= perTickerCap) continue;
    perT[t] = (perT[t] || 0) + 1; out.push(e); used.add(e.id);
    if (out.length >= max) return out;
  }
  // Pass 3 — top off the budget with anything left (cap relaxed).
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
    // ── First pass: send EVERY batch to the STRONGEST available model. ──
    // The old design round-robined batches across the WHOLE chain
    // (avail[i % avail.length]), so 4 of every 5 batches landed on weak fallback
    // models (flash-lite / 2.0-flash / 1.5-flash / 8B-NIM) that truncate or
    // mis-id the 8-event JSON → only the one batch that hit the strong primary
    // came back complete, leaving ~8/40 events analyzed and the rest stuck as RAW.
    // The strong primary returns all 8 verdicts per batch reliably (~7s each), and
    // a handful of parallel calls stay under its RPM, so first-pass coverage jumps
    // to ~full. Weak models are now reserved for the salvage passes below, applied
    // only to batches the primary actually dropped.
    const primary = avail[0];
    const jobs = batches.map((b, i) => ({ b, i }));
    const ran = await mapLimit(
      jobs, AI_CONCURRENCY,
      j => callModel(primary, j.b, env, ctx, wl, sectors).catch(() => null)
    );
    ran.forEach((out, k) => { if (out){ outputs[jobs[k].i] = out; } });

    // ── Salvage pass: retry any dropped batches on the FALLBACK models.
    // Cycle through the rest of the chain (avail[round], avail[round+1]…) so a
    // batch the primary dropped (503/RPM blip) still gets a different model.
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

    // ── Omission-retry pass ──────────────────────────────────────────────────
    // Models routinely return a verdict for only SOME events in a batch and
    // silently omit the rest, leaving real news stuck as RAW even though the batch
    // "succeeded". Collect every event that has no verdict yet, re-batch them, and
    // re-run on a fresh model. ONE round, and we skip events already resolved
    // (enriched OR returned as NONE) so we don't burn the budget re-asking noise.
    if (aiBudgetLeft() && aiCallBudgetLeft()){
      const haveVerdict = new Set();
      for (const bi of Object.keys(outputs)){
        const out = outputs[bi]; if (!out) continue;
        for (const o of out) haveVerdict.add(o.id); // NONE verdicts count → not re-asked
      }
      const missing = events.filter(ev => !haveVerdict.has(ev.id));
      if (missing.length){
        const retryBatches = [];
        for (let i=0;i<missing.length;i+=BATCH_SIZE) retryBatches.push(missing.slice(i,i+BATCH_SIZE));
        const model = avail[2 % avail.length];
        const retried = await mapLimit(retryBatches, AI_CONCURRENCY,
          b => callModel(model, b, env, ctx, wl, sectors).catch(()=>null));
        retryBatches.forEach((b, k) => {
          const idx = batches.length;
          batches.push(b);
          if (retried[k] && retried[k].length) outputs[idx] = retried[k];
        });
      }
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
      if (!ai.primaryTicker || ai.primaryTicker === 'NONE'){
        // Safety net: a THEME-matched (sector/supply-chain) event the AI mislabels
        // as NONE is exactly the big industry news we must not drop. Reclaim it
        // with its first valid watchlist candidate and a real impact floor.
        const themedCand = ev.themed ? (ev.candidateTickers||[]).find(t=>wlSet.has(t)) : null;
        if (!themedCand){
          aiRejectedIds.add(ev.id); // genuine off-watchlist noise → drop
          continue;
        }
        const floor = Math.max(ai.impactScore || 0, 60);
        enriched.push({
          id: ev.id,
          primaryTicker: themedCand,
          additionalTickers: (ev.candidateTickers||[]).filter(t=>wlSet.has(t) && t!==themedCand),
          sectors: (ai.sectors||[]).filter(Boolean),
          eventType: ai.eventType || 'macro',
          summary: ai.summary || (ev.sources?.[0]?.headline || ''),
          sentiment: { label: ai.sentiment || 'neutral', score: ai.sentimentScore || 0 },
          impact: { score: floor, tier: impactTier(floor) },
          relevanceConfidence: ai.relevanceConfidence ?? 0.6,
          ts: ev.ts,
          sources: ev.sources.map(s => ({ name:s.name, url:s.url, headline:s.headline, feed:s.feed, ts:s.ts })),
          sourceCount: ev.sourceCount,
          aiAnalyzed: true,
        });
        continue;
      }
      // Use the AI's ticker if it's a watchlist ticker the article actually
      // mentioned. If the AI picked a ticker NOT in this event's candidates (a
      // hallucination — e.g. tagging a Lucid story as TSLA), fall back to the
      // article's own primary candidate so the analysis attaches to the RIGHT
      // stock instead of a made-up one.
      const candList = ev.candidateTickers || [];
      let primaryTicker = ai.primaryTicker;
      if (!candList.includes(primaryTicker)){
        const realCand = candList.find(t => wlSet.has(t));
        if (!realCand){ aiRejectedIds.add(ev.id); continue; } // nothing valid → drop
        primaryTicker = realCand;
      }
      if (!wlSet.has(primaryTicker)){ aiRejectedIds.add(ev.id); continue; }
      enriched.push({
        id: ev.id,
        primaryTicker: primaryTicker,
        additionalTickers: (ai.additionalTickers||[]).filter(t=>wlSet.has(t) && t!==primaryTicker),
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
  // Degraded means the AI phase genuinely failed to run (all models blocked /
  // timed out → nothing analyzed). If even a handful of events got real AI
  // verdicts, the pipeline worked — the rest being raw is just the low-signal
  // tail or AI-rejected noise, NOT a degraded build. Banner only shows when the
  // AI produced essentially nothing.
  const aiCount = enriched.filter(e=>e.aiAnalyzed).length;
  const degraded = aiCount < 3;
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
    // First pass on the STRONGEST model (see runPipeline note): round-robin onto
    // weak fallbacks left most events RAW; the strong primary returns full batches.
    const primary = avail[0];
    const jobs = batches.map((b, i) => ({ b, i }));
    const ran = await mapLimit(jobs, AI_CONCURRENCY,
      j => callModel(primary, j.b, env, ctx, wl, sectors).catch(() => null));
    ran.forEach((out, k) => { if (out){ outputs[jobs[k].i] = out; } });
    // One salvage round on a fallback model for dropped batches.
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
  // Each stage is a fresh invocation, so the derived alias/theme overlays start
  // empty — re-hydrate from KV so isRelevant() and broadenByTheme() see AI-derived
  // aliases + industry keywords during this slice's fetch.
  await hydrateMeta(wl, env);
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
    // Fires once daily at 12:00 UTC (= builds begin 06:00 MDT / 05:00 MST Mountain).
    // Branch on the DAY OF WEEK, not the exact cron string. Robust to any future
    // cron-time change (DST shift, 6:30→6:00, etc.): whatever UTC time fires, the
    // day decides what builds.
    //   Mon-Fri (1-5) → News pre-warm
    //   Sun (0) + Wed (3) → Catalysts pre-warm
    //   Wednesday → BOTH (weekday AND catalyst day)
    const day = new Date().getUTCDay();              // 0=Sun … 6=Sat
    const isWeekday     = day >= 1 && day <= 5;
    const isCatalystDay = day === 0 || day === 3;

    // Skip the Mon-Fri News pre-warm on full-closure market holidays (e.g. Labor
    // Day) — there's no trading session to refresh for. Uses the built-in computed
    // NYSE calendar (mktHolYear.H = full closures), keyed by the current ET date.
    // Catalysts (Sun/Wed) is intentionally NOT gated: it's a forward-looking
    // calendar and should still surface the holiday itself.
    const etDate     = etDateStr(0);                 // 'YYYY-MM-DD' in US Eastern
    const isHoliday  = !!mktHolYear(+etDate.slice(0,4)).H[etDate];

    // ── Catalysts pre-warm (Sun + Wed) → KV + Firebase push for TaskHub ──
    if (isCatalystDay){
      ctx.waitUntil(prewarmCalendar(env).catch(e => console.error('Cron calendar failed:', e.message)));
    }

    // ── News pre-warm (Mon-Fri, skipping market holidays) — RICH build for TB_WL ──
    if (isWeekday && !isHoliday){
      const richKey = 'cron:rich:' + new Date().toISOString().slice(0,13);
      const already = await env.NEWSHUB_CACHE.get(richKey).catch(()=>null);
      const useLimited = !already;                 // first tick of the hour → rich
      if (!already) ctx.waitUntil(env.NEWSHUB_CACHE.put(richKey, '1', { expirationTtl: 7200 }));
      const { wl, sectors, cacheKey, lockKey } = await resolveCronWatchlist(env);
      ctx.waitUntil(buildAndCache(env, ctx, useLimited, wl, sectors, cacheKey, lockKey).catch(e => console.error('Cron news failed:', e.message)));
    }
  },

  async fetch(req, env, ctx){
    if (req.method === 'OPTIONS')
      return new Response(null, { headers: cors() });

    const url = new URL(req.url);

    // ── /watchlist (POST) — front-end pushes TB_WL (Control-tab list) so cron +
    // builds use the exact same list the app requests. Stored at KV 'wl:current'.
    if (url.pathname === '/watchlist'){
      if (req.method === 'POST'){
        let tickers = [];
        try { const b = await req.json(); tickers = Array.isArray(b.tickers) ? b.tickers : []; } catch(e){}
        tickers = tickers.map(t => String(t||'').trim().toUpperCase()).filter(Boolean).slice(0, 80);
        if (!tickers.length)
          return new Response(JSON.stringify({ ok:false, error:'no tickers' }), { status:400, headers:{ ...cors(), 'Content-Type':'application/json' } });
        await env.NEWSHUB_CACHE.put('wl:current', JSON.stringify(tickers));
        // Warm sector/alias classification for any non-static tickers in the
        // background so the next cron/news build already has them cached.
        const unknown = tickers.filter(t => !SECTOR_LOOKUP[t]);
        if (unknown.length) ctx.waitUntil(resolveMeta(unknown, env).catch(()=>{}));
        return new Response(JSON.stringify({ ok:true, count:tickers.length }), { headers:{ ...cors(), 'Content-Type':'application/json' } });
      }
      const cur = await resolveCronWatchlist(env);
      return new Response(JSON.stringify({ ok:true, tickers:cur.wl, count:cur.wl.length }), { headers:{ ...cors(), 'Content-Type':'application/json' } });
    }

    // ── /sectors?tickers=A,B,C — AI sector auto-derivation for the Control tab.
    // For each ticker: static table → KV cache → Gemini classify (then cache).
    // Returns { sectors:{TICKER:label}, meta:{TICKER:{name,aliases}} }. This is
    // what lets a newly-added ticker show its real sector everywhere instead of
    // "Diversified", with zero hardcoding.
    if (url.pathname === '/sectors'){
      const tk = parseTickers(url.searchParams.get('tickers'));
      if (!tk || !tk.length)
        return new Response(JSON.stringify({ ok:false, error:'no tickers' }), { status:400, headers:{ ...cors(), 'Content-Type':'application/json' } });
      const meta = await resolveMeta(tk, env);
      const sectors = {};
      for (const [t, m] of Object.entries(meta)) sectors[t] = m.sector;
      return new Response(JSON.stringify({ ok:true, sectors, meta }), { headers:{ ...cors(), 'Content-Type':'application/json' } });
    }

    // ── /quotes?tickers=A,B,C — real-time Finnhub quotes for the watchlist,
    // KV-cached ~60s. Powers the Top Movers strip + per-card % change (price-move
    // correlation). Cheap: Finnhub quotes are 60/min, effectively unlimited daily.
    // ?fresh=1 bypasses the cache. Returns { quotes:{T:{c,d,dp,h,l,o,pc}}, asOf }.
    if (url.pathname === '/quotes'){
      const tk = parseTickers(url.searchParams.get('tickers')) || WATCHLIST;
      const ckey = 'quotes:' + wlHash(tk);
      if (url.searchParams.get('fresh') !== '1'){
        try {
          const c = await env.NEWSHUB_CACHE.get(ckey, 'json');
          if (c && c.quotes) return new Response(JSON.stringify({ ok:true, ...c, cached:true }), { headers:{ ...cors(), 'Content-Type':'application/json' } });
        } catch(e){}
      }
      const quotes = await fetchQuotes(tk, env);
      const payload = { quotes, asOf: Date.now() };
      ctx.waitUntil(env.NEWSHUB_CACHE.put(ckey, JSON.stringify(payload), { expirationTtl: 60 }).catch(()=>{}));
      return new Response(JSON.stringify({ ok:true, ...payload }), { headers:{ ...cors(), 'Content-Type':'application/json' } });
    }

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
        const sc = isCustomT ? await sectorsForLive(tw, env) : SECTORS;
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
    const sectors  = isCustom ? await sectorsForLive(wl, env) : SECTORS;
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
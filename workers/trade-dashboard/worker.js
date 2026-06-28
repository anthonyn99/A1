/**
 * MACROBOARD — Cloudflare Worker  (was: trade-dashboard / TradeBoard)
 * ────────────────────────────────────────────────────────────────────────────
 * Top-down MACRO engine. Replaces the old free-text "run any prompt → blocks"
 * runner (which HALLUCINATED the macro narrative because the AI chain had no web
 * access) with a FIXED pipeline that feeds the AI only REAL, fresh data:
 *
 *   FACTS  → FRED (real macro series) + Yahoo (live index/commodity moves)
 *            + Finnhub earnings + deterministic macro calendar
 *   STAGE A → GROUNDED Gemini (google_search) synthesizes today's market-moving
 *             macro narrative (geopolitics / Trump / Fed / OPEC / data) — CITED,
 *             current. This is the fix: real story in, not training-data guess.
 *   STAGE B → fast non-grounded model renders narrative+data into the SAME block
 *             schema the front-end already draws (zero front-end change needed).
 *
 * I/O CONTRACT (unchanged — tradehub.html keeps working):
 *   GET  /                health
 *   GET  /rate-status     { usedToday, dailyLimit, cooldownSec, canRun }
 *   GET  /poll            { status, report:{title,summary,meta,blocks}, ... }
 *   POST /build           { force? } → kicks async build
 *   GET  /calendar        Catalysts feed (deterministic macro + Finnhub earnings)
 *   GET  /diag            last-build snapshot
 *   POST /_stage          internal staged hop (gated by STAGE_SECRET)
 *   GET/POST/DELETE /prompts*  legacy CRUD (kept; no longer drives the build)
 *
 * SECRETS (wrangler secret put — NEVER in code):
 *   MACRO_GEMINI_KEY  Gemini key from a SEPARATE Google project (own grounding
 *                     quota; NOT shared with newshub). Falls back to GEMINI_KEY.
 *   NVIDIA_KEY     build.nvidia.com NIM key      (Stage B fallback)
 *   GROQ_KEY       Groq key                       (Stage B fallback)
 *   FINNHUB_KEY    earnings + general news
 *   FRED_KEY       FRED API key (free: fred.stlouisfed.org/docs/api/api_key.html)
 *   STAGE_SECRET   long random string; gates /_stage
 *
 * KV (TD_KV):  td_report · td_job · td_rate · td_cron · td_prompts
 * ──────────────────────────────────────────────────────────────────────────── */

/* ════════════════════════ CONFIG ════════════════════════ */
const VERSION         = '2026-06-23-macroboard-v1';
const DAILY_LIMIT     = 12;          // manual fresh builds / UTC day
const MIN_INTERVAL_S  = 15 * 60;     // 15-min cooldown between manual builds
const CACHE_TTL_S     = 25 * 60;     // dedup identical builds 25 min
const AI_TIMEOUT_MS   = 24 * 1000;   // per-AI-call cap (under ~30s isolate wall)
const STAGE_A_TOKENS  = 4096;        // grounded narrative budget
const STAGE_B_TOKENS  = 8192;        // render budget (full block report)
const POLL_STALE_MS   = 240 * 1000;  // /poll marks a build dead after this

/* Stage-B render chain — walked top→bottom. Grounding is Stage A only; B is a
   pure JSON formatter so a fast non-grounded model is ideal. */
const RENDER_CHAIN = [
  { provider:'gemini', models:['gemini-2.5-flash-lite','gemini-2.5-flash'] },
  { provider:'nvidia', models:['nvidia/llama-3.3-nemotron-super-49b-v1','meta/llama-3.3-70b-instruct'] },
  { provider:'groq',   models:['llama-3.3-70b-versatile'] },
];
/* Stage-A grounded models (must support google_search tool). */
const GROUNDED_MODELS = ['gemini-2.5-flash','gemini-2.0-flash','gemini-2.5-flash-lite'];

/* ════════════════════════ FACTS: live data layer ════════════════════════ */
const FH_BASE = 'https://finnhub.io/api/v1';

/* Indices + commodities — Yahoo gives the LIVE/premarket move (FRED is daily &
   lagged). Label shown to AI. */
const YH_MARKET = [
  { sym:'SPY',  label:'S&P 500 (SPY)' },
  { sym:'QQQ',  label:'NASDAQ 100 (QQQ)' },
  { sym:'DIA',  label:'Dow (DIA)' },
  { sym:'IWM',  label:'Russell 2000 (IWM)' },
  { sym:'SOXX', label:'Semis (SOXX)' },
  { sym:'TLT',  label:'20Y Treasuries (TLT) — inverse of yields' },
  { sym:'UUP',  label:'US Dollar (UUP)' },
  { sym:'USO',  label:'WTI Oil (USO)' },
  { sym:'BNO',  label:'Brent Oil (BNO)' },
  { sym:'GLD',  label:'Gold (GLD)' },
  { sym:'VIXY', label:'VIX short-term (VIXY)' },
];

/* Sector proxies — each maps to part of the WATCHLIST so "Sector Strength" is
   grounded in the real sectors held, not generic guesses. */
const YH_SECTORS = [
  { sym:'SMH',  label:'Semis/Memory (SMH)  → DRAM,SNDK,MU,INTC,WDC,AMD,MRVL,CRDO,NVDA' },
  { sym:'IGV',  label:'Software (IGV)       → CRWD,NET,PLTR,MSFT' },
  { sym:'CIBR', label:'Cybersecurity (CIBR) → CRWD,NET' },
  { sym:'XLC',  label:'Comm Services (XLC)  → GOOGL' },
  { sym:'XLY',  label:'Consumer Disc (XLY)  → AMZN,TSLA' },
  { sym:'KWEB', label:'China Internet (KWEB)→ BABA' },
  { sym:'COPX', label:'Copper Miners (COPX) → SCCO,ERO,FCX' },
  { sym:'TAN',  label:'Clean Energy (TAN)   → BE' },
  { sym:'ITA',  label:'Aero & Defense (ITA) → SPCX (space)' },
  { sym:'XLF',  label:'Financials (XLF)     → COF' },
  { sym:'XLI',  label:'Industrials (XLI)    → MMM' },
  { sym:'XLB',  label:'Materials (XLB)      → VMC' },
];

/* Watchlist — drives the earnings facts (per-ticker analysis is the News tab's
   job; MacroBoard stays top-down). */
const WATCHLIST = ['DRAM','SNDK','MU','INTC','WDC','AMD','CRWD','BE','GOOGL','PLTR',
  'NVDA','MRVL','CRDO','TSLA','SPCX','AAPL','MSFT','NET','SCCO','ERO','WMT','AMZN','BABA'];

/* FRED series → label. Real macro values, no guessing. "." obs = skip. */
const FRED_SERIES = [
  { id:'DGS10',        label:'US 10Y Treasury Yield', unit:'%' },
  { id:'DGS2',         label:'US 2Y Treasury Yield',  unit:'%' },
  { id:'T10Y2Y',       label:'10Y–2Y Spread (curve)', unit:'%' },
  { id:'DFF',          label:'Fed Funds (effective)', unit:'%' },
  { id:'VIXCLS',       label:'VIX (close)',           unit:'' },
  { id:'DCOILWTICO',   label:'WTI Crude',             unit:'$' },
  { id:'DCOILBRENTEU', label:'Brent Crude',           unit:'$' },
  { id:'DTWEXBGS',     label:'US Dollar Index (broad)',unit:'' },
];

const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19',
  '2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18',
  '2027-07-05','2027-09-06','2027-11-25','2027-12-24',
]);

/* ── fetch helpers ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function tagged(code,msg){ const e=new Error(msg); e.code=code; return e; }
function httpErr(res){
  const e=new Error(`HTTP ${res.status}`); e.status=res.status;
  e.retryAfter=parseFloat(res.headers.get('Retry-After'))||0;
  e.code = res.status===429?'RATE_LIMIT' : res.status>=500?'SERVER' : 'HTTP';
  return e;
}
function fetchTO(url,opts){ return fetch(url,{...opts,signal:AbortSignal.timeout(AI_TIMEOUT_MS)}); }

const pct  = dp => dp==null?'?':(dp>0?'+':'')+dp.toFixed(2)+'%';
const arrow= dp => dp>0.15?'▲':dp<-0.15?'▼':'→';

async function fhFetch(path, env){
  if(!env.FINNHUB_KEY) return null;
  const sep = path.includes('?')?'&':'?';
  try{
    const r = await fetch(`${FH_BASE}${path}${sep}token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(8000)});
    if(!r.ok){ globalThis.__err=`${path}→${r.status}`; return null; }
    return await r.json();
  }catch(e){ globalThis.__err=`${path}→${e.message}`; return null; }
}

/* Live quote via Yahoo chart endpoint (free, datacenter-IP friendly). */
async function yhQuote(sym){
  const host = async h => {
    const url=`https://${h}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'Mozilla/5.0 (compatible; MacroBoard/1.0)'}});
    if(!r.ok) return null;
    const j=await r.json(); const res=j?.chart?.result?.[0]; if(!res) return null;
    const m=res.meta||{}; const c=m.regularMarketPrice; const p=m.chartPreviousClose||m.previousClose;
    if(c==null||isNaN(c)) return null;
    return { c, dp: p?((c-p)/p)*100:0 };
  };
  try{ return (await host('query1.finance.yahoo.com'))||(await host('query2.finance.yahoo.com')); }
  catch{ return null; }
}
async function yhQuotes(syms){
  const out={};
  const results=await Promise.all(syms.map(async s=>[s, await yhQuote(s)]));
  for(const [s,q] of results) if(q&&q.c) out[s]=q;
  return out;
}

/* FRED: latest valid observation + the one before (for direction). */
async function fredLatest(id, env){
  if(!env.FRED_KEY) return null;
  const url=`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${env.FRED_KEY}&file_type=json&sort_order=desc&limit=8`;
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(8000)});
    if(!r.ok) return null;
    const j=await r.json();
    const obs=(j.observations||[]).filter(o=>o.value!=='.'&&o.value!=null);
    if(!obs.length) return null;
    const v=parseFloat(obs[0].value);
    const prev=obs[1]?parseFloat(obs[1].value):null;
    return { value:v, date:obs[0].date, prev, chg: prev!=null?v-prev:null };
  }catch{ return null; }
}
async function fredAll(env){
  const out={};
  const results=await Promise.all(FRED_SERIES.map(async s=>[s.id, await fredLatest(s.id,env)]));
  for(const [id,d] of results) if(d) out[id]=d;
  return out;
}

/* ── deterministic macro calendar (authoritative, never AI-guessed) ── */
const FOMC_DATES=['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09','2027-01-27','2027-03-17','2027-04-28','2027-06-16','2027-07-28','2027-09-22','2027-11-03','2027-12-15'];
const MACRO_2026={
  jobs:['2026-01-09','2026-02-11','2026-03-06','2026-04-03','2026-05-08','2026-06-05','2026-07-02','2026-08-07','2026-09-04','2026-10-02','2026-11-06','2026-12-04'],
  cpi:['2026-01-13','2026-02-13','2026-03-11','2026-04-10','2026-05-12','2026-06-10','2026-07-14','2026-08-12','2026-09-11','2026-10-14','2026-11-10','2026-12-10'],
  ppi:['2026-01-15','2026-02-19','2026-03-12','2026-04-14','2026-05-14','2026-06-11','2026-07-16','2026-08-13','2026-09-15','2026-10-15','2026-11-13','2026-12-11'],
  pce:['2026-01-29','2026-02-26','2026-03-27','2026-04-30','2026-05-28','2026-06-25','2026-07-30','2026-08-26','2026-09-30','2026-10-29','2026-11-25','2026-12-23'],
  gdp:['2026-01-29','2026-02-26','2026-03-27','2026-04-30','2026-05-28','2026-06-25','2026-07-30','2026-08-26','2026-09-30','2026-10-29','2026-11-25','2026-12-23'],
  retail:['2026-01-16','2026-02-17','2026-03-16','2026-04-15','2026-05-15','2026-06-16','2026-07-16','2026-08-14','2026-09-16','2026-10-16','2026-11-17','2026-12-15'],
  fomc:FOMC_DATES,
};
const MON=['January','February','March','April','May','June','July','August','September','October','November','December'];
const prevMon = ds => MON[(parseInt(ds.slice(5,7),10)-2+12)%12];
function gdpQ(ds){ const m=parseInt(ds.slice(5,7),10),y=parseInt(ds.slice(0,4),10); if(m<=3)return`Q4 ${y-1}`; if(m<=6)return`Q1 ${y}`; if(m<=9)return`Q2 ${y}`; return`Q3 ${y}`; }
function authoritativeMacro(fromD,toD){
  const out=[]; const inWin=d=>d>=fromD&&d<=toD;
  const add=(d,name,cat,kind,when)=>{ if(inWin(d)) out.push({id:`macro_${d}_${cat}`,name,date:d,category:cat,kind:kind||cat,when:when||'bmo'}); };
  for(const d of MACRO_2026.jobs)   add(d,`${prevMon(d)} Jobs Report (NFP)`,'jobs','jobs');
  for(const d of MACRO_2026.cpi)    add(d,`${prevMon(d)} CPI Report`,'inflation','inflation');
  for(const d of MACRO_2026.ppi)    add(d,`${prevMon(d)} PPI Report`,'inflation','inflation');
  for(const d of MACRO_2026.pce)    add(d,`${prevMon(d)} PCE Report`,'inflation','inflation');
  for(const d of MACRO_2026.gdp)    add(d,`${gdpQ(d)} GDP`,'growth','growth');
  for(const d of MACRO_2026.retail) add(d,`${prevMon(d)} Retail Sales`,'growth','growth');
  for(const d of MACRO_2026.fomc)   add(d,'FOMC Rate Decision','fed','fed','pm');
  return out.sort((a,b)=>a.date.localeCompare(b.date));
}
const isoD = d => d.toISOString().slice(0,10);
function nextTradingDays(n){
  const out=[]; const d=new Date();
  while(out.length<n){ d.setDate(d.getDate()+1); const wd=d.getDay(); const k=isoD(d); if(wd!==0&&wd!==6&&!US_MARKET_HOLIDAYS.has(k)) out.push(new Date(d)); }
  return out;
}

/* Build the full FACTS object the AI stages consume. */
// Live watchlist — the Control-tab list (TB_WL) the front-end pushes via
// POST /watchlist. Falls back to the hardcoded WATCHLIST until first push.
async function currentWatchlist(env){
  try{ const j=await env.TD_KV.get('wl:current','json'); if(Array.isArray(j)&&j.length) return j; }catch{}
  return WATCHLIST;
}

async function buildFacts(env){
  const today=new Date();
  const to=new Date(today); to.setDate(to.getDate()+14);
  const [yq, sq, fred, earnings] = await Promise.all([
    yhQuotes(YH_MARKET.map(m=>m.sym)),
    yhQuotes(YH_SECTORS.map(m=>m.sym)),
    fredAll(env),
    fhFetch(`/calendar/earnings?from=${isoD(today)}&to=${isoD(to)}`, env),
  ]);

  // live market text
  let market='LIVE MARKET (Yahoo — real % move vs prior close):\n';
  for(const m of YH_MARKET){ const q=yq[m.sym]; if(q) market+=`  ${m.label}: $${q.c.toFixed(2)} ${arrow(q.dp)} ${pct(q.dp)}\n`; }

  // sector proxies → drives "Sector Strength" for the actual watchlist
  let sectors='SECTOR PROXIES (Yahoo — rate Sector Strength off THESE; each maps to watchlist names):\n';
  for(const m of YH_SECTORS){ const q=sq[m.sym]; if(q) sectors+=`  ${m.label}: ${arrow(q.dp)} ${pct(q.dp)}\n`; }

  // FRED real macro values
  let macro='REAL MACRO LEVELS (FRED — authoritative latest prints):\n';
  for(const s of FRED_SERIES){ const d=fred[s.id]; if(d){ const dir=d.chg==null?'':` (${d.chg>0?'+':''}${d.chg.toFixed(2)} vs prev)`; macro+=`  ${s.label}: ${s.unit==='$'?'$':''}${d.value}${s.unit==='%'?'%':''}${dir}  [${d.date}]\n`; } }

  // forward calendar (next 14d)
  const cal=authoritativeMacro(isoD(today), isoD(to));
  let calText='FORWARD MACRO CALENDAR (real scheduled dates, next ~10 trading days):\n';
  for(const e of cal.slice(0,12)) calText+=`  ${e.date}  ${e.name}\n`;

  // real earnings (watchlist)
  const wl=new Set(await currentWatchlist(env));
  const ern=(earnings?.earningsCalendar||[]).filter(e=>wl.has((e.symbol||'').toUpperCase()))
    .sort((a,b)=>(a.date||'').localeCompare(b.date||'')).slice(0,12);
  let ernText='UPCOMING WATCHLIST EARNINGS (real dates):\n';
  for(const e of ern){ const hr=e.hour?` (${e.hour})`:''; ernText+=`  ${e.date}  ${e.symbol}${hr}\n`; }

  const dateLine=`Today: ${today.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'America/New_York'})} (US Eastern).`;

  return {
    text: [dateLine,'',market,'',sectors,'',macro,'',calText,'',ernText].join('\n'),
    haveData: { yahoo:Object.keys(yq).length, sectors:Object.keys(sq).length, fred:Object.keys(fred).length, earnings:ern.length },
  };
}

/* ════════════════════════ CORS / JSON / KV ════════════════════════ */
const ALLOWED=['https://anthonyn99.github.io'];
function cors(req){
  const o=req?.headers?.get('Origin')||'';
  let allow;
  if(ALLOWED.includes(o)) allow=o;
  else if(o==='null'||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) allow=o;
  else allow=ALLOWED[0];
  return {'Access-Control-Allow-Origin':allow,'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type, Cache-Control, Pragma','Vary':'Origin'};
}
function json(d,s,req){ return new Response(JSON.stringify(d),{status:s||200,headers:{'Content-Type':'application/json',...cors(req)}}); }
async function kvGet(env,k){ try{ return await env.TD_KV.get(k,'json'); }catch{ return null; } }
async function kvPut(env,k,v,ttl){ await env.TD_KV.put(k,JSON.stringify(v), ttl?{expirationTtl:ttl}:undefined); }
const todayUTC=()=>new Date().toISOString().slice(0,10);

/* ── rate (manual builds only; cron uses its own cap) ── */
async function getRate(env){ const r=await kvGet(env,'td_rate'); return (!r||r.day!==todayUTC())?{day:todayUTC(),used:0,lastRunMs:0}:r; }
async function rateStatus(env){
  const r=await getRate(env);
  const since=(Date.now()-(r.lastRunMs||0))/1000;
  const cooldownSec=Math.max(0,Math.ceil(MIN_INTERVAL_S-since));
  return { usedToday:r.used, dailyLimit:DAILY_LIMIT, cooldownSec, minIntervalSec:MIN_INTERVAL_S, canRun:r.used<DAILY_LIMIT&&cooldownSec<=0 };
}
async function bumpRate(env){ const r=await getRate(env); r.used+=1; r.lastRunMs=Date.now(); await kvPut(env,'td_rate',r); }

/* ════════════════════════ AI: provider adapters ════════════════════════ */
async function callGemini(model, sys, user, env, maxTokens, grounded, timeoutMs){
  // Dedicated MacroBoard Gemini key (separate project = separate quota/grounding
  // bucket from newshub). Falls back to GEMINI_KEY so nothing breaks pre-setup.
  const gkey = env.MACRO_GEMINI_KEY || env.GEMINI_KEY;
  if(!gkey) throw tagged('NO_KEY','gemini key not set');
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gkey}`;
  const body={
    systemInstruction: sys?{parts:[{text:sys}]}:undefined,
    contents:[{role:'user',parts:[{text:user}]}],
    generationConfig:{
      temperature: grounded?0.3:0.4,
      maxOutputTokens: maxTokens,
      // grounding CANNOT combine with responseMimeType:json → ask for JSON in text,
      // salvage-parse downstream. Non-grounded render uses strict JSON mode.
      ...(grounded?{}:{responseMimeType:'application/json'}),
      thinkingConfig:{ thinkingBudget: /pro/i.test(model)?256:0 },
    },
    ...(grounded?{tools:[{google_search:{}}]}:{}),
  };
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs||AI_TIMEOUT_MS)});
  if(!r.ok) throw httpErr(r);
  const j=await r.json();
  const txt=j?.candidates?.[0]?.content?.parts?.map(p=>p.text).join('')||'';
  if(!txt) throw tagged('EMPTY','gemini empty');
  return txt;
}
async function callOAICompat(baseUrl, key, model, sys, user, maxTokens, timeoutMs){
  if(!key) throw tagged('NO_KEY','key not set');
  const r=await fetch(`${baseUrl}/chat/completions`,{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
    body:JSON.stringify({ model, messages:[{role:'system',content:sys},{role:'user',content:user}], temperature:0.4, max_tokens:maxTokens, response_format:{type:'json_object'} }),
    signal:AbortSignal.timeout(timeoutMs||AI_TIMEOUT_MS),
  });
  if(!r.ok) throw httpErr(r);
  const j=await r.json();
  const txt=j?.choices?.[0]?.message?.content||'';
  if(!txt) throw tagged('EMPTY','empty completion');
  return txt;
}
const callNvidia=(m,sys,user,env,mt,to)=>callOAICompat('https://integrate.api.nvidia.com/v1',env.NVIDIA_KEY,m,sys,user,mt,to);
const callGroq  =(m,sys,user,env,mt,to)=>callOAICompat('https://api.groq.com/openai/v1',env.GROQ_KEY,m,sys,user,mt,to);

/* ── JSON salvage (handles truncation + stray prose/fences) ── */
function parseObj(txt){
  let s=String(txt||'').trim().replace(/^```(?:json)?/i,'').replace(/```$/i,'').trim();
  const a=s.indexOf('{'), b=s.lastIndexOf('}');
  if(a===-1) throw tagged('PARSE','no object');
  if(b>a){ try{ return JSON.parse(s.slice(a,b+1)); }catch{} }
  // salvage: trim to last balanced brace
  let depth=0,inStr=false,esc=false,end=-1;
  for(let i=a;i<s.length;i++){ const c=s[i];
    if(inStr){ if(esc)esc=false; else if(c==='\\')esc=true; else if(c==='"')inStr=false; continue; }
    if(c==='"')inStr=true; else if(c==='{')depth++; else if(c==='}'){ depth--; if(depth===0)end=i; }
  }
  if(end>a){ try{ return JSON.parse(s.slice(a,end+1)); }catch{} }
  throw tagged('PARSE','unparseable');
}

/* ════════════════════════ STAGE A — grounded narrative ════════════════════════ */
const STAGE_A_SYS = `You are a senior macro strategist for an active LONG-ONLY equity trader. Using Google Search for the latest developments, produce TODAY'S market-moving macro picture. The user provides real live market/macro DATA below — build the narrative AROUND that data. Be specific, current, and cite real developments. Return ONE JSON object ONLY (no markdown, no prose outside it):
{
 "asOf": "<today, US Eastern>",
 "marketReaction": "<1-2 sentences: how is the tape reacting right now — indices/yields/oil/VIX, premarket direction>",
 "drivers": [ {"title":"<driver>","detail":"<1 line, with the actual latest fact>","tone":"good|warn|bad|neutral"} ],   // top 3-6 that ACTUALLY matter today
 "geopolitics": {"summary":"<1 line>","bullets":["<latest Iran/Hormuz/Middle East/Ukraine/Taiwan dev + market impact>"]},
 "trump": {"summary":"<1 line>","bullets":["<latest market-moving Trump statement/policy/tariff + impact>"]},
 "centralBanks": {"summary":"<1 line>","bullets":["<Fed/ECB/BOJ latest + rate-path read>"]},
 "energy": {"summary":"<1 line>","bullets":["<oil/OPEC driver + equity/inflation impact>"]},
 "dataPrints": ["<any econ print released today/this week + actual vs expected if known>"],
 "regimeRead": "<risk-on | risk-off | mixed — why, 1 line>",
 "biasRead": "<bullish | bearish | chop — why, 1 line>",
 "keyRisk": "<the single biggest downside risk to longs today>",
 "keyOpportunity": "<the single best tailwind for longs today>",
 "sectorTailwinds": ["<sectors with macro tailwind today>"],
 "sectorHeadwinds": ["<sectors to avoid for longs today>"]
}
RULES: real facts only — if search yields nothing fresh on a topic, say "no major new development" rather than inventing. Keep each string to ~1 line. Never output template brackets.`;

const STAGE_A_CALL_MS = 18000;   // per grounded call (search adds latency)
const STAGE_A_WALK_MS = 70000;   // hard cap for the whole Stage A walk
async function runStageA(facts, env){
  const user = `${facts.text}\n\nUsing live Google Search, produce the macro JSON for an active long-only trader. Search the very latest on: geopolitics (Iran/Middle East/Ukraine), Trump policy & tariffs, the Fed & rate path, and oil/OPEC. Tie each to how it moves the data above (yields, oil, VIX, indices).`;
  const attempts=[];
  const deadline = Date.now() + STAGE_A_WALK_MS;
  for(const model of GROUNDED_MODELS){
    if(Date.now() > deadline) break;                              // out of time → fall to degraded
    const blocked = await kvGet(env,'qblock:'+model).catch(()=>null);
    if(blocked){ attempts.push({model:`gemini:${model}`,code:'KV_BLOCKED'}); continue; }
    // at most ONE retry per model, and only if there's time left
    for(let retry=0; retry<=1; retry++){
      if(Date.now() > deadline) break;
      try{
        const txt=await callGemini(model, STAGE_A_SYS, user, env, STAGE_A_TOKENS, true, STAGE_A_CALL_MS);
        const obj=parseObj(txt);
        return { narrative:obj, model:`gemini:${model} (grounded)`, attempts };
      }catch(e){
        attempts.push({model:`gemini:${model}`,code:e.code||'ERR',retry,msg:(e.message||'').slice(0,80)});
        if(e.code==='RATE_LIMIT'){ await kvPut(env,'qblock:'+model,'1',3600); break; }   // quota → block 1h, next model
        const transient = e.code==='SERVER' || e.name==='TimeoutError' || e.code==='EMPTY';
        if(transient && retry<1 && Date.now()+3000<deadline){ await sleep(900+Math.random()*400); continue; }
        break;  // next model
      }
    }
  }
  const e=tagged('STAGE_A_FAILED','grounded narrative failed'); e.attempts=attempts; throw e;
}

/* ════════════════════════ STAGE B — render to block schema ════════════════════════ */
const RENDER_SCHEMA=`You are a rendering engine. Return ONE JSON object and NOTHING else (no markdown/backticks/prose). Schema:
{
 "title": "Daily MacroBoard",
 "summary": "<1-2 sentence top-line read>",
 "meta": { "bias":"Bullish|Bearish|Chop", "regime":"Risk-On|Risk-Off|Mixed", "goNoGo":"GO|NO-GO", "confidence":"High|Medium|Low" },
 "blocks": Block[]
}
Block is ONE of:
 {"type":"kpis","title"?,"items":[{"label","value","tone"?:"good|warn|bad|neutral"}]}
 {"type":"scoreboard","title"?,"items":[{"label","rating":"good|warn|bad","note"?}]}
 {"type":"table","title"?,"columns":[],"rows":[[]],"tone"?:[]}
 {"type":"list","title"?,"ordered"?,"items":[]}
 {"type":"cards","title"?,"items":[{"heading","body","tag"?,"tone"?}]}
 {"type":"tiers","title"?,"tiers":[{"label","tone"?,"items":[]}]}
 {"type":"keyvalue","title"?,"items":[{"k","v"}]}
 {"type":"callout","tone":"good|warn|bad|neutral","title"?,"body"}
RULES: valid JSON, no trailing commas. Concise (1 line/string). Fill every block with real content from the data — never template brackets, never empty blocks. Map green→good, yellow→warn, red→bad.`;

function renderUserPrompt(facts, narrative){
  const nb = narrative ? `MACRO NARRATIVE (grounded, today — use as the source of truth for the story):\n${JSON.stringify(narrative,null,1)}\n\n` : '(no grounded narrative available — derive read from the hard data below)\n\n';
  return `${nb}HARD DATA (real numbers):\n${facts.text}\n\nRender the MacroBoard with these blocks IN THIS ORDER:
1. callout — GO / NO-GO for long-only today (tone good=GO, bad=NO-GO) + 1-line reason.
2. kpis — "Market Dashboard": SPX/NDX/Dow/SOXX/10Y/2Y/VIX/WTI/Brent/Dollar with value + tone.
3. cards — "Top Macro Drivers": one card per driver (heading, body=the actual latest fact, tone).
4. cards — "Geopolitics & Policy": Middle East/Iran, Trump/tariffs, central banks, energy (one card each, tone by risk).
5. keyvalue — "Forward Calendar": next macro catalysts (date → event) from the calendar above.
6. scoreboard — "Sector Strength": rate the SECTOR PROXIES above (good=strong today, bad=weak) and name the watchlist tickers each covers in the note. Order strongest→weakest.
7. list — "What NOT To Do Today": 3 concrete mistakes given current conditions.
8. tiers — "Tier List": S/A/B/C of what's driving the tape today (S=dominant driver).
Set meta.bias/regime/goNoGo/confidence from the narrative's read. summary = the 1-line market read.`;
}

const STAGE_B_CALL_MS = 16000;   // per render call
const STAGE_B_WALK_MS = 55000;   // hard cap for the whole render walk
async function runStageB(facts, narrative, env, opts={}){
  const sys=RENDER_SCHEMA, user=renderUserPrompt(facts,narrative);
  const attempts=[];
  const deadline = Date.now() + STAGE_B_WALK_MS;
  for(const tier of RENDER_CHAIN){
    // when gemini just got throttled this build, don't waste calls on it — go
    // straight to nvidia/groq (avoids two guaranteed-429s + speeds render).
    if(opts.skipGemini && tier.provider==='gemini'){ attempts.push({model:'gemini:*',code:'SKIPPED_THROTTLED'}); continue; }
    for(const model of tier.models){
      if(Date.now() > deadline){ attempts.push({model:`${tier.provider}:${model}`,code:'WALK_TIMEOUT'}); break; }
      try{
        let txt;
        if(tier.provider==='gemini') txt=await callGemini(model,sys,user,env,STAGE_B_TOKENS,false,STAGE_B_CALL_MS);
        else if(tier.provider==='nvidia') txt=await callNvidia(model,sys,user,env,STAGE_B_TOKENS,STAGE_B_CALL_MS);
        else txt=await callGroq(model,sys,user,env,STAGE_B_TOKENS,STAGE_B_CALL_MS);
        const obj=parseObj(txt);
        if(!Array.isArray(obj.blocks)||!obj.blocks.length) throw tagged('NO_BLOCKS','empty blocks');
        return { report:obj, model:`${tier.provider}:${model}`, attempts };
      }catch(e){ attempts.push({model:`${tier.provider}:${model}`,code:e.code||'ERR',msg:(e.message||'').slice(0,80)}); }
    }
  }
  const e=tagged('STAGE_B_FAILED','all render models failed'); e.attempts=attempts; throw e;
}

/* ════════════════════════ BUILD PIPELINE (3 staged invocations) ════════════════════════ */
async function fnv1a(str){ let h=0x811c9dc5; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,0x01000193); } return (h>>>0).toString(16); }

/* Kick the next stage as its OWN invocation (fresh wall-time budget) via SELF. */
async function kickStage(env, runId, phase){
  const url=`${env.WORKER_ORIGIN||'https://trade-dashboard.av1.workers.dev'}/_stage`;
  const headers={'Content-Type':'application/json','x-stage-secret':env.STAGE_SECRET||''};
  const body=JSON.stringify({runId,phase});
  try{
    if(env.SELF) await env.SELF.fetch(new Request(url,{method:'POST',headers,body}));
    else await fetch(url,{method:'POST',headers,body});
  }catch(e){ console.error('[kickStage]',e.message); }
}

async function runBuild(env, opts={}){
  const runId=crypto.randomUUID();
  const startedAt=Date.now();
  await kvPut(env,'td_report',{status:'building',report:null,error:null,generatedAt:null,model:null,runId,startedAt});
  const job={ runId, startedAt, phase:'facts', facts:null, narrative:null, narrativeModel:null,
              cron:!!opts.cron, deadStageA:false };
  await kvPut(env,'td_job',job);
  await kickStage(env, runId, 'facts');
  return { runId };
}

/* STAGE 1: facts (network-heavy, own invocation). */
async function stageFacts(runId, env){
  const job=await kvGet(env,'td_job'); if(!job||job.runId!==runId) return;
  let facts=null;
  try{ facts=await buildFacts(env); }catch(e){ console.error('[facts]',e.message); }
  job.facts=facts; job.phase='narrative';
  await kvPut(env,'td_job',job);
  await kickStage(env, runId, 'narrative');
}
/* STAGE 2: grounded narrative (one AI call, own invocation). */
async function stageNarrative(runId, env){
  const job=await kvGet(env,'td_job'); if(!job||job.runId!==runId) return;
  if(job.facts){
    try{ const {narrative,model}=await runStageA(job.facts,env); job.narrative=narrative; job.narrativeModel=model; }
    catch(e){
      console.error('[narrative]',e.message); job.deadStageA=true; job.lastAttempts=e.attempts||null;
      // if grounding 429'd, gemini is throttled for this build → skip it in render
      job.geminiThrottled = !!(e.attempts||[]).some(a=>a.code==='RATE_LIMIT');
    }
  }
  job.phase='render';
  await kvPut(env,'td_job',job);
  await kickStage(env, runId, 'render');
}
/* STAGE 3: render + finalize (one AI call, own invocation). */
async function stageRender(runId, env){
  const job=await kvGet(env,'td_job'); if(!job||job.runId!==runId) return;
  const generatedAt=Date.now();
  try{
    const {report,model}=await runStageB(job.facts||{text:''}, job.narrative, env, {skipGemini: !!job.geminiThrottled});
    const modelStr=`${job.narrativeModel?job.narrativeModel+' + ':''}${model}`;
    await kvPut(env,'td_report',{status:'ready',report,error:null,generatedAt,model:modelStr,runId});
    const hash=await fnv1a((job.facts?.text||'')+JSON.stringify(job.narrative||{}));
    await kvPut(env,`td_cache:${hash}`,{report,generatedAt,model:modelStr},CACHE_TTL_S);
    if(!job.cron) await bumpRate(env);
  }catch(e){
    await kvPut(env,'td_report',{status:'degraded',report:null,error:e.message||'render failed',generatedAt,model:null,runId,lastAttempts:e.attempts||job.lastAttempts||null});
  }
}

/* ════════════════════════ /calendar (Catalysts — unchanged behavior) ════════════════════════ */
async function calendarHandler(url, env, request){
  const days=Math.min(30,Math.max(1,parseInt(url.searchParams.get('days')||'10',10)));
  const tickers=(url.searchParams.get('tickers')||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
  const today=new Date(); const to=new Date(today); to.setDate(to.getDate()+days+4);
  const events=authoritativeMacro(isoD(today), isoD(to));
  if(tickers.length && env.FINNHUB_KEY){
    const ec=await fhFetch(`/calendar/earnings?from=${isoD(today)}&to=${isoD(to)}`, env);
    const wl=new Set(tickers);
    for(const e of (ec?.earningsCalendar||[])){
      const sym=(e.symbol||'').toUpperCase(); if(!wl.has(sym)) continue;
      events.push({ id:'earn_'+sym+'_'+e.date, name:sym+' Earnings', date:e.date, kind:'earnings', category:'earnings', when:(e.hour==='amc'||e.hour==='bmo')?e.hour:'amc', epsEstimate:e.epsEstimate??null });
    }
  }
  const windowDays=Math.max(days,14);
  const cutoff=isoD(new Date(today.getTime()+windowDays*86400000));
  const seen=new Set();
  const out=events.filter(e=>e.date>=isoD(today)&&e.date<=cutoff&&!seen.has(e.id)&&seen.add(e.id)).sort((a,b)=>a.date.localeCompare(b.date));
  return json({events:out,generatedAt:Date.now(),degraded:false,source:'macroboard'},200,request);
}

/* ════════════════════════ ROUTER ════════════════════════ */
async function handle(request, env, ctx){
  const url=new URL(request.url);
  const path=url.pathname.replace(/\/+$/,'')||'/';
  const method=request.method;
  if(method==='OPTIONS') return new Response(null,{status:204,headers:cors(request)});

  if(path==='/'&&method==='GET')
    return json({ok:true,service:'macroboard',version:VERSION,daily:DAILY_LIMIT,intervalSec:MIN_INTERVAL_S},200,request);

  if(path==='/rate-status'&&method==='GET')
    return json(await rateStatus(env),200,request);

  if(path==='/poll'&&method==='GET'){
    const r=await kvGet(env,'td_report');
    if(r&&r.status==='building'&&r.startedAt&&(Date.now()-r.startedAt>POLL_STALE_MS)){
      const job=await kvGet(env,'td_job');
      const stale={...r,status:'degraded',error:'Build timed out. Try again.',diag:job?{phase:job.phase,deadStageA:job.deadStageA,lastAttempts:job.lastAttempts||null}:null};
      await kvPut(env,'td_report',stale);
      return json(stale,200,request);
    }
    return json(r||{status:'idle',report:null},200,request);
  }

  if(path==='/build'&&method==='POST'){
    const body=await request.json().catch(()=>({}));
    const rs=await rateStatus(env);
    const force=body.force===true;
    if(rs.usedToday>=DAILY_LIMIT) return json({ok:false,error:'Daily limit reached.',...rs},429,request);
    if(!force&&rs.cooldownSec>0) return json({ok:false,error:`Cooldown ${rs.cooldownSec}s`,...rs},429,request);
    const {runId}=await runBuild(env,{cron:false});
    return json({ok:true,status:'building',runId},202,request);
  }

  if(path==='/_stage'&&method==='POST'){
    if(env.STAGE_SECRET&&request.headers.get('x-stage-secret')!==env.STAGE_SECRET)
      return json({ok:false,error:'forbidden'},403,request);
    const body=await request.json().catch(()=>({}));
    if(!body.runId) return json({ok:false,error:'runId required'},400,request);
    const p=body.phase;
    if(p==='facts')          ctx.waitUntil(stageFacts(body.runId,env));
    else if(p==='narrative') ctx.waitUntil(stageNarrative(body.runId,env));
    else                     ctx.waitUntil(stageRender(body.runId,env));
    return json({ok:true,status:'staging',phase:p},202,request);
  }

  if(path==='/calendar'&&method==='GET')
    return await calendarHandler(url,env,request);

  if(path==='/diag'&&method==='GET'){
    const report=await kvGet(env,'td_report'); const job=await kvGet(env,'td_job'); const rs=await rateStatus(env).catch(()=>null);
    return json({ version:VERSION, now:Date.now(), rate:rs,
      report: report?{status:report.status,error:report.error,model:report.model,generatedAt:report.generatedAt,startedAt:report.startedAt,elapsedSec:report.startedAt?Math.round((Date.now()-report.startedAt)/1000):null,lastAttempts:report.lastAttempts||null}:null,
      job: job?{runId:job.runId,phase:job.phase,cron:job.cron,deadStageA:job.deadStageA,haveFacts:!!job.facts,haveNarrative:!!job.narrative,narrativeModel:job.narrativeModel,haveData:job.facts?.haveData||null,lastAttempts:job.lastAttempts||null}:null,
    },200,request);
  }

  if(path==='/debug-data'&&method==='GET'){
    let facts=null; try{ facts=await buildFacts(env); }catch(e){ return json({ok:false,error:e.message},200,request); }
    return json({ ok:true, haveData:facts.haveData, factsLength:facts.text.length, factsPreview:facts.text.slice(0,1500) },200,request);
  }

  // Universal watchlist — front-end pushes TB_WL here so cron + builds use the
  // exact Control-tab list. Stored in KV; read by currentWatchlist().
  if(path==='/watchlist'&&method==='POST'){
    const body=await request.json().catch(()=>({}));
    let tickers=Array.isArray(body.tickers)?body.tickers:[];
    tickers=tickers.map(t=>String(t||'').trim().toUpperCase()).filter(Boolean).slice(0,80);
    if(!tickers.length) return json({ok:false,error:'no tickers'},400,request);
    await env.TD_KV.put('wl:current',JSON.stringify(tickers));
    return json({ok:true,count:tickers.length},200,request);
  }
  if(path==='/watchlist'&&method==='GET'){
    const wl=await currentWatchlist(env);
    return json({ok:true,tickers:wl,count:wl.length},200,request);
  }

  // legacy prompts CRUD kept so old front-end calls don't 404 (no longer drives build)
  if(path==='/prompts'&&method==='GET') return json({ok:true,prompts:[],activeId:null,note:'MacroBoard is fixed-pipeline; prompts deprecated'},200,request);
  if(path==='/prompts'&&method==='POST') return json({ok:true,prompts:[],activeId:null},200,request);
  if(/^\/prompts\/.+$/.test(path)&&method==='DELETE') return json({ok:true},200,request);

  return json({ok:false,error:`Not found: ${method} ${path}`},404,request);
}

/* ════════════════════════ CRON ════════════════════════
   Mon-Fri pre-warm → build + cache so the user just opens the tab. Fires once daily
   at 11:45 UTC (= 05:45 MDT / 04:45 MST) — before 6am Mountain. Cron builds bypass the
   manual cooldown and use a small daily cap. */
async function scheduled(event, env, ctx){
  // Skip full-closure market holidays (e.g. Labor Day) — no session to pre-build for.
  // At 11:45 UTC the UTC date == US Eastern date, so todayUTC() is the correct
  // calendar day to test against the ET-dated US_MARKET_HOLIDAYS set.
  if(US_MARKET_HOLIDAYS.has(todayUTC())) return;
  // small cron cap so a stuck loop can't hammer AI quota
  const day=todayUTC();
  const c=await kvGet(env,'td_cron')||{day,used:0};
  if(c.day!==day){ c.day=day; c.used=0; }
  if(c.used>=5) return;            // hard daily cron ceiling
  c.used+=1; await kvPut(env,'td_cron',c);
  await runBuild(env,{cron:true}); // fires staged pipeline via waitUntil hops
}

export default {
  async fetch(request, env, ctx){
    try{ return await handle(request,env,ctx); }
    catch(e){ console.error('[macroboard] unhandled',e); return json({ok:false,error:'Internal error'},500,request); }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil(scheduled(event,env,ctx));
  },
};

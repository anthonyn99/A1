/**
 * TRADE-DASHBOARD — Cloudflare Worker
 * ────────────────────────────────────────────────────────────────────────────
 * Support endpoints for TradeHub. The MacroBoard AI engine that used to live
 * here (FRED/Yahoo facts → grounded Gemini → block-schema render, the /build ·
 * /poll · /rate-status · /active-prompt · /_stage routes and the weekday cron)
 * has been removed along with the MacroBoard tab. What's left is the plumbing
 * other tabs still depend on:
 *
 *   GET  /                     health
 *   GET  /calendar             Catalysts feed (deterministic macro + Finnhub earnings)
 *   GET/POST /watchlist        the universal Control-tab ticker list (KV)
 *   GET/POST /analysis-config  Analysis-tab selection (prompt + searches);
 *                              Trading Auto Launch reads it to open ChatGPT
 *   GET/POST /daily-reminder   Playbook's "Daily Reminder" page (Markdown);
 *                              Trading Auto Launch blocks the morning launch on it
 *   GET/POST/DELETE /prompts*  legacy CRUD no-ops (kept so stale front-ends don't 404)
 *
 * SECRETS (wrangler secret put — NEVER in code):
 *   FINNHUB_KEY    earnings for /calendar
 *
 * KV (TD_KV):  wl:current · td_analysis_prompt · td_daily_reminder
 * ──────────────────────────────────────────────────────────────────────────── */

/* ════════════════════════ CONFIG ════════════════════════ */
const VERSION = '2026-08-03-support-only';
const FH_BASE = 'https://finnhub.io/api/v1';

/* Watchlist fallback — used until the front-end first pushes POST /watchlist. */
const WATCHLIST = ['DRAM','SNDK','MU','INTC','WDC','AMD','CRWD','BE','GOOGL','PLTR',
  'NVDA','MRVL','CRDO','TSLA','SPCX','AAPL','MSFT','NET','SCCO','ERO','WMT','AMZN','BABA'];

async function fhFetch(path, env){
  if(!env.FINNHUB_KEY) return null;
  const sep = path.includes('?')?'&':'?';
  try{
    const r = await fetch(`${FH_BASE}${path}${sep}token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(8000)});
    if(!r.ok){ globalThis.__err=`${path}→${r.status}`; return null; }
    return await r.json();
  }catch(e){ globalThis.__err=`${path}→${e.message}`; return null; }
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
// charset is explicit: without it a client is free to guess, and PowerShell's
// Invoke-RestMethod guesses latin-1 and turns every em-dash into mojibake.
function json(d,s,req){ return new Response(JSON.stringify(d),{status:s||200,headers:{'Content-Type':'application/json; charset=utf-8',...cors(req)}}); }
async function kvGet(env,k){ try{ return await env.TD_KV.get(k,'json'); }catch{ return null; } }
async function kvPut(env,k,v,ttl){ await env.TD_KV.put(k,JSON.stringify(v), ttl?{expirationTtl:ttl}:undefined); }

/* Live watchlist — the Control-tab list the front-end pushes via POST /watchlist.
   Falls back to the hardcoded WATCHLIST until the first push. */
async function currentWatchlist(env){
  try{ const j=await env.TD_KV.get('wl:current','json'); if(Array.isArray(j)&&j.length) return j; }catch{}
  return WATCHLIST;
}

/* Analysis-tab config — the front-end pushes the Analysis section's selection:
   the selected prompt PLUS the configured search/URL list. Trading Auto Launch reads it
   (GET /analysis-config) to open ChatGPT with that exact prompt (auto-submitted)
   and open each search. */
/* Browser tab groups only support these 9 fixed colors. Anything else → teal. */
const TD_GROUP_COLORS=['grey','blue','red','yellow','green','pink','purple','cyan','orange'];
function tdGroupColor(c){c=String(c||'').toLowerCase();if(c==='teal')c='cyan';if(c==='gray')c='grey';return TD_GROUP_COLORS.includes(c)?c:'cyan';}

async function getAnalysisConfig(env){
  const p=await kvGet(env,'td_analysis_prompt');
  if(p&&p.text&&String(p.text).trim())
    return { name:p.name||'Prompt', text:String(p.text), searches:Array.isArray(p.searches)?p.searches:[],
             groupName:p.groupName||'Trading Analysis', groupColor:tdGroupColor(p.groupColor) };
  return null;
}
async function setAnalysisConfig(env, p){
  const text=String(p&&p.text||'').trim(); if(!text) return false;
  const searches=Array.isArray(p&&p.searches)
    ? p.searches.map(s=>String(s||'').slice(0,500)).filter(Boolean).slice(0,20) : [];
  await kvPut(env,'td_analysis_prompt',{ name:String(p&&p.name||'Prompt').slice(0,80), text:text.slice(0,8000), searches,
    groupName:String(p&&p.groupName||'Trading Analysis').slice(0,60), groupColor:tdGroupColor(p&&p.groupColor), updatedAt:Date.now() });
  return true;
}

/* Daily Reminder — the TradeHub Playbook page the trader must acknowledge before
   the morning workspace opens. TradeHub authors it as HTML and pushes a Markdown
   copy here; Trading Auto Launch GETs /daily-reminder and blocks the launch on a
   Confirm click. Kept in a slot of its own so it can never be clobbered by the
   analysis writer above. */
async function getDailyReminder(env){
  const r=await kvGet(env,'td_daily_reminder');
  if(r&&r.markdown&&String(r.markdown).trim())
    return { title:r.title||'Daily Reminder', markdown:String(r.markdown), updatedAt:r.updatedAt||null };
  return null;
}
async function setDailyReminder(env, p){
  const markdown=String(p&&p.markdown||'').trim(); if(!markdown) return false;
  await kvPut(env,'td_daily_reminder',{
    title:String(p&&p.title||'Daily Reminder').slice(0,120),
    markdown:markdown.slice(0,20000),
    updatedAt:Date.now(),
  });
  return true;
}

/* ════════════════════════ /calendar (Catalysts) ════════════════════════ */
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
  return json({events:out,generatedAt:Date.now(),degraded:false,source:'trade-dashboard'},200,request);
}

/* ════════════════════════ ROUTER ════════════════════════ */
async function handle(request, env, ctx){
  const url=new URL(request.url);
  const path=url.pathname.replace(/\/+$/,'')||'/';
  const method=request.method;
  if(method==='OPTIONS') return new Response(null,{status:204,headers:cors(request)});

  if(path==='/'&&method==='GET')
    return json({ok:true,service:'trade-dashboard',version:VERSION},200,request);

  if(path==='/calendar'&&method==='GET')
    return await calendarHandler(url,env,request);

  // Universal watchlist — front-end pushes TB_WL here so /calendar uses the exact
  // Control-tab list. Stored in KV; read by currentWatchlist().
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

  // Analysis-tab config — the front-end pushes the Analysis selection (prompt +
  // search list) here; the Trading Auto Launch GETs it to open ChatGPT with that exact
  // prompt (auto-submitted) and open each configured search.
  if(path==='/analysis-config'&&method==='POST'){
    const body=await request.json().catch(()=>({}));
    const ok=await setAnalysisConfig(env, body);
    if(!ok) return json({ok:false,error:'prompt text required'},400,request);
    const p=await getAnalysisConfig(env);
    return json({ok:true,name:p.name,preview:p.text.slice(0,160),searches:p.searches.length},200,request);
  }
  if(path==='/analysis-config'&&method==='GET'){
    const p=await getAnalysisConfig(env);
    if(!p) return json({ok:false,error:'no analysis config set'},404,request);
    return json({ok:true,name:p.name,text:p.text,searches:p.searches,groupName:p.groupName,groupColor:p.groupColor},200,request);
  }

  // Daily Reminder — TradeHub (Playbook → Daily Reminder) pushes the page here;
  // Trading Auto Launch GETs it and won't open the trading workspace until it's
  // acknowledged.
  if(path==='/daily-reminder'&&method==='POST'){
    const body=await request.json().catch(()=>({}));
    const ok=await setDailyReminder(env, body);
    if(!ok) return json({ok:false,error:'markdown required'},400,request);
    const p=await getDailyReminder(env);
    return json({ok:true,title:p.title,chars:p.markdown.length,updatedAt:p.updatedAt},200,request);
  }
  if(path==='/daily-reminder'&&method==='GET'){
    const p=await getDailyReminder(env);
    if(!p) return json({ok:false,error:'no daily reminder set'},404,request);
    return json({ok:true,title:p.title,markdown:p.markdown,updatedAt:p.updatedAt},200,request);
  }

  // legacy prompts CRUD kept so old cached front-ends don't 404
  if(path==='/prompts'&&method==='GET') return json({ok:true,prompts:[],activeId:null,note:'retired'},200,request);
  if(path==='/prompts'&&method==='POST') return json({ok:true,prompts:[],activeId:null},200,request);
  if(/^\/prompts\/.+$/.test(path)&&method==='DELETE') return json({ok:true},200,request);

  return json({ok:false,error:`Not found: ${method} ${path}`},404,request);
}

export default {
  async fetch(request, env, ctx){
    try{ return await handle(request,env,ctx); }
    catch(e){ console.error('[trade-dashboard] unhandled',e); return json({ok:false,error:'Internal error'},500,request); }
  },
};

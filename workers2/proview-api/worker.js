// ============================================================================
// proview-api — Cloudflare Worker
//
// KV-cached proxy for the LoL Esports public API, backing the "ProView"
// esports-schedule tab in index.html (Tony's dashboard). Recovered from the
// live Cloudflare deployment 2026-07-03 — this worker had no source in git
// before (deployed directly, outside this repo); this file is now the source
// of truth and auto-deploys like every other worker here.
//
// Routes:
//   GET /leagues                        → list of LoL esports leagues
//   GET /schedule?leagueId=<id>          → match schedule for a league
//   GET /tournaments?leagueId=<id>       → tournaments for a league
//   GET /standings?tournamentId=<id>     → standings for a tournament
//
// Each route is cached in KV (binding PV_CACHE) under ONE key. The route's own
// TTL decides how long that entry counts as fresh (from the fetch time stored in
// KV metadata); the entry itself lives PV_KEEP so it can still be served as a
// stale fallback when the upstream LoL API errors. One key = one write per miss.
//
// Bindings (Cloudflare → Settings → Bindings):
//   PV_CACHE   KV namespace (id 512ff8d9f3144c16966179105586768d)
// ============================================================================

const LOL_API='https://esports-api.lolesports.com/persisted/gw';
const LOL_KEY='0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'; // LoL Esports' own public client key (used by lolesports.com itself) — not a secret
const HL='en-US';
const TTL_SCHEDULE=15*60;
const TTL_STANDINGS=30*60;
const TTL_TOURNAMENTS=60*60;
const TTL_LEAGUES=4*3600;
const TTL_TEAMS=12*3600;   // rosters change on transfer windows, not hourly
const CORS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
  'Content-Type':'application/json',
};
export default {
  async fetch(request,env,ctx){
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:CORS});
    const url=new URL(request.url);
    const path=url.pathname;
    const league=url.searchParams.get('leagueId')||'';
    const tourny=url.searchParams.get('tournamentId')||'';
    try{
      if(path==='/schedule'&&league)
        return await cachedFetch(env,'schedule:'+league,TTL_SCHEDULE,
          LOL_API+'/getSchedule?hl='+HL+'&leagueId='+league,ctx);
      if(path==='/tournaments'&&league)
        return await cachedFetch(env,'tournaments:'+league,TTL_TOURNAMENTS,
          LOL_API+'/getTournamentsForLeague?hl='+HL+'&leagueId='+league,ctx);
      if(path==='/standings'&&tourny)
        return await cachedFetch(env,'standings:'+tourny,TTL_STANDINGS,
          LOL_API+'/getStandings?hl='+HL+'&tournamentId='+tourny,ctx);
      // ── /pro-index ────────────────────────────────────────────────────────
      // A compact pro-player lookup built from the official LoL Esports team
      // rosters. getTeams is ~1.5 MB of roster + art; the index below is ~250 KB
      // and is all WarRoom needs to badge a ladder entry, so the reduction happens
      // HERE rather than shipping the whole payload to every browser.
      //
      // Shape: { builtAt, teams: { "<code> <handle>": [team, league, role, region] } }
      // keyed lowercase. Rosters overlap between an org's main and academy teams
      // (Gumayusi is listed on both Hanwha Life Esports and HLE Challengers), so
      // the top-tier team wins the key — otherwise whichever came last in the
      // response would decide, and a starter would get badged as an academy player.
      if(path==='/pro-index')
        return await cachedFetch(env,'proindex:v1',TTL_TEAMS,
          LOL_API+'/getTeams?hl='+HL,ctx,buildProIndex);
      if(path==='/leagues')
        return await cachedFetch(env,'leagues',TTL_LEAGUES,
          LOL_API+'/getLeagues?hl='+HL,ctx);
      return j({error:'Not found'},404);
    }catch(e){return j({error:e.message},502);}
  }
};
// ── One-time cleanup of the legacy `<key>:stale` twins ───────────────────────
// The previous cache wrote every payload twice and gave the second copy no TTL,
// so those keys never expire on their own. This removes them once and records a
// marker so it never runs again. Cost after the first pass: a single KV read on
// the first cache miss a cold isolate serves, and nothing once it is warm.
const SWEEP_KEY = '_swept:stale-twins';
let _sweptLegacy = false;
async function sweepLegacyStale(kv){
  if (_sweptLegacy) return;
  _sweptLegacy = true;
  try{
    if (await kv.get(SWEEP_KEY)) return;          // already done, nothing to do
    let cursor, removed = 0;
    do{
      const page = await kv.list({ cursor });
      cursor = page.list_complete ? undefined : page.cursor;
      for (const k of page.keys){
        if (k.name.endsWith(':stale')){ await kv.delete(k.name); removed++; }
      }
    } while (cursor);
    await kv.put(SWEEP_KEY, String(removed));
    console.log('[sweep] removed ' + removed + ' legacy :stale key(s)');
  }catch(e){
    _sweptLegacy = false;                          // transient failure — retry later
    console.warn('[sweep] failed:', e.message);
  }
}

// How long a cached entry stays available as a last-known-good fallback after it
// stops being fresh. `ttl` still decides freshness; this only decides how long
// the fallback survives.
const PV_KEEP = 7*24*3600;

async function cachedFetch(env,key,ttl,url,ctx,transform){
  // One read covers both cases: a fresh hit, or the stale fallback if the
  // upstream call below fails.
  let cached=null;
  try{
    const e=await env.PV_CACHE.getWithMetadata(key,'text');
    if(e&&e.value) cached={body:e.value,at:(e.metadata&&e.metadata.at)||0};
  }catch(e){}
  if(cached&&Date.now()-cached.at<ttl*1000)
    return new Response(cached.body,{headers:{...CORS,'X-Cache':'HIT'}});

  let res;
  try{
    res=await fetch(url,{headers:{'x-api-key':LOL_KEY,'Origin':'https://lolesports.com','Referer':'https://lolesports.com/'}});
  }catch(e){
    if(cached) return new Response(cached.body,{headers:{...CORS,'X-Cache':'STALE'}});
    return j({error:'Upstream unreachable'},502);
  }
  if(!res.ok){
    if(cached) return new Response(cached.body,{headers:{...CORS,'X-Cache':'STALE'}});
    return j({error:'Upstream '+res.status},res.status);
  }
  let body=await res.text();
  // Reduce BEFORE storing, so the KV entry and every later HIT are the small
  // form rather than the raw upstream payload.
  if(transform){ try{ body=transform(body); }catch(e){ return j({error:'Transform failed: '+e.message},502); } }
  await env.PV_CACHE.put(key,body,{expirationTtl:PV_KEEP,metadata:{at:Date.now()}});
  if(ctx&&ctx.waitUntil) ctx.waitUntil(sweepLegacyStale(env.PV_CACHE)); else await sweepLegacyStale(env.PV_CACHE);
  return new Response(body,{headers:{...CORS,'X-Cache':'MISS'}});
}
function j(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:CORS});}


// ── Pro index builder ───────────────────────────────────────────────────────
// Only ACTIVE teams with a tricode and a roster contribute. Everything else in
// getTeams (logos, background art, disbanded orgs) is dropped.
const PRO_TIER1=['LCK','LEC','LCS','LPL','LTA','LTA North','LTA South','LCP','PCS','VCS'];
function proLeagueRank(name){
  const n=String(name||'');
  if(/challeng|academy|amateur|2nd|junior/i.test(n)) return 2;   // never outrank a main roster
  return PRO_TIER1.includes(n) ? 0 : 1;
}
function buildProIndex(raw){
  let teams=[];
  try{ teams=(JSON.parse(raw).data||{}).teams||[]; }catch(e){ return raw; }
  const out={};
  for(const t of teams){
    if(!t||t.status!=='active'||!Array.isArray(t.players)||!t.players.length) continue;
    const code=String(t.code||'').trim(); if(!code) continue;
    const league=(t.homeLeague&&t.homeLeague.name)||'';
    const region=(t.homeLeague&&t.homeLeague.region)||'';
    for(const pl of t.players){
      const h=String(pl.summonerName||'').trim(); if(!h) continue;
      const key=(code+' '+h).toLowerCase();
      const prev=out[key];
      if(prev && proLeagueRank(prev[1])<=proLeagueRank(league)) continue;
      out[key]=[t.name,league,pl.role||'',region];
    }
  }
  return JSON.stringify({builtAt:Date.now(),teams:out});
}
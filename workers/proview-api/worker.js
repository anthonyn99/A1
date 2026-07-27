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
const CORS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
  'Content-Type':'application/json',
};
export default {
  async fetch(request,env){
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:CORS});
    const url=new URL(request.url);
    const path=url.pathname;
    const league=url.searchParams.get('leagueId')||'';
    const tourny=url.searchParams.get('tournamentId')||'';
    try{
      if(path==='/schedule'&&league)
        return await cachedFetch(env,'schedule:'+league,TTL_SCHEDULE,
          LOL_API+'/getSchedule?hl='+HL+'&leagueId='+league);
      if(path==='/tournaments'&&league)
        return await cachedFetch(env,'tournaments:'+league,TTL_TOURNAMENTS,
          LOL_API+'/getTournamentsForLeague?hl='+HL+'&leagueId='+league);
      if(path==='/standings'&&tourny)
        return await cachedFetch(env,'standings:'+tourny,TTL_STANDINGS,
          LOL_API+'/getStandings?hl='+HL+'&tournamentId='+tourny);
      if(path==='/leagues')
        return await cachedFetch(env,'leagues',TTL_LEAGUES,
          LOL_API+'/getLeagues?hl='+HL);
      return j({error:'Not found'},404);
    }catch(e){return j({error:e.message},502);}
  }
};
// How long a cached entry stays available as a last-known-good fallback after it
// stops being fresh. `ttl` still decides freshness; this only decides how long
// the fallback survives.
const PV_KEEP = 7*24*3600;

async function cachedFetch(env,key,ttl,url){
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
  const body=await res.text();
  await env.PV_CACHE.put(key,body,{expirationTtl:PV_KEEP,metadata:{at:Date.now()}});
  return new Response(body,{headers:{...CORS,'X-Cache':'MISS'}});
}
function j(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:CORS});}

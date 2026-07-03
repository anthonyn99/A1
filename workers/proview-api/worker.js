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
// Each route is cached in KV (binding PV_CACHE) for its own TTL, with a
// "stale" copy kept indefinitely as a fallback if the upstream LoL API errors.
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
async function cachedFetch(env,key,ttl,url){
  const hit=await env.PV_CACHE.get(key);
  if(hit) return new Response(hit,{headers:{...CORS,'X-Cache':'HIT'}});
  const res=await fetch(url,{headers:{'x-api-key':LOL_KEY,'Origin':'https://lolesports.com','Referer':'https://lolesports.com/'}});
  if(!res.ok){
    const stale=await env.PV_CACHE.get(key+':stale');
    if(stale) return new Response(stale,{headers:{...CORS,'X-Cache':'STALE'}});
    return j({error:'Upstream '+res.status},res.status);
  }
  const body=await res.text();
  await Promise.all([
    env.PV_CACHE.put(key,body,{expirationTtl:ttl}),
    env.PV_CACHE.put(key+':stale',body),
  ]);
  return new Response(body,{headers:{...CORS,'X-Cache':'MISS'}});
}
function j(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:CORS});}

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

// Even when the payload has not changed, the durable copy has to be rewritten
// occasionally or its 7-day expirationTtl runs out and the stale-fallback is
// gone exactly when upstream is down and it is needed.
const PV_REFRESH_FLOOR_MS = 3*24*3600*1000;

// The Cache API in front of KV.
//
// WHY: KV WRITES are the scarce resource — 1,000/day per Cloudflare account,
// shared by every worker on it — and this worker wrote one on every expiry of
// every key. The client loads ALL configured leagues on open (ensureCardLeaguesLoaded,
// so favourited teams in any league can produce a card), so a heavy day was a
// dozen leagues x the 15-minute schedule TTL, and that is what made ProView
// spike the account's budget.
//
// caches.default costs NOTHING against any quota and is what warroom-api has
// always used — it has no KV binding at all, which is why WarRoom never
// contributed to these spikes. Putting it in front means repeat traffic inside
// a TTL touches neither KV read nor KV write. KV stays underneath as the
// durable, cross-colo, last-known-good copy, which the edge cache cannot be:
// it is per-colo and Cloudflare may evict it at any time.
const PV_EDGE = 'https://proview-cache.internal/';

function pvCorsResponse(body,xcache){
  return new Response(body,{headers:{...CORS,'X-Cache':xcache}});
}

async function cachedFetch(env,key,ttl,url,ctx,transform){
  const edge = caches.default;
  const edgeKey = new Request(PV_EDGE+encodeURIComponent(key));

  // Free, and the common case on any repeat view.
  try{
    const hit=await edge.match(edgeKey);
    if(hit) return pvCorsResponse(await hit.text(),'EDGE');
  }catch(e){}

  // One read covers both cases: a fresh hit, or the stale fallback if the
  // upstream call below fails.
  let cached=null;
  try{
    const e=await env.PV_CACHE.getWithMetadata(key,'text');
    if(e&&e.value) cached={body:e.value,at:(e.metadata&&e.metadata.at)||0};
  }catch(e){}
  if(cached&&Date.now()-cached.at<ttl*1000){
    // Populate the edge for the rest of this TTL so the next view is free.
    pvEdgePut(edge,edgeKey,cached.body,ttl,ctx);
    return pvCorsResponse(cached.body,'HIT');
  }

  let res;
  try{
    res=await fetch(url,{headers:{'x-api-key':LOL_KEY,'Origin':'https://lolesports.com','Referer':'https://lolesports.com/'}});
  }catch(e){
    if(cached) return pvCorsResponse(cached.body,'STALE');
    return j({error:'Upstream unreachable'},502);
  }
  if(!res.ok){
    if(cached) return pvCorsResponse(cached.body,'STALE');
    return j({error:'Upstream '+res.status},res.status);
  }
  let body=await res.text();
  // Reduce BEFORE storing, so the KV entry and every later HIT are the small
  // form rather than the raw upstream payload.
  if(transform){ try{ body=transform(body); }catch(e){ return j({error:'Transform failed: '+e.message},502); } }

  // Only WRITE when the content actually moved.
  //
  // A schedule is mostly static — matches are fixed days ahead — so the great
  // majority of these refreshes produced a byte-identical payload and spent a
  // KV write to store something already stored. Upstream fetches are free and
  // uncapped; KV writes are neither, so re-fetching to discover "nothing
  // changed" is the cheap half of this trade. The edge cache above bounds how
  // often that re-fetch happens to once per TTL per colo.
  //
  // The floor is what keeps the durable copy alive: skipping the write also
  // skips renewing its expirationTtl, so an entry that never changes would
  // quietly expire out of KV and take the stale-fallback with it.
  const unchanged = cached && cached.body===body;
  const age = cached ? Date.now()-cached.at : Infinity;
  if(!unchanged || age>PV_REFRESH_FLOOR_MS){
    await env.PV_CACHE.put(key,body,{expirationTtl:PV_KEEP,metadata:{at:Date.now()}});
  }
  pvEdgePut(edge,edgeKey,body,ttl,ctx);
  if(ctx&&ctx.waitUntil) ctx.waitUntil(sweepLegacyStale(env.PV_CACHE)); else await sweepLegacyStale(env.PV_CACHE);
  return pvCorsResponse(body,unchanged?'REVALIDATED':'MISS');
}

// Store in the edge cache for one TTL. Never awaited on the response path: it
// is an optimisation, and a cache write must not add latency to the answer.
function pvEdgePut(edge,edgeKey,body,ttl,ctx){
  try{
    const p=edge.put(edgeKey,new Response(body,{status:200,headers:{
      'Content-Type':'application/json','Cache-Control':'public, max-age='+ttl}}));
    if(ctx&&ctx.waitUntil) ctx.waitUntil(p); else p.catch(()=>{});
  }catch(e){}
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
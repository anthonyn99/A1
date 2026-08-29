/* RiftIQ: recovering games Riot's match INDEX never lists.

   ARAM: Mayhem is the case that exposed the gap. Checked against a live NA
   account on 2026-08-28:

     /lol/match/v5/matches/by-puuid/{puuid}/ids   a Mayhem game played that day is
         absent from the UNFILTERED list; the newest id returned was from the
         previous day.
     .../ids?queue=2400                           [] for that account and for 30
         other sampled ARAM players, while ?queue=450 and ?queue=480 both answer
         normally.
     /lol/match/v5/matches/{matchId}              serves ANY match id, including
         one belonging to a player the caller has never met.

   So the games exist in Riot's store and are missing only from the list the app
   pages through — no classifier change can find them. The spectator endpoint
   does report Mayhem (it is where the Live Game card gets the name), so the app
   writes down `gameId` while the game is up and fetches ${platformId}_${gameId}
   by id once it is over.

   The failure mode this guards is silent: nothing throws, nothing 429s, the
   profile loads fine — a whole queue is just quietly absent from Match History.

   Run: node tests/mayhem-backfill.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'riftiq.html'), 'utf8');

const results = [];
const check = (n, p, d) => { results.push(p); console.log('  ' + (p ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); };

/* Lift one contiguous run of riftiq.html's inline script into its own context.
   The page is a single 600KB file whose top level touches the DOM, so the parts
   under test are sliced out rather than the whole thing being executed. */
function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('markers not found: ' + startMarker);
  return SRC.slice(a, b);
}

/* ── The capture store and the by-id backfill ────────────────────────────── */
const store = {};
const ctx = {
  console,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  wrSetItem: (k, v) => { store[k] = String(v); return true; },
  wrRoutingFor: p => ({ na1: 'americas', kr: 'asia' }[p] || 'americas'),
  allMatches: [],
  summoner: { puuid: 'ME', routing: 'americas' },
  document: { getElementById: () => null },
  renderMatchHistory: () => '', visibleMatches: () => [],
  renderStatsSection: () => '', buildRecentPlayers: () => {},
  calls: [],
  respond: null,
};
ctx.riotFetch = async (ep, region, priority) => {
  ctx.calls.push({ ep, region, priority });
  return ctx.respond(ep);
};
vm.createContext(ctx);
vm.runInContext(slice('const WRCAP_KEY', '// Poll handle for the profile'), ctx);

const run = expr => vm.runInContext(expr, ctx);
const match = (id, ts, players) => ({
  metadata: { matchId: id, participants: players || ['ME', 'X'] },
  info: { gameStartTimestamp: ts, queueId: 2400, mapId: 12, gameMode: 'ARAM' },
});
// A capture old enough to be past the settle window.
const aged = id => ({ id: id, rout: 'americas', tries: 0,
                      at: Date.now() - 300000, seen: Date.now() - 300000 });
const seed = list => { store.wr_livecap_v1 = JSON.stringify({ ME: list }); };

(async () => {
  console.log('\nCapturing the id while the game is live');
  {
    run("rememberLiveGame('ME','na1',{gameId:5630421523,platformId:'NA1',gameQueueConfigId:2400})");
    const s = run('_capLoad()');
    check('the sighting is stored as platformId_gameId', s.ME[0].id === 'NA1_5630421523', s.ME[0].id);
    check('routing is derived from the platform', s.ME[0].rout === 'americas');
    run("rememberLiveGame('ME','na1',{gameId:5630421523,platformId:'NA1',gameQueueConfigId:2400})");
    check('re-sighting the same game does not duplicate it', run('_capLoad()').ME.length === 1);
  }

  console.log('\nA game is not asked for until it has had time to land');
  {
    ctx.respond = () => { throw new Error('a game seen seconds ago must not be fetched'); };
    ctx.calls.length = 0;
    const n = await run("backfillCapturedGames('ME','americas')");
    check('a live or just-ended game costs no request', ctx.calls.length === 0);
    check('and adds nothing yet', n === 0);
  }

  console.log('\nOnce it has settled, the game comes back by id');
  {
    seed([aged('NA1_5630421523')]);
    ctx.allMatches = [];
    ctx.respond = () => match('NA1_5630421523', 1000);
    ctx.calls.length = 0;
    const n = await run("backfillCapturedGames('ME','americas')");
    check('one game recovered', n === 1);
    check('fetched by id, not through the index',
      ctx.calls[0].ep === '/lol/match/v5/matches/NA1_5630421523', ctx.calls[0].ep);
    check('at background priority, so a click never waits behind it', ctx.calls[0].priority === 1);
    check('and it lands in allMatches', ctx.allMatches.length === 1);
  }

  console.log('\nA game the index DID return is never re-fetched');
  {
    ctx.respond = () => { throw new Error('already-held game must not be fetched'); };
    ctx.calls.length = 0;
    const n = await run("backfillCapturedGames('ME','americas')");
    check('no request spent', ctx.calls.length === 0);
    check('nothing added', n === 0);
  }

  console.log('\nOrdering: paging is a cursor into a newest-first list');
  {
    ctx.allMatches = [match('NA1_A', 3000), match('NA1_C', 1000)];
    run('allMatches.push(' + JSON.stringify(match('NA1_B', 2000)) + '); sortMatchesNewestFirst();');
    const order = ctx.allMatches.map(m => m.metadata.matchId).join(',');
    check('a recovered game slots in by timestamp', order === 'NA1_A,NA1_B,NA1_C', order);
  }

  console.log('\nAn id Riot will not serve stops costing requests');
  {
    seed([aged('NA1_GONE')]);
    ctx.allMatches = [];
    ctx.respond = () => { throw new Error('404'); };
    let spent = 0;
    for (let i = 0; i < 6; i++) {
      ctx.calls.length = 0;
      await run("backfillCapturedGames('ME','americas')");
      spent += ctx.calls.length;
    }
    check('gives up after WRCAP_TRIES attempts', spent === run('WRCAP_TRIES'), String(spent));
  }

  console.log('\nBut a rate limit is "ask later", not "does not exist"');
  {
    seed([aged('NA1_RL')]);
    ctx.respond = () => { throw new Error('429'); };
    let spent = 0;
    for (let i = 0; i < 6; i++) {
      ctx.calls.length = 0;
      await run("backfillCapturedGames('ME','americas')");
      spent += ctx.calls.length;
    }
    check('429 does not burn a retry', spent === 6, String(spent));
  }

  console.log('\nSanity guards');
  {
    seed([aged('NA1_OTHER')]);
    ctx.allMatches = [];
    ctx.respond = () => match('NA1_OTHER', 5000, ['SOMEONE', 'ELSE']);
    const n = await run("backfillCapturedGames('ME','americas')");
    check('a match this player is not in is rejected', n === 0 && ctx.allMatches.length === 0);

    seed([{ id: 'NA1_OLD', rout: 'americas', tries: 0,
            at: Date.now() - 20 * 86400000, seen: Date.now() - 20 * 86400000 }]);
    ctx.respond = () => { throw new Error('an expired capture must not be fetched'); };
    ctx.calls.length = 0;
    await run("backfillCapturedGames('ME','americas')");
    check('a capture older than WRCAP_TTL is forgotten, not retried',
      ctx.calls.length === 0 && run('_capLoad()').ME.length === 0);
  }

  /* ── Classification: a recovered Mayhem match must reach the right chip ─── */
  console.log('\nA recovered Mayhem match classifies as ARAM Mayhem');
  {
    const c2 = { console, localStorage: { getItem: () => null, setItem: () => {} },
                 wrSetItem: () => true, allMatches: [], _matchFilter: 'All',
                 document: { getElementById: () => null } };
    vm.createContext(c2);
    vm.runInContext(slice('const QUEUES = {', 'function matchesForFilter'), c2);

    const cat = (q, map, mode) => vm.runInContext(
      'matchCategory({info:{queueId:' + q + ',mapId:' + map + ',gameMode:' + JSON.stringify(mode) + '}})', c2);
    const label = (q, map, mode) => vm.runInContext(
      'queueLabel(' + q + ',' + map + ',' + JSON.stringify(mode) + ')', c2);

    // queue 2400 on Howling Abyss — exactly what the Live Game card reported.
    check('queue 2400 is labelled ARAM: Mayhem', label(2400, 12, 'ARAM') === 'ARAM: Mayhem', label(2400, 12, 'ARAM'));
    check('and buckets into the ARAM Mayhem chip', cat(2400, 12, 'ARAM') === 'ARAM Mayhem', cat(2400, 12, 'ARAM'));
    // Riot runs event modes on maps it has not published; gameMode still carries.
    check('Mayhem on an unpublished map still buckets correctly',
      cat(2400, 99, 'ARAM') === 'ARAM Mayhem', cat(2400, 99, 'ARAM'));
    check('plain ARAM is not swept into the Mayhem chip', cat(450, 12, 'ARAM') === 'ARAM', cat(450, 12, 'ARAM'));
    // 1750 is live in NA match data and is in no static table Riot publishes.
    check('an undocumented Arena id still reads off gameMode',
      cat(1750, 30, 'CHERRY') === 'Arena', cat(1750, 30, 'CHERRY'));
  }

  /* ── The paging cursor ───────────────────────────────────────────────────── */
  console.log('\nPaging counts the index, not the list');
  {
    check('loadMoreMatches pages from _mhIndexCount',
      /ids\?start=' \+ _mhIndexCount/.test(SRC));
    check('and never from allMatches.length, which recovered games inflate',
      !/ids\?start=' \+ allMatches\.length/.test(SRC));
    check('both profile loaders seed the cursor',
      (SRC.match(/_mhIndexCount = matchIds\.length/g) || []).length === 2);
  }

  const failed = results.filter(r => !r).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
  if (failed) process.exit(1);
})();

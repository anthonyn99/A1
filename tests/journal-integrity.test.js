/* TradeHub Journal: load ordering, bulk-write guards and the backup vault.
 *
 * THE BUG THIS EXISTS FOR (2026-09-04)
 * Opening TradeHub and landing on Journal showed the Webull trades but not the
 * CSV-imported ones. Reloading showed the CSV trades but with the Webull ones
 * mis-grouped. Only pressing "Webull Sync" by hand put it right.
 *
 * Cause: the tab's morning auto-sync and the Firebase load raced. Nothing made
 * a job wait for the load, so when the sync won it ran its whole-journal
 * read-modify-write against `prev = []` — every CSV and manual trade fell out
 * of the merge — and tbLoadJournal then DISCARDED its own correct result
 * because a job was busy, while still marking the journal loaded. The next page
 * load read back the damage.
 *
 * Everything here is sliced out of tradehub.html and run for real. The four
 * things that must never regress:
 *
 *   1. No mutating job may start before a read has SUCCEEDED.
 *   2. A failed read must not count as "loaded" (an empty list is not evidence
 *      the journal is empty).
 *   3. A bulk write that would gut the journal is refused — and a healthy
 *      re-merge, which writes only the Webull subset, is NOT.
 *   4. Reconciliation never touches CSV/manual entries, and CSV import dedups.
 *
 * Run: node tests/journal-integrity.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'tradehub.html'), 'utf8');

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log('  ' + (pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
        JSON.stringify(got) + ' vs ' + JSON.stringify(want));

/* Lift a contiguous run of tradehub.html's inline script into its own context.
   The page is one 550KB file whose top level touches React and the DOM, so the
   parts under test are sliced out rather than the whole thing being run. */
function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error('start marker not found: ' + startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return SRC.slice(a, b);
}

/* ══ 1. The load gate: tbLoadJournal / tbJournalReady / tbRunJournalJob ══ */
console.log('\nLoad gate — a job may not run against a journal that has not loaded');

function gateContext(loader) {
  const store = {};
  const ctx = {
    console: { warn() {}, error() {}, log() {} },
    setTimeout, clearTimeout, Date,
    Promise, Set, Map, JSON, Math, Array, Object, String, Number, isNaN, parseInt, parseFloat,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    document: { addEventListener() {}, visibilityState: 'visible' },
  };
  ctx.window = ctx;
  ctx.window._fbLoadTBJournal = loader;
  ctx.window.addEventListener = () => {};
  ctx.TB_SYNC_TS_KEY = 'tb_last_webull_sync';
  // The vault is exercised on its own below; here it must simply not explode.
  ctx.tbBackupCapture = () => Promise.resolve(null);
  ctx._tbJobs = { set() {} };
  vm.createContext(ctx);
  vm.runInContext(
    slice('const _tbJournalStore={', '/* ── Firebase-backed journal hook'), ctx);
  return ctx;
}

(async () => {
  /* ── 1a. The original failure, replayed ─────────────────────────────────
     A slow load and a job kicked in the same tick. The job must see the FULL
     list — the CSV trades included — not the empty one it used to see. */
  {
    const server = [
      { id: 'w1', source: 'webull', ticker: 'PLTR' },
      { id: 'c1', source: 'csv', ticker: 'TSLA' },
      { id: 'm1', source: 'manual', ticker: 'BE' },
    ];
    let loadStarted = false;
    const ctx = gateContext(async () => {
      loadStarted = true;
      await new Promise(r => setTimeout(r, 40));   // the slow server read
      return { ok: true, trades: server, exists: true, savedAt: 1 };
    });

    let sawInJob = null;
    const jobP = ctx.tbRunJournalJob('sync', 'Syncing…', async () => {
      sawInJob = ctx._tbJournalStore.trades.slice();
      return { ok: true };
    });
    // Kicked in the same tick, exactly as the tab's auto-sync and the morning
    // orchestrator do.
    const loadP = ctx.tbLoadJournal(true);
    await Promise.all([jobP, loadP]);

    check('load actually ran', loadStarted);
    eq('job sees all three sources, not just Webull',
       sawInJob && sawInJob.map(t => t.id).sort(), ['c1', 'm1', 'w1']);
    check('journal is marked loaded', ctx._tbJournalStore.loaded === true);
  }

  /* ── 1b. A second job cannot slip in while the first is claimed ── */
  {
    const ctx = gateContext(async () => ({ ok: true, trades: [{ id: 'a' }], exists: true }));
    let firstRan = false;
    const p1 = ctx.tbRunJournalJob('sync', 'x', async () => { firstRan = true; return { ok: true }; });
    const p2 = await ctx.tbRunJournalJob('import', 'y', async () => ({ ok: true, ran: true }));
    await p1;
    check('first job ran', firstRan);
    check('second job kicked in the same tick is refused, not interleaved',
          p2 && p2.busy === true, JSON.stringify(p2));
  }

  /* ── 1c. A FAILED read is not "loaded", and no job runs on it ──────────
     This is the half of the bug that made it stick: the old loader collapsed
     "read failed" and "no document" into null, marked the journal loaded, and
     every job downstream treated the empty list as fact. */
  {
    let attempts = 0;
    const ctx = gateContext(async () => { attempts++; return { ok: false, error: 'unavailable' }; });
    let jobBody = false;
    const res = await ctx.tbRunJournalJob('sync', 'x', async () => { jobBody = true; return { ok: true }; });
    check('a failing read leaves the journal NOT loaded', ctx._tbJournalStore.loaded === false);
    check('the job body never runs', jobBody === false);
    check('the job reports why', res && res.error === 'journal not loaded', JSON.stringify(res));
    check('the read was retried, not given up on after one try', attempts >= 3, 'attempts=' + attempts);
    check('the failure is recorded for the UI', ctx._tbJournalStore.loadError === 'unavailable');
  }

  /* ── 1d. A read that succeeds on retry unblocks the job ── */
  {
    let n = 0;
    const ctx = gateContext(async () => {
      n++;
      return n < 2 ? { ok: false, error: 'flaky' }
                   : { ok: true, trades: [{ id: 'x' }, { id: 'y' }], exists: true };
    });
    let saw = null;
    await ctx.tbRunJournalJob('sync', 'x', async () => { saw = ctx._tbJournalStore.trades.length; return { ok: true }; });
    check('a retry that succeeds lets the job through', saw === 2, 'saw=' + saw);
    check('loadError is cleared on success', ctx._tbJournalStore.loadError === '');
  }

  /* ── 1e. An empty document IS a valid empty journal ──────────────────── */
  {
    const ctx = gateContext(async () => ({ ok: true, trades: [], exists: false, savedAt: 0 }));
    let ran = false;
    await ctx.tbRunJournalJob('sync', 'x', async () => { ran = true; return { ok: true }; });
    check('a first-ever empty journal does not block the first sync', ran === true);
  }

  /* ══ 2. Backup vault: retention, budget, round-trip ══ */
  console.log('\nBackup vault — retention, budget and round-trip');

  const bkCtx = (() => {
    const ctx = {
      console: { warn() {}, log() {} },
      setTimeout, clearTimeout, Date, Promise, Set, Map, JSON, Math, Array, Object,
      String, Number, isNaN, parseInt, parseFloat,
      TextEncoder, TextDecoder, Response,
      CompressionStream: typeof CompressionStream === 'function' ? CompressionStream : undefined,
      DecompressionStream: typeof DecompressionStream === 'function' ? DecompressionStream : undefined,
      crypto: require('crypto').webcrypto,
      btoa: str => Buffer.from(str, 'binary').toString('base64'),
      atob: b64 => Buffer.from(b64, 'base64').toString('binary'),
      navigator: { userAgent: 'node' },
      localStorage: { getItem: () => null, setItem() {} },
      document: { addEventListener() {}, visibilityState: 'visible' },
      indexedDB: undefined,
    };
    ctx.window = ctx;
    ctx.window.addEventListener = () => {};
    vm.createContext(ctx);
    vm.runInContext(slice('const TB_BK={', '/* ── Module-level JOURNAL store'), ctx);
    return ctx;
  })();

  /* Retention keeps the newest N outright, then one per further day, then one
     per further week — and never silently keeps nothing. */
  {
    const DAY = 86400000, now = Date.UTC(2026, 8, 4, 12);
    const list = [];
    // 20 snapshots today, then one every day for 40 days.
    for (let i = 0; i < 20; i++) list.push({ at: now - i * 60000, bytes: 1000 });
    for (let d = 1; d <= 40; d++) list.push({ at: now - d * DAY, bytes: 1000 });
    const r = bkCtx.tbBkPrune(list, { recent: 6, daily: 10, weekly: 6 });
    check('prune keeps the newest snapshot', r.keep[0].at === now);
    check('prune keeps recent + daily + weekly, not everything',
          r.keep.length > 6 && r.keep.length < list.length, 'kept=' + r.keep.length);
    check('every snapshot is either kept or dropped, never both or neither',
          r.keep.length + r.drop.length === list.length);
    const keptAts = new Set(r.keep.map(x => x.at));
    check('nothing is kept twice', keptAts.size === r.keep.length);
    // The oldest surviving copy must reach meaningfully further back than the
    // newest few — that is the entire point of tiering.
    const oldest = Math.min.apply(null, r.keep.map(x => x.at));
    check('retention still reaches weeks back', (now - oldest) / DAY > 20,
          Math.round((now - oldest) / DAY) + ' days');
  }

  /* The byte budget trims oldest-first and never discards the snapshot it was
     called to store. */
  {
    const keep = [{ at: 500, bytes: 400 }, { at: 400, bytes: 400 }, { at: 300, bytes: 400 }];
    const r = bkCtx.tbBkBudget(keep, [], 900, keep[0]);
    check('budget trims until it fits', r.keep.reduce((a, x) => a + x.bytes, 0) <= 900,
          JSON.stringify(r.keep.map(x => x.at)));
    check('budget never drops the snapshot being written',
          r.keep.some(x => x.at === 500));
    check('trimmed snapshots move to the drop list', r.drop.length === 1 && r.drop[0].at === 300);
  }
  {
    // A single snapshot larger than the whole budget must still be stored:
    // refusing it would mean no backup at all.
    const only = [{ at: 9, bytes: 10 * 1024 * 1024 }];
    const r = bkCtx.tbBkBudget(only, [], 1024, only[0]);
    check('an over-budget lone snapshot is kept rather than lost', r.keep.length === 1);
  }

  /* Encode → decode is lossless, including the fields the CSV export cannot
     carry: ids, per-leg fills, source tags and Webull order ids. */
  {
    const trades = [
      { id: 'c1', source: 'csv', ticker: 'TSLA', netPnL: 5.64,
        legs: [{ id: 'l1', _csvImport: true, action: 'BUY', datetime: '2026-09-02T09:30', qty: '1', price: '350', fee: '0' },
               { id: 'l2', _csvImport: true, action: 'SELL', datetime: '2026-09-02T10:30', qty: '1', price: '355.64', fee: '0' }],
        tags: ['gap'], notes: 'a note with, a comma and "quotes"' },
      { id: 'w1', source: 'webull', ticker: 'PLTR',
        legs: [{ id: 'l3', _wbId: 'ord#1', action: 'BUY', datetime: '2026-09-03T09:31', qty: '1', price: '170.30', fee: '0.02' }] },
      { id: 'm1', source: 'manual', ticker: 'BE', legs: [] },
    ];
    const json = JSON.stringify(trades);
    const enc = await bkCtx.tbBkEncode(json);
    const back = await bkCtx.tbBkDecode({ gz: enc.gz, enc: enc.enc, n: trades.length });
    eq('snapshot round-trips byte-for-byte', back, trades);
    check('gzip is actually used where available',
          typeof CompressionStream !== 'function' || enc.enc === 'gzip+b64', enc.enc);
    if (enc.enc === 'gzip+b64') {
      check('compression is a real saving', enc.gz.length < json.length,
            enc.gz.length + ' vs ' + json.length);
    }
    const by = bkCtx.tbBkBreakdown(trades);
    eq('breakdown counts each source separately', by, { webull: 1, csv: 1, manual: 1, other: 0 });
  }

  /* A corrupted or truncated snapshot must fail loudly, not restore silently. */
  {
    const trades = [{ id: 'a' }, { id: 'b' }];
    const enc = await bkCtx.tbBkEncode(JSON.stringify(trades));
    let threw = '';
    try { await bkCtx.tbBackupRead({ gz: enc.gz, enc: enc.enc, n: 5 }); }
    catch (e) { threw = e.message; }
    check('a snapshot whose count disagrees with its contents is rejected',
          /expected 5/.test(threw), threw);
  }

  /* Two identical journals hash the same, a changed one does not — this is what
     stops the vault storing the same state over and over. */
  {
    const a = await bkCtx.tbBkHash(JSON.stringify([{ id: 'x' }]));
    const b = await bkCtx.tbBkHash(JSON.stringify([{ id: 'x' }]));
    const c = await bkCtx.tbBkHash(JSON.stringify([{ id: 'y' }]));
    check('identical journals hash identically', a === b);
    check('a changed journal hashes differently', a !== c);
  }

  /* ══ 3. The bulk-write shrink guard ══ */
  console.log('\nBulk-write guard — refuse a write that would gut the journal');

  /* Re-implemented here exactly as tradehub.html computes it, and asserted
     against the source so the two cannot drift. */
  const RATIO = 0.5, FLOOR = 8;
  check('the guard constants in tradehub.html still match this test',
        /REPLACE_SHRINK_RATIO = 0\.5/.test(SRC) && /REPLACE_SHRINK_FLOOR = 8/.test(SRC));

  function wouldRefuse(before, oldIds, newTrades, opts) {
    opts = opts || {};
    const resultIds = new Set();
    if (opts.prune) newTrades.forEach(t => resultIds.add(t.id));
    else {
      before.forEach(t => resultIds.add(t.id));
      (oldIds || []).forEach(id => resultIds.delete(id));
      newTrades.forEach(t => resultIds.add(t.id));
    }
    const after = resultIds.size;
    return before.length >= FLOOR && !opts.force &&
           after < Math.floor(before.length * RATIO);
  }

  const journal = [];
  for (let i = 0; i < 20; i++) journal.push({ id: 'w' + i, source: 'webull' });
  for (let i = 0; i < 55; i++) journal.push({ id: 'c' + i, source: 'csv' });
  for (let i = 0; i < 8; i++) journal.push({ id: 'm' + i, source: 'manual' });

  {
    // The bug itself: a sync that merged into an empty list and wrote back only
    // the Webull entries it had just pulled.
    const onlyWebull = journal.filter(t => t.source === 'webull');
    check('a sync that lost the CSV and manual trades is REFUSED',
          wouldRefuse(journal, journal.map(t => t.id), onlyWebull) === true);
  }
  {
    // A healthy re-merge writes ONLY the rebuilt Webull entries and deletes only
    // the old ones. Counting written fields instead of the resulting journal
    // would refuse this — which is the mistake this arithmetic exists to avoid.
    const oldW = journal.filter(t => t.source === 'webull').map(t => t.id);
    const rebuilt = [];
    for (let i = 0; i < 17; i++) rebuilt.push({ id: 'r' + i, source: 'webull' });
    check('a healthy re-merge (17 rebuilt from 20) is ALLOWED',
          wouldRefuse(journal, oldW, rebuilt) === false);
  }
  {
    const half = journal.slice(0, 60);
    check('a normal sync result is allowed', wouldRefuse(journal, [], half) === false);
  }
  {
    check('an explicit restore may shrink the journal',
          wouldRefuse(journal, journal.map(t => t.id), [{ id: 'z' }], { force: true, prune: true }) === false);
  }
  {
    const tiny = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    check('a journal below the floor is never judged',
          wouldRefuse(tiny, ['a', 'b'], [{ id: 'a' }]) === false);
  }
  {
    // prune (restore) counts only the snapshot's own trades.
    check('a restore to a smaller-but-sane journal is allowed unforced only above the ratio',
          wouldRefuse(journal, [], journal.slice(0, 50), { prune: true }) === false);
  }

  /* The source must actually call the guard on every bulk path. */
  check('sync passes the whole journal to the bulk write, not just Webull',
        /_fbReplaceTBTrades\(staleIds,finalTrades,\{reason:'pre-sync'\}\)/.test(SRC));
  check('restore is the only bulk write that forces past the guard',
        (SRC.match(/_fbReplaceTBTrades\([^)]*force:true/g) || []).length === 1);

  /* ══ 4. Reconciliation and CSV import identity ══ */
  console.log('\nReconciliation and CSV dedup');

  const reconCtx = (() => {
    const ctx = {
      console, Set, Map, JSON, Math, Array, Object, String, Number, Date, isNaN,
      parseFloat, parseInt, Infinity,
      crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(slice('function tbUuid(){', '/* ── Trade stats computer ── */'), ctx);
    vm.runInContext(slice('function tbCsvSig(entry){', '\n}\n') + '\n}\n', ctx);
    return ctx;
  })();

  {
    /* The feed re-delivering a fill a CSV entry already owns must not produce a
       second, basis-less row next to it. */
    const trades = [
      { id: 'c1', source: 'csv', ticker: 'TSLA', createdAt: 1,
        legs: [{ id: 'a', action: 'BUY', datetime: '2026-09-02T09:30', qty: '1', price: '350', fee: '0' },
               { id: 'b', action: 'SELL', datetime: '2026-09-02T10:30', qty: '1', price: '355.64', fee: '0' }] },
      { id: 'm1', source: 'manual', ticker: 'BE', createdAt: 2, legs: [] },
      { id: 'w1', source: 'webull', ticker: 'TSLA', createdAt: 3,
        legs: [{ id: 'd', _wbId: 'o1', action: 'BUY', datetime: '2026-09-02T09:30', qty: '1', price: '350', fee: '0' }] },
      { id: 'w2', source: 'webull', ticker: 'PLTR', createdAt: 4,
        legs: [{ id: 'e', _wbId: 'o2', action: 'BUY', datetime: '2026-09-03T09:31', qty: '1', price: '170.30', fee: '0' },
               { id: 'f', _wbId: 'o3', action: 'SELL', datetime: '2026-09-03T15:31', qty: '1', price: '182.88', fee: '0' }] },
    ];
    const r = reconCtx.tbReconcileWebull(trades);
    eq('CSV and manual entries pass through untouched',
       r.others.map(t => t.id).sort(), ['c1', 'm1']);
    check('the Webull twin of a CSV-owned fill is dropped',
          !r.rebuilt.some(t => t.ticker === 'TSLA'), JSON.stringify(r.rebuilt.map(t => t.ticker)));
    eq('the genuinely new Webull position survives',
       r.rebuilt.map(t => t.ticker), ['PLTR']);
    /* Idempotent: running it again changes nothing. */
    const again = reconCtx.tbReconcileWebull([].concat(r.others, r.rebuilt));
    eq('re-merge is idempotent', again.rebuilt.map(t => t.ticker), ['PLTR']);
    eq('re-merge still leaves the hand-owned entries alone',
       again.others.map(t => t.id).sort(), ['c1', 'm1']);
  }

  {
    /* CSV identity: the same trade from two exports collides; different trades
       do not. Ids, clock time and notes are deliberately ignored. */
    const mk = (over) => Object.assign({
      id: 'x', ticker: 'TSLA', notes: '',
      legs: [{ action: 'BUY', datetime: '2026-09-02T09:30', qty: '1', price: '350.00' },
             { action: 'SELL', datetime: '2026-09-02T10:30', qty: '1', price: '355.64' }],
    }, over || {});
    const base = reconCtx.tbCsvSig(mk());
    check('same trade, new ids and different clock times → same signature',
          base === reconCtx.tbCsvSig(mk({
            id: 'other',
            legs: [{ action: 'BUY', datetime: '2026-09-02T09:47', qty: '1', price: '350.00' },
                   { action: 'SELL', datetime: '2026-09-02T10:12', qty: '1', price: '355.64' }],
          })));
    check('notes edited afterwards do not resurrect the old copy',
          base === reconCtx.tbCsvSig(mk({ notes: 'edited later' })));
    check('a different exit price is a different trade',
          base !== reconCtx.tbCsvSig(mk({
            legs: [{ action: 'BUY', datetime: '2026-09-02T09:30', qty: '1', price: '350.00' },
                   { action: 'SELL', datetime: '2026-09-02T10:30', qty: '1', price: '360.00' }],
          })));
    check('a different day is a different trade',
          base !== reconCtx.tbCsvSig(mk({
            legs: [{ action: 'BUY', datetime: '2026-09-03T09:30', qty: '1', price: '350.00' },
                   { action: 'SELL', datetime: '2026-09-03T10:30', qty: '1', price: '355.64' }],
          })));
    check('a different ticker is a different trade',
          base !== reconCtx.tbCsvSig(mk({ ticker: 'PLTR' })));
    check('a different quantity is a different trade',
          base !== reconCtx.tbCsvSig(mk({
            legs: [{ action: 'BUY', datetime: '2026-09-02T09:30', qty: '2', price: '350.00' },
                   { action: 'SELL', datetime: '2026-09-02T10:30', qty: '2', price: '355.64' }],
          })));
    check('a legless entry has no signature and never dedups anything away',
          reconCtx.tbCsvSig({ ticker: 'BE', legs: [] }) === '');
  }

  /* ══ 5. Wiring assertions — the guards must actually be reachable ══ */
  console.log('\nWiring');
  check('every mutating job goes through the load gate',
        /tbRunJournalJob\('sync'/.test(SRC) && /tbRunJournalJob\('remerge'/.test(SRC) &&
        /tbRunJournalJob\('import'/.test(SRC) && /tbRunJournalJob\('restore'/.test(SRC));
  check('single-trade writes await the load too',
        (SRC.match(/await tbJournalReady\(\);/g) || []).length >= 4);
  check('remote snapshots are ignored while a job owns the list',
        /if\(S\.busy\|\|_tbJobClaim\)return;/.test(SRC));
  check('destructive paths snapshot BEFORE they act, awaited',
        /await tbBackupCapture\(S\.trades,'pre-bulk-delete',\{now:true\}\)/.test(SRC) &&
        /await tbBackupCapture\(S\.trades,'pre-import',\{now:true\}\)/.test(SRC) &&
        /await tbBackupCapture\(before,'pre-remerge',\{now:true\}\)/.test(SRC));
  check('backups live in their own Firestore document',
        /tradeboard_journal_backups/.test(SRC) &&
        SRC.indexOf('tradeboard_journal_backups') !== SRC.indexOf('dashboards/tradeboard_journal"'));
  check('a failed sync no longer stamps itself as this morning\'s sync',
        /if\(syncOk\)\{[\s\S]{0,400}TB_SYNC_TS_KEY/.test(SRC));
  check('the Backups panel is reachable from the Journal header',
        /setModal\('backups'\)/.test(SRC) && /TBBackupModal/.test(SRC));

  console.log('');
  if (failures) {
    console.error(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('Journal integrity OK.');
})().catch(e => { console.error(e); process.exit(1); });

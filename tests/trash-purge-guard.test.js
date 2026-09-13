/* ─────────────────────────────────────────────────────────────────────────────
 * The 30-day trash purge must never fire off cached state.
 *
 * THE BUG THIS PINS (found 2026-09-13, after 18 entries vanished)
 *
 * purgeExpiredTrash() calls hardDeleteEntry(), which calls deleteField() on
 * dashboards/journal — a PERMANENT delete that removes the entry for every
 * device and tombstones the id locally so no sync can bring it back.
 *
 * It used to run at boot, one statement after loadState():
 *
 *     loadState(); purgeExpiredTrash(); renderSidebar(); ...
 *
 * loadState() reads localStorage. So the decision to permanently delete was
 * made from this device's cached memory of the journal, before Firebase had
 * said anything. A cache that still holds a `trashed` stamp another device has
 * already reverted — or that is simply weeks stale — therefore destroys live
 * entries on the server.
 *
 * _bjWhenServerSeen does not save it: that defers the WRITE until the server
 * connects, but the decision was already made, so the delete fires the moment
 * the connection opens, with no re-check.
 *
 * Both journals had the identical code (BJ = Veda's Brainstorm Journal,
 * TJ = Tony's MyJournal), so both are pinned here.
 * ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('\nTrash purge cannot fire from cached state\n');

// ── 1. The boot line must no longer run an unguarded purge ───────────────────
console.log('The boot sequence');
{
  // Both journals boot with the same statement. Neither may call the purge in a
  // way that acts immediately off localStorage.
  // Anchored at line start so the prose in the guard's own comment, which
  // quotes the old boot line, is not counted as code.
  const bootLines = html.split('\n').filter(l => /^loadState\(\);\s*purgeExpiredTrash\(\)/.test(l));
  ok('the boot line still exists for both journals', bootLines.length === 2,
     'found ' + bootLines.length);
  // It is allowed to CALL purgeExpiredTrash() there — the function now treats a
  // bare call as "schedule me" — but it must not be able to delete from it.
  ok('boot calls it with no authoritative flag (so it only schedules)',
     bootLines.every(l => !/authoritative/.test(l)));
}

// ── 2. The purge refuses to act unless explicitly authoritative ──────────────
console.log('\nThe guard itself');
{
  // Pull each purgeExpiredTrash body out of the file.
  const bodies = [];
  const re = /function purgeExpiredTrash\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(html))) {
    // Brace-match from the opening brace.
    let i = html.indexOf('{', m.index + m[0].length - 1), depth = 0, end = i;
    for (; end < html.length; end++) {
      if (html[end] === '{') depth++;
      else if (html[end] === '}') { depth--; if (!depth) break; }
    }
    bodies.push({ arg: m[1].trim(), body: html.slice(i, end + 1) });
  }

  ok('both journals define purgeExpiredTrash', bodies.length === 2, 'found ' + bodies.length);
  ok('both take an options argument', bodies.every(b => b.arg.length > 0),
     JSON.stringify(bodies.map(b => b.arg)));
  ok('both bail out unless opts.authoritative is set',
     bodies.every(b => /if\s*\(!opts\s*\|\|\s*!opts\.authoritative\)/.test(b.body)));
  ok('both schedule instead of deleting when called bare',
     bodies.every(b => /Schedule(Purge)?\(\)/.test(b.body)));
  ok('both run at most once per session',
     bodies.every(b => /PurgeDone/.test(b.body)));
  ok('the actual delete still happens when authorised',
     bodies.every(b => /hardDeleteEntry/.test(b.body)));
}

// ── 3. The scheduler waits for an AUTHORITATIVE update, not just any sync ────
console.log('\nWhat the scheduler waits for');
{
  const scheds = [];
  const re = /function _(bj|tj)SchedulePurge\(\)\s*\{/g;
  let m;
  while ((m = re.exec(html))) {
    let i = html.indexOf('{', m.index + m[0].length - 1), depth = 0, end = i;
    for (; end < html.length; end++) {
      if (html[end] === '{') depth++;
      else if (html[end] === '}') { depth--; if (!depth) break; }
    }
    scheds.push({ app: m[1], body: html.slice(i, end + 1) });
  }

  ok('both journals have a scheduler', scheds.length === 2, 'found ' + scheds.length);

  // This is the heart of it. fb-XX-synced ALSO fires for cache-sourced
  // snapshots, so waiting on it would reintroduce the bug in a new costume.
  // Only the _authoritative flag on fb-XX-remote-update means "this is the
  // server's copy, not our memory of it".
  ok('neither waits on the plain synced event',
     scheds.every(s => !/fb-(bj|tj)-synced/.test(s.body)),
     'a cache-sourced snapshot fires that too');
  ok('both wait on the remote-update event',
     scheds.every(s => new RegExp('fb-' + s.app + '-remote-update').test(s.body)));
  ok('both require detail._authoritative before purging',
     scheds.every(s => /_authoritative/.test(s.body)));
  ok('both keep waiting (do not unsubscribe) on a non-authoritative update',
     scheds.every(s => /return;/.test(s.body) &&
                       s.body.indexOf('return;') < s.body.indexOf('removeEventListener')));
  ok('both only then call the purge with the authoritative flag',
     scheds.every(s => /purgeExpiredTrash\(\{\s*authoritative:\s*true\s*\}\)/.test(s.body)));
}

// ── 4. The merge still runs before the purge reads state ────────────────────
console.log('\nOrdering');
{
  // The purge reads state.entries, which _XXApplyRemote rewrites. The merge
  // listener must be registered FIRST so it has already run, and the purge is
  // additionally deferred a turn with setTimeout.
  ['bj', 'tj'].forEach(app => {
    const mergeAt = html.indexOf(`addEventListener('fb-${app}-remote-update', function(e) { _${app}ApplyRemote`);
    const purgeAt = html.indexOf(`function _${app}SchedulePurge`);
    ok(`${app}: the merge listener is registered before the purge scheduler`,
       mergeAt > -1 && purgeAt > -1 && mergeAt < purgeAt,
       `merge@${mergeAt} purge@${purgeAt}`);
  });
  const scheds = html.match(/setTimeout\(\(\) => purgeExpiredTrash\(\{ authoritative: true \}\), 0\)/g) || [];
  ok('both defer a turn so the merge finishes writing state first', scheds.length === 2,
     'found ' + scheds.length);
}

// ── 5. Manual deletion is untouched ─────────────────────────────────────────
console.log('\nWhat must still work');
{
  // Emptying the trash by hand is an explicit user action and must stay
  // immediate — the guard is only about the AUTOMATIC time-based purge.
  ok('the Trash UI can still purge on demand',
     /purge:\s*\(ids\)\s*=>\s*\{\s*\(ids\|\|\[\]\)\.forEach\(hardDeleteEntry\)/.test(html));
  ok('deleting an entry still moves it to the trash first',
     /function deleteEntry\(id\)/.test(html) && /entry\.trashed = /.test(html));
  ok('the 30-day TTL itself is unchanged',
     /BJ_TRASH_TTL = 30 \* 24 \* 60 \* 60 \* 1000/.test(html) &&
     /TJ_TRASH_TTL = 30 \* 24 \* 60 \* 60 \* 1000/.test(html));
}

console.log('\n' + (fail ? 'FAILED — ' + fail + ' of ' + (pass + fail)
                         : 'ALL PASSED — ' + pass + ' assertions') + '\n');
process.exit(fail ? 1 : 0);

// Simulate a full day of minute ticks and confirm the write-skip changes only
// the KV write count — never which ticks actually run the reminder query.
const GRACE = 15 * 60 * 1000;
const MAX_AGE = 15 * 60 * 1000;   // mirrors LOOKAHEAD_MAX_AGE_MS in worker.js
const MIN = 60 * 1000;

function shouldSkip(cache, now) {
  if (new Date(now).getMinutes() === 0) return false;   // top of hour always runs
  if (!cache || typeof cache.checkedAt !== 'number') return false;
  const age = now - cache.checkedAt;
  if (age < 0 || age > MAX_AGE) return false;
  if (cache.nextDueAt === null) return true;
  if (typeof cache.nextDueAt !== 'number') return false;
  return now < cache.nextDueAt - GRACE;
}

// `skipUselessWrite` is the new behaviour.
function simulate(reminders, skipUselessWrite) {
  let cache = null, writes = 0;
  const ran = [];
  const start = Date.UTC(2026, 7, 21, 0, 0, 0);
  for (let m = 0; m < 1440; m++) {
    const now = start + m * MIN;
    if (shouldSkip(cache, now)) continue;
    ran.push(m);                                   // this tick queried Firestore
    const upcoming = reminders.filter(r => r > now).sort((a, b) => a - b);
    const nextDueAt = upcoming.length ? upcoming[0] : null;
    if (skipUselessWrite && nextDueAt !== null && now >= nextDueAt - GRACE) continue;
    cache = { nextDueAt, checkedAt: now };
    writes++;
  }
  return { writes, ran };
}

const start = Date.UTC(2026, 7, 21, 0, 0, 0);
const at = (h, mm) => start + (h * 60 + mm) * MIN;

const cases = {
  'no reminders at all':       [],
  '3 reminders':               [at(9, 0), at(13, 30), at(18, 45)],
  '12 reminders through day':  Array.from({ length: 12 }, (_, i) => at(8 + i, 20)),
  'a dense morning (6 in 2h)': [at(9,0),at(9,20),at(9,40),at(10,0),at(10,20),at(10,40)],
};

let allSame = true;
console.log('day of 1,440 ticks\n');
console.log('  scenario                      writes(old)  writes(new)   saved   query-ticks identical?');
for (const [name, rs] of Object.entries(cases)) {
  const oldR = simulate(rs, false);
  const newR = simulate(rs, true);
  const same = JSON.stringify(oldR.ran) === JSON.stringify(newR.ran);
  if (!same) allSame = false;
  console.log('  ' + name.padEnd(30) +
    String(oldR.writes).padStart(8) + String(newR.writes).padStart(13) +
    String(oldR.writes - newR.writes).padStart(9) + '   ' + (same ? 'yes' : 'NO — BEHAVIOUR CHANGED'));
}
console.log('\n  ' + (allSame
  ? 'SAFE: every scenario runs the query on exactly the same ticks; only writes drop.'
  : 'UNSAFE: the skip changed which ticks run. Do not ship.'));
process.exit(allSame ? 0 : 1);

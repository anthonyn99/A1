// COPY of A1-Priv TradeHub/core/streaks.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Streaks: runs of up or down closes, and what followed runs like the current
// one. Pure; `c` is a list of closes, oldest first. Moves are fractions.

/** Signed count of consecutive up (+) or down (−) closes at each bar; a flat
 *  close ends the run (0). */
export function streak(c) {
  const out = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    if (c[i] > c[i - 1]) out[i] = out[i - 1] > 0 ? out[i - 1] + 1 : 1;
    else if (c[i] < c[i - 1]) out[i] = out[i - 1] < 0 ? out[i - 1] - 1 : -1;
  }
  return out;
}

/** The current streak and its history → `{ current, pctMove, longestUp,
 *  longestDown, afterSimilar: { n, avgNext1, avgNext5, upShare } }`.
 *  `pctMove = c_last / c_(last − |current|) − 1`. `afterSimilar` looks at every
 *  earlier day a streak of the same sign reached the current length (so every
 *  past streak at least this long, once): the average move over the next 1 and
 *  5 bars from that day's close, and the share whose next bar closed higher. */
export function streakStats(c) {
  const s = streak(c), last = c.length - 1;
  const current = last >= 0 ? s[last] : 0, len = Math.abs(current);
  let longestUp = 0, longestDown = 0;
  for (const x of s) { if (x > longestUp) longestUp = x; if (-x > longestDown) longestDown = -x; }
  const after = { n: 0, avgNext1: null, avgNext5: null, upShare: null };
  if (current !== 0) {
    let s1 = 0, up = 0, s5 = 0, n5 = 0;
    for (let j = 0; j < last; j++) {
      if (s[j] !== current) continue;
      const r1 = c[j + 1] / c[j] - 1;
      after.n++;
      s1 += r1;
      if (r1 > 0) up++;
      if (j + 5 <= last) { s5 += c[j + 5] / c[j] - 1; n5++; }
    }
    if (after.n) { after.avgNext1 = s1 / after.n; after.upShare = up / after.n; }
    if (n5) after.avgNext5 = s5 / n5;
  }
  return {
    current,
    pctMove: len ? c[last] / c[last - len] - 1 : 0,
    longestUp, longestDown,
    afterSimilar: after,
  };
}

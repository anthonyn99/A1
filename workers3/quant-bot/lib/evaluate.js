import { nyClock } from '../core/clock.js';
import { DAY_SETUPS } from '../core/detect-day.js';
import { evalLast, warmupOf } from '../core/live-eval.js';
import { entryPrices } from '../core/pilot.js';
import { checkEntry, flattenDue, size, LIMITS } from '../core/risk-book.js';
import { isStop, isTarget, isTime, ruleText, rulesOf } from '../core/strategy.js';
import { evalRule, series } from '../core/strategy-rules.js';
import { BAR_MINUTES, isFresh, withVolume } from './market.js';

const SHARD = 10;
const r2 = (value) => Math.round(value * 100) / 100;
const leaves = (block) => (block?.all || block?.any) ? [...(block.all || []), ...(block.any || [])].flatMap(leaves) : block ? [block] : [];

export function shardsFor(strategies, held = []) {
  const symbols = [...new Set([...strategies.flatMap(({ spec }) => spec.universe.symbols), ...held.map(({ sym }) => sym)])].sort();
  const out = [];
  for (let i = 0; i < symbols.length; i += SHARD) out.push(symbols.slice(i, i + SHARD));
  return out;
}

export const usesDaySetup = (spec) => spec.timeframe === '5m' && rulesOf(spec).some((r) => DAY_SETUPS.includes(r.setup));

function explain(context, spec, bar, session) {
  const i = context.bars.length - 1;
  const trueRules = leaves(spec.entry).filter((r) => evalRule(context, r, spec.side)[i]).map((r) => {
    if (r.setup === 'orb') {
      const range = context.bars.filter((b) => {
        const { date, minutes } = nyClock(b.t);
        return date === session.date && minutes < session.openMin + 15;
      });
      if (range.length) {
        const short = spec.side === 'short';
        const edge = (short ? Math.min(...range.map((b) => b.l)) : Math.max(...range.map((b) => b.h))).toFixed(2);
        return 'opening range ' + (short ? 'low ' : 'high ') + edge + (bar.closedRvol == null ? '' : ' on ' + bar.closedRvol.toFixed(2) + '× volume');
      }
    }
    const value = r.ind && series(context, r.ind, r.args)[i];
    return ruleText(r) + (Number.isFinite(value) ? ' (observed ' + r2(value) + ')' : '');
  });
  return (trueRules.length ? trueRules.join(', ') + ' at ' : 'Entry conditions met at ') + '$' + bar.c.toFixed(2);
}

/** Evaluation is pure. The coordinator owns broker access and reconciles caps before acting. */
export function candidate(row, sym, data, { now, session }) {
  const { spec } = row;
  const tf = spec.timeframe;
  const raw = data.bars?.[tf]?.[sym] || [];
  const last = raw.at(-1);
  if (!isFresh(last, tf, now, session)) return { skip: 'No fresh closed ' + tf + ' bar', barTime: last?.t ?? null };
  const dayVolume = usesDaySetup(spec);
  const previous = data.volume?.[sym];
  const bars = dayVolume && previous ? withVolume(raw, session.date, previous) : raw;
  const bar = bars.at(-1);
  if (dayVolume && bar.closedRvol == null) return { skip: 'No same-minute volume baseline', barTime: bar.t };
  const need = warmupOf(spec, { dayVolume });
  if (bars.length < need) return { skip: 'Needs ' + (Number.isFinite(need) ? need : 'unbounded') + ' bars for this strategy', barTime: bar.t };
  const daily = data.bars?.['1d']?.[sym];
  const bench = data.bars?.[tf]?.SPY;
  const result = evalLast(spec, bars, { dayVolume, side: spec.side, daily, bench, withContext: true });
  if (!result.fire) return null;
  const context = result.context, exits = spec.exit.any;
  const stopX = exits.find(isStop), targetX = exits.find(isTarget);
  const plan = entryPrices(context, context.bars.length - 1, spec.side, { stopX, targetX });
  if (!(plan.stop > 0)) return { skip: 'The rule fired, but the stop price is unavailable', barTime: bar.t };
  const stop = r2(plan.stop), target = plan.target == null ? null : r2(plan.target), price = r2(plan.price);
  const why = explain(context, spec, bar, session) + ', stop $' + stop.toFixed(2) +
    (target == null ? '' : ', target $' + target.toFixed(2)) + '.';
  return { symbol: sym, strategy: row.id, version: row.version, stage: row.stage, side: spec.side, style: spec.horizon,
    price, stop, target, why, thesis: spec.thesis || null, barTime: bar.t, window: spec.window, flattenBy: spec.flattenBy,
    maxPositions: spec.maxPositions };
}

export function checkCandidate(p, exposure, limits = LIMITS, { session, earningsSoon = false } = {}) {
  const count = exposure.positions.filter((pos) => pos.strategy === p.strategy).length;
  if (count >= p.maxPositions) return { ok: false, why: 'Strategy position cap of ' + p.maxPositions };
  const qty = size(p, exposure, limits).shares;
  const result = checkEntry({ ...p, sym: p.symbol, qty }, exposure, limits, {
    nyMinutes: session.minutes, half: session.half, window: p.window, flattenBy: p.flattenBy, earningsSoon,
  });
  return { ...result, qty };
}

export function exitReason(position, spec, bars, { now, session, daily, bench, volume } = {}) {
  if (flattenDue(position, session.minutes, { half: session.half, flattenBy: spec.flattenBy })) return 'Session flatten due';
  const raw = bars || [], last = raw.at(-1);
  if (!isFresh(last, spec.timeframe, now, session) || last.t < position.opened) return null;
  const maxBars = spec.exit.any.find(isTime)?.bars;
  if (maxBars && raw.filter((bar) => bar.t >= position.opened).length >= maxBars) return 'Maximum hold of ' + maxBars + ' bars reached';
  const dayVolume = usesDaySetup(spec), input = dayVolume && volume ? withVolume(raw, session.date, volume) : raw;
  if (input.length < warmupOf(spec, { dayVolume }) || (dayVolume && input.at(-1).closedRvol == null)) return null;
  const result = evalLast(spec, input, { side: position.side, daily, bench, dayVolume, rules: 'exit' });
  return result.fire ? 'Exit rule fired at $' + last.c.toFixed(2) : null;
}

// Cloudflare entrypoint. The HTTP API remains independently testable with Node.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import api from './worker.js';
import { inspectShard, runShadow } from './lib/shadow.js';
import { paperBroker } from './lib/alpaca.js';
import { loadVolume } from './lib/market.js';
import { readSettings } from './lib/state.js';
import { flattenPaper } from './lib/kill.js';
import { paperCycle } from './lib/paper-cycle.js';
import { runPaper } from './lib/paper-tick.js';
import { admit, review } from './lib/lifecycle.js';
import { briefTick } from './lib/brief.js';
import { nyClock } from './core/clock.js';
import { isTradingDay } from './core/holidays.js';

export class CortexShard extends WorkerEntrypoint {
  inspect(symbols, strategies, now, session, managed) {
    return inspectShard(this.env, symbols, strategies, now, session, {
      managed, volumeOf: (symbol, date) => this.ctx.exports.CortexShard.volume(symbol, date),
    });
  }

  volume(symbol, date) {
    return loadVolume(paperBroker(this.env), [symbol], date, caches.default);
  }
}

export class CortexExecution extends DurableObject {
  #tail = Promise.resolve();

  #serial(action) {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }

  cycle(input) {
    return this.#serial(() => paperCycle(this.env, input, paperBroker(this.env)));
  }

  liquidate() {
    return this.#serial(() => flattenPaper(this.env));
  }
}

/** N5: admit waiting strategies to shadow before the open; review the day once after the close (lib/lifecycle.js).
 *  A failure here is logged and never stops the trading tick. */
async function lifecycle(env, at) {
  const { date, minutes } = nyClock(at);
  if (!isTradingDay(date)) return;
  try {
    if (minutes >= 9 * 60 && minutes <= 9 * 60 + 30) await admit(env, at);
    else if (minutes >= 13 * 60 + 5) await review(env, at);
  } catch (e) { console.warn('Neo Cortex lifecycle:', e.message); }
}

export default {
  ...api,
  async scheduled(controller, env, ctx) {
    const at = controller.scheduledTime;
    await lifecycle(env, at);
    const { settings } = await readSettings(env.DB);
    const inspect = (symbols, strategies, now, session, managed = []) => ctx.exports.CortexShard.inspect(symbols, strategies, now, session, managed);
    let outcome;
    if (settings.mode === 'shadow') outcome = await runShadow(env, at, inspect);
    else if (settings.mode === 'paper') {
      outcome = await runPaper(env, at, inspect, (input) => env.EXECUTION.getByName('account').cycle(input));
    }
    if (outcome?.reason) console.warn('Neo Cortex:', outcome.reason);
    // N8: the daily brief after the close (lib/brief.js); never in the way of the trading tick.
    if (settings.mode !== 'off') {
      try { await briefTick(env, at); } catch (e) { console.warn('Neo Cortex brief:', e.message); }
    }
  },
};

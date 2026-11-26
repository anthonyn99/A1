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

export default {
  ...api,
  async scheduled(controller, env, ctx) {
    const { settings } = await readSettings(env.DB);
    const inspect = (symbols, strategies, now, session, managed = []) => ctx.exports.CortexShard.inspect(symbols, strategies, now, session, managed);
    const at = controller.scheduledTime;
    let outcome;
    if (settings.mode === 'shadow') outcome = await runShadow(env, at, inspect);
    else if (settings.mode === 'paper') {
      outcome = await runPaper(env, at, inspect, (input) => env.EXECUTION.getByName('account').cycle(input));
    }
    if (outcome?.reason) console.warn('Neo Cortex:', outcome.reason);
  },
};

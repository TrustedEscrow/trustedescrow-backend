import { pino, type Logger } from 'pino';
import { SorobanChain } from '../chain/soroban.js';
import { type Config, loadConfig } from '../config.js';
import { createDb, type DB } from '../db/index.js';

export interface WorkerRuntime {
  config: Config;
  db: DB;
  chain: SorobanChain;
  log: Logger;
}

export function createRuntime(name: string): WorkerRuntime {
  const config = loadConfig();
  return {
    config,
    db: createDb(config.DATABASE_URL),
    chain: new SorobanChain(config.SOROBAN_RPC_URL, config.STELLAR_NETWORK_PASSPHRASE),
    log: pino({ name, level: config.LOG_LEVEL }),
  };
}

/** An error the loop must not retry; the process exits non-zero so a supervisor alerts. */
export class FatalWorkerError extends Error {}

export async function runLoop(opts: {
  name: string;
  intervalMs: number;
  log: Logger;
  tick: () => Promise<void>;
  isFatal?: (err: unknown) => boolean;
  onStop: () => Promise<void>;
}): Promise<void> {
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  opts.log.info({ intervalMs: opts.intervalMs }, `${opts.name} started`);
  while (!stopping) {
    try {
      await opts.tick();
    } catch (err) {
      if (err instanceof FatalWorkerError || opts.isFatal?.(err)) {
        opts.log.fatal({ err }, `${opts.name} halted`);
        process.exitCode = 1;
        break;
      }
      opts.log.error({ err }, `${opts.name} tick failed`);
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await opts.onStop();
  opts.log.info(`${opts.name} stopped`);
}

import { Indexer, IndexerGapError } from '../indexer/indexer.js';
import { createRuntime, runLoop } from './runtime.js';

const { config, db, chain, log } = createRuntime('indexer');
const indexer = new Indexer({ db, chain, config, now: () => new Date(), log });

await runLoop({
  name: 'indexer',
  intervalMs: config.INDEXER_POLL_INTERVAL_MS,
  log,
  tick: async () => {
    // Drain backlogs quickly: keep ticking while whole windows come back.
    for (let i = 0; i < 20; i++) {
      const before = await db.selectFrom('indexer_state').select('last_processed_ledger').where('name', '=', 'main').executeTakeFirst();
      const { lastProcessedLedger } = await indexer.tick();
      if (before?.last_processed_ledger === lastProcessedLedger) break;
      const health = await chain.getHealth();
      if (lastProcessedLedger >= health.latestLedger) break;
    }
  },
  isFatal: (err) => err instanceof IndexerGapError,
  onStop: () => db.destroy(),
});

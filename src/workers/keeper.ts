import { Keypair } from '@stellar/stellar-sdk';
import { Keeper } from '../keeper/keeper.js';
import { createRuntime, runLoop } from './runtime.js';

const { config, db, chain, log } = createRuntime('keeper');
if (!config.KEEPER_SECRET) {
  log.fatal('KEEPER_SECRET is not set; the keeper needs a funded account to pay fees');
  process.exit(1);
}
const keypair = Keypair.fromSecret(config.KEEPER_SECRET);
log.info({ account: keypair.publicKey(), dryRun: config.KEEPER_DRY_RUN }, 'keeper account');

const keeper = new Keeper({ db, chain, server: chain.server, keypair, config, now: () => new Date(), log });

await runLoop({
  name: 'keeper',
  intervalMs: config.KEEPER_POLL_INTERVAL_MS,
  log,
  tick: () => keeper.tick(),
  onStop: () => db.destroy(),
});

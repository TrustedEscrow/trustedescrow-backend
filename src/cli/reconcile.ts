import { parseArgs } from 'node:util';
import { TERMINAL_STATES } from '../chain/types.js';
import { recordSnapshot } from '../indexer/escrow-cache.js';
import { INDEXER_NAME } from '../indexer/indexer.js';
import { isContractAddress } from '../lib/stellar.js';
import { createRuntime } from '../workers/runtime.js';

/**
 * Operator-triggered reconciliation for the read cache (ARCHITECTURE §6).
 *
 *   npm run reconcile -- --status
 *   npm run reconcile -- --from-ledger 123456     resume from a ledger still inside RPC retention
 *   npm run reconcile -- --skip-gap               accept the gap: jump to head, refresh known escrows
 *   npm run reconcile -- --add-escrow C...        add an escrow the indexer missed (repeatable)
 *   npm run reconcile -- --refresh-all            re-read every open escrow from contract storage
 *
 * Nothing here is authoritative: contract state is read live, and the cache only ever
 * answers "which escrows involve this address".
 */

const { values } = parseArgs({
  options: {
    status: { type: 'boolean', default: false },
    'from-ledger': { type: 'string' },
    'skip-gap': { type: 'boolean', default: false },
    'add-escrow': { type: 'string', multiple: true, default: [] },
    'refresh-all': { type: 'boolean', default: false },
  },
});

const { config, db, chain, log } = createRuntime('reconcile');
const now = () => new Date();

async function refresh(contractIds: string[], created?: boolean) {
  for (const id of contractIds) {
    const s = await chain.getEscrow(id);
    await recordSnapshot(db, s, {
      now: now(),
      arbitratorAddresses: config.ARBITRATOR_ADDRESSES,
      ...(created ? { created: { buyer: s.buyer, seller: s.seller, ledger: s.ledger, txHash: 'reconciled' } } : {}),
    });
    log.info({ contractId: id, state: s.state }, 'refreshed escrow');
  }
}

async function openEscrows(): Promise<string[]> {
  const rows = await db.selectFrom('escrows').select('contract_id').where('state', 'not in', [...TERMINAL_STATES]).execute();
  return rows.map((r) => r.contract_id);
}

try {
  const health = await chain.getHealth();
  const state = await db.selectFrom('indexer_state').selectAll().where('name', '=', INDEXER_NAME).executeTakeFirst();

  if (values.status || Object.values(values).every((v) => !v || (Array.isArray(v) && v.length === 0))) {
    console.log(JSON.stringify({ indexer: state ?? null, rpc: health }, null, 2));
  }

  if (values['from-ledger']) {
    const ledger = Number(values['from-ledger']);
    if (!Number.isInteger(ledger) || ledger < health.oldestLedger) {
      throw new Error(`--from-ledger must be an integer ≥ ${health.oldestLedger} (the RPC's oldest retained ledger)`);
    }
    await db
      .insertInto('indexer_state')
      .values({ name: INDEXER_NAME, last_processed_ledger: ledger - 1, status: 'ok' })
      .onConflict((oc) => oc.column('name').doUpdateSet({ last_processed_ledger: ledger - 1, status: 'ok', error: null, updated_at: now() }))
      .execute();
    log.info({ ledger }, 'indexer will resume from ledger');
  }

  if (values['skip-gap']) {
    await db
      .insertInto('indexer_state')
      .values({ name: INDEXER_NAME, last_processed_ledger: health.latestLedger, status: 'ok' })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          last_processed_ledger: health.latestLedger,
          status: 'ok',
          error: `gap skipped by operator at ${now().toISOString()}`,
          updated_at: now(),
        }),
      )
      .execute();
    log.warn(
      { latestLedger: health.latestLedger },
      'gap skipped: escrows created during the gap are missing from list views until added with --add-escrow',
    );
    await refresh(await openEscrows());
  }

  const add = values['add-escrow'] ?? [];
  for (const id of add) if (!isContractAddress(id)) throw new Error(`not a contract address: ${id}`);
  if (add.length > 0) await refresh(add, true);

  if (values['refresh-all']) await refresh(await openEscrows());
} catch (err) {
  log.error({ err }, 'reconcile failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}

import {
  Address,
  BASE_FEE,
  Contract,
  type Keypair,
  Operation,
  type Transaction,
  TransactionBuilder,
  rpc,
  type xdr,
} from '@stellar/stellar-sdk';
import { TERMINAL_STATES, type ChainClient, type EscrowSnapshot } from '../chain/types.js';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { recordSnapshot } from '../indexer/escrow-cache.js';

/**
 * The operator's scheduled job (ARCHITECTURE §4 "Functions", "TTL and archival").
 *
 * Triggers the permissionless timeouts and TTL bumps so users don't have to. Every
 * call it makes is one *anyone* may make, and funds still go only to the party the
 * contract predetermines, so the keeper key carries no authority; it only pays fees.
 * If this job stops, nobody is stranded. It runs as its own process so the API never
 * holds a key.
 */

export type KeeperMethod = 'cancel' | 'refund_after_delivery_timeout' | 'escalate' | 'refund_after_arbitration_timeout';

/** The timeout call due for an escrow at `nowSec`, mirroring the contract's `now >= deadline`. */
export function dueAction(s: EscrowSnapshot, nowSec: number): KeeperMethod | null {
  const passed = (d: Date | null | undefined) => !!d && nowSec >= Math.floor(d.getTime() / 1000);
  switch (s.state) {
    case 'Created':
      return passed(s.fundingDeadline) ? 'cancel' : null;
    case 'Funded':
      return passed(s.deliveryDeadline) ? 'refund_after_delivery_timeout' : null;
    case 'Delivered':
      return passed(s.receiptDeadline) ? 'escalate' : null;
    case 'Disputed':
      return passed(s.dispute?.deadline) ? 'refund_after_arbitration_timeout' : null;
    default:
      return null;
  }
}

export interface KeeperDeps {
  db: DB;
  chain: ChainClient;
  server: rpc.Server;
  keypair: Keypair;
  config: Pick<Config, 'STELLAR_NETWORK_PASSPHRASE' | 'KEEPER_BUMP_THRESHOLD_LEDGERS' | 'KEEPER_DRY_RUN' | 'ARBITRATOR_ADDRESSES'>;
  now: () => Date;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

const BUMP_CHECK_INTERVAL_MS = 24 * 3600 * 1000;

export class Keeper {
  constructor(private readonly deps: KeeperDeps) {}

  async tick(): Promise<void> {
    await this.runTimeouts();
    await this.runBumps();
  }

  private async runTimeouts(): Promise<void> {
    const { db, chain, config, log } = this.deps;
    const now = this.deps.now();
    const candidates = await db
      .selectFrom('escrows')
      .select('contract_id')
      .where((eb) =>
        eb.or([
          eb.and([eb('state', '=', 'Created'), eb('funding_deadline', '<=', now)]),
          eb.and([eb('state', '=', 'Funded'), eb('delivery_deadline', '<=', now)]),
          eb.and([eb('state', '=', 'Delivered'), eb('receipt_deadline', '<=', now)]),
          eb.and([eb('state', '=', 'Disputed'), eb('dispute_deadline', '<=', now)]),
        ]),
      )
      .limit(50)
      .execute();

    for (const { contract_id } of candidates) {
      try {
        // The cache may be stale: decide on live state.
        const live = await chain.getEscrow(contract_id);
        const method = dueAction(live, Math.floor(now.getTime() / 1000));
        if (method) {
          const args = method === 'cancel' ? [new Address(this.deps.keypair.publicKey()).toScVal()] : [];
          const hash = await this.invoke(contract_id, method, args);
          log.info({ contractId: contract_id, method, hash }, 'keeper triggered timeout');
        }
        const after = await chain.getEscrow(contract_id);
        await recordSnapshot(db, after, { now: this.deps.now(), arbitratorAddresses: config.ARBITRATOR_ADDRESSES });
      } catch (err) {
        // Another caller may have won the race; the next tick re-reads state.
        log.warn({ contractId: contract_id, err: String(err) }, 'keeper timeout call failed');
      }
    }
  }

  /** Extends instance TTL for open escrows close to archival. An archived escrow is frozen funds. */
  private async runBumps(): Promise<void> {
    const { db, chain, config, log } = this.deps;
    const now = this.deps.now();
    const open = await db
      .selectFrom('escrows')
      .select('contract_id')
      .where('state', 'not in', [...TERMINAL_STATES])
      .where((eb) => eb.or([eb('last_bumped_at', 'is', null), eb('last_bumped_at', '<', new Date(now.getTime() - BUMP_CHECK_INTERVAL_MS))]))
      .limit(50)
      .execute();

    for (const { contract_id } of open) {
      try {
        const { liveUntil, latestLedger } = await chain.getInstanceLiveUntil(contract_id);
        let liveUntilLedger = liveUntil;
        if (liveUntil === null || liveUntil - latestLedger < config.KEEPER_BUMP_THRESHOLD_LEDGERS) {
          const hash = await this.invoke(contract_id, 'bump', []);
          log.info({ contractId: contract_id, liveUntil, latestLedger, hash }, 'keeper bumped escrow TTL');
          liveUntilLedger = (await chain.getInstanceLiveUntil(contract_id)).liveUntil;
        }
        await db
          .updateTable('escrows')
          .set({ last_bumped_at: now, live_until_ledger: liveUntilLedger })
          .where('contract_id', '=', contract_id)
          .execute();
      } catch (err) {
        log.warn({ contractId: contract_id, err: String(err) }, 'keeper bump failed');
      }
    }
  }

  private async invoke(contractId: string, method: string, args: xdr.ScVal[]): Promise<string> {
    const { server, keypair, config, log } = this.deps;
    if (config.KEEPER_DRY_RUN) {
      log.info({ contractId, method }, 'keeper dry run: would invoke');
      return 'dry-run';
    }
    const build = async () =>
      new TransactionBuilder(await server.getAccount(keypair.publicKey()), {
        fee: BASE_FEE,
        networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
      })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(60)
        .build();

    let tx = await build();
    let sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationRestore(sim)) {
      await this.restore(sim.restorePreamble);
      tx = await build();
      sim = await server.simulateTransaction(tx);
    }
    if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(keypair);
    return this.send(prepared);
  }

  /** Restores an archived instance so the escrow can be touched again. */
  private async restore(preamble: rpc.Api.SimulateTransactionRestoreResponse['restorePreamble']): Promise<void> {
    const { server, keypair, config, log } = this.deps;
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: (BigInt(BASE_FEE) + BigInt(preamble.minResourceFee)).toString(),
      networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(60)
      .build();
    tx.sign(keypair);
    const hash = await this.send(tx);
    log.info({ hash }, 'keeper restored archived entries');
  }

  private async send(tx: Transaction): Promise<string> {
    const { server } = this.deps;
    const sent = await server.sendTransaction(tx);
    if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
      throw new Error(`sendTransaction ${sent.status} for ${sent.hash}`);
    }
    const final = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ended ${final.status}`);
    return sent.hash;
  }
}

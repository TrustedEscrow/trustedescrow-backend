import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { decodeEscrow } from './decode.js';
import { type ChainClient, ChainError, type EscrowSnapshot, type EventPage } from './types.js';

/**
 * Read-only Soroban RPC client. It holds no key: reads are simulated from a throwaway
 * source account that never signs anything.
 */
export class SorobanChain implements ChainClient {
  readonly server: rpc.Server;

  constructor(
    rpcUrl: string,
    readonly networkPassphrase: string,
  ) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  }

  async getHealth() {
    const h = await this.server.getHealth();
    return { latestLedger: h.latestLedger, oldestLedger: h.oldestLedger };
  }

  async getEvents(request: rpc.Api.GetEventsRequest): Promise<EventPage> {
    const r = await this.server.getEvents(request);
    return {
      events: r.events.map((e) => ({
        id: e.id,
        txHash: e.txHash,
        ledger: e.ledger,
        contractId: e.contractId?.contractId() ?? '',
        topic: e.topic,
        value: e.value,
        inSuccessfulContractCall: e.inSuccessfulContractCall,
      })),
      cursor: r.cursor,
      latestLedger: r.latestLedger,
      oldestLedger: r.oldestLedger,
    };
  }

  async getEscrow(contractId: string): Promise<EscrowSnapshot> {
    const { retval, latestLedger } = await this.simulateRead(contractId, 'get');
    return decodeEscrow(contractId, scValToNative(retval), latestLedger);
  }

  async getInstanceLiveUntil(contractId: string) {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const res = await this.server.getLedgerEntries(key);
    return { liveUntil: res.entries[0]?.liveUntilLedgerSeq ?? null, latestLedger: res.latestLedger };
  }

  private async simulateRead(contractId: string, method: string, ...args: xdr.ScVal[]) {
    const source = new Account(Keypair.random().publicKey(), '0');
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    let sim: rpc.Api.SimulateTransactionResponse;
    try {
      sim = await this.server.simulateTransaction(tx);
    } catch (e) {
      throw new ChainError(`RPC error reading ${contractId}: ${String(e)}`, 'rpc');
    }
    if (rpc.Api.isSimulationError(sim)) {
      const kind = /MissingValue|not found|non-existent/i.test(sim.error) ? 'not_found' : 'simulation';
      throw new ChainError(`simulation of ${method} on ${contractId} failed: ${sim.error}`, kind);
    }
    // A restore response still carries the read result; the archived state is surfaced
    // to callers that act on it (the keeper), not to readers.
    if (!sim.result) throw new ChainError(`simulation of ${method} on ${contractId} returned no result`, 'simulation');
    return { retval: sim.result.retval, latestLedger: sim.latestLedger };
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordSnapshot } from '../src/indexer/escrow-cache.js';
import {
  codeHashHex,
  contractAddress,
  createTestContext,
  grouped,
  login,
  randomCode,
  snapshotFor,
  stepUpWithWallet,
  termsInput,
  type LoginResult,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

interface Trade {
  buyer: Keypair;
  seller: Keypair;
  b: LoginResult;
  s: LoginResult;
  draftId: string;
  terms: any;
  termsHash: string;
}

async function agreedTrade(): Promise<Trade> {
  const buyer = Keypair.random();
  const seller = Keypair.random();
  const b = await login(ctx.app, buyer);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/drafts',
    headers: b.headers,
    payload: { role: 'buyer', counterpartyAddress: seller.publicKey(), terms: termsInput(ctx.clock) },
  });
  expect(created.statusCode).toBe(201);
  const draftId = created.json().id;
  const s = await login(ctx.app, seller);
  const accepted = await ctx.app.inject({ method: 'POST', url: `/drafts/${draftId}/accept`, headers: s.headers, payload: { revision: 1 } });
  expect(accepted.json().status).toBe('agreed');
  return { buyer, seller, b, s, draftId, terms: created.json().terms, termsHash: created.json().termsHash };
}

async function linkTrade(t: Trade, code = randomCode()) {
  const escrowId = contractAddress(50);
  ctx.chain.escrows.set(escrowId, snapshotFor(escrowId, t.terms, t.termsHash, codeHashHex(code)));
  const res = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/link`, headers: t.b.headers, payload: { contractId: escrowId } });
  expect(res.statusCode).toBe(200);
  return { escrowId, code };
}

function envelope(credentialId = 'passkey-1', ciphertext = randomBytes(32)) {
  return {
    credentialId,
    alg: 'A256GCM',
    kdf: { name: 'webauthn-prf', salt: randomBytes(32).toString('base64') },
    iv: randomBytes(12).toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function multipart(file: { filename: string; contentType: string; data: Buffer }, fields: Record<string, string> = {}) {
  const boundary = `----trustescrow${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('drafts and negotiation', () => {
  it('reaches agreement and serves the exact bytes to hash', async () => {
    const t = await agreedTrade();
    expect(t.terms).toMatchObject({ version: 1, ref: t.draftId, buyer: t.buyer.publicKey(), seller: t.seller.publicKey(), amount: '1500000000' });
    const res = await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/terms`, headers: t.s.headers });
    const body = res.json();
    expect(createHash('sha256').update(body.canonical).digest('hex')).toBe(t.termsHash);
    expect(body.termsHash).toBe(t.termsHash);
  });

  it('validates terms against delivery rules, rails and deadlines', async () => {
    const b = await login(ctx.app, Keypair.random());
    const post = (terms: object) =>
      ctx.app.inject({ method: 'POST', url: '/drafts', headers: b.headers, payload: { role: 'buyer', counterpartyAddress: Keypair.random().publicKey(), terms } });
    expect((await post(termsInput(ctx.clock, { delivery: { method: 'shipped', proofKind: 'Attestation', carrier: 'GIG' } }))).statusCode).toBe(400);
    expect((await post(termsInput(ctx.clock, { delivery: { method: 'shipped', proofKind: 'Tracking' } }))).statusCode).toBe(400);
    expect((await post(termsInput(ctx.clock, { rail: 'ngn' }))).json().error.code).toBe('UNKNOWN_RAIL');
    expect((await post(termsInput(ctx.clock, { fundingDeadline: ctx.clock.seconds - 1 }))).json().error.code).toBe('INVALID_FUNDING_DEADLINE');
    expect((await post(termsInput(ctx.clock, { windows: { delivery: 60, receipt: 3600, arbitration: 3600 } }))).statusCode).toBe(400);
    expect((await post(termsInput(ctx.clock, { amount: '0' }))).statusCode).toBe(400);
  });

  it('reopens negotiation on a counter-proposal and rejects stale acceptance', async () => {
    const t = await agreedTrade();
    const revise = await ctx.app.inject({
      method: 'POST',
      url: `/drafts/${t.draftId}/revisions`,
      headers: t.s.headers,
      payload: { terms: termsInput(ctx.clock, { amount: '1600000000' }) },
    });
    expect(revise.json().revision).toBe(2);
    const stale = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/accept`, headers: t.b.headers, payload: { revision: 1 } });
    expect(stale.json().error.code).toBe('STALE_REVISION');
    const ok = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/accept`, headers: t.b.headers, payload: { revision: 2 } });
    expect(ok.json()).toMatchObject({ status: 'agreed', agreedRevision: 2, termsHash: revise.json().termsHash });
  });

  it('stops a seller agreeing to terms that pay another address', async () => {
    const buyer = Keypair.random();
    const seller = Keypair.random();
    const b = await login(ctx.app, buyer);
    const draft = (
      await ctx.app.inject({ method: 'POST', url: '/drafts', headers: b.headers, payload: { role: 'buyer', counterpartyAddress: seller.publicKey(), terms: termsInput(ctx.clock) } })
    ).json();
    const s = await login(ctx.app, seller);
    await stepUpWithWallet(ctx.app, seller, s.headers);
    await ctx.app.inject({ method: 'PUT', url: '/me/payout-address', headers: s.headers, payload: { address: Keypair.random().publicKey() } });
    const res = await ctx.app.inject({ method: 'POST', url: `/drafts/${draft.id}/accept`, headers: s.headers, payload: { revision: 1 } });
    expect(res.json().error.code).toBe('PAYOUT_ADDRESS_MISMATCH');
  });

  it('hides drafts from everyone but the two parties', async () => {
    const t = await agreedTrade();
    const outsider = await login(ctx.app, Keypair.random());
    expect((await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}`, headers: outsider.headers })).statusCode).toBe(404);
    const arb = await login(ctx.app, ctx.arbitrator);
    expect((await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}`, headers: arb.headers })).statusCode).toBe(404);
  });

  it('links an escrow only when contract storage commits the agreed terms', async () => {
    const t = await agreedTrade();
    const wrong = contractAddress(40);
    ctx.chain.escrows.set(wrong, snapshotFor(wrong, t.terms, t.termsHash, codeHashHex(randomCode()), { amount: '1' }));
    const bad = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/link`, headers: t.b.headers, payload: { contractId: wrong } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.mismatches).toEqual(['amount']);

    const missing = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/link`, headers: t.b.headers, payload: { contractId: contractAddress(41) } });
    expect(missing.statusCode).toBe(404);

    const { escrowId, code } = await linkTrade(t);
    const draft = (await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}`, headers: t.s.headers })).json();
    expect(draft).toMatchObject({ status: 'linked', escrowContractId: escrowId, releaseCodeHash: codeHashHex(code) });
  });
});

describe('messaging', () => {
  it('delivers messages in order and refuses to store the delivery code', async () => {
    const t = await agreedTrade();
    const { code } = await linkTrade(t);

    const leak = await ctx.app.inject({
      method: 'POST',
      url: `/drafts/${t.draftId}/messages`,
      headers: t.b.headers,
      payload: { body: `Here you go: ${grouped(code).toLowerCase()}` },
    });
    expect(leak.statusCode).toBe(422);
    expect(leak.json().error.code).toBe('DELIVERY_CODE_IN_MESSAGE');

    const ok = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/messages`, headers: t.b.headers, payload: { body: 'Shipped yet?' } });
    expect(ok.statusCode).toBe(201);

    const list = (await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/messages`, headers: t.s.headers })).json();
    const bodies = list.messages.map((m: { body: string }) => m.body);
    expect(bodies.at(-1)).toBe('Shipped yet?');
    expect(list.messages.map((m: { senderRole: string }) => m.senderRole)).toEqual(['system', 'system', 'buyer']);
    const stored = await ctx.db.selectFrom('messages').select('body').execute();
    expect(stored.some((m) => m.body.toUpperCase().replace(/-/g, '').includes(code))).toBe(false);
  });

  it('uses the vault hash to block codes before the escrow exists', async () => {
    const t = await agreedTrade();
    const code = randomCode();
    await ctx.app.inject({ method: 'PUT', url: `/drafts/${t.draftId}/vault`, headers: t.b.headers, payload: { releaseCodeHash: codeHashHex(code), envelope: envelope() } });
    const leak = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/messages`, headers: t.b.headers, payload: { body: code } });
    expect(leak.statusCode).toBe(422);
  });
});

describe('encrypted code vault', () => {
  it('stores ciphertext for the buyer only, immutably, and reveals it only after step-up', async () => {
    const t = await agreedTrade();
    const code = randomCode();
    const hash = codeHashHex(code);
    const put = (headers: Record<string, string>, payload: object) => ctx.app.inject({ method: 'PUT', url: `/drafts/${t.draftId}/vault`, headers, payload });

    expect((await put(t.s.headers, { releaseCodeHash: hash, envelope: envelope() })).statusCode).toBe(403);

    const plaintext = Buffer.concat([Buffer.from(code, 'ascii'), randomBytes(16)]);
    const leaked = await put(t.b.headers, { releaseCodeHash: hash, envelope: envelope('passkey-1', plaintext) });
    expect(leaked.json().error.code).toBe('INVALID_ENVELOPE');

    expect((await put(t.b.headers, { releaseCodeHash: hash, envelope: envelope() })).statusCode).toBe(201);
    expect((await put(t.b.headers, { releaseCodeHash: codeHashHex(randomCode()), envelope: envelope('passkey-2') })).json().error.code).toBe(
      'CODE_HASH_IMMUTABLE',
    );
    expect((await put(t.b.headers, { releaseCodeHash: hash, envelope: envelope('passkey-2') })).json().error.code).toBe('STEP_UP_REQUIRED');

    await stepUpWithWallet(ctx.app, t.buyer, t.b.headers);
    expect((await put(t.b.headers, { releaseCodeHash: hash, envelope: envelope('passkey-1') })).json().error.code).toBe('ENVELOPE_EXISTS');
    expect((await put(t.b.headers, { releaseCodeHash: hash, envelope: envelope('passkey-2') })).statusCode).toBe(201);

    const read = await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/vault`, headers: t.b.headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().envelopes.map((e: { credentialId: string }) => e.credentialId)).toEqual(['passkey-1', 'passkey-2']);

    ctx.clock.advance(301_000);
    expect((await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/vault`, headers: t.b.headers })).json().error.code).toBe('STEP_UP_REQUIRED');

    await stepUpWithWallet(ctx.app, t.seller, t.s.headers);
    expect((await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/vault`, headers: t.s.headers })).statusCode).toBe(403);

    const audits = await ctx.db.selectFrom('audit_log').select('action').where('action', '=', 'vault.read').execute();
    expect(audits).toHaveLength(1);
  });

  it('rejects a code that differs from the on-chain hash once linked', async () => {
    const t = await agreedTrade();
    await linkTrade(t);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/drafts/${t.draftId}/vault`,
      headers: t.b.headers,
      payload: { releaseCodeHash: codeHashHex(randomCode()), envelope: envelope() },
    });
    expect(res.json().error.code).toBe('CODE_HASH_MISMATCH');
  });
});

describe('disputes, evidence and arbitration', () => {
  it('assembles a case file the arbitrator can see only once disputed', async () => {
    const t = await agreedTrade();
    const { escrowId } = await linkTrade(t);
    const arb = await login(ctx.app, ctx.arbitrator);

    const photo = randomBytes(2048);
    const upload = multipart({ filename: '../../etc/passwd.jpg', contentType: 'image/jpeg', data: photo }, { description: 'Box as received' });
    const up = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/evidence`, headers: { ...t.b.headers, ...upload.headers }, payload: upload.payload });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ filename: 'passwd.jpg', sha256: createHash('sha256').update(photo).digest('hex') });

    const exe = multipart({ filename: 'x.exe', contentType: 'application/x-msdownload', data: randomBytes(10) });
    expect((await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/evidence`, headers: { ...t.b.headers, ...exe.headers }, payload: exe.payload })).statusCode).toBe(422);

    // Not disputed yet: invisible to the arbitrator.
    expect((await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/evidence`, headers: arb.headers })).statusCode).toBe(404);

    const statement = () =>
      ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/dispute-case`, headers: t.b.headers, payload: { statement: 'The phone in the box is a different model.' } });
    expect((await statement()).json().error.code).toBe('STEP_UP_REQUIRED');
    await stepUpWithWallet(ctx.app, t.buyer, t.b.headers);
    expect((await statement()).statusCode).toBe(201);

    const now = ctx.clock.now();
    await recordSnapshot(
      ctx.db,
      snapshotFor(escrowId, t.terms, t.termsHash, ctx.chain.escrows.get(escrowId)!.releaseCodeHash, {
        state: 'Disputed',
        dispute: { openedBy: 'Buyer', openedAt: now, fromState: 'Delivered', deadline: new Date(now.getTime() + 7 * 86400_000) },
      }),
      { now, arbitratorAddresses: ctx.config.ARBITRATOR_ADDRESSES, created: { buyer: t.buyer.publicKey(), seller: t.seller.publicKey(), ledger: 900, txHash: 'aa' } },
    );
    ctx.chain.escrows.set(escrowId, { ...ctx.chain.escrows.get(escrowId)!, state: 'Disputed' });

    const evidence = (await ctx.app.inject({ method: 'GET', url: `/drafts/${t.draftId}/evidence`, headers: arb.headers })).json();
    expect(evidence).toHaveLength(1);
    const dl = await ctx.app.inject({ method: 'GET', url: `/evidence/${evidence[0].id}/download`, headers: arb.headers });
    expect(dl.rawPayload.equals(photo)).toBe(true);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');

    const note = await ctx.app.inject({ method: 'POST', url: `/drafts/${t.draftId}/messages`, headers: arb.headers, payload: { body: 'Please upload the waybill.' } });
    expect(note.json().senderRole).toBe('arbitrator');

    const disputes = (await ctx.app.inject({ method: 'GET', url: '/arbitration/disputes', headers: arb.headers })).json();
    expect(disputes.map((d: { contractId: string }) => d.contractId)).toEqual([escrowId]);
    const caseFile = (await ctx.app.inject({ method: 'GET', url: `/arbitration/escrows/${escrowId}`, headers: arb.headers })).json();
    expect(caseFile.termsCheck).toEqual({ onChain: t.termsHash, recomputed: t.termsHash, match: true });
    expect(caseFile.statements).toHaveLength(1);
    expect(caseFile.evidence).toHaveLength(1);

    const arbNotes = (await ctx.app.inject({ method: 'GET', url: '/notifications', headers: arb.headers })).json();
    expect(arbNotes.map((n: { kind: string }) => n.kind)).toEqual(expect.arrayContaining(['dispute_new', 'dispute_statement']));

    expect((await ctx.app.inject({ method: 'GET', url: '/arbitration/disputes', headers: t.b.headers })).statusCode).toBe(403);
  });
});

describe('escrow views', () => {
  it('lists from the cache and reads detail live from the chain', async () => {
    const t = await agreedTrade();
    const { escrowId } = await linkTrade(t);
    await recordSnapshot(ctx.db, ctx.chain.escrows.get(escrowId)!, {
      now: ctx.clock.now(),
      arbitratorAddresses: [],
      created: { buyer: t.buyer.publicKey(), seller: t.seller.publicKey(), ledger: 900, txHash: 'bb' },
    });
    const list = (await ctx.app.inject({ method: 'GET', url: '/escrows?role=seller', headers: t.s.headers })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'cache', contractId: escrowId, draftId: t.draftId });

    ctx.chain.escrows.set(escrowId, { ...ctx.chain.escrows.get(escrowId)!, state: 'Funded' });
    const detail = (await ctx.app.inject({ method: 'GET', url: `/escrows/${escrowId}`, headers: t.b.headers })).json();
    expect(detail).toMatchObject({ source: 'chain', state: 'Funded', draftId: t.draftId });
  });
});

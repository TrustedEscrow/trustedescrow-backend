import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpAt } from '../src/lib/totp.js';
import { base32Decode, createTestContext, login, stepUpWithWallet, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

async function enableTwoFactor(kp: Keypair, headers: { authorization: string }) {
  await stepUpWithWallet(ctx.app, kp, headers);
  const setup = await ctx.app.inject({ method: 'POST', url: '/me/2fa/setup', headers });
  expect(setup.statusCode).toBe(200);
  const secret = base32Decode(setup.json().secret);
  const enable = await ctx.app.inject({
    method: 'POST',
    url: '/me/2fa/enable',
    headers,
    payload: { code: totpAt(secret, currentStep(ctx.clock.t)) },
  });
  expect(enable.statusCode).toBe(200);
  return { secret, backupCodes: enable.json().backupCodes as string[] };
}

const codeNow = (secret: Buffer) => totpAt(secret, currentStep(ctx.clock.t));

describe('wallet sign-in', () => {
  it('signs in with a SEP-53 signature and creates the user', async () => {
    const kp = Keypair.random();
    const s = await login(ctx.app, kp);
    expect(s.status).toBe('active');
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: s.headers });
    expect(me.json()).toMatchObject({ address: kp.publicKey(), payoutAddress: kp.publicKey(), twoFactorEnabled: false, roles: [] });
  });

  it('rejects a signature by another key and burns the challenge', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await ctx.app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: kp.publicKey() } })).json();
    const attempt = (signer: Keypair) =>
      ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { challengeId, deviceId: 'device-0000000000000001', signature: Buffer.from(signer.signMessage(message)).toString('base64') },
      });
    expect((await attempt(Keypair.random())).statusCode).toBe(401);
    expect((await attempt(kp)).statusCode).toBe(401);
  });

  it('rejects an expired challenge', async () => {
    const kp = Keypair.random();
    const { challengeId, message } = (await ctx.app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: kp.publicKey() } })).json();
    ctx.clock.advance(301_000);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { challengeId, deviceId: 'device-0000000000000001', signature: Buffer.from(kp.signMessage(message)).toString('base64') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('grants the arbitrator role only to configured addresses', async () => {
    const s = await login(ctx.app, ctx.arbitrator);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: s.headers })).json().roles).toEqual(['arbitrator']);
  });

  it('logs out', async () => {
    const s = await login(ctx.app, Keypair.random());
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: s.headers })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: s.headers })).statusCode).toBe(401);
  });
});

describe('two-factor authentication', () => {
  it('requires step-up to enrol, then gates new devices on a second factor', async () => {
    const kp = Keypair.random();
    const s = await login(ctx.app, kp, 'device-aaaaaaaaaaaaaaaa');
    const noStepUp = await ctx.app.inject({ method: 'POST', url: '/me/2fa/setup', headers: s.headers });
    expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');

    const { secret, backupCodes } = await enableTwoFactor(kp, s.headers);
    expect(backupCodes).toHaveLength(10);

    expect((await login(ctx.app, kp, 'device-aaaaaaaaaaaaaaaa')).status).toBe('active');

    const fresh = await login(ctx.app, kp, 'device-bbbbbbbbbbbbbbbb');
    expect(fresh.status).toBe('pending_2fa');
    const blocked = await ctx.app.inject({ method: 'GET', url: '/me', headers: fresh.headers });
    expect(blocked.json().error.code).toBe('TWO_FACTOR_REQUIRED');

    // The code used for enrolment can't be replayed.
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/2fa', headers: fresh.headers, payload: { code: codeNow(secret) } })).statusCode).toBe(401);
    ctx.clock.advance(30_000);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/2fa', headers: fresh.headers, payload: { code: codeNow(secret) } })).statusCode).toBe(200);
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: fresh.headers });
    expect(me.json().twoFactorEnabled).toBe(true);
  });

  it('accepts each backup code once', async () => {
    const kp = Keypair.random();
    const s = await login(ctx.app, kp);
    const { backupCodes } = await enableTwoFactor(kp, s.headers);
    const d1 = await login(ctx.app, kp, 'device-cccccccccccccccc');
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/2fa', headers: d1.headers, payload: { code: backupCodes[0] } })).statusCode).toBe(200);
    const d2 = await login(ctx.app, kp, 'device-dddddddddddddddd');
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/2fa', headers: d2.headers, payload: { code: backupCodes[0] } })).statusCode).toBe(401);
  });

  it('locks after repeated failures', async () => {
    const kp = Keypair.random();
    const s = await login(ctx.app, kp);
    const { secret } = await enableTwoFactor(kp, s.headers);
    const valid = new Set([-1, 0, 1].map((d) => totpAt(secret, currentStep(ctx.clock.t) + d)));
    const wrong = ['111111', '222222', '333333', '444444'].find((c) => !valid.has(c))!;
    const d = await login(ctx.app, kp, 'device-eeeeeeeeeeeeeeee');
    for (let i = 0; i < 5; i++) {
      expect((await ctx.app.inject({ method: 'POST', url: '/auth/2fa', headers: d.headers, payload: { code: wrong } })).statusCode).toBe(401);
    }
    const locked = await ctx.app.inject({ method: 'POST', url: '/auth/2fa', headers: d.headers, payload: { code: wrong } });
    expect(locked.statusCode).toBe(429);
  });

  it('refuses wallet step-up once 2FA is on', async () => {
    const kp = Keypair.random();
    const s = await login(ctx.app, kp);
    const { secret } = await enableTwoFactor(kp, s.headers);
    const ch = (await ctx.app.inject({ method: 'POST', url: '/auth/step-up/challenge', headers: s.headers })).json();
    const viaWallet = await ctx.app.inject({
      method: 'POST',
      url: '/auth/step-up',
      headers: s.headers,
      payload: { challengeId: ch.challengeId, signature: Buffer.from(kp.signMessage(ch.message)).toString('base64') },
    });
    expect(viaWallet.json().error.code).toBe('TWO_FACTOR_CODE_REQUIRED');
    ctx.clock.advance(30_000);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/step-up', headers: s.headers, payload: { code: codeNow(secret) } })).statusCode).toBe(200);
  });
});

describe('payout address', () => {
  it('is 2FA-gated, time-limited, and announced to the user', async () => {
    const kp = Keypair.random();
    const s = await login(ctx.app, kp);
    const target = Keypair.random().publicKey();
    const change = () => ctx.app.inject({ method: 'PUT', url: '/me/payout-address', headers: s.headers, payload: { address: target } });

    expect((await change()).json().error.code).toBe('STEP_UP_REQUIRED');
    await stepUpWithWallet(ctx.app, kp, s.headers);
    const ok = await change();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().payoutAddress).toBe(target);

    const notes = (await ctx.app.inject({ method: 'GET', url: '/notifications', headers: s.headers })).json();
    expect(notes.map((n: { kind: string }) => n.kind)).toContain('payout_address_changed');

    ctx.clock.advance(301_000);
    expect((await change()).json().error.code).toBe('STEP_UP_REQUIRED');
  });
});

# TrustEscrow backend

[![CI](https://github.com/TrustedEscrow/trustedescrow-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/TrustedEscrow/trustedescrow-backend/actions/workflows/ci.yml)

The off-chain half of TrustEscrow: order drafts and negotiation, messaging, deadline notifications, 2FA, the encrypted delivery-code vault, dispute evidence, and the read cache that answers "which escrows involve me".

**Nothing here has authority over funds.** The API process holds no signing key and never submits a transaction. Escrow state is read live from contract storage; the cache only drives list views and notification schedules. If this whole service disappears, every escrow can still be completed or timed out from a CLI.

## Live deployment

| | |
|---|---|
| **Base URL** | `https://trustescrow-api-k5us.onrender.com` |
| **Health** | [`/healthz`](https://trustescrow-api-k5us.onrender.com/healthz) — `{"status":"ok"}` only after `select 1` reaches Postgres, so it covers the database too |
| **Host** | Render, free tier, built from the [`Dockerfile`](Dockerfile) |
| **Network** | Stellar testnet, factory `CDBD65SK43MNCD5JW7HXXV3EMG2OH2UJ3FKJ2O6OEQINV7NJZOIUQMRP` |
| **Consumer** | [trustedescrow-frontend-eta.vercel.app](https://trustedescrow-frontend-eta.vercel.app) |

There is no route at `/`; an unauthenticated `GET /healthz` is the only thing worth curling. CORS is restricted to the deployed frontend origins, so a browser on any other origin is refused by design.

**This deployment runs the API only.** Render's free tier has no background workers, so the indexer, notifier and keeper are built and tested but not running. In practice: list views can lag the chain, no emails go out, and no timeout or TTL call happens on its own. None of that traps funds — every call those workers make is permissionless, so anyone can make it, and escrow pages read contract storage directly.

Two free-tier limits worth knowing before pointing anyone at this:

- **It sleeps after about 15 minutes idle,** and the first request after that takes 25-35 seconds while the container starts. [`.github/workflows/keep-awake.yml`](.github/workflows/keep-awake.yml) tries to prevent that by pinging `/healthz` on a schedule, with a second interleaved schedule in the frontend repo. Treat it as best effort: GitHub does not promise punctual cron, and in practice these schedules are delayed or dropped often enough that a cold start still happens. An off-GitHub uptime monitor is the only reliable fix.
- **The managed Postgres instance expires 30 days after creation.** When it does, anything that needs the database — sign-in, drafts, chat, the vault, notifications — stops, while on-chain escrows are unaffected.

## Processes

| Process | Entry | What it does | Holds a key? |
|---|---|---|---|
| API | `src/server.ts` | HTTP API for the web app and arbitrator console | No |
| Indexer | `src/workers/indexer.ts` | Polls Soroban RPC `getEvents`, refreshes escrow snapshots, links drafts, plans notifications | No |
| Notifier | `src/workers/notifier.ts` | Emails due notifications to verified addresses | No |
| Keeper | `src/workers/keeper.ts` | Calls the permissionless timeouts (`cancel`, `refund_after_delivery_timeout`, `escalate`, `refund_after_arbitration_timeout`) and `bump` | Fee-paying key only |

The keeper's key has no authority: every call it makes is one anyone may make, and the contract decides where funds go. It runs separately so the API never has a key.

## Getting started

Requires Node 22+ and Postgres 14+.

```sh
npm install
cp .env.example .env            # set SERVER_ENCRYPTION_KEY, DATABASE_URL, FACTORY_CONTRACT_ID, RAILS
createdb trustescrow
npm run migrate
npm run dev                     # API on :3000
```

Workers, after `npm run build`:

```sh
npm run start:indexer
npm run start:notifier
npm run start:keeper            # needs KEEPER_SECRET; try KEEPER_DRY_RUN=true first
```

Tests run against an in-memory Postgres (PGlite), so they need no database:

```sh
npm test
npm run typecheck
```

### Code coverage

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) measures line coverage with [`@vitest/coverage-v8`](https://vitest.dev/guide/coverage) on every push and pull request, fails the build below 77% lines (the measured baseline, rounded down — not a guessed target; raise it as coverage genuinely improves), and uploads the report as a workflow artifact. Reproduce locally with:

```sh
npm run test:coverage
```

## Running in Docker

One image serves all four processes in the table above, since they share the same build output and dependencies. The API runs by default; override `CMD` to run a worker instead:

```sh
docker build -t trustescrow-backend .
docker run --rm -p 3000:3000 --env-file .env trustescrow-backend                                  # API
docker run --rm --env-file .env trustescrow-backend node dist/workers/indexer.js                  # indexer
docker run --rm --env-file .env trustescrow-backend node dist/workers/notifier.js                  # notifier
docker run --rm --env-file .env trustescrow-backend node dist/workers/keeper.js                    # keeper — needs KEEPER_SECRET
```

Run a migration against the container's own build output the same way, instead of `npm run migrate` (which needs `tsx` and the TypeScript source, neither present in this production image):

```sh
docker run --rm --env-file .env trustescrow-backend node dist/db/migrate-cli.js
```

The image runs as its base image's unprivileged `node` user, not root.

### Deploying on Render

[`render.yaml`](render.yaml) is a Blueprint for all four processes plus a managed Postgres database, built from the same Dockerfile. Connect this repo as a Blueprint in the Render dashboard, then fill in the values it prompts for (`SERVER_ENCRYPTION_KEY`, `FACTORY_CONTRACT_ID`, `ARBITRATOR_ADDRESSES`, `RAILS`, `KEEPER_SECRET`, and anything CORS/email-related). `KEEPER_DRY_RUN` defaults to `"true"` so the keeper doesn't send real transactions until you deliberately flip it. Run the first migration once via Render's shell (or a one-off job): `node dist/db/migrate-cli.js`.

**Evidence storage is ephemeral on Render's web service disk** — `LocalBlobStorage` writes to the local filesystem, which Render does not persist across deploys or restarts on the free/starter plan. This is a known limitation, not something this blueprint works around; don't rely on uploaded evidence surviving a redeploy until the storage backend is swapped for an object store.

## How the pieces fit the trust model

### Sign-in
Wallet sign-in uses [SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md) signed messages. `POST /auth/challenge` issues a single-use message bound to `AUTH_DOMAIN`, the network passphrase, a nonce and an expiry; `POST /auth/login` verifies the signature and issues an opaque bearer session. Only the SHA-256 of the session token is stored.

### 2FA
TOTP (RFC 6238) with ten single-use backup codes, replay protection, and a lockout after five failures. It gates what the backend mediates: signing in from a new device, changing the payout address, reading the code vault, and filing a dispute statement. These require a **step-up** (`POST /auth/step-up`) within the last five minutes. Users without 2FA step up by signing a fresh challenge with their wallet. 2FA does not and cannot gate on-chain calls: anyone holding their key can call the contract directly.

### Drafts
A draft is the negotiation before an escrow exists. Each proposal is an immutable revision. When both parties accept the same revision, its terms are frozen and `terms_hash = sha256(canonical_json(terms))` is fixed. Canonicalisation is RFC 8785, and the terms embed the draft id, so every hash is unique. `GET /drafts/:id/terms` returns the exact canonical bytes the buyer hashes into `Factory::create`.

Terms enforce the architecture's evidence rules: shipped goods need `Tracking` and a named carrier, digital goods need `Content`, and all windows must be between one hour and 365 days. The seller field is the seller's payout address. A seller cannot accept terms that pay a different address than their current one.

`POST /drafts/:id/link` reads the deployed escrow's storage and links it only if every committed field matches the agreed terms. The indexer does the same automatically when it sees the factory event.

### The encrypted code vault
`PUT /drafts/:id/vault` stores an envelope the buyer's client encrypted under a key derived from their own credential (passkey PRF, or Argon2id/PBKDF2 over a password that never leaves the device). The server has no key and cannot decrypt it. It does refuse envelopes that would weaken the scheme:

- The ciphertext must be exactly 32 bytes (the 16-byte code plus the AEAD tag).
- Password KDFs must meet a work-factor floor: Argon2id ≥ 64 MiB and 3 passes, PBKDF2 ≥ 600k iterations. A stolen database gives an attacker both the ciphertext and a tag to test guesses against.
- No field may contain the plaintext code. This is checked by hashing candidates against the committed `release_code_hash`.

The committed hash is write-once: there is no rotation and no delete. Rotation would let a buyer hand over the code and then invalidate it before the seller's transaction confirmed. A buyer who adds a device adds another envelope, which needs a step-up. Reading requires a step-up and is written to the audit log.

### Keeping codes out of the database
Messages, dispute statements, evidence descriptions and small text uploads are checked against the escrow's `release_code_hash` before anything is stored. A match is refused with `422 DELIVERY_CODE_IN_MESSAGE` (or the equivalent code for statements and evidence), and the response repeats the warning that the code is the money. The check is exact, so it has no false positives. It is a backstop; clients should warn first.

There is intentionally **no** endpoint to verify a seller-claimed code for the arbitrator. The console hashes it locally, so a plaintext code never reaches the server.

### Read cache and indexer
- Polls `getEvents` for the factory's `escrow` event and each escrow's `funded`, `proof`, `disputed`, `released`, `refunded` and `cancelled` events.
- Event payloads are used only to learn *which* escrow changed. The new state is always read back with a simulated `get`, so the cache never depends on event layout beyond the escrow address.
- Persists `last_processed_ledger`, and writes are idempotent on `(tx_hash, event_index)`.
- If the resume point has fallen out of RPC retention, the indexer marks a gap and exits non-zero until an operator reconciles:

```sh
npm run reconcile -- --status
npm run reconcile -- --from-ledger <n>     # still inside retention
npm run reconcile -- --skip-gap            # accept the gap, refresh known escrows
npm run reconcile -- --add-escrow C...     # add an escrow created during a gap
```

`GET /escrows` lists from the cache and labels results `source: "cache"`. `GET /escrows/:contractId` always reads contract storage (`source: "chain"`).

### Notifications
Planned from each fresh contract snapshot (`src/notifications/plan.ts`) with dedupe keys, so re-planning is idempotent:

- **Buyer:** proof submitted; 24 h before the receipt deadline.
- **Seller:** funded; 24 h before the delivery deadline; escalated.
- **Both parties:** dispute opened; 72 h before the arbitration deadline; resolved; released or refunded.
- **Arbitrators:** every new dispute; 72 h and 24 h before its deadline.

Reminders that no longer apply are cancelled when the state moves on. Notifications appear in-app once due. Users with a verified email also get them by email. Codes are never sent by email or SMS.

### Arbitration support
`/arbitration/*` requires an address listed in `ARBITRATOR_ADDRESSES`. It serves:

- open disputes, ordered by deadline;
- a case file: live contract state, the agreed terms with a recomputed-hash check against the on-chain `terms_hash`, chat history, statements and evidence;
- health stats: the share of releases that were two-sided, and the escalation rate per proof submission.

Arbitrators see a draft's messages and evidence only once its escrow has entered a dispute.

## API summary

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/challenge` `POST /auth/login` `POST /auth/2fa` `POST /auth/step-up/challenge` `POST /auth/step-up` `POST /auth/logout` |
| Account | `GET/PATCH /me` `PUT /me/payout-address`★ `PUT /me/email` `POST /me/email/verify` `GET /me/sessions` `DELETE /me/sessions/:id` `GET /me/devices` `DELETE /me/devices/:id`★ |
| 2FA | `POST /me/2fa/setup`★ `POST /me/2fa/enable`★ `POST /me/2fa/disable`★ `POST /me/2fa/backup-codes`★ |
| Drafts | `POST /drafts` `GET /drafts` `GET /drafts/:id` `POST /drafts/:id/revisions` `POST /drafts/:id/accept` `GET /drafts/:id/terms` `POST /drafts/:id/withdraw` `POST /drafts/:id/link` |
| Messages | `GET/POST /drafts/:id/messages` |
| Vault | `PUT /drafts/:id/vault` `GET /drafts/:id/vault`★ |
| Disputes | `POST /drafts/:id/evidence` (multipart) `GET /drafts/:id/evidence` `GET /evidence/:id/download` `POST /drafts/:id/dispute-case`★ `GET /drafts/:id/dispute-case` |
| Escrows | `GET /escrows` `GET /escrows/:contractId` |
| Notifications | `GET /notifications` `POST /notifications/:id/read` `POST /notifications/read-all` |
| Arbitration | `GET /arbitration/disputes` `GET /arbitration/escrows/:contractId` `GET /arbitration/stats` |
| Misc | `GET /healthz` `GET /meta` |

★ requires a recent step-up.

Errors are `{"error": {"code", "message", "details?"}}`.

## License

[MIT](LICENSE)


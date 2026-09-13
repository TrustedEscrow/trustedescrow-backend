# TrustEscrow backend

The off-chain half of TrustEscrow ([ARCHITECTURE.md §6](ARCHITECTURE.md#6-backend)): order drafts and negotiation, messaging, deadline notifications, 2FA, the encrypted delivery-code vault, dispute evidence, and the read cache that answers "which escrows involve me".

**Nothing here has authority over funds.** The API process holds no signing key and never submits a transaction. Escrow state is read live from contract storage; the cache only drives list views and notification schedules. If this whole service disappears, every escrow can still be completed or timed out from a CLI.

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

## How the pieces fit the trust model

### Sign-in
Wallet sign-in uses [SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md) signed messages. `POST /auth/challenge` issues a single-use message bound to `AUTH_DOMAIN`, the network passphrase, a nonce and an expiry; `POST /auth/login` verifies the signature and issues an opaque bearer session. Only the SHA-256 of the session token is stored.

### 2FA
TOTP (RFC 6238) with ten single-use backup codes, replay protection, and a lockout after five failures. It gates what the backend mediates: signing in from a new device, changing the payout address, reading the code vault, and filing a dispute statement. These require a **step-up** (`POST /auth/step-up`) within the last five minutes. Users without 2FA step up by signing a fresh challenge with their wallet. 2FA does not and cannot gate on-chain calls (D13).

### Drafts
A draft is the negotiation before an escrow exists. Each proposal is an immutable revision. When both parties accept the same revision, its terms are frozen and `terms_hash = sha256(canonical_json(terms))` is fixed. Canonicalisation is RFC 8785, and the terms embed the draft id, so every hash is unique. `GET /drafts/:id/terms` returns the exact canonical bytes the buyer hashes into `Factory::create`.

Terms enforce the architecture's evidence rules: shipped goods need `Tracking` and a named carrier, digital goods need `Content`, and all windows must be between one hour and 365 days. The seller field is the seller's payout address. A seller cannot accept terms that pay a different address than their current one.

`POST /drafts/:id/link` reads the deployed escrow's storage and links it only if every committed field matches the agreed terms. The indexer does the same automatically when it sees the factory event.

### The encrypted code vault
`PUT /drafts/:id/vault` stores an envelope the buyer's client encrypted under a key derived from their own credential (passkey PRF, or Argon2id/PBKDF2 over a password that never leaves the device). The server has no key and cannot decrypt it. It does refuse envelopes that would weaken the scheme:

- The ciphertext must be exactly 32 bytes (the 16-byte code plus the AEAD tag).
- Password KDFs must meet a work-factor floor: Argon2id ≥ 64 MiB and 3 passes, PBKDF2 ≥ 600k iterations. A stolen database gives an attacker both the ciphertext and a tag to test guesses against.
- No field may contain the plaintext code. This is checked by hashing candidates against the committed `release_code_hash`.

The committed hash is write-once: there is no rotation (D11) and no delete. A buyer who adds a device adds another envelope, which needs a step-up. Reading requires a step-up and is written to the audit log.

### Keeping codes out of the database
Messages, dispute statements, evidence descriptions and small text uploads are checked against the escrow's `release_code_hash` before anything is stored. A match is refused with `422 DELIVERY_CODE_IN_MESSAGE` (or the equivalent code for statements and evidence), and the response repeats the warning that the code is the money. The check is exact, so it has no false positives. It is a backstop; clients should warn first.

There is intentionally **no** endpoint to verify a seller-claimed code for the arbitrator. The console hashes it locally (ARCHITECTURE §7 "Dispute", step 6).

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

## Assumptions to confirm against the contracts

The contracts are not in this repository. The backend assumes:

1. `Escrow::get` returns the `Escrow` struct from ARCHITECTURE §4, with snake_case fields. Optional parts are enums: `proof: Pending | Submitted(Proof)`, `dispute: NotOpened | Opened(Dispute)`, `settlement: Open | Released(ReleasePath) | Refunded(RefundPath)`. See `src/chain/decode.ts`. Decoding fails loudly on any other shape.
2. Escrow events carry the event name as a `Symbol` in `topic[0]`.
3. The factory's `escrow` event carries the new escrow's contract address somewhere in its data. The indexer searches the data for it.
4. `cancel(caller: Address)` takes the caller, as documented. The keeper passes its own address after `funding_deadline`.

## Not done yet

- **Passkey smart-wallet sign-in (C… accounts).** Sign-in currently supports G… accounts through SEP-53. Contract-account sign-in needs verification against the wallet contract's signers.
- **Object storage.** Evidence is stored on local disk behind the `BlobStorage` interface; production needs an object-store implementation.
- **Real-time messaging.** Messages are fetched by polling with `?after=<seq>`. There is no push channel yet.

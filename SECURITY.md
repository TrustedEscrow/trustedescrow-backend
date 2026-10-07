# Security

This service mediates trades that settle in real money on-chain. Please report problems privately.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** (Security tab → *Report a vulnerability*) on this repository. Do not open a public issue or pull request for anything that could expose a delivery code, a user's funds, or another user's personal data.

Include the affected endpoint or process, the sequence of calls that triggers the problem, and what you expected to happen instead. A failing test is the most useful report there is.

## Status

Pre-production. No external security review has been performed on this codebase. Treat it accordingly before handling real funds or real personal data with it.

## What this service can't do

These are structural, not configuration — see [README.md](README.md#how-the-pieces-fit-the-trust-model) for the detail behind each:

- **The API process holds no signing key and never submits a transaction.** Escrow state changes only through calls the buyer, seller, or arbitrator sign themselves, or through the keeper's permissionless timeout/bump calls, which can only trigger outcomes the contract already predetermines.
- **The server never has a delivery code.** `vault_envelopes.ciphertext` is encrypted client-side under a key derived from the buyer's own credential; the server stores and returns it but cannot decrypt it. Messages, dispute statements, evidence descriptions and small text uploads are scanned against the committed `release_code_hash` before storage and refused on a match.
- **The keeper key carries no authority.** Every call it makes (`cancel`, `refund_after_delivery_timeout`, `escalate`, `refund_after_arbitration_timeout`, `sweep_fee`, TTL bumps) is one anyone could make; funds still go only where the contract already says they go. If the keeper process stops, nobody is stranded — the same calls can be made from the CLI or another operator.
- **2FA does not gate on-chain calls.** It gates what this backend mediates (new-device sign-in, changing the payout address, reading the vault, filing a dispute statement). Anyone holding a user's wallet key can call the contract directly regardless of this backend's state.

## What counts as a vulnerability here

Anything that breaks one of these:

1. **Code secrecy.** A plaintext delivery code reaching the database, a log line, or any API response.
2. **Vault confidentiality.** Any path that would let the server (or a database dump) decrypt a vault envelope, or that accepts an envelope encrypted below the documented work-factor floor (Argon2id < 64 MiB / 3 passes, PBKDF2 < 600k iterations) or the wrong ciphertext length.
3. **Session and 2FA integrity.** Bypassing step-up on a sensitive route, replaying a TOTP code or challenge, reusing a backup code, or forging a session without the stored token hash matching.
4. **Draft/escrow linking integrity.** Linking a draft to an escrow that doesn't commit the agreed terms exactly (buyer, seller, token, amount, windows, funding deadline, factory provenance).
5. **Access control.** A buyer, seller or arbitrator seeing or acting on a draft/escrow/evidence/statement that ARCHITECTURE.md (in the docs repo) says they shouldn't yet (e.g. an arbitrator seeing a draft before its escrow is disputed).
6. **Keeper/indexer correctness that risks funds.** The keeper acting on stale state in a way that double-spends an action, or the indexer attributing an event to the wrong escrow.

## Known limitations (not vulnerabilities)

- A user who loses every device and backup code, and never set a recovery email, cannot regain access to 2FA. Nothing here grants a backdoor around it.
- The read cache (`GET /escrows`) can lag behind the chain between indexer polls, or go stale during a reconciliation gap. `GET /escrows/:contractId` and anything that acts on an escrow always reads contract storage live, never the cache.
- The keeper pays its own transaction fees from its own account; it has no funding mechanism built in. An unfunded keeper key simply means timeouts aren't triggered automatically — a permissionless action is always still available from the CLI.
- Local disk evidence storage (`LocalBlobStorage`) does not survive a redeploy or scale across instances. This is a known operational gap (tracked separately), not a security one.

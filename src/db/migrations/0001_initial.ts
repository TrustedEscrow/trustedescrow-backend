import { type Kysely, sql } from 'kysely';

/**
 * Statements run one at a time: PGlite (used in tests) binds through the extended
 * protocol, which rejects multi-statement strings.
 *
 * There is intentionally no column anywhere that could hold a plaintext delivery code.
 * `vault_envelopes.ciphertext` is client-encrypted; the server has no key for it.
 */
const up_statements = [
  `create table users (
    id uuid primary key default gen_random_uuid(),
    address text not null unique,
    payout_address text not null,
    display_name text,
    email text,
    email_verified_at timestamptz,
    email_verify_token_hash text,
    email_verify_expires_at timestamptz,
    totp_secret_sealed text,
    totp_pending_secret_sealed text,
    totp_enabled_at timestamptz,
    totp_last_step integer,
    totp_failed_attempts integer not null default 0,
    totp_locked_until timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index users_payout_address_idx on users (payout_address)`,

  `create table auth_challenges (
    id uuid primary key default gen_random_uuid(),
    address text not null,
    purpose text not null check (purpose in ('login', 'step_up')),
    message text not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
  )`,

  `create table devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    device_key_hash text not null,
    label text,
    trusted_at timestamptz,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    unique (user_id, device_key_hash)
  )`,

  `create table sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    device_id uuid not null references devices(id) on delete cascade,
    token_hash text not null unique,
    status text not null check (status in ('active', 'pending_2fa')),
    step_up_at timestamptz,
    ip text,
    user_agent text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
  )`,
  `create index sessions_user_idx on sessions (user_id)`,

  `create table backup_codes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    code_hash text not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create index backup_codes_user_idx on backup_codes (user_id)`,

  `create table drafts (
    id uuid primary key default gen_random_uuid(),
    buyer_address text not null,
    seller_address text not null,
    created_by uuid not null references users(id),
    status text not null check (status in ('negotiating', 'agreed', 'linked', 'withdrawn')),
    current_revision integer not null default 0,
    agreed_revision integer,
    terms_hash text,
    escrow_contract_id text unique,
    release_code_hash text check (release_code_hash ~ '^[0-9a-f]{64}$'),
    linked_at timestamptz,
    withdrawn_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (buyer_address <> seller_address)
  )`,
  `create index drafts_buyer_idx on drafts (buyer_address)`,
  `create index drafts_seller_idx on drafts (seller_address)`,
  `create index drafts_terms_hash_idx on drafts (terms_hash)`,

  `create table draft_revisions (
    draft_id uuid not null references drafts(id) on delete cascade,
    revision integer not null,
    proposed_by uuid not null references users(id),
    terms jsonb not null,
    terms_hash text not null,
    note text,
    created_at timestamptz not null default now(),
    primary key (draft_id, revision)
  )`,

  `create table draft_acceptances (
    draft_id uuid not null,
    revision integer not null,
    user_id uuid not null references users(id),
    accepted_at timestamptz not null default now(),
    primary key (draft_id, revision, user_id),
    foreign key (draft_id, revision) references draft_revisions(draft_id, revision) on delete cascade
  )`,

  `create table messages (
    id uuid primary key default gen_random_uuid(),
    draft_id uuid not null references drafts(id) on delete cascade,
    seq integer not null,
    sender_user_id uuid references users(id),
    sender_role text not null check (sender_role in ('buyer', 'seller', 'arbitrator', 'system')),
    body text not null,
    created_at timestamptz not null default now(),
    unique (draft_id, seq)
  )`,

  `create table vault_entries (
    id uuid primary key default gen_random_uuid(),
    draft_id uuid not null unique references drafts(id) on delete cascade,
    buyer_user_id uuid not null references users(id),
    release_code_hash text not null check (release_code_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now()
  )`,

  `create table vault_envelopes (
    id uuid primary key default gen_random_uuid(),
    entry_id uuid not null references vault_entries(id) on delete cascade,
    credential_id text not null,
    alg text not null,
    kdf text not null,
    kdf_params jsonb not null,
    iv text not null,
    ciphertext text not null,
    created_at timestamptz not null default now(),
    unique (entry_id, credential_id)
  )`,

  `create table escrows (
    contract_id text primary key,
    buyer_address text not null,
    seller_address text not null,
    draft_id uuid references drafts(id) on delete set null,
    created_ledger integer not null,
    created_tx_hash text not null,
    state text,
    arbitrator text,
    token text,
    amount text,
    fee_bps integer,
    terms_hash text,
    release_code_hash text,
    funding_deadline timestamptz,
    funded_at timestamptz,
    delivery_deadline timestamptz,
    receipt_deadline timestamptz,
    dispute_opened_by text,
    dispute_opened_at timestamptz,
    dispute_deadline timestamptz,
    proof_kind text,
    proof_uri text,
    proof_hash text,
    proof_submitted_at timestamptz,
    settlement text,
    settlement_path text,
    snapshot_ledger integer,
    snapshot_at timestamptz,
    live_until_ledger integer,
    last_bumped_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index escrows_buyer_idx on escrows (buyer_address)`,
  `create index escrows_seller_idx on escrows (seller_address)`,
  `create index escrows_state_idx on escrows (state)`,
  `create index escrows_terms_hash_idx on escrows (terms_hash)`,

  `create table chain_events (
    tx_hash text not null,
    event_index integer not null,
    event_id text not null,
    ledger integer not null,
    contract_id text not null,
    name text not null,
    topics jsonb not null,
    value jsonb,
    created_at timestamptz not null default now(),
    primary key (tx_hash, event_index)
  )`,
  `create index chain_events_contract_idx on chain_events (contract_id, ledger)`,

  `create table indexer_state (
    name text primary key,
    last_processed_ledger integer not null,
    status text not null check (status in ('ok', 'gap')),
    error text,
    updated_at timestamptz not null default now()
  )`,

  `create table notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    dedupe_key text not null unique,
    kind text not null,
    escrow_contract_id text,
    draft_id uuid references drafts(id) on delete cascade,
    title text not null,
    body text not null,
    send_at timestamptz not null,
    sent_at timestamptz,
    email_sent_at timestamptz,
    cancelled_at timestamptz,
    read_at timestamptz,
    attempts integer not null default 0,
    last_error text,
    created_at timestamptz not null default now()
  )`,
  `create index notifications_due_idx on notifications (send_at) where sent_at is null and cancelled_at is null`,
  `create index notifications_user_idx on notifications (user_id, send_at desc)`,

  `create table evidence (
    id uuid primary key default gen_random_uuid(),
    draft_id uuid not null references drafts(id) on delete cascade,
    uploaded_by uuid not null references users(id),
    uploader_role text not null,
    filename text not null,
    content_type text not null,
    size_bytes integer not null,
    sha256 text not null,
    storage_key text not null unique,
    description text,
    created_at timestamptz not null default now()
  )`,
  `create index evidence_draft_idx on evidence (draft_id)`,

  `create table dispute_statements (
    id uuid primary key default gen_random_uuid(),
    draft_id uuid not null references drafts(id) on delete cascade,
    user_id uuid not null references users(id),
    role text not null,
    statement text not null,
    created_at timestamptz not null default now()
  )`,
  `create index dispute_statements_draft_idx on dispute_statements (draft_id)`,

  `create table audit_log (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references users(id) on delete set null,
    action text not null,
    subject text,
    ip text,
    user_agent text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`,
  `create index audit_log_user_idx on audit_log (user_id, created_at desc)`,
];

const tables = [
  'audit_log',
  'dispute_statements',
  'evidence',
  'notifications',
  'indexer_state',
  'chain_events',
  'escrows',
  'vault_envelopes',
  'vault_entries',
  'messages',
  'draft_acceptances',
  'draft_revisions',
  'drafts',
  'backup_codes',
  'sessions',
  'devices',
  'auth_challenges',
  'users',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of up_statements) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of tables) {
    await sql.raw(`drop table if exists ${table} cascade`).execute(db);
  }
}

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;
/** jsonb: inserted via the `json()` helper so both node-pg and PGlite bind it identically. */
type Json<T> = ColumnType<T, unknown, unknown>;

export interface UsersTable {
  id: Generated<string>;
  address: string;
  payout_address: string;
  display_name: string | null;
  email: string | null;
  email_verified_at: Timestamp | null;
  email_verify_token_hash: string | null;
  email_verify_expires_at: Timestamp | null;
  totp_secret_sealed: string | null;
  totp_pending_secret_sealed: string | null;
  totp_enabled_at: Timestamp | null;
  totp_last_step: number | null;
  totp_failed_attempts: Generated<number>;
  totp_locked_until: Timestamp | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AuthChallengesTable {
  id: Generated<string>;
  address: string;
  purpose: 'login' | 'step_up';
  message: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  device_key_hash: string;
  label: string | null;
  trusted_at: Timestamp | null;
  first_seen_at: CreatedAt;
  last_seen_at: UpdatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  device_id: string;
  token_hash: string;
  status: 'active' | 'pending_2fa';
  step_up_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
  created_at: CreatedAt;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface BackupCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Timestamp | null;
  created_at: CreatedAt;
}

export type DraftStatus = 'negotiating' | 'agreed' | 'linked' | 'withdrawn';

export interface DraftsTable {
  id: Generated<string>;
  buyer_address: string;
  seller_address: string;
  created_by: string;
  status: DraftStatus;
  current_revision: Generated<number>;
  agreed_revision: number | null;
  terms_hash: string | null;
  escrow_contract_id: string | null;
  release_code_hash: string | null;
  linked_at: Timestamp | null;
  withdrawn_at: Timestamp | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface DraftRevisionsTable {
  draft_id: string;
  revision: number;
  proposed_by: string;
  terms: Json<Record<string, unknown>>;
  terms_hash: string;
  note: string | null;
  created_at: CreatedAt;
}

export interface DraftAcceptancesTable {
  draft_id: string;
  revision: number;
  user_id: string;
  accepted_at: CreatedAt;
}

export type ParticipantRole = 'buyer' | 'seller' | 'arbitrator' | 'system';

export interface MessagesTable {
  id: Generated<string>;
  draft_id: string;
  seq: number;
  sender_user_id: string | null;
  sender_role: ParticipantRole;
  body: string;
  created_at: CreatedAt;
}

export interface VaultEntriesTable {
  id: Generated<string>;
  draft_id: string;
  buyer_user_id: string;
  release_code_hash: string;
  created_at: CreatedAt;
}

export interface VaultEnvelopesTable {
  id: Generated<string>;
  entry_id: string;
  credential_id: string;
  alg: string;
  kdf: string;
  kdf_params: Json<Record<string, unknown>>;
  iv: string;
  ciphertext: string;
  created_at: CreatedAt;
}

export type EscrowState = 'Created' | 'Funded' | 'Delivered' | 'Disputed' | 'Released' | 'Refunded' | 'Cancelled';

export interface EscrowsTable {
  contract_id: string;
  buyer_address: string;
  seller_address: string;
  draft_id: string | null;
  created_ledger: number;
  created_tx_hash: string;
  state: EscrowState | null;
  arbitrator: string | null;
  token: string | null;
  amount: string | null;
  fee_bps: number | null;
  terms_hash: string | null;
  release_code_hash: string | null;
  funding_deadline: Timestamp | null;
  funded_at: Timestamp | null;
  delivery_deadline: Timestamp | null;
  receipt_deadline: Timestamp | null;
  dispute_opened_by: string | null;
  dispute_opened_at: Timestamp | null;
  dispute_deadline: Timestamp | null;
  proof_kind: string | null;
  proof_uri: string | null;
  proof_hash: string | null;
  proof_submitted_at: Timestamp | null;
  settlement: 'Open' | 'Released' | 'Refunded' | null;
  settlement_path: string | null;
  snapshot_ledger: number | null;
  snapshot_at: Timestamp | null;
  live_until_ledger: number | null;
  last_bumped_at: Timestamp | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ChainEventsTable {
  tx_hash: string;
  event_index: number;
  event_id: string;
  ledger: number;
  contract_id: string;
  name: string;
  topics: Json<unknown[]>;
  value: Json<unknown>;
  created_at: CreatedAt;
}

export interface IndexerStateTable {
  name: string;
  last_processed_ledger: number;
  status: 'ok' | 'gap';
  error: string | null;
  updated_at: UpdatedAt;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  dedupe_key: string;
  kind: string;
  escrow_contract_id: string | null;
  draft_id: string | null;
  title: string;
  body: string;
  send_at: Timestamp;
  sent_at: Timestamp | null;
  email_sent_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  read_at: Timestamp | null;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: CreatedAt;
}

export interface EvidenceTable {
  id: Generated<string>;
  draft_id: string;
  uploaded_by: string;
  uploader_role: ParticipantRole;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  description: string | null;
  created_at: CreatedAt;
}

export interface DisputeStatementsTable {
  id: Generated<string>;
  draft_id: string;
  user_id: string;
  role: ParticipantRole;
  statement: string;
  created_at: CreatedAt;
}

export interface AuditLogTable {
  id: Generated<string>;
  user_id: string | null;
  action: string;
  subject: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Json<Record<string, unknown>>;
  created_at: CreatedAt;
}

export interface Database {
  users: UsersTable;
  auth_challenges: AuthChallengesTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  backup_codes: BackupCodesTable;
  drafts: DraftsTable;
  draft_revisions: DraftRevisionsTable;
  draft_acceptances: DraftAcceptancesTable;
  messages: MessagesTable;
  vault_entries: VaultEntriesTable;
  vault_envelopes: VaultEnvelopesTable;
  escrows: EscrowsTable;
  chain_events: ChainEventsTable;
  indexer_state: IndexerStateTable;
  notifications: NotificationsTable;
  evidence: EvidenceTable;
  dispute_statements: DisputeStatementsTable;
  audit_log: AuditLogTable;
}

export type User = Selectable<UsersTable>;
export type Session = Selectable<SessionsTable>;
export type Draft = Selectable<DraftsTable>;
export type EscrowRow = Selectable<EscrowsTable>;
export type NewEscrowRow = Insertable<EscrowsTable>;
export type EscrowRowUpdate = Updateable<EscrowsTable>;
export type Notification = Selectable<NotificationsTable>;

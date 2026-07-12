// Shared domain types, reused across crypto.ts, db.ts, and the components.
//
// Entry is a flat shape with type-specific fields optional, rather than a
// strict discriminated union keyed on `type`: the existing UI already reads
// fields like `username`/`urls` defensively (`entry.urls?.length`) across
// every entry type, and a real union would require type-narrowing at every
// one of those call sites for no practical safety gain, since every entry
// already carries all its own type's fields set and the others simply
// absent. This still catches the bugs that mattered this session: wrong
// field names, wrong return shapes across db.ts's API boundary.

export type EntryType = 'login' | 'note' | 'card';

export interface CustomField {
  label: string;
  value: string;
}

export interface EntryHistoryCommit {
  id: string;
  hash: string;
  timestamp: number;
  snapshot: Entry;
  parent: string | null;
  changed: string[] | undefined;
}

export interface Entry {
  id: string;
  type: EntryType;
  title: string;
  notes: string;
  tags: string[];
  customFields: CustomField[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  commitHash?: string;
  history?: EntryHistoryCommit[];

  // login
  username?: string;
  password?: string;
  urls?: string[];
  totpSecrets?: string[];

  // card
  cardholderName?: string;
  cardNumber?: string;
  cardExpiry?: string;
  cardCvv?: string;

  // UI-only draft bookkeeping, never persisted (stripped in db.ts before
  // any entry content is encrypted/saved)
  _isNew?: boolean;
}

// The shape buildExportData() produces: entry.history minus the current
// version (already duplicated by the entry's own top-level fields), plus
// each entry's raw entry_key attached only at export time.
export interface ExportEntry extends Omit<Entry, 'history'> {
  entry_key: string | null;
  history: EntryHistoryCommit[];
}

export interface ExportData {
  version: number;
  username: string | null;
  user_master_key: string | null;
  data: ExportEntry[];
  trash: ExportEntry[];
}

export interface R2Config {
  account_id: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

export interface S3DestinationConfig {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

export interface BackupDestinations {
  r2_config: R2Config | null;
  s3_config: S3DestinationConfig[];
}

// The config JSON file dragged onto the setup screen; see CLAUDE.md, Config
// Contract. validateConfig() checks an untrusted, unknown-shaped parse of
// this against these fields before anything here is trusted.
export interface ConfigContract {
  instant_app_id: string;
  instant_client_name: string;
  firebase_api_key: string;
  email: string;
  password: string;
  root_master_key: string;
  username: string;
  backup_master_key?: string;
  r2_config?: R2Config;
  s3_config?: S3DestinationConfig[];
}

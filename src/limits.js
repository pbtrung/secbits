// ─── Per-field character limits ──────────────────────────────────────────────
// These keep encrypted payloads small enough to stay under Firestore's
// 999,999-byte document value cap even with version history.

export const TITLE_MAX               = 200;
export const USERNAME_MAX            = 200;
export const PASSWORD_MAX            = 1000;
export const NOTES_MAX               = 100_000;
export const URL_MAX                 = 2048;   // de-facto browser/server URL limit
export const TOTP_SECRET_MAX         = 256;    // base32 seeds are typically 16-64 chars
export const CUSTOM_FIELD_LABEL_MAX  = 100;
export const CUSTOM_FIELD_VALUE_MAX  = 1000;
export const TAG_MAX                 = 50;

// ─── Per-entry collection limits ─────────────────────────────────────────────
export const MAX_URLS                = 20;
export const MAX_TOTP_SECRETS        = 10;
export const MAX_CUSTOM_FIELDS       = 20;
export const MAX_TAGS                = 20;

import { decodeRootMasterKey } from '../crypto';

export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateRootMasterKey(value) {
  try {
    decodeRootMasterKey(value);
    return true;
  } catch {
    return false;
  }
}

function validateS3DestinationConfig(c, label) {
  const errors = [];
  if (!isHttpsUrl(c.endpoint || '')) errors.push(`${label} endpoint must be HTTPS`);
  if (!String(c.region || '').trim()) errors.push(`${label} region is required`);
  if (!String(c.bucket || '').trim()) errors.push(`${label} bucket is required`);
  if (!String(c.access_key_id || '').trim()) errors.push(`${label} access key ID is required`);
  if (!String(c.secret_access_key || '').trim()) errors.push(`${label} secret access key is required`);
  return errors;
}

function validateRequiredFields(c) {
  const errors = [];
  if (!String(c.instant_app_id || '').trim()) errors.push('InstantDB app ID is required');
  if (!String(c.instant_client_name || '').trim()) errors.push('InstantDB client name is required');
  if (!String(c.email || '').trim()) errors.push('Email is required');
  if (!String(c.password || '').trim()) errors.push('Password is required');
  if (!String(c.firebase_api_key || '').trim()) errors.push('Firebase API key is required');
  if (!String(c.username || '').trim()) errors.push('Display name is required');
  if (!validateRootMasterKey(c.root_master_key || '')) {
    errors.push('Root master key must be base64 and at least 256 bytes decoded');
  }
  return errors;
}

function validateR2Config(c) {
  if (c.r2_config === undefined) return [];
  const errors = [];
  const r2 = c.r2_config && typeof c.r2_config === 'object' ? c.r2_config : {};
  if (!String(r2.account_id || '').trim()) errors.push('R2 account ID is required');
  if (!String(r2.bucket || '').trim()) errors.push('R2 bucket is required');
  if (!String(r2.access_key_id || '').trim()) errors.push('R2 access key ID is required');
  if (!String(r2.secret_access_key || '').trim()) errors.push('R2 secret access key is required');
  return errors;
}

function validateS3Configs(c) {
  if (c.s3_config === undefined) return [];
  if (!Array.isArray(c.s3_config)) return ['S3 destinations must be a list'];
  return c.s3_config.flatMap((entry, i) => validateS3DestinationConfig(
    entry && typeof entry === 'object' ? entry : {},
    `S3 destination ${i + 1}`,
  ));
}

// Same format requirement as root_master_key (base64, >=256 bytes); only
// required when a cloud destination is actually configured, since it's
// otherwise unused.
function validateBackupMasterKeyRequirement(c) {
  const wantsCloudBackup = c.r2_config !== undefined
    || (Array.isArray(c.s3_config) && c.s3_config.length > 0);
  if (!wantsCloudBackup || validateRootMasterKey(c.backup_master_key || '')) return [];
  return ['Backup master key must be base64 and at least 256 bytes decoded'];
}

export function validateConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  return [
    ...validateRequiredFields(c),
    ...validateR2Config(c),
    ...validateS3Configs(c),
    ...validateBackupMasterKeyRequirement(c),
  ];
}

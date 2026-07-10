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

export function validateConfig(config) {
  const errors = [];
  const c = config && typeof config === 'object' ? config : {};
  if (!String(c.instant_app_id || '').trim()) errors.push('InstantDB app ID is required');
  if (!String(c.instant_client_name || '').trim()) errors.push('InstantDB client name is required');
  if (!String(c.email || '').trim()) errors.push('Email is required');
  if (!String(c.password || '').trim()) errors.push('Password is required');
  if (!String(c.firebase_api_key || '').trim()) errors.push('Firebase API key is required');
  if (!String(c.username || '').trim()) errors.push('Display name is required');
  if (!validateRootMasterKey(c.root_master_key || '')) {
    errors.push('Root master key must be base64 and at least 256 bytes decoded');
  }

  if (c.r2_config !== undefined) {
    const r2 = c.r2_config && typeof c.r2_config === 'object' ? c.r2_config : {};
    if (!String(r2.account_id || '').trim()) errors.push('R2 account ID is required');
    if (!String(r2.bucket || '').trim()) errors.push('R2 bucket is required');
    if (!String(r2.access_key_id || '').trim()) errors.push('R2 access key ID is required');
    if (!String(r2.secret_access_key || '').trim()) errors.push('R2 secret access key is required');
  }

  if (c.s3_config !== undefined) {
    if (!Array.isArray(c.s3_config)) {
      errors.push('S3 destinations must be a list');
    } else {
      c.s3_config.forEach((entry, i) => {
        const entryErrors = validateS3DestinationConfig(
          entry && typeof entry === 'object' ? entry : {},
          `S3 destination ${i + 1}`,
        );
        errors.push(...entryErrors);
      });
    }
  }

  return errors;
}

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

function validateS3DestinationConfig(c) {
  const errors = [];
  if (!isHttpsUrl(c.endpoint || '')) errors.push('endpoint must be HTTPS');
  if (!String(c.region || '').trim()) errors.push('region is required');
  if (!String(c.bucket || '').trim()) errors.push('bucket is required');
  if (!String(c.access_key_id || '').trim()) errors.push('access_key_id is required');
  if (!String(c.secret_access_key || '').trim()) errors.push('secret_access_key is required');
  return errors;
}

export function validateConfig(config) {
  const errors = [];
  const c = config && typeof config === 'object' ? config : {};
  if (!String(c.instant_app_id || '').trim()) errors.push('instant_app_id is required');
  if (!String(c.instant_client_name || '').trim()) errors.push('instant_client_name is required');
  if (!String(c.email || '').trim()) errors.push('email is required');
  if (!String(c.password || '').trim()) errors.push('password is required');
  if (!String(c.firebase_api_key || '').trim()) errors.push('firebase_api_key is required');
  if (!String(c.username || '').trim()) errors.push('username is required');
  if (!validateRootMasterKey(c.root_master_key || '')) {
    errors.push('root_master_key must be base64 and at least 256 bytes decoded');
  }

  if (c.r2_config !== undefined) {
    const r2 = c.r2_config && typeof c.r2_config === 'object' ? c.r2_config : {};
    if (!String(r2.account_id || '').trim()) errors.push('r2_config.account_id is required');
    if (!String(r2.bucket || '').trim()) errors.push('r2_config.bucket is required');
    if (!String(r2.access_key_id || '').trim()) errors.push('r2_config.access_key_id is required');
    if (!String(r2.secret_access_key || '').trim()) errors.push('r2_config.secret_access_key is required');
  }

  if (c.s3_config !== undefined) {
    if (!Array.isArray(c.s3_config)) {
      errors.push('s3_config must be an array');
    } else {
      c.s3_config.forEach((entry, i) => {
        const entryErrors = validateS3DestinationConfig(entry && typeof entry === 'object' ? entry : {});
        for (const e of entryErrors) errors.push(`s3_config[${i}].${e}`);
      });
    }
  }

  return errors;
}

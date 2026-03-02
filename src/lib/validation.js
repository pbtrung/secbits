import { decodeRootMasterKey } from './crypto';
import { isValidZBase32 } from './zbase32';

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

export function validateZBase32Id(value) {
  return isValidZBase32(value, 52);
}

export function validateConfig(config) {
  const errors = [];
  const c = config && typeof config === 'object' ? config : {};
  if (!isHttpsUrl(c.worker_url || '')) errors.push('worker_url must be HTTPS');
  if (!String(c.email || '').trim()) errors.push('email is required');
  if (!String(c.password || '').trim()) errors.push('password is required');
  if (!String(c.firebase_api_key || '').trim()) errors.push('firebase_api_key is required');
  if (!validateRootMasterKey(c.root_master_key || '')) {
    errors.push('root_master_key must be base64 and at least 256 bytes decoded');
  }
  return errors;
}

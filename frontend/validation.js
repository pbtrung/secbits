import {
  TITLE_MAX,
  URL_MAX,
  TOTP_SECRET_MAX,
  CARD_EXPIRY_MAX,
  CARD_NUMBER_MAX,
} from './limits.js';

export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateTitle(value) {
  const text = String(value || '').trim();
  if (!text) return 'Title is required';
  if (text.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer`;
  return null;
}

export function validateUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > URL_MAX) return `URL must be ${URL_MAX} characters or fewer`;
  if (!isHttpUrl(text)) return 'Invalid URL - must start with https:// or http://';
  return null;
}

export function validateTotpSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length > TOTP_SECRET_MAX) return `TOTP secret must be ${TOTP_SECRET_MAX} characters or fewer`;
  const cleaned = text.replace(/[\s=_-]+/g, '').toUpperCase();
  if (cleaned.length > 0 && !/^[A-Z2-7]+$/.test(cleaned)) {
    return 'Invalid base32 - only A-Z and 2-7';
  }
  return null;
}

export function validateExpiry(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > CARD_EXPIRY_MAX) return `Expiry must be ${CARD_EXPIRY_MAX} characters or fewer`;
  if (!/^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/.test(text)) {
    return 'Invalid expiry - use MM/YY or MM/YYYY';
  }
  return null;
}

export function validateCardNumber(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > CARD_NUMBER_MAX) return `Card number must be ${CARD_NUMBER_MAX} characters or fewer`;
  const digits = text.replace(/[\s-]+/g, '');
  if (!/^\d{12,19}$/.test(digits)) {
    return 'Invalid card number';
  }
  return null;
}

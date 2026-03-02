const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const ALPHABET_SET = new Set(ALPHABET.split(''));
const CHAR_TO_VALUE = new Map(ALPHABET.split('').map((ch, i) => [ch, i]));

export const ZBASE32_ALPHABET = ALPHABET;

export function zbase32Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('zbase32Encode expects Uint8Array');
  }

  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

export function zbase32Decode(text, expectedLength = 52) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Invalid z-base-32 string');
  }
  if (expectedLength != null && text.length !== expectedLength) {
    throw new Error('Invalid z-base-32 string');
  }

  let buffer = 0;
  let bits = 0;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!ALPHABET_SET.has(ch)) {
      throw new Error('Invalid z-base-32 string');
    }
    const val = CHAR_TO_VALUE.get(ch);
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }

  if (bits > 0) {
    const mask = (1 << bits) - 1;
    if ((buffer & mask) !== 0) {
      throw new Error('Invalid z-base-32 string');
    }
  }

  return new Uint8Array(out);
}

export function isValidZBase32(text, expectedLength = null) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (expectedLength != null && text.length !== expectedLength) return false;
  for (let i = 0; i < text.length; i++) {
    if (!ALPHABET_SET.has(text[i])) return false;
  }
  try {
    zbase32Decode(text, expectedLength);
    return true;
  } catch {
    return false;
  }
}

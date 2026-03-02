const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const CHAR_TO_VALUE = new Map(ALPHABET.split('').map((ch, i) => [ch, i]));
const VALID_SET = new Set(ALPHABET.split(''));

export function zbase32Encode(bytes) {
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
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

export function isValidZBase32Id(value) {
  if (typeof value !== 'string' || value.length !== 52) return false;
  for (let i = 0; i < value.length; i++) {
    if (!VALID_SET.has(value[i])) return false;
  }

  // Reject malformed tails.
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < value.length; i++) {
    buffer = (buffer << 5) | CHAR_TO_VALUE.get(value[i]);
    bits += 5;
    if (bits >= 8) bits -= 8;
  }
  return bits === 4 ? (buffer & 0x0f) === 0 : bits === 0;
}

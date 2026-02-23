const PBKDF2_ITERATIONS = 100_000;
const SALT_LEN = 32;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
    key, 256,
  );
  return bufToB64(salt) + ':' + bufToB64(bits);
}

export async function verifyPassword(password, stored) {
  const parts = stored?.split(':');
  if (parts?.length !== 2) return false;
  const salt = b64ToBuf(parts[0]);
  const expected = new Uint8Array(b64ToBuf(parts[1]));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const actual = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
    key, 256,
  ));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function b64urlStr(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlBuf(buf) {
  return bufToB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function signJWT(payload, secret) {
  const header = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64urlBuf(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = token?.split('.');
  if (parts?.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const sigBytes = b64ToBuf(sig.replace(/-/g, '+').replace(/_/g, '/'));
  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`),
  );
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

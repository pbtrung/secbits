const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SECONDS = 300;

let cachedJwks = null;
let cachedAt = 0;
let maxAgeSeconds = 0;

function parseJwt(token) {
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  return parts;
}

function base64urlToBytes(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64urlToJson(input) {
  const bytes = base64urlToBytes(input);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseMaxAge(cacheControl) {
  const match = /max-age=(\d+)/i.exec(cacheControl || '');
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getJwks() {
  const now = Date.now();
  if (cachedJwks && now - cachedAt < maxAgeSeconds * 1000) {
    return cachedJwks;
  }

  const res = await fetch(FIREBASE_JWKS_URL);
  if (!res.ok) {
    throw new Error('Failed to fetch Firebase public keys');
  }

  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  cachedJwks = new Map(keys.filter((k) => k?.kid).map((k) => [k.kid, k]));
  cachedAt = now;
  maxAgeSeconds = parseMaxAge(res.headers.get('Cache-Control')) || 300;
  return cachedJwks;
}

async function verifySignature(headerB64, payloadB64, signatureB64, jwk) {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToBytes(signatureB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  if (!valid) {
    throw new Error('Invalid token signature');
  }
}

export async function verifyFirebaseToken(token, projectId) {
  const [headerB64, payloadB64, signatureB64] = parseJwt(token);
  const header = base64urlToJson(headerB64);
  const payload = base64urlToJson(payloadB64);

  if (header?.alg !== 'RS256') {
    throw new Error('Invalid token algorithm');
  }
  if (typeof header?.kid !== 'string' || header.kid.length === 0) {
    throw new Error('Missing token kid');
  }

  let jwks = await getJwks();
  let key = jwks.get(header.kid);
  if (!key) {
    cachedJwks = null;
    jwks = await getJwks();
    key = jwks.get(header.kid);
  }
  if (!key) {
    throw new Error('Unknown token key id');
  }

  await verifySignature(headerB64, payloadB64, signatureB64, key);

  const now = Math.floor(Date.now() / 1000);
  if (!(Number(payload?.exp) > now - CLOCK_SKEW_SECONDS)) {
    throw new Error('Token expired');
  }
  if (!(Number(payload?.iat) <= now + CLOCK_SKEW_SECONDS)) {
    throw new Error('Token issued in the future');
  }
  if (payload?.aud !== projectId) {
    throw new Error('Invalid token audience');
  }
  if (payload?.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Invalid token issuer');
  }
  if (typeof payload?.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Missing token subject');
  }

  return payload;
}

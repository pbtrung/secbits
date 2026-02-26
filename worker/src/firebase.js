const CERTS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let certCache = {
  expiresAt: 0,
  keys: new Map(),
};

function parseMaxAge(cacheControl) {
  const match = String(cacheControl || '').match(/max-age=(\d+)/i);
  return match ? Number(match[1]) : 300;
}

function b64urlToBytes(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64urlToJson(value) {
  const bytes = b64urlToBytes(value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadGoogleCerts() {
  const now = Date.now();
  if (certCache.expiresAt > now && certCache.keys.size > 0) return certCache.keys;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to load Firebase certs (${res.status})`);
  const body = await res.json();

  const keys = new Map();
  const jwks = Array.isArray(body?.keys) ? body.keys : [];
  for (const jwk of jwks) {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }

  const maxAge = parseMaxAge(res.headers.get('cache-control'));
  certCache = {
    keys,
    expiresAt: now + maxAge * 1000,
  };

  return keys;
}

export async function verifyFirebaseToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid bearer token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);

  if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid token header');

  const certs = await loadGoogleCerts();
  const key = certs.get(header.kid);
  if (!key) throw new Error('Unknown token key id');

  const signedPart = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBytes(signatureB64);

  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature,
    signedPart,
  );
  if (!ok) throw new Error('Invalid token signature');

  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  if (!payload.exp || Number(payload.exp) < now - skew) throw new Error('Token expired');
  if (!payload.iat || Number(payload.iat) > now + skew) throw new Error('Invalid token iat');

  if (payload.aud !== projectId) throw new Error('Invalid token audience');
  const expectedIss = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== expectedIss) throw new Error('Invalid token issuer');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('Invalid token subject');

  return payload;
}

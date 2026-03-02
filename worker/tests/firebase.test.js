import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCertCacheForTests, deriveUserId, verifyFirebaseToken } from '../src/firebase.js';

function toBase64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function makeSignedToken({ privateKey, kid, aud = 'proj', iss = 'https://securetoken.google.com/proj', expOffset = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const payload = {
    aud,
    iss,
    sub: 'uid-123',
    iat: now - 10,
    exp: now + expOffset,
  };
  const enc = new TextEncoder();
  const h = toBase64Url(enc.encode(JSON.stringify(header)));
  const p = toBase64Url(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, data);
  return `${h}.${p}.${toBase64Url(sig)}`;
}

describe('firebase token verification', () => {
  beforeEach(() => {
    __resetCertCacheForTests();
    vi.restoreAllMocks();
  });

  it('accepts valid RS256 token with correct audience', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    jwk.kid = 'kid-1';
    const token = await makeSignedToken({ privateKey: pair.privateKey, kid: 'kid-1' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'cache-control': 'max-age=300' },
    }));

    const payload = await verifyFirebaseToken(token, 'proj');
    expect(payload.sub).toBe('uid-123');
  });

  it('rejects expired tokens', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    jwk.kid = 'kid-2';
    const token = await makeSignedToken({ privateKey: pair.privateKey, kid: 'kid-2', expOffset: -1000 });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    await expect(verifyFirebaseToken(token, 'proj')).rejects.toThrow();
  });

  it('rejects wrong audience and malformed JWT', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    jwk.kid = 'kid-3';
    const token = await makeSignedToken({ privateKey: pair.privateKey, kid: 'kid-3', aud: 'other' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

    await expect(verifyFirebaseToken(token, 'proj')).rejects.toThrow();
    await expect(verifyFirebaseToken('x.y', 'proj')).rejects.toThrow();
  });

  it('rejects forged signature (token signed by different key under same kid)', async () => {
    const legitPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    );
    const forgePair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', legitPair.publicKey);
    jwk.kid = 'kid-legit';
    // Token signed by forger's private key but the JWK set has the legit public key
    const token = await makeSignedToken({ privateKey: forgePair.privateKey, kid: 'kid-legit' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'cache-control': 'max-age=300' },
    }));
    await expect(verifyFirebaseToken(token, 'proj')).rejects.toThrow();
  });

  it('deriveUserId returns expected 52-char z-base-32 value', () => {
    expect(deriveUserId('firebase-uid-123')).toBe('3rd65irghj1jkh68ybpcqq4jprhs5cip9rpaytwgb79tssdddugo');
  });
});

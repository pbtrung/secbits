#!/usr/bin/env node
'use strict';

// Trimmed from the old project's leancrypto.test.js: this now covers only
// the primitives crypto.js actually uses (Ascon-Keccak AEAD, SHA3-512,
// HKDF-SHA3-512). The ML-KEM+X448 keypair and SPHINCS+ signature vector
// coverage was dropped along with the peer-sharing feature they backed.

const leancrypto = require('../../leancrypto/leancrypto.js');

// This file pokes at the raw Emscripten WASM module directly (numeric
// memory pointers, dynamically-looked-up `_lc_*` symbol names) to run
// third-party test vectors, rather than going through crypto.ts's
// LeancryptoModule interface (which only covers the subset crypto.ts calls).
// A real interface here would need an index signature and degenerate to
// `any` for every property anyway, so this stays explicitly untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lib = any;

const EBADMSG = 9;

function hexToU8(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function seq(start: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (start + i) & 0xff;
  return out;
}

function repeatRange(start: number, len: number, repeats: number): Uint8Array {
  const block = seq(start, len);
  const out = new Uint8Array(len * repeats);
  for (let i = 0; i < repeats; i++) out.set(block, i * len);
  return out;
}

function allocAndWrite(lib: Lib, data: Uint8Array): number {
  const ptr = lib._malloc(data.length);
  lib.HEAPU8.set(data, ptr);
  return ptr;
}

function readBytes(lib: Lib, ptr: number, len: number): Uint8Array {
  return lib.HEAPU8.slice(ptr, ptr + len);
}

function assertRc(name: string, rc: number, expected = 0): void {
  if (rc !== expected) throw new Error(`${name} failed: rc=${rc}, expected=${expected}`);
}

function assertEqBytes(name: string, got: Uint8Array, expected: Uint8Array): void {
  if (got.length !== expected.length) throw new Error(`${name}: length mismatch ${got.length} != ${expected.length}`);
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== expected[i]) {
      throw new Error(
        `${name}: mismatch at ${i}, got=0x${got[i].toString(16).padStart(2, '0')}, expected=0x${expected[i].toString(16).padStart(2, '0')}`,
      );
    }
  }
}

function resolveHashPtr(lib: Lib, hashSymbol: number): number {
  return lib.HEAPU32[hashSymbol >> 2];
}

interface HashImpl {
  name: string;
  ptr: number;
}

function listHashImpls(lib: Lib, symbolNames: string[]): HashImpl[] {
  const out: HashImpl[] = [];
  const seen = new Set();
  for (const name of symbolNames) {
    const sym = lib[name];
    if (typeof sym !== 'number' || sym === 0) continue;
    const ptr = resolveHashPtr(lib, sym);
    if (!ptr || seen.has(ptr)) continue;
    seen.add(ptr);
    out.push({ name, ptr });
  }
  return out;
}

function allocCtx(lib: Lib, hashPtr: number, tagLen: number): number {
  const ctxPtrPtr = lib._malloc(4);
  try {
    const rc = lib._lc_ak_alloc_taglen(hashPtr, tagLen, ctxPtrPtr);
    assertRc('lc_ak_alloc_taglen', rc);
    return lib.HEAP32[ctxPtrPtr >> 2];
  } finally {
    lib._free(ctxPtrPtr);
  }
}

interface AeadVector {
  name: string;
  hashPtr: number;
  pt: Uint8Array;
  key: Uint8Array;
  iv: Uint8Array;
  aad?: Uint8Array;
  expCt: Uint8Array;
  expTag: Uint8Array;
}

function runAeadVectorCase(lib: Lib, name: string, hashPtr: number, vector: AeadVector): void {
  const { pt, iv, aad, key, expCt, expTag } = vector;
  const tagLen = expTag.length;

  const ctx = allocCtx(lib, hashPtr, tagLen);
  try {
    const keyPtr = allocAndWrite(lib, key);
    const ivPtr = allocAndWrite(lib, iv);
    const ptPtr = allocAndWrite(lib, pt);
    const aadPtr = allocAndWrite(lib, aad!);
    const ctPtr = lib._malloc(pt.length);
    const tagPtr = lib._malloc(tagLen);

    try {
      let rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
      assertRc(`${name}: lc_aead_setkey (encrypt)`, rc);

      rc = lib._lc_aead_encrypt(ctx, ptPtr, ctPtr, pt.length, aadPtr, aad!.length, tagPtr, tagLen);
      assertRc(`${name}: lc_aead_encrypt (out-of-place)`, rc);

      lib._lc_aead_zero(ctx);

      const outCt = readBytes(lib, ctPtr, pt.length);
      const outTag = readBytes(lib, tagPtr, tagLen);
      assertEqBytes(`${name}: ciphertext`, outCt, expCt);
      assertEqBytes(`${name}: tag`, outTag, expTag);

      const ctxInPlace = allocCtx(lib, hashPtr, tagLen);
      try {
        const inOutPtr = allocAndWrite(lib, pt);
        const tag2Ptr = lib._malloc(tagLen);
        try {
          rc = lib._lc_aead_setkey(ctxInPlace, keyPtr, key.length, ivPtr, iv.length);
          assertRc(`${name}: lc_aead_setkey (in-place)`, rc);

          rc = lib._lc_aead_encrypt(ctxInPlace, inOutPtr, inOutPtr, pt.length, aadPtr, aad!.length, tag2Ptr, tagLen);
          assertRc(`${name}: lc_aead_encrypt (in-place)`, rc);

          const outCt2 = readBytes(lib, inOutPtr, pt.length);
          const outTag2 = readBytes(lib, tag2Ptr, tagLen);
          assertEqBytes(`${name}: ciphertext (in-place)`, outCt2, expCt);
          assertEqBytes(`${name}: tag (in-place)`, outTag2, expTag);

          rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
          assertRc(`${name}: lc_aead_setkey (decrypt)`, rc);

          const ptOutPtr = lib._malloc(pt.length);
          try {
            rc = lib._lc_aead_decrypt(ctx, inOutPtr, ptOutPtr, pt.length, aadPtr, aad!.length, tag2Ptr, tagLen);
            if (rc < 0) throw new Error(`${name}: lc_aead_decrypt returned error ${rc}`);
            lib._lc_aead_zero(ctx);

            const outPt = readBytes(lib, ptOutPtr, pt.length);
            assertEqBytes(`${name}: plaintext`, outPt, pt);

            rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
            assertRc(`${name}: lc_aead_setkey (tamper)`, rc);

            const tamperedCt = new Uint8Array(outCt2);
            tamperedCt[0] = (tamperedCt[0] + 1) & 0xff;
            lib.HEAPU8.set(tamperedCt, inOutPtr);

            rc = lib._lc_aead_decrypt(ctx, inOutPtr, ptOutPtr, pt.length, aadPtr, aad!.length, tag2Ptr, tagLen);
            lib._lc_aead_zero(ctx);
            if (rc !== -EBADMSG) throw new Error(`${name}: expected auth failure rc=${-EBADMSG}, got ${rc}`);
          } finally {
            lib._free(ptOutPtr);
          }
        } finally {
          lib._free(inOutPtr);
          lib._free(tag2Ptr);
        }
      } finally {
        lib._lc_aead_zero_free(ctxInPlace);
      }
    } finally {
      lib._free(keyPtr);
      lib._free(ivPtr);
      lib._free(ptPtr);
      lib._free(aadPtr);
      lib._free(ctPtr);
      lib._free(tagPtr);
    }
  } finally {
    lib._lc_aead_zero_free(ctx);
  }
}

function testAsconKeccak(lib: Lib): void {
  const vectors: AeadVector[] = [
    {
      name: 'ascon-keccak-512',
      hashPtr: resolveHashPtr(lib, lib._lc_sha3_512),
      pt: repeatRange(0x00, 0x40, 3),
      key: seq(0x00, 64),
      iv: seq(0x20, 16),
      expCt: hexToU8(`
        ed504363832faf87f017472c7024f304ea6cff9d96d204e7e473907785f545cd
        adc4884901091ab4f2af34a7dc6c0202db2750c007daa2b78f6cd1a0a4a58e97
        bfb22908ddbc5c893b795f9ff56d02fd8d09727b1ff7c54a68d56e914d7264af
        57550c54dca6d5bc1c036af69f037f37edae75bb030962473318abc02b2c2db0
        88ef7c4b75567d58bd8172247e551b5c1f359d1da1f3292811abb5ea56d0942f
        15720a58f84b8e61b9cfddcc42edf0e16e5d85e7357420bb3e792f59e3f45f54
      `),
      expTag: hexToU8('b56333419ada82c1badccd70e798fae5'),
    },
    {
      name: 'ascon-keccak-512-large-iv-tag',
      hashPtr: resolveHashPtr(lib, lib._lc_sha3_512),
      pt: repeatRange(0x00, 0x40, 3),
      key: seq(0x00, 64),
      iv: repeatRange(0x20, 16, 4),
      expCt: hexToU8(`
        2909364da7d101bf09d0072fd3cc4b28dfd8fd9b546eacca1d1c4b4731977dcc
        fffe31e70a39a175711b5872067a3a77736499621605702b192d01f026e29b74
        8ffd745c7abf8879d80132387786464735ab948f8c61526f67b07d6fbd018c03
        ba819794a367a8bb3f08a739f3c441e516f50c008223f6866253e6679afb37e1
        4e7ec1c270ddb8a41809dd9944695cc629e4133aa352e1b1cd2968764e9345e4
        19a4989cb419d8125c6757ec2256ef876e3f318c3f3600ad0da415342fd675b4
      `),
      expTag: hexToU8(`
        f75a99d07c5e60350aaa88700da30addf72677d93f7162b2efc4adececfbd3e1
        c047e799587a5657fd065741dac65ed6b158e723c54bc8579ef52c6dc0e5c76e
      `),
    },
    {
      name: 'ascon-keccak-256',
      hashPtr: resolveHashPtr(lib, lib._lc_sha3_256),
      pt: seq(0x00, 64),
      key: seq(0x80, 32),
      iv: seq(0x20, 16),
      expCt: hexToU8(`
        bfdfeb808488bed1dadb85dae23918fc1420f10bc4d2afc31cee970fad52a0fa
        a61a580b563ff6e8034943f1120d5eb08269e2fdde02c212d6913b313d205463
      `),
      expTag: hexToU8('c5723477a060460dc17421176a28bb70'),
    },
    {
      name: 'ascon-keccak-256-large-iv-tag',
      hashPtr: resolveHashPtr(lib, lib._lc_sha3_256),
      pt: seq(0x00, 64),
      key: seq(0x80, 32),
      iv: repeatRange(0x20, 16, 2),
      expCt: hexToU8(`
        fff30f02b83dbfcdbc3a525568abffa478823188833f9dadad43705d6d493401
        b225e1a2ecbfc0a381126f6285cc0a7d590a8c33d84754ee8a618ac248e5480a
      `),
      expTag: hexToU8(`
        a1a3cedf4006245b4a7f6f31cb44ae71f5e2ac24c8c690461f8607475840e9b9
      `),
    },
  ];

  for (const v of vectors) {
    v.aad = v.pt;
    runAeadVectorCase(lib, v.name, v.hashPtr, v);
    console.log(`PASS ${v.name}`);
  }
}

function testSha3_512(lib: Lib): void {
  const msg = new Uint8Array([0x82, 0xd9, 0x19]);
  const exp = new Uint8Array([
    0x76, 0x75, 0x52, 0x82, 0xa9, 0xc5, 0x0a, 0x67, 0xfe, 0x69, 0xbd, 0x3f, 0xce, 0xfe, 0x12, 0xe7, 0x1d, 0xe0, 0x4f,
    0xa2, 0x51, 0xc6, 0x7e, 0x9c, 0xc8, 0x5c, 0x7f, 0xab, 0xc6, 0xcc, 0x89, 0xca, 0x9b, 0x28, 0x88, 0x3b, 0x2a, 0xdb,
    0x22, 0x84, 0x69, 0x5d, 0xd0, 0x43, 0x77, 0x55, 0x32, 0x19, 0xc8, 0xfd, 0x07, 0xa9, 0x4c, 0x29, 0xd7, 0x46, 0xcc,
    0xef, 0xb1, 0x09, 0x6e, 0xde, 0x42, 0x91,
  ]);

  const impls = listHashImpls(lib, [
    '_lc_sha3_512',
    '_lc_sha3_512_c',
    '_lc_sha3_512_arm_asm',
    '_lc_sha3_512_arm_ce',
    '_lc_sha3_512_arm_neon',
    '_lc_sha3_512_avx2',
    '_lc_sha3_512_avx512',
    '_lc_sha3_512_riscv_asm',
    '_lc_sha3_512_riscv_asm_zbb',
  ]);

  for (const impl of impls) {
    const msgPtr = allocAndWrite(lib, msg);
    const outPtr = lib._malloc(exp.length);
    try {
      let rc = lib._lc_hash(impl.ptr, msgPtr, msg.length, outPtr);
      assertRc(`sha3_512 oneshot ${impl.name}`, rc);
      assertEqBytes(`sha3_512 oneshot ${impl.name}`, readBytes(lib, outPtr, exp.length), exp);

      const ctxPtrPtr = lib._malloc(4);
      let ctx = 0;
      try {
        rc = lib._lc_hash_alloc(impl.ptr, ctxPtrPtr);
        assertRc(`sha3_512 hash_alloc#1 ${impl.name}`, rc);
        ctx = lib.HEAPU32[ctxPtrPtr >> 2];
      } finally {
        lib._free(ctxPtrPtr);
      }

      try {
        rc = lib._lc_hash_init(ctx);
        assertRc(`sha3_512 hash_init#1 ${impl.name}`, rc);
        lib._lc_hash_update(ctx, msgPtr, msg.length);
        lib._lc_hash_final(ctx, outPtr);
        assertEqBytes(`sha3_512 streaming#1 ${impl.name}`, readBytes(lib, outPtr, exp.length), exp);
      } finally {
        lib._lc_hash_zero_free(ctx);
      }

      console.log(`PASS sha3_512 ${impl.name}`);
    } finally {
      lib._free(msgPtr);
      lib._free(outPtr);
    }
  }
}

function testHkdfSha3_512(lib: Lib): void {
  // KAT: IKM = 22 × 0x0b, salt = 0x00..0x0c, no info, 128-byte OKM.
  // Expected output computed via leancrypto _lc_hkdf with _lc_sha3_512.
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
  const exp = hexToU8(`
    a028cafac3bc77073b20cc81200f52e4a324f5a36be5320adc7991248092eef5
    19e6ce5f0b48302c58e9e9fe64960590992cc082424cd77438faff3ad18a6d31
    93f7fdfaff003353ce6cdcc55fe0c8f77eb259dae0ff26383c10d6fe17f54dc1
    5245c3f08c606989c1394b940e4761705cc140855a27f433683b7266f0800280
  `);

  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ikmPtr = allocAndWrite(lib, ikm);
  const saltPtr = allocAndWrite(lib, salt);
  const outPtr = lib._malloc(exp.length);
  try {
    const rc = lib._lc_hkdf(sha3_512_ptr, ikmPtr, ikm.length, saltPtr, salt.length, 0, 0, outPtr, exp.length);
    assertRc('hkdf_sha3_512 oneshot', rc);
    assertEqBytes('hkdf_sha3_512 oneshot', readBytes(lib, outPtr, exp.length), exp);
    console.log('PASS hkdf_sha3_512');
  } finally {
    lib._free(ikmPtr);
    lib._free(saltPtr);
    lib._free(outPtr);
  }
}

async function main(): Promise<void> {
  const lib = await leancrypto();
  assertRc('lc_init', lib._lc_init());

  testAsconKeccak(lib);
  testSha3_512(lib);
  testHkdfSha3_512(lib);

  console.log('All leancrypto WASM vector tests passed');
}

// Dual-mode: Vitest test wrapper or standalone Node execution
const globalTest = (globalThis as unknown as { test?: (name: string, fn: () => unknown, timeout?: number) => void })
  .test;
if (typeof globalTest === 'function') {
  globalTest('leancrypto WASM vector tests', () => main(), 60_000);
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

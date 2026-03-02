#!/usr/bin/env node
"use strict";

const leancrypto = require("../../leancrypto/leancrypto.js");

const EBADMSG = 9;
const { SPHINCS_TEST_VECTORS } = require("./leancrypto.sphincs-vectors.js");

function hexToU8(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function seq(start, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (start + i) & 0xff;
  return out;
}

function repeatRange(start, len, repeats) {
  const block = seq(start, len);
  const out = new Uint8Array(len * repeats);
  for (let i = 0; i < repeats; i++) out.set(block, i * len);
  return out;
}

function allocAndWrite(lib, data) {
  const ptr = lib._malloc(data.length);
  lib.HEAPU8.set(data, ptr);
  return ptr;
}

function readBytes(lib, ptr, len) {
  return lib.HEAPU8.slice(ptr, ptr + len);
}

function assertRc(name, rc, expected = 0) {
  if (rc !== expected) throw new Error(`${name} failed: rc=${rc}, expected=${expected}`);
}

function assertEqBytes(name, got, expected) {
  if (got.length !== expected.length) throw new Error(`${name}: length mismatch ${got.length} != ${expected.length}`);
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== expected[i]) {
      throw new Error(`${name}: mismatch at ${i}, got=0x${got[i].toString(16).padStart(2, "0")}, expected=0x${expected[i].toString(16).padStart(2, "0")}`);
    }
  }
}

function resolveHashPtr(lib, hashSymbol) {
  return lib.HEAPU32[hashSymbol >> 2];
}

function listHashImpls(lib, symbolNames) {
  const out = [];
  const seen = new Set();
  for (const name of symbolNames) {
    const sym = lib[name];
    if (typeof sym !== "number" || sym === 0) continue;
    const ptr = resolveHashPtr(lib, sym);
    if (!ptr || seen.has(ptr)) continue;
    seen.add(ptr);
    out.push({ name, ptr });
  }
  return out;
}

function allocCtx(lib, hashPtr, tagLen) {
  const ctxPtrPtr = lib._malloc(4);
  try {
    const rc = lib._lc_ak_alloc_taglen(hashPtr, tagLen, ctxPtrPtr);
    assertRc("lc_ak_alloc_taglen", rc);
    return lib.HEAP32[ctxPtrPtr >> 2];
  } finally {
    lib._free(ctxPtrPtr);
  }
}

function runAeadVectorCase(lib, name, hashPtr, vector) {
  const { pt, iv, aad, key, expCt, expTag } = vector;
  const tagLen = expTag.length;

  const ctx = allocCtx(lib, hashPtr, tagLen);
  try {
    const keyPtr = allocAndWrite(lib, key);
    const ivPtr = allocAndWrite(lib, iv);
    const ptPtr = allocAndWrite(lib, pt);
    const aadPtr = allocAndWrite(lib, aad);
    const ctPtr = lib._malloc(pt.length);
    const tagPtr = lib._malloc(tagLen);

    try {
      let rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
      assertRc(`${name}: lc_aead_setkey (encrypt)`, rc);

      rc = lib._lc_aead_encrypt(ctx, ptPtr, ctPtr, pt.length, aadPtr, aad.length, tagPtr, tagLen);
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

          rc = lib._lc_aead_encrypt(ctxInPlace, inOutPtr, inOutPtr, pt.length, aadPtr, aad.length, tag2Ptr, tagLen);
          assertRc(`${name}: lc_aead_encrypt (in-place)`, rc);

          const outCt2 = readBytes(lib, inOutPtr, pt.length);
          const outTag2 = readBytes(lib, tag2Ptr, tagLen);
          assertEqBytes(`${name}: ciphertext (in-place)`, outCt2, expCt);
          assertEqBytes(`${name}: tag (in-place)`, outTag2, expTag);

          rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
          assertRc(`${name}: lc_aead_setkey (decrypt)`, rc);

          const ptOutPtr = lib._malloc(pt.length);
          try {
            rc = lib._lc_aead_decrypt(ctx, inOutPtr, ptOutPtr, pt.length, aadPtr, aad.length, tag2Ptr, tagLen);
            if (rc < 0) throw new Error(`${name}: lc_aead_decrypt returned error ${rc}`);
            lib._lc_aead_zero(ctx);

            const outPt = readBytes(lib, ptOutPtr, pt.length);
            assertEqBytes(`${name}: plaintext`, outPt, pt);

            rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
            assertRc(`${name}: lc_aead_setkey (tamper)`, rc);

            const tamperedCt = new Uint8Array(outCt2);
            tamperedCt[0] = (tamperedCt[0] + 1) & 0xff;
            lib.HEAPU8.set(tamperedCt, inOutPtr);

            rc = lib._lc_aead_decrypt(ctx, inOutPtr, ptOutPtr, pt.length, aadPtr, aad.length, tag2Ptr, tagLen);
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

function testAsconKeccak(lib) {
  const vectors = [
    {
      name: "ascon-keccak-512",
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
      expTag: hexToU8("b56333419ada82c1badccd70e798fae5"),
    },
    {
      name: "ascon-keccak-512-large-iv-tag",
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
      name: "ascon-keccak-256",
      hashPtr: resolveHashPtr(lib, lib._lc_sha3_256),
      pt: seq(0x00, 64),
      key: seq(0x80, 32),
      iv: seq(0x20, 16),
      expCt: hexToU8(`
        bfdfeb808488bed1dadb85dae23918fc1420f10bc4d2afc31cee970fad52a0fa
        a61a580b563ff6e8034943f1120d5eb08269e2fdde02c212d6913b313d205463
      `),
      expTag: hexToU8("c5723477a060460dc17421176a28bb70"),
    },
    {
      name: "ascon-keccak-256-large-iv-tag",
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

function testHmacSha3_224(lib) {
  const msg = new Uint8Array([0x35, 0x8e, 0x06, 0xba, 0x03, 0x21, 0x83, 0xfc, 0x18, 0x20, 0x58, 0xbd, 0xb7, 0xbb, 0x13, 0x40]);
  const key = new Uint8Array([0xbb, 0x00, 0x95, 0xc4, 0xa4, 0xa6, 0x67, 0xd2, 0xe7, 0x43, 0x30, 0xe5, 0xd6]);
  const exp = new Uint8Array([
    0x16, 0xf7, 0xb2, 0x7e, 0x25, 0x37, 0x6c, 0x38, 0xcf, 0xaa, 0x6f, 0xcc, 0xe2, 0x85,
    0xc5, 0x14, 0x28, 0xdb, 0x33, 0xa0, 0xfe, 0x7a, 0xf0, 0xaf, 0x53, 0x95, 0xde, 0xa2,
  ]);

  const impls = listHashImpls(lib, [
    "_lc_sha3_224",
    "_lc_sha3_224_c",
    "_lc_sha3_224_arm_asm",
    "_lc_sha3_224_arm_ce",
    "_lc_sha3_224_arm_neon",
    "_lc_sha3_224_avx2",
    "_lc_sha3_224_avx512",
    "_lc_sha3_224_riscv_asm",
    "_lc_sha3_224_riscv_asm_zbb",
  ]);

  for (const impl of impls) {
    const keyPtr = allocAndWrite(lib, key);
    const msgPtr = allocAndWrite(lib, msg);
    const outPtr = lib._malloc(exp.length);
    try {
      const rc = lib._lc_hmac(impl.ptr, keyPtr, key.length, msgPtr, msg.length, outPtr);
      assertRc(`hmac_sha3_224 ${impl.name}`, rc);
      assertEqBytes(`hmac_sha3_224 ${impl.name}`, readBytes(lib, outPtr, exp.length), exp);
      console.log(`PASS hmac_sha3_224 ${impl.name}`);
    } finally {
      lib._free(keyPtr);
      lib._free(msgPtr);
      lib._free(outPtr);
    }
  }
}

function testSha3_512(lib) {
  const msg = new Uint8Array([0x82, 0xd9, 0x19]);
  const exp = new Uint8Array([
    0x76, 0x75, 0x52, 0x82, 0xa9, 0xc5, 0x0a, 0x67, 0xfe, 0x69, 0xbd, 0x3f, 0xce, 0xfe, 0x12, 0xe7,
    0x1d, 0xe0, 0x4f, 0xa2, 0x51, 0xc6, 0x7e, 0x9c, 0xc8, 0x5c, 0x7f, 0xab, 0xc6, 0xcc, 0x89, 0xca,
    0x9b, 0x28, 0x88, 0x3b, 0x2a, 0xdb, 0x22, 0x84, 0x69, 0x5d, 0xd0, 0x43, 0x77, 0x55, 0x32, 0x19,
    0xc8, 0xfd, 0x07, 0xa9, 0x4c, 0x29, 0xd7, 0x46, 0xcc, 0xef, 0xb1, 0x09, 0x6e, 0xde, 0x42, 0x91,
  ]);

  const impls = listHashImpls(lib, [
    "_lc_sha3_512",
    "_lc_sha3_512_c",
    "_lc_sha3_512_arm_asm",
    "_lc_sha3_512_arm_ce",
    "_lc_sha3_512_arm_neon",
    "_lc_sha3_512_avx2",
    "_lc_sha3_512_avx512",
    "_lc_sha3_512_riscv_asm",
    "_lc_sha3_512_riscv_asm_zbb",
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

      const ctxPtrPtr2 = lib._malloc(4);
      let ctx2 = 0;
      try {
        rc = lib._lc_hash_alloc(impl.ptr, ctxPtrPtr2);
        assertRc(`sha3_512 hash_alloc#2 ${impl.name}`, rc);
        ctx2 = lib.HEAPU32[ctxPtrPtr2 >> 2];
      } finally {
        lib._free(ctxPtrPtr2);
      }

      try {
        rc = lib._lc_hash_init(ctx2);
        assertRc(`sha3_512 hash_init#2 ${impl.name}`, rc);
        lib._lc_hash_update(ctx2, msgPtr, msg.length);
        lib._lc_hash_final(ctx2, outPtr);
        assertEqBytes(`sha3_512 streaming#2 ${impl.name}`, readBytes(lib, outPtr, exp.length), exp);
      } finally {
        lib._lc_hash_zero_free(ctx2);
      }

      console.log(`PASS sha3_512 ${impl.name}`);
    } finally {
      lib._free(msgPtr);
      lib._free(outPtr);
    }
  }
}

function testHkdf(lib) {
  const ikm = new Uint8Array([
    0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b,
    0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b,
  ]);
  const salt = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
  const info = new Uint8Array([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
  const exp = new Uint8Array([
    0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0, 0x36,
    0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0, 0x2d, 0x56,
    0xec, 0xc4, 0xc5, 0xbf, 0x34, 0x00, 0x72, 0x08, 0xd5, 0xb8, 0x87, 0x18, 0x58, 0x65,
  ]);

  const hashPtr = resolveHashPtr(lib, lib._lc_sha256);
  const ikmPtr = allocAndWrite(lib, ikm);
  const saltPtr = allocAndWrite(lib, salt);
  const infoPtr = allocAndWrite(lib, info);
  const outPtr = lib._malloc(exp.length);

  try {
    const hkdfPtrPtr = lib._malloc(4);
    let hkdfCtx = 0;
    try {
      let rc = lib._lc_hkdf_alloc(hashPtr, hkdfPtrPtr);
      assertRc("hkdf_alloc stack-equivalent", rc);
      hkdfCtx = lib.HEAPU32[hkdfPtrPtr >> 2];
    } finally {
      lib._free(hkdfPtrPtr);
    }

    try {
      let rc = lib._lc_hkdf_extract(hkdfCtx, ikmPtr, ikm.length, saltPtr, salt.length);
      assertRc("hkdf_extract stack-equivalent", rc);
      rc = lib._lc_hkdf_expand(hkdfCtx, infoPtr, info.length, outPtr, exp.length);
      assertRc("hkdf_expand stack-equivalent", rc);
      assertEqBytes("hkdf stack-equivalent", readBytes(lib, outPtr, exp.length), exp);
    } finally {
      lib._lc_hkdf_zero_free(hkdfCtx);
    }

    const rngPtrPtr = lib._malloc(4);
    let hkdfRng = 0;
    try {
      let rc = lib._lc_hkdf_rng_alloc(rngPtrPtr, hashPtr);
      assertRc("hkdf_rng_alloc", rc);
      hkdfRng = lib.HEAPU32[rngPtrPtr >> 2];
    } finally {
      lib._free(rngPtrPtr);
    }

    try {
      let rc = lib._lc_rng_seed(hkdfRng, ikmPtr, ikm.length, saltPtr, salt.length);
      assertRc("hkdf_rng seed", rc);
      rc = lib._lc_rng_generate(hkdfRng, infoPtr, info.length, outPtr, exp.length);
      assertRc("hkdf_rng generate", rc);
      assertEqBytes("hkdf rng", readBytes(lib, outPtr, exp.length), exp);

      for (let block = 1; block <= exp.length; block++) {
        rc = lib._lc_rng_zero(hkdfRng);
        rc = lib._lc_rng_seed(hkdfRng, ikmPtr, ikm.length, saltPtr, salt.length);
        assertRc(`hkdf_rng reseed block=${block}`, rc);

        let off = 0;
        while (off < exp.length) {
          const todo = Math.min(block, exp.length - off);
          rc = lib._lc_rng_generate(hkdfRng, infoPtr, info.length, outPtr + off, todo);
          assertRc(`hkdf_rng chunk gen block=${block}`, rc);
          off += todo;
        }

        assertEqBytes(`hkdf rng regenerate block=${block}`, readBytes(lib, outPtr, exp.length), exp);
      }
    } finally {
      lib._lc_rng_zero_free(hkdfRng);
    }

    let rc = lib._lc_hkdf(hashPtr, ikmPtr, ikm.length, saltPtr, salt.length, infoPtr, info.length, outPtr, exp.length);
    assertRc("hkdf oneshot", rc);
    assertEqBytes("hkdf oneshot", readBytes(lib, outPtr, exp.length), exp);

    const hkdfHeapPtrPtr = lib._malloc(4);
    let hkdfHeap = 0;
    try {
      rc = lib._lc_hkdf_alloc(hashPtr, hkdfHeapPtrPtr);
      assertRc("hkdf_alloc heap", rc);
      hkdfHeap = lib.HEAPU32[hkdfHeapPtrPtr >> 2];
    } finally {
      lib._free(hkdfHeapPtrPtr);
    }

    try {
      rc = lib._lc_hkdf_extract(hkdfHeap, ikmPtr, ikm.length, saltPtr, salt.length);
      assertRc("hkdf_extract heap", rc);
      rc = lib._lc_hkdf_expand(hkdfHeap, infoPtr, info.length, outPtr, exp.length);
      assertRc("hkdf_expand heap", rc);
      assertEqBytes("hkdf heap", readBytes(lib, outPtr, exp.length), exp);
    } finally {
      lib._lc_hkdf_zero_free(hkdfHeap);
    }

    console.log("PASS hkdf_sha256");
  } finally {
    lib._free(ikmPtr);
    lib._free(saltPtr);
    lib._free(infoPtr);
    lib._free(outPtr);
  }
}

function testHkdfSha3_512(lib) {
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
    assertRc("hkdf_sha3_512 oneshot", rc);
    assertEqBytes("hkdf_sha3_512 oneshot", readBytes(lib, outPtr, exp.length), exp);
    console.log("PASS hkdf_sha3_512");
  } finally {
    lib._free(ikmPtr);
    lib._free(saltPtr);
    lib._free(outPtr);
  }
}

function testSphincs(lib) {
  // enum lc_sphincs_type values from lc_sphincs.h
  const SPHINCS_SHAKE_256s = 1;
  const SPHINCS_SHAKE_256f = 2;
  const SPHINCS_SHAKE_192s = 3;
  const SPHINCS_SHAKE_192f = 4;
  const SPHINCS_SHAKE_128s = 5;
  const SPHINCS_SHAKE_128f = 6;
  const staticDrng = lib.HEAPU32[lib._lc_static_drng >> 2];
  if (!staticDrng) throw new Error("lc_static_drng pointer is null");

  const cases = [
    {
      name: "shake_128f",
      sphincsType: SPHINCS_SHAKE_128f,
      seedLen: 48,
      keypairFn: "_lc_sphincs_shake_128f_keypair",
      signFn: "_lc_sphincs_shake_128f_sign",
      verifyFn: "_lc_sphincs_shake_128f_verify",
    },
    {
      name: "shake_128s",
      sphincsType: SPHINCS_SHAKE_128s,
      seedLen: 48,
      keypairFn: "_lc_sphincs_shake_128s_keypair",
      signFn: "_lc_sphincs_shake_128s_sign",
      verifyFn: "_lc_sphincs_shake_128s_verify",
    },
    {
      name: "shake_192f",
      sphincsType: SPHINCS_SHAKE_192f,
      seedLen: 72,
      keypairFn: "_lc_sphincs_shake_192f_keypair",
      signFn: "_lc_sphincs_shake_192f_sign",
      verifyFn: "_lc_sphincs_shake_192f_verify",
    },
    {
      name: "shake_192s",
      sphincsType: SPHINCS_SHAKE_192s,
      seedLen: 72,
      keypairFn: "_lc_sphincs_shake_192s_keypair",
      signFn: "_lc_sphincs_shake_192s_sign",
      verifyFn: "_lc_sphincs_shake_192s_verify",
    },
    {
      name: "shake_256f",
      sphincsType: SPHINCS_SHAKE_256f,
      seedLen: 96,
      keypairFn: "_lc_sphincs_shake_256f_keypair",
      signFn: "_lc_sphincs_shake_256f_sign",
      verifyFn: "_lc_sphincs_shake_256f_verify",
    },
    {
      name: "shake_256s",
      sphincsType: SPHINCS_SHAKE_256s,
      seedLen: 96,
      keypairFn: "_lc_sphincs_shake_256s_keypair",
      signFn: "_lc_sphincs_shake_256s_sign",
      verifyFn: "_lc_sphincs_shake_256s_verify",
    },
  ];

  for (const tc of cases) {
    if (typeof lib[tc.keypairFn] !== "function" || typeof lib[tc.signFn] !== "function" || typeof lib[tc.verifyFn] !== "function") {
      continue;
    }

    const pkLen = lib._lc_sphincs_pk_size(tc.sphincsType);
    const skLen = lib._lc_sphincs_sk_size(tc.sphincsType);
    const sigLen = lib._lc_sphincs_sig_size(tc.sphincsType);
    if (!pkLen || !skLen || !sigLen) throw new Error(`sphincs ${tc.name}: invalid size`);

    const seed = seq(0x20 + tc.sphincsType, tc.seedLen);
    const msg = repeatRange(0xd8, 33, 1);
    const seedPtr = allocAndWrite(lib, seed);
    const msgPtr = allocAndWrite(lib, msg);
    const pkPtr = lib._malloc(pkLen);
    const skPtr = lib._malloc(skLen);
    const sigPtr = lib._malloc(sigLen);
    const pk2Ptr = lib._malloc(pkLen);
    const sk2Ptr = lib._malloc(skLen);
    const sig2Ptr = lib._malloc(sigLen);
    const statePtr = lib._malloc(8);
    const rngCtxPtr = lib._malloc(8);
    const vecPkPtr = lib._malloc(pkLen);
    const vecSkPtr = lib._malloc(skLen);
    const vecSigPtr = lib._malloc(sigLen);

    try {
      // Build lc_static_rng_data and lc_rng_ctx directly in WASM memory.
      lib.HEAPU32[statePtr >> 2] = seedPtr;
      lib.HEAPU32[(statePtr >> 2) + 1] = seed.length;
      lib.HEAPU32[rngCtxPtr >> 2] = staticDrng;
      lib.HEAPU32[(rngCtxPtr >> 2) + 1] = statePtr;

      // Determinism check with fixed seed: generate twice, expect identical keys.
      let rc = lib[tc.keypairFn](pkPtr, skPtr, rngCtxPtr);
      assertRc(`sphincs ${tc.name} keypair #1`, rc);
      // Reset static RNG state for second deterministic run.
      lib.HEAPU32[statePtr >> 2] = seedPtr;
      lib.HEAPU32[(statePtr >> 2) + 1] = seed.length;
      rc = lib[tc.keypairFn](pk2Ptr, sk2Ptr, rngCtxPtr);
      assertRc(`sphincs ${tc.name} keypair #2`, rc);
      assertEqBytes(`sphincs ${tc.name} pk deterministic`, readBytes(lib, pkPtr, pkLen), readBytes(lib, pk2Ptr, pkLen));
      assertEqBytes(`sphincs ${tc.name} sk deterministic`, readBytes(lib, skPtr, skLen), readBytes(lib, sk2Ptr, skLen));

      // Deterministic signing with NULL RNG must also be stable.
      rc = lib[tc.signFn](sigPtr, msgPtr, msg.length, skPtr, 0);
      assertRc(`sphincs ${tc.name} sign #1`, rc);
      rc = lib[tc.signFn](sig2Ptr, msgPtr, msg.length, skPtr, 0);
      assertRc(`sphincs ${tc.name} sign #2`, rc);
      assertEqBytes(`sphincs ${tc.name} sig deterministic`, readBytes(lib, sigPtr, sigLen), readBytes(lib, sig2Ptr, sigLen));

      rc = lib[tc.verifyFn](sigPtr, msgPtr, msg.length, pkPtr);
      assertRc(`sphincs ${tc.name} verify`, rc);

      // Negative check: flip one signature byte and expect verification error.
      const tampered = readBytes(lib, sigPtr, sigLen);
      tampered[0] ^= 0x01;
      lib.HEAPU8.set(tampered, sig2Ptr);
      rc = lib[tc.verifyFn](sig2Ptr, msgPtr, msg.length, pkPtr);
      if (rc !== -EBADMSG) throw new Error(`sphincs ${tc.name} tamper verify: expected ${-EBADMSG}, got ${rc}`);

      const vecDef = SPHINCS_TEST_VECTORS[tc.name];
      if (!vecDef) throw new Error(`missing SPHINCS vector for ${tc.name}`);
      const vec = {
        seed: hexToU8(vecDef.seedHex),
        msg: hexToU8(vecDef.msgHex),
        pk: hexToU8(vecDef.pkHex),
        sk: hexToU8(vecDef.skHex),
        sig: hexToU8(vecDef.sigHex),
      };
      if (vec.pk.length !== pkLen || vec.sk.length !== skLen || vec.sig.length !== sigLen) {
        throw new Error(`sphincs ${tc.name} vector size mismatch`);
      }
      const vecSeedPtr = allocAndWrite(lib, vec.seed);
      const vecMsgPtr = allocAndWrite(lib, vec.msg);
      try {
        lib.HEAPU32[statePtr >> 2] = vecSeedPtr;
        lib.HEAPU32[(statePtr >> 2) + 1] = vec.seed.length;

        rc = lib[tc.keypairFn](vecPkPtr, vecSkPtr, rngCtxPtr);
        assertRc(`sphincs ${tc.name} vector keypair`, rc);
        assertEqBytes(`sphincs ${tc.name} vector pk`, readBytes(lib, vecPkPtr, pkLen), vec.pk);
        assertEqBytes(`sphincs ${tc.name} vector sk`, readBytes(lib, vecSkPtr, skLen), vec.sk);

        rc = lib[tc.signFn](vecSigPtr, vecMsgPtr, vec.msg.length, vecSkPtr, 0);
        assertRc(`sphincs ${tc.name} vector sign`, rc);
        assertEqBytes(`sphincs ${tc.name} vector sig`, readBytes(lib, vecSigPtr, sigLen), vec.sig);

        rc = lib[tc.verifyFn](vecSigPtr, vecMsgPtr, vec.msg.length, vecPkPtr);
        assertRc(`sphincs ${tc.name} vector verify`, rc);
      } finally {
        lib._free(vecSeedPtr);
        lib._free(vecMsgPtr);
      }

      console.log(`PASS sphincs_${tc.name}`);
    } finally {
      lib._free(seedPtr);
      lib._free(msgPtr);
      lib._free(pkPtr);
      lib._free(skPtr);
      lib._free(sigPtr);
      lib._free(pk2Ptr);
      lib._free(sk2Ptr);
      lib._free(sig2Ptr);
      lib._free(statePtr);
      lib._free(rngCtxPtr);
      lib._free(vecPkPtr);
      lib._free(vecSkPtr);
      lib._free(vecSigPtr);
    }
  }
}

async function main() {
  const lib = await leancrypto();
  assertRc("lc_init", lib._lc_init());

  testAsconKeccak(lib);
  testHmacSha3_224(lib);
  testSha3_512(lib);
  testHkdf(lib);
  testHkdfSha3_512(lib);
  testSphincs(lib);

  console.log("All leancrypto WASM vector tests passed");
}

// Dual-mode: Vitest test wrapper or standalone Node execution
if (typeof globalThis.test === 'function') {
  globalThis.test('leancrypto WASM vector tests', () => main(), 60_000);
} else {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
}

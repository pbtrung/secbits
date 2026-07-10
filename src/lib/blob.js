export const BLOB_MAGIC = new Uint8Array([0x53, 0x42]); // "SB"
export const BLOB_VERSION = new Uint8Array([0x01, 0x00]); // v1.0
export const BLOB_SALT_LEN = 64;
export const BLOB_TAG_LEN = 64;
export const BLOB_HEADER_LEN = BLOB_MAGIC.length + BLOB_VERSION.length;
export const BLOB_AD_LEN = BLOB_HEADER_LEN + BLOB_SALT_LEN;
export const BLOB_MIN_LEN = BLOB_HEADER_LEN + BLOB_SALT_LEN + BLOB_TAG_LEN;

function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const arr of arrays) {
    out.set(arr, off);
    off += arr.length;
  }
  return out;
}

export function buildBlob({ version = BLOB_VERSION, salt, ciphertext, tag }) {
  if (!(salt instanceof Uint8Array) || salt.length !== BLOB_SALT_LEN) {
    throw new Error('Invalid blob salt');
  }
  if (!(ciphertext instanceof Uint8Array)) {
    throw new Error('Invalid blob ciphertext');
  }
  if (!(tag instanceof Uint8Array) || tag.length !== BLOB_TAG_LEN) {
    throw new Error('Invalid blob tag');
  }
  if (!(version instanceof Uint8Array) || version.length !== BLOB_VERSION.length) {
    throw new Error('Invalid blob version');
  }
  const ad = concat(BLOB_MAGIC, version, salt);
  return concat(ad, ciphertext, tag);
}

export function parseBlob(blobBytes) {
  if (!(blobBytes instanceof Uint8Array) || blobBytes.length < BLOB_MIN_LEN) {
    throw new Error('Invalid encrypted value');
  }
  for (let i = 0; i < BLOB_MAGIC.length; i++) {
    if (blobBytes[i] !== BLOB_MAGIC[i]) {
      throw new Error('Invalid encrypted value');
    }
  }

  const versionStart = BLOB_MAGIC.length;
  const saltStart = versionStart + BLOB_VERSION.length;
  const ctStart = saltStart + BLOB_SALT_LEN;
  const tagStart = blobBytes.length - BLOB_TAG_LEN;

  const version = blobBytes.slice(versionStart, saltStart);
  const salt = blobBytes.slice(saltStart, ctStart);
  const ciphertext = blobBytes.slice(ctStart, tagStart);
  const tag = blobBytes.slice(tagStart);
  const ad = blobBytes.slice(0, ctStart);

  return { version, salt, ciphertext, tag, ad };
}

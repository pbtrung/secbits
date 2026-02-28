use std::ptr;
use std::sync::Once;

use leancrypto_sys::ffi::leancrypto;
use rand::TryRngCore;
use rand::rngs::OsRng;
use zeroize::Zeroize;

use crate::Result;
use crate::error::AppError;

pub const MAGIC: [u8; 2] = [0x53, 0x42];
pub const VERSION_MAJOR: u8 = 0x01;
pub const VERSION_MINOR: u8 = 0x00;

pub const MAGIC_LEN: usize = 2;
pub const VERSION_LEN: usize = 2;
pub const HEADER_LEN: usize = MAGIC_LEN + VERSION_LEN;
pub const SALT_LEN: usize = 64;
pub const USER_MASTER_KEY_LEN: usize = 64;
pub const DOC_KEY_LEN: usize = 64;
pub const ENC_KEY_LEN: usize = 64;
pub const ENC_IV_LEN: usize = 64;
pub const TAG_LEN: usize = 64;
pub const HKDF_OUT_LEN: usize = ENC_KEY_LEN + ENC_IV_LEN;
pub const AAD_LEN: usize = HEADER_LEN + SALT_LEN;
pub const MIN_BLOB_LEN: usize = HEADER_LEN + SALT_LEN + TAG_LEN;
pub const MASTER_BLOB_LEN: usize = HEADER_LEN + SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN;

pub fn hkdf_sha3_512(key: &[u8], salt: &[u8]) -> Result<[u8; HKDF_OUT_LEN]> {
    if key.is_empty() || salt.len() != SALT_LEN {
        return Err(AppError::InvalidKeyMaterial);
    }

    ensure_leancrypto_initialized()?;

    let mut out = [0_u8; HKDF_OUT_LEN];

    let rc = unsafe {
        leancrypto::lc_hkdf(
            leancrypto::lc_sha3_512,
            key.as_ptr(),
            key.len(),
            salt.as_ptr(),
            salt.len(),
            ptr::null(),
            0,
            out.as_mut_ptr(),
            out.len(),
        )
    };

    if rc < 0 {
        out.zeroize();
        return Err(AppError::KeyDerivationFailed);
    }

    Ok(out)
}

pub fn encrypt_bytes_to_blob(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if key.is_empty() {
        return Err(AppError::InvalidKeyMaterial);
    }

    ensure_leancrypto_initialized()?;

    let mut salt = [0_u8; SALT_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let aad = build_aad(&salt);
    let mut material = derive_material(key, &salt)?;
    let mut ciphertext = vec![0_u8; plaintext.len()];
    let mut tag = [0_u8; TAG_LEN];

    let mut aead = AeadContext::new(TAG_LEN as u8)?;
    aead.setkey(&material.enc_key, &material.enc_iv)?;
    aead.encrypt(plaintext, &aad, &mut ciphertext, &mut tag)?;

    let mut blob = Vec::with_capacity(HEADER_LEN + SALT_LEN + ciphertext.len() + TAG_LEN);
    blob.extend_from_slice(&MAGIC);
    blob.extend_from_slice(&[VERSION_MAJOR, VERSION_MINOR]);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ciphertext);
    blob.extend_from_slice(&tag);

    material.enc_key.zeroize();
    material.enc_iv.zeroize();

    Ok(blob)
}

pub fn decrypt_bytes_from_blob(key: &[u8], blob: &[u8]) -> Result<Vec<u8>> {
    if key.is_empty() {
        return Err(AppError::InvalidKeyMaterial);
    }

    if blob.len() < MIN_BLOB_LEN {
        return Err(AppError::InvalidBlobFormat);
    }

    if blob[..MAGIC_LEN] != MAGIC {
        return Err(AppError::InvalidBlobFormat);
    }

    let major = blob[MAGIC_LEN];
    let minor = blob[MAGIC_LEN + 1];
    if major != VERSION_MAJOR {
        return Err(AppError::UnsupportedBlobVersion { major, minor });
    }

    let salt_start = HEADER_LEN;
    let ct_start = salt_start + SALT_LEN;
    let tag_start = blob.len() - TAG_LEN;

    let mut salt = [0_u8; SALT_LEN];
    salt.copy_from_slice(&blob[salt_start..ct_start]);

    let ciphertext = &blob[ct_start..tag_start];
    let tag = &blob[tag_start..];

    let aad = build_aad(&salt);
    let mut material = derive_material(key, &salt)?;
    let mut plaintext = vec![0_u8; ciphertext.len()];

    let mut aead = AeadContext::new(TAG_LEN as u8)?;
    aead.setkey(&material.enc_key, &material.enc_iv)?;
    aead.decrypt(ciphertext, &aad, &mut plaintext, tag)?;

    material.enc_key.zeroize();
    material.enc_iv.zeroize();

    Ok(plaintext)
}

#[derive(Debug)]
struct KeyMaterial {
    enc_key: [u8; ENC_KEY_LEN],
    enc_iv: [u8; ENC_IV_LEN],
}

fn derive_material(key: &[u8], salt: &[u8]) -> Result<KeyMaterial> {
    let out = hkdf_sha3_512(key, salt)?;

    let mut enc_key = [0_u8; ENC_KEY_LEN];
    enc_key.copy_from_slice(&out[..ENC_KEY_LEN]);

    let mut enc_iv = [0_u8; ENC_IV_LEN];
    enc_iv.copy_from_slice(&out[ENC_KEY_LEN..]);

    Ok(KeyMaterial { enc_key, enc_iv })
}

fn build_aad(salt: &[u8; SALT_LEN]) -> [u8; AAD_LEN] {
    let mut aad = [0_u8; AAD_LEN];
    aad[..MAGIC_LEN].copy_from_slice(&MAGIC);
    aad[MAGIC_LEN..HEADER_LEN].copy_from_slice(&[VERSION_MAJOR, VERSION_MINOR]);
    aad[HEADER_LEN..].copy_from_slice(salt);
    aad
}

struct AeadContext {
    ctx: *mut leancrypto::lc_aead_ctx,
}

impl AeadContext {
    fn new(tag_len: u8) -> Result<Self> {
        let mut ctx: *mut leancrypto::lc_aead_ctx = ptr::null_mut();

        let rc =
            unsafe { leancrypto::lc_ak_alloc_taglen(leancrypto::lc_sha3_512, tag_len, &mut ctx) };
        if rc < 0 || ctx.is_null() {
            return Err(AppError::CryptoOperationFailed(rc));
        }

        let expected_alg =
            unsafe { leancrypto::lc_aead_algorithm_type(leancrypto::lc_ascon_keccak_aead) };
        let actual_alg = unsafe { leancrypto::lc_aead_ctx_algorithm_type(ctx) };
        if expected_alg == 0 || actual_alg != expected_alg {
            unsafe {
                leancrypto::lc_aead_zero_free(ctx);
            }
            return Err(AppError::CryptoAlgorithmMismatch);
        }

        Ok(Self { ctx })
    }

    fn setkey(&mut self, key: &[u8], iv: &[u8]) -> Result<()> {
        if key.len() != ENC_KEY_LEN || iv.len() != ENC_IV_LEN {
            return Err(AppError::InvalidKeyMaterial);
        }

        let rc = unsafe {
            leancrypto::lc_aead_setkey(self.ctx, key.as_ptr(), key.len(), iv.as_ptr(), iv.len())
        };
        if rc < 0 {
            return Err(AppError::CryptoOperationFailed(rc));
        }

        Ok(())
    }

    fn encrypt(
        &mut self,
        plaintext: &[u8],
        aad: &[u8],
        ciphertext: &mut [u8],
        tag: &mut [u8],
    ) -> Result<()> {
        if tag.len() != TAG_LEN || ciphertext.len() != plaintext.len() {
            return Err(AppError::InvalidBlobFormat);
        }

        let rc = unsafe {
            leancrypto::lc_aead_encrypt(
                self.ctx,
                plaintext.as_ptr(),
                ciphertext.as_mut_ptr(),
                plaintext.len(),
                aad.as_ptr(),
                aad.len(),
                tag.as_mut_ptr(),
                tag.len(),
            )
        };

        if rc < 0 {
            return Err(AppError::CryptoOperationFailed(rc));
        }

        Ok(())
    }

    fn decrypt(
        &mut self,
        ciphertext: &[u8],
        aad: &[u8],
        plaintext: &mut [u8],
        tag: &[u8],
    ) -> Result<()> {
        if tag.len() != TAG_LEN || plaintext.len() != ciphertext.len() {
            return Err(AppError::InvalidBlobFormat);
        }

        let rc = unsafe {
            leancrypto::lc_aead_decrypt(
                self.ctx,
                ciphertext.as_ptr(),
                plaintext.as_mut_ptr(),
                ciphertext.len(),
                aad.as_ptr(),
                aad.len(),
                tag.as_ptr(),
                tag.len(),
            )
        };

        if rc == -(leancrypto::EBADMSG as i32) {
            return Err(AppError::DecryptionFailedAuthentication);
        }
        if rc < 0 {
            return Err(AppError::CryptoOperationFailed(rc));
        }

        Ok(())
    }
}

impl Drop for AeadContext {
    fn drop(&mut self) {
        if !self.ctx.is_null() {
            unsafe {
                leancrypto::lc_aead_zero_free(self.ctx);
            }
            self.ctx = ptr::null_mut();
        }
    }
}

fn ensure_leancrypto_initialized() -> Result<()> {
    static INIT: Once = Once::new();
    static mut INIT_STATUS: i32 = 0;

    INIT.call_once(|| {
        let rc = unsafe { leancrypto::lc_init(0) };
        unsafe {
            INIT_STATUS = rc;
        }
    });

    let status = unsafe { INIT_STATUS };
    if status < 0 {
        return Err(AppError::CryptoOperationFailed(status));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        AAD_LEN, HEADER_LEN, HKDF_OUT_LEN, MAGIC, MIN_BLOB_LEN, SALT_LEN, TAG_LEN, VERSION_MAJOR,
        VERSION_MINOR, decrypt_bytes_from_blob, encrypt_bytes_to_blob, hkdf_sha3_512,
    };
    use crate::error::AppError;

    fn key(seed: u8, len: usize) -> Vec<u8> {
        vec![seed; len]
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let plaintext = b"hello secbits";
        let blob = encrypt_bytes_to_blob(&key(7, 256), plaintext).expect("encrypts");
        let out = decrypt_bytes_from_blob(&key(7, 256), &blob).expect("decrypts");
        assert_eq!(out, plaintext);
    }

    #[test]
    fn empty_plaintext_round_trip() {
        let blob = encrypt_bytes_to_blob(&key(9, 256), b"").expect("encrypts");
        assert_eq!(blob.len(), MIN_BLOB_LEN);
        let out = decrypt_bytes_from_blob(&key(9, 256), &blob).expect("decrypts");
        assert!(out.is_empty());
    }

    #[test]
    fn large_plaintext_round_trip() {
        let payload = vec![0xAB_u8; 1024 * 1024];
        let blob = encrypt_bytes_to_blob(&key(10, 512), &payload).expect("encrypts");
        let out = decrypt_bytes_from_blob(&key(10, 512), &blob).expect("decrypts");
        assert_eq!(out, payload);
    }

    #[test]
    fn fresh_salt_changes_ciphertext() {
        let plaintext = b"same payload";
        let key = key(11, 256);
        let a = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");
        let b = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");
        assert_ne!(a, b);
    }

    #[test]
    fn blob_layout_is_correct() {
        let payload = b"abc123";
        let blob = encrypt_bytes_to_blob(&key(12, 256), payload).expect("encrypts");

        assert_eq!(&blob[..2], &MAGIC);
        assert_eq!(blob[2], VERSION_MAJOR);
        assert_eq!(blob[3], VERSION_MINOR);
        assert_eq!(blob.len(), HEADER_LEN + SALT_LEN + payload.len() + TAG_LEN);
    }

    #[test]
    fn wrong_key_rejected() {
        let blob = encrypt_bytes_to_blob(&key(13, 256), b"top secret").expect("encrypts");
        let err = decrypt_bytes_from_blob(&key(14, 256), &blob).expect_err("must fail");
        assert!(matches!(err, AppError::DecryptionFailedAuthentication));
    }

    #[test]
    fn tampered_magic_rejected() {
        let mut blob = encrypt_bytes_to_blob(&key(15, 256), b"x").expect("encrypts");
        blob[0] ^= 0x01;
        let err = decrypt_bytes_from_blob(&key(15, 256), &blob).expect_err("must fail");
        assert!(matches!(err, AppError::InvalidBlobFormat));
    }

    #[test]
    fn tampered_version_major_rejected() {
        let mut blob = encrypt_bytes_to_blob(&key(16, 256), b"x").expect("encrypts");
        blob[2] = 0xFF;
        let err = decrypt_bytes_from_blob(&key(16, 256), &blob).expect_err("must fail");
        assert!(matches!(err, AppError::UnsupportedBlobVersion { .. }));
    }

    #[test]
    fn tampered_salt_rejected() {
        let mut blob = encrypt_bytes_to_blob(&key(17, 256), b"abcdef").expect("encrypts");
        blob[HEADER_LEN + 2] ^= 0x01;
        let err = decrypt_bytes_from_blob(&key(17, 256), &blob).expect_err("must fail");
        assert!(matches!(err, AppError::DecryptionFailedAuthentication));
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let mut blob = encrypt_bytes_to_blob(&key(18, 256), b"abcdef").expect("encrypts");
        blob[HEADER_LEN + SALT_LEN + 1] ^= 0x80;
        let err = decrypt_bytes_from_blob(&key(18, 256), &blob).expect_err("must fail");
        assert!(matches!(err, AppError::DecryptionFailedAuthentication));
    }

    #[test]
    fn tampered_tag_rejected() {
        let mut blob = encrypt_bytes_to_blob(&key(19, 256), b"abcdef").expect("encrypts");
        let last = blob.len() - 1;
        blob[last] ^= 0x40;
        let err = decrypt_bytes_from_blob(&key(19, 256), &blob).expect_err("must fail");
        assert!(matches!(err, AppError::DecryptionFailedAuthentication));
    }

    #[test]
    fn truncated_blob_rejected() {
        let blob = encrypt_bytes_to_blob(&key(20, 256), b"").expect("encrypts");
        let err = decrypt_bytes_from_blob(&key(20, 256), &blob[..MIN_BLOB_LEN - 1])
            .expect_err("must fail");
        assert!(matches!(err, AppError::InvalidBlobFormat));

        let err2 = decrypt_bytes_from_blob(&key(20, 256), &[]).expect_err("must fail");
        assert!(matches!(err2, AppError::InvalidBlobFormat));
    }

    #[test]
    fn hkdf_is_deterministic_and_sensitive() {
        let salt = [0x22_u8; SALT_LEN];
        let key_a = key(1, 256);
        let key_b = key(2, 256);

        let out1 = hkdf_sha3_512(&key_a, &salt).expect("hkdf");
        let out2 = hkdf_sha3_512(&key_a, &salt).expect("hkdf");
        assert_eq!(out1, out2);

        let out3 = hkdf_sha3_512(&key_b, &salt).expect("hkdf");
        assert_ne!(out1, out3);

        let mut salt2 = salt;
        salt2[0] ^= 0x01;
        let out4 = hkdf_sha3_512(&key_a, &salt2).expect("hkdf");
        assert_ne!(out1, out4);

        assert_eq!(out1.len(), HKDF_OUT_LEN);
    }

    #[test]
    fn append_garbage_is_rejected() {
        let mut blob = encrypt_bytes_to_blob(&key(23, 256), b"abcdef").expect("encrypts");
        blob.extend_from_slice(&[1, 2, 3, 4]);
        let err = decrypt_bytes_from_blob(&key(23, 256), &blob).expect_err("must fail");
        assert!(matches!(
            err,
            AppError::InvalidBlobFormat | AppError::DecryptionFailedAuthentication
        ));
    }

    #[test]
    fn aad_size_matches_spec() {
        assert_eq!(AAD_LEN, HEADER_LEN + SALT_LEN);
    }
}

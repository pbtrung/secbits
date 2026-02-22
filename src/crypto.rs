use std::ptr;
use std::sync::Once;

use leancrypto_sys::ffi::leancrypto;
use rand::rngs::OsRng;
use rand::TryRngCore;
use zeroize::Zeroize;

use crate::error::AppError;
use crate::Result;

pub const SALT_LEN: usize = 64;
pub const USER_MASTER_KEY_LEN: usize = 64;
pub const DOC_KEY_LEN: usize = 64;
pub const ENC_KEY_LEN: usize = 64;
pub const ENC_IV_LEN: usize = 64;
pub const TAG_LEN: usize = 64;
pub const HKDF_OUT_LEN: usize = ENC_KEY_LEN + ENC_IV_LEN;
pub const MASTER_BLOB_LEN: usize = SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN;

const HKDF_INFO: &[u8] = b"secbits:enc-material:v1";

pub fn encrypt_bytes_to_blob(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if key.is_empty() {
        return Err(AppError::InvalidKeyMaterial);
    }

    ensure_leancrypto_initialized()?;

    let mut salt = [0_u8; SALT_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let mut material = derive_material(key, &salt)?;
    let mut ciphertext = vec![0_u8; plaintext.len()];
    let mut tag = [0_u8; TAG_LEN];

    let mut aead = AeadContext::new(TAG_LEN as u8)?;
    aead.setkey(&material.enc_key, &material.enc_iv)?;
    aead.encrypt(plaintext, &mut ciphertext, &mut tag)?;

    let mut blob = Vec::with_capacity(SALT_LEN + ciphertext.len() + TAG_LEN);
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

    if blob.len() < SALT_LEN + TAG_LEN {
        return Err(AppError::InvalidBlob);
    }

    ensure_leancrypto_initialized()?;

    let salt = &blob[..SALT_LEN];
    let ciphertext = &blob[SALT_LEN..blob.len() - TAG_LEN];
    let tag = &blob[blob.len() - TAG_LEN..];

    let mut material = derive_material(key, salt)?;
    let mut plaintext = vec![0_u8; ciphertext.len()];

    let mut aead = AeadContext::new(TAG_LEN as u8)?;
    aead.setkey(&material.enc_key, &material.enc_iv)?;
    aead.decrypt(ciphertext, &mut plaintext, tag)?;

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
    let mut out = [0_u8; HKDF_OUT_LEN];

    let rc = unsafe {
        leancrypto::lc_hkdf(
            leancrypto::lc_sha3_512,
            key.as_ptr(),
            key.len(),
            salt.as_ptr(),
            salt.len(),
            HKDF_INFO.as_ptr(),
            HKDF_INFO.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    };

    if rc < 0 {
        out.zeroize();
        return Err(AppError::KeyDerivationFailed);
    }

    let mut enc_key = [0_u8; ENC_KEY_LEN];
    enc_key.copy_from_slice(&out[..ENC_KEY_LEN]);

    let mut enc_iv = [0_u8; ENC_IV_LEN];
    enc_iv.copy_from_slice(&out[ENC_KEY_LEN..]);

    out.zeroize();

    Ok(KeyMaterial { enc_key, enc_iv })
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

        Ok(Self { ctx })
    }

    fn setkey(&mut self, key: &[u8], iv: &[u8]) -> Result<()> {
        let rc = unsafe {
            leancrypto::lc_aead_setkey(self.ctx, key.as_ptr(), key.len(), iv.as_ptr(), iv.len())
        };

        if rc < 0 {
            return Err(AppError::CryptoOperationFailed(rc));
        }

        Ok(())
    }

    fn encrypt(&mut self, plaintext: &[u8], ciphertext: &mut [u8], tag: &mut [u8]) -> Result<()> {
        let rc = unsafe {
            leancrypto::lc_aead_encrypt(
                self.ctx,
                plaintext.as_ptr(),
                ciphertext.as_mut_ptr(),
                plaintext.len(),
                ptr::null(),
                0,
                tag.as_mut_ptr(),
                tag.len(),
            )
        };

        if rc < 0 {
            return Err(AppError::CryptoOperationFailed(rc));
        }

        Ok(())
    }

    fn decrypt(&mut self, ciphertext: &[u8], plaintext: &mut [u8], tag: &[u8]) -> Result<()> {
        let rc = unsafe {
            leancrypto::lc_aead_decrypt(
                self.ctx,
                ciphertext.as_ptr(),
                plaintext.as_mut_ptr(),
                ciphertext.len(),
                ptr::null(),
                0,
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
    use super::{decrypt_bytes_from_blob, encrypt_bytes_to_blob, SALT_LEN, TAG_LEN};
    use crate::error::AppError;

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = [1_u8; 64];
        let plaintext = b"secret payload for entry history";

        let blob = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");
        let decrypted = decrypt_bytes_from_blob(&key, &blob).expect("decrypts");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypting_same_plaintext_twice_changes_output() {
        let key = [2_u8; 64];
        let plaintext = b"constant payload";

        let a = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");
        let b = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");

        assert_ne!(a, b);
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let key = [3_u8; 64];
        let plaintext = b"auth check";

        let mut blob = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");
        blob[SALT_LEN] ^= 0x01;

        let err = decrypt_bytes_from_blob(&key, &blob).expect_err("must fail");
        assert!(matches!(err, AppError::DecryptionFailedAuthentication));
    }

    #[test]
    fn tampered_tag_fails_authentication() {
        let key = [4_u8; 64];
        let plaintext = b"tag check";

        let mut blob = encrypt_bytes_to_blob(&key, plaintext).expect("encrypts");
        let idx = blob.len() - TAG_LEN;
        blob[idx] ^= 0x10;

        let err = decrypt_bytes_from_blob(&key, &blob).expect_err("must fail");
        assert!(matches!(err, AppError::DecryptionFailedAuthentication));
    }

    #[test]
    fn blob_too_short_is_rejected() {
        let key = [5_u8; 64];
        let err = decrypt_bytes_from_blob(&key, &[0_u8; 10]).expect_err("must fail");
        assert!(matches!(err, AppError::InvalidBlob));
    }
}

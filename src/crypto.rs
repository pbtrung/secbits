use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::TryRngCore;
use sha3::{Digest, Sha3_512};
use subtle::ConstantTimeEq;
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

type HmacSha3_512 = Hmac<Sha3_512>;

#[derive(Debug)]
struct KeyMaterial {
    enc_key: [u8; ENC_KEY_LEN],
    enc_iv: [u8; ENC_IV_LEN],
}

impl Drop for KeyMaterial {
    fn drop(&mut self) {
        self.enc_key.zeroize();
        self.enc_iv.zeroize();
    }
}

pub fn encrypt_bytes_to_blob(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if key.is_empty() {
        return Err(AppError::InvalidKeyMaterial);
    }

    let mut salt = [0_u8; SALT_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let material = derive_material(key, &salt)?;
    let ciphertext = xor_stream(&material, plaintext);
    let tag = compute_tag(&material, &ciphertext)?;

    let mut blob = Vec::with_capacity(SALT_LEN + ciphertext.len() + TAG_LEN);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ciphertext);
    blob.extend_from_slice(&tag);
    Ok(blob)
}

pub fn decrypt_bytes_from_blob(key: &[u8], blob: &[u8]) -> Result<Vec<u8>> {
    if key.is_empty() {
        return Err(AppError::InvalidKeyMaterial);
    }

    if blob.len() < SALT_LEN + TAG_LEN {
        return Err(AppError::InvalidBlob);
    }

    let salt = &blob[..SALT_LEN];
    let ciphertext = &blob[SALT_LEN..blob.len() - TAG_LEN];
    let tag = &blob[blob.len() - TAG_LEN..];

    let material = derive_material(key, salt)?;
    let expected_tag = compute_tag(&material, ciphertext)?;

    if expected_tag.as_slice().ct_eq(tag).unwrap_u8() != 1 {
        return Err(AppError::DecryptionFailedAuthentication);
    }

    Ok(xor_stream(&material, ciphertext))
}

fn derive_material(key: &[u8], salt: &[u8]) -> Result<KeyMaterial> {
    let hk = Hkdf::<Sha3_512>::new(Some(salt), key);

    let mut out = [0_u8; HKDF_OUT_LEN];
    hk.expand(b"secbits:enc-material:v1", &mut out)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let mut enc_key = [0_u8; ENC_KEY_LEN];
    enc_key.copy_from_slice(&out[..ENC_KEY_LEN]);

    let mut enc_iv = [0_u8; ENC_IV_LEN];
    enc_iv.copy_from_slice(&out[ENC_KEY_LEN..]);

    out.zeroize();

    Ok(KeyMaterial { enc_key, enc_iv })
}

fn xor_stream(material: &KeyMaterial, input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut counter: u64 = 0;

    while output.len() < input.len() {
        let mut hasher = Sha3_512::new();
        hasher.update(material.enc_key);
        hasher.update(material.enc_iv);
        hasher.update(counter.to_le_bytes());
        let block = hasher.finalize();

        let remaining = input.len() - output.len();
        let take = remaining.min(block.len());

        let start = output.len();
        for idx in 0..take {
            output.push(input[start + idx] ^ block[idx]);
        }

        counter = counter.wrapping_add(1);
    }

    output
}

fn compute_tag(material: &KeyMaterial, ciphertext: &[u8]) -> Result<[u8; TAG_LEN]> {
    let mut mac = HmacSha3_512::new_from_slice(&material.enc_key)
        .map_err(|_| AppError::KeyDerivationFailed)?;
    mac.update(&material.enc_iv);
    mac.update(ciphertext);

    let mut out = [0_u8; TAG_LEN];
    out.copy_from_slice(&mac.finalize().into_bytes());
    Ok(out)
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

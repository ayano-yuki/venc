use anyhow::{anyhow, ensure, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

pub type Key = Zeroizing<[u8; 32]>;

pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| anyhow!("OS randomness unavailable"))?;
    Ok(bytes)
}
pub fn new_key() -> Result<Key> {
    Ok(Zeroizing::new(random()?))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Kdf {
    pub algorithm: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt_a: [u8; 16],
    pub salt_b: [u8; 16],
    pub hkdf_salt: [u8; 32],
}
impl Kdf {
    pub fn new() -> Result<Self> {
        Ok(Self {
            algorithm: "argon2id".into(),
            memory_kib: 65536,
            iterations: 3,
            parallelism: 1,
            salt_a: random()?,
            salt_b: random()?,
            hkdf_salt: random()?,
        })
    }
    pub fn derive(&self, a: &[u8], b: &[u8]) -> Result<Key> {
        // Validate untrusted cost parameters before allocating Argon2 memory.
        ensure!(
            self.algorithm == "argon2id"
                && self.memory_kib == 65536
                && self.iterations == 3
                && self.parallelism == 1,
            "unsupported KDF parameters"
        );
        ensure!(
            !a.is_empty() && !b.is_empty(),
            "both passwords must be nonempty"
        );
        ensure!(a.len() <= 4096 && b.len() <= 4096, "password too long");
        let params = Params::new(self.memory_kib, self.iterations, self.parallelism, Some(32))
            .map_err(|_| anyhow!("invalid KDF parameters"))?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut ikm = Zeroizing::new([0u8; 64]);
        argon
            .hash_password_into(a, &self.salt_a, &mut ikm[..32])
            .map_err(|_| anyhow!("key derivation failed"))?;
        argon
            .hash_password_into(b, &self.salt_b, &mut ikm[32..])
            .map_err(|_| anyhow!("key derivation failed"))?;
        expand(&ikm[..], &self.hkdf_salt, b"venc/v1/vmk-wrap")
    }
}
pub fn expand(ikm: &[u8], salt: &[u8], info: &[u8]) -> Result<Key> {
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut key[..])
        .map_err(|_| anyhow!("key derivation failed"))?;
    Ok(key)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sealed {
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}
pub fn seal(key: &Key, plain: &[u8], aad: &[u8]) -> Result<Sealed> {
    let nonce = random()?;
    let cipher = XChaCha20Poly1305::new((&**key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| anyhow!("encryption failed"))?;
    Ok(Sealed { nonce, ciphertext })
}
pub fn open(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let cipher = XChaCha20Poly1305::new((&**key).into());
    cipher
        .decrypt(
            XNonce::from_slice(&sealed.nonce),
            Payload {
                msg: &sealed.ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| anyhow!("authentication failed: wrong passwords or damaged vault"))
}
pub fn open_key(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Key> {
    let plain = open(key, sealed, aad)?;
    ensure!(plain.len() == 32, "invalid key length");
    let mut result = Zeroizing::new([0; 32]);
    result.copy_from_slice(&plain);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authentication_and_domains() -> Result<()> {
        let key = new_key()?;
        let sealed = seal(&key, b"secret", b"file1")?;
        assert_eq!(&*open(&key, &sealed, b"file1")?, b"secret");
        assert!(open(&key, &sealed, b"file2").is_err());
        let mut corrupt = sealed.clone();
        corrupt.ciphertext[0] ^= 1;
        assert!(open(&key, &corrupt, b"file1").is_err());
        corrupt.ciphertext.pop();
        assert!(open(&key, &corrupt, b"file1").is_err());
        Ok(())
    }
    #[test]
    fn both_passwords_required() -> Result<()> {
        let kdf = Kdf::new()?;
        let key = kdf.derive(b"alpha", b"beta")?;
        let sealed = seal(&key, b"master", b"vault")?;
        for (a, b) in [
            (b"wrong".as_slice(), b"beta".as_slice()),
            (b"alpha", b"wrong"),
            (b"beta", b"alpha"),
        ] {
            assert!(open(&kdf.derive(a, b)?, &sealed, b"vault").is_err());
        }
        assert!(open(&kdf.derive(b"alpha", b"beta")?, &sealed, b"vault").is_ok());
        let mut hostile = kdf;
        hostile.memory_kib = u32::MAX;
        assert!(hostile.derive(b"a", b"b").is_err());
        Ok(())
    }
}

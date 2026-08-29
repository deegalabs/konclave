//! Konclave's confidential-channel primitive (ECIES over X25519), shared by the browser signer
//! (`konclave-wasm`) and the hosted helper (`orchestrator`) so ONE implementation seals both the
//! DKG round-2 packages and the SignRequest (#63 / ADR-0007 I3). A blind or hostile relay carries
//! only ciphertext: an ephemeral X25519 key -> HKDF-SHA256 -> an XChaCha20-Poly1305 box.
//! Confidentiality comes from here; plaintext authenticity is guaranteed independently (the DKG
//! checks each round-2 share; the transport signs every relay message).

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

const INFO: &[u8] = b"konclave-dkg-seal-v1";
const EPH_LEN: usize = 32;
const NONCE_LEN: usize = 24;

/// A device's long-term encryption keypair - separate from its FROST share. The public
/// half rides in the invite/contacts; the secret half never leaves the device.
pub struct DeviceKey {
    secret: StaticSecret,
}

impl DeviceKey {
    /// A fresh keypair from the OS CSPRNG.
    pub fn generate() -> DeviceKey {
        let mut b = [0u8; 32];
        OsRng.fill_bytes(&mut b);
        DeviceKey {
            secret: StaticSecret::from(b),
        }
    }
    /// Restore from the 32 secret bytes persisted on the device.
    pub fn from_secret_bytes(b: &[u8; 32]) -> DeviceKey {
        DeviceKey {
            secret: StaticSecret::from(*b),
        }
    }
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }
    pub fn public_bytes(&self) -> [u8; 32] {
        PublicKey::from(&self.secret).to_bytes()
    }
}

/// A device's PERSISTENT comms identity for a vault, derived deterministically from its FROST
/// share (the serialized KeyPackage). Unlike `generate()` (a fresh ephemeral key), this is the
/// device's long-term identity: reproduced on every unlock from the already-sealed share, so
/// NOTHING NEW IS STORED and no key-distribution migration touches the sealed-share blob. HKDF
/// over the share with a distinct info label yields a key independent of the DKG-seal key; the
/// share cannot be recovered from the public half (HKDF is one-way). This public half is what a
/// device registers with the helper so the helper can seal the SignRequest to it (#63 / I3).
pub fn device_key_from_share(key_package: &[u8]) -> DeviceKey {
    // HKDF-SHA256 over the share with an info label distinct from the DKG-seal one, so the
    // comms key is cryptographically independent of the sealing key derived elsewhere.
    // StaticSecret::from clamps the 32 bytes, so any HKDF output is a valid X25519 secret.
    let hk = Hkdf::<Sha256>::new(None, key_package);
    let mut okm = [0u8; 32];
    hk.expand(b"konclave-device-comms-v1", &mut okm)
        .expect("hkdf expand 32 bytes never fails");
    DeviceKey::from_secret_bytes(&okm)
}

fn derive_key(shared: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, shared);
    let mut okm = [0u8; 32];
    hk.expand(INFO, &mut okm)
        .expect("hkdf expand 32 bytes never fails");
    okm
}

/// Seal `plaintext` to `recipient_pub` (32-byte X25519 public key). `aad` binds context
/// (e.g. the sender and recipient identifiers) into the tag. Wire layout:
/// `ephemeral_pub(32) ‖ nonce(24) ‖ ciphertext`.
pub fn seal(recipient_pub: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let eph = EphemeralSecret::random_from_rng(OsRng);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_pub));
    let key = derive_key(shared.as_bytes());
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "seal: encrypt failed".to_string())?;
    let mut out = Vec::with_capacity(EPH_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Open a sealed message with this device's secret. `aad` must equal what was sealed, or
/// the tag check fails. A wrong key or any tampering is an error, never a silent bad open.
pub fn open(device: &DeviceKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < EPH_LEN + NONCE_LEN {
        return Err("open: message too short".into());
    }
    let mut eph = [0u8; EPH_LEN];
    eph.copy_from_slice(&sealed[..EPH_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&sealed[EPH_LEN..EPH_LEN + NONCE_LEN]);
    let ct = &sealed[EPH_LEN + NONCE_LEN..];
    let shared = device.secret.diffie_hellman(&PublicKey::from(eph));
    let key = derive_key(shared.as_bytes());
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: ct, aad })
        .map_err(|_| "open: wrong recipient or tampered message".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_key_derived_from_a_share_is_deterministic_and_distinct() {
        // The persistent device identity (#63): derived from the FROST share, so it survives a
        // reload with nothing stored, and every device gets its OWN identity.
        let share_a = b"device A's serialized FROST KeyPackage bytes".as_slice();
        let share_b = b"device B's serialized FROST KeyPackage bytes".as_slice();

        // Deterministic: the same share always yields the same identity (reproduced on unlock).
        assert_eq!(
            device_key_from_share(share_a).public_bytes(),
            device_key_from_share(share_a).public_bytes(),
            "the same share must derive the same device identity every time",
        );
        // Distinct: different devices (different shares) get different identities.
        assert_ne!(
            device_key_from_share(share_a).public_bytes(),
            device_key_from_share(share_b).public_bytes(),
            "different shares must derive different device identities",
        );
        // Usable: a message sealed to the derived public opens with the derived key.
        let dev = device_key_from_share(share_a);
        let aad = b"helper->device:sign-request";
        let sealed = seal(&dev.public_bytes(), b"sighash+alpha+pczt", aad).unwrap();
        assert_eq!(
            open(&device_key_from_share(share_a), &sealed, aad).unwrap(),
            b"sighash+alpha+pczt",
            "the derived key must open what was sealed to its public half",
        );
    }

    #[test]
    fn a_sealed_package_opens_only_for_its_recipient() {
        let bob = DeviceKey::generate();
        let aad = b"alice->bob:round2";
        let secret_share = b"this stands in for a DKG round-2 secret package";
        let sealed = seal(&bob.public_bytes(), secret_share, aad).unwrap();

        // Bob opens it.
        assert_eq!(open(&bob, &sealed, aad).unwrap(), secret_share);

        // A different device cannot.
        let mallory = DeviceKey::generate();
        assert!(open(&mallory, &sealed, aad).is_err());
    }

    #[test]
    fn tampering_or_wrong_context_is_rejected() {
        let bob = DeviceKey::generate();
        let aad = b"alice->bob:round2";
        let mut sealed = seal(&bob.public_bytes(), b"payload", aad).unwrap();

        // Flip a ciphertext byte → tag fails.
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(open(&bob, &sealed, aad).is_err());

        // Right ciphertext, wrong AAD (different sender/recipient binding) → tag fails.
        let good = seal(&bob.public_bytes(), b"payload", aad).unwrap();
        assert!(open(&bob, &good, b"eve->bob:round2").is_err());
    }

    #[test]
    fn the_relay_only_ever_sees_ciphertext() {
        // The sealed bytes must not contain the plaintext anywhere (a blind relay holding
        // these learns nothing about the share).
        let bob = DeviceKey::generate();
        let plaintext = b"SECRET-SHARE-MATERIAL-0xdeadbeef";
        let sealed = seal(&bob.public_bytes(), plaintext, b"ctx").unwrap();
        assert!(
            !sealed.windows(plaintext.len()).any(|w| w == plaintext),
            "plaintext must never appear in the sealed bytes"
        );
    }

    #[test]
    fn a_persisted_device_key_round_trips() {
        let k = DeviceKey::generate();
        let restored = DeviceKey::from_secret_bytes(&k.secret_bytes());
        assert_eq!(k.public_bytes(), restored.public_bytes());
    }
}

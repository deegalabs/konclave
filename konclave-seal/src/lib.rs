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
    // #421. `x25519-dalek` deliberately does NOT reject small-order peer keys; it exposes this
    // check and leaves it to the caller. Skipping it is not a theoretical lapse: against such a
    // key the shared secret is all zeros, so `derive_key` yields a CONSTANT anyone can compute,
    // and under hybrid sealing that one box carries the body key shared with every other
    // recipient. One bad registered key would unseal the request for the whole vault.
    //
    // The ecosystem does not agree here, which is why it is easy to miss: Noise discourages the
    // check, libsodium performs it and fails, HPKE (RFC 9180 s7.1.4) requires it. For a key that
    // arrives over an unauthenticated registration endpoint, refusing is the only defensible
    // choice.
    if !shared.was_contributory() {
        return Err("seal: recipient public key has small order".to_string());
    }
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
    // The mirror of the check in `seal`, and it is not redundant. An attacker who cannot choose
    // OUR key can still choose the EPHEMERAL one on a message it sends us, reaching the same
    // constant key. The AEAD tag does not save us there: the attacker derives that key too, so
    // its tag is correct and the message opens. Refuse before the tag, not after.
    if !shared.was_contributory() {
        return Err("open: the message's ephemeral key has small order".to_string());
    }
    let key = derive_key(shared.as_bytes());
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: ct, aad })
        .map_err(|_| "open: wrong recipient or tampered message".to_string())
}

// ---------- Hybrid sealing: encrypt a large body ONCE, seal only the small key to each recipient ----
//
// Sealing a whole SignRequest to EACH device (via `seal`) multiplies the ~PCZT-sized body by the
// signer count and blew the relay's 128 KiB message cap for a real send (#63). Hybrid fixes that: the
// helper encrypts the body once under a random symmetric key (`seal_body`) and `seal`s only that
// 32-byte key to each device, so the wire is ~one body plus a tiny box per device - flat in the
// signer count. Each device opens its box for the key, then `open_body`s the shared body.

/// A fresh 32-byte symmetric key for hybrid sealing, from the OS CSPRNG.
pub fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    k
}

/// Encrypt `plaintext` under a raw 32-byte key (XChaCha20-Poly1305). Wire: `nonce(24) ‖ ciphertext`.
pub fn seal_body(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: b"",
            },
        )
        .expect("xchacha20-poly1305 encryption never fails");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

/// Decrypt what `seal_body` produced. A wrong key or any tampering is an error, never a bad open.
pub fn open_body(key: &[u8; 32], sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < NONCE_LEN {
        return Err("open_body: message too short".into());
    }
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&sealed[..NONCE_LEN]);
    let ct = &sealed[NONCE_LEN..];
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: ct, aad: b"" })
        .map_err(|_| "open_body: wrong key or tampered message".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_sealed_under_a_symmetric_key_opens_only_with_that_key() {
        // Hybrid sealing (#63): the body is encrypted once; only the key is sealed per device.
        let k = random_key();
        let plaintext = b"a large SignRequest body carrying the PCZT hex".as_slice();
        let sealed = seal_body(&k, plaintext);
        assert_eq!(
            open_body(&k, &sealed).unwrap(),
            plaintext,
            "round-trips with its key"
        );
        assert!(
            open_body(&random_key(), &sealed).is_err(),
            "a different key cannot open it"
        );
        assert!(
            !sealed.windows(plaintext.len()).any(|w| w == plaintext),
            "the plaintext never appears in the sealed body",
        );
    }

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

#[cfg(test)]
mod low_order_tests {
    use super::*;

    /// The canonical small-order X25519 points. Any of these as a peer key drives the shared
    /// secret to all zeros, so the derived key becomes a constant anyone can compute. They are
    /// published (RFC 7748 s6.1 discusses the cofactor; these are the standard test vectors used
    /// by libsodium and the "May the Fourth Be With You" analysis), which is the point: an
    /// attacker does not have to find one.
    const LOW_ORDER: [[u8; 32]; 6] = [
        [0u8; 32],
        {
            let mut b = [0u8; 32];
            b[0] = 1;
            b
        },
        [
            0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f,
            0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16,
            0x5f, 0x49, 0xb8, 0x00,
        ],
        [
            0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83,
            0xef, 0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd,
            0xd0, 0x9f, 0x11, 0xd7,
        ],
        // p-1 (order 2). NOT [0xff; 32]: X25519 clears the high bit, so that decodes to u = 18,
        // an ordinary high-order point. Getting this wrong is easy and the test caught it.
        [
            0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0x7f,
        ],
        // p (decodes to zero)
        [
            0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xff, 0x7f,
        ],
    ];

    #[test]
    fn sealing_to_a_low_order_key_is_refused() {
        // #421. x25519-dalek deliberately does NOT reject these; it exposes `was_contributory()`
        // and leaves the check to the caller. Without it, the box addressed to such a key is
        // encrypted under a CONSTANT, and in hybrid sealing that box carries the body key shared
        // with every other recipient - so one bad registered key unseals the request for everyone.
        for (i, bad) in LOW_ORDER.iter().enumerate() {
            let out = seal(bad, b"the SignRequest body key", b"aad");
            assert!(
                out.is_err(),
                "low-order point {i} was accepted; the box would use a key anyone can compute",
            );
        }
    }

    #[test]
    fn sealing_to_an_honest_key_still_works() {
        // The other half: the check must not break the path it guards. A device key derived from a
        // real share has to keep round-tripping.
        let device = device_key_from_share(b"a serialized KeyPackage stands in here");
        let pubkey = device.public_bytes();
        let sealed = seal(&pubkey, b"hello", b"aad").expect("an honest key seals");
        assert_eq!(open(&device, &sealed, b"aad").unwrap(), b"hello");
    }

    #[test]
    fn opening_a_message_forged_under_the_constant_key_is_refused() {
        // The mirror image, and it has to be tested with a message that a NAIVE implementation
        // would ACCEPT. Feeding `open` random bytes proves nothing: the AEAD tag rejects those on
        // its own, so the test would pass without any contributory check at all.
        //
        // So this forges properly. With a low-order ephemeral the shared secret is all zeros for
        // EVERY recipient, so the attacker derives the same key the device will derive, encrypts
        // real content under it, and hands it over. No knowledge of the device's key is needed.
        let device = DeviceKey::generate();

        let key = derive_key(&[0u8; 32]); // what the device computes from a zero shared secret
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        let nonce = [7u8; NONCE_LEN];
        let ct = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: b"a forged SignRequest",
                    aad: b"aad",
                },
            )
            .expect("encrypting under the constant key never fails");

        let mut forged = Vec::with_capacity(EPH_LEN + NONCE_LEN + ct.len());
        forged.extend_from_slice(&[0u8; EPH_LEN]); // the low-order ephemeral
        forged.extend_from_slice(&nonce);
        forged.extend_from_slice(&ct);

        assert!(
            open(&device, &forged, b"aad").is_err(),
            "a message forged under the all-zero shared secret must be refused, and the AEAD tag \
             cannot refuse it because the tag is correct for that key",
        );
    }
}

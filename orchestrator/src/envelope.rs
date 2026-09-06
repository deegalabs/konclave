//! The hybrid seal-to-many envelope (#481), as ONE implementation.
//!
//! #63 built this for the signing request and it lived inside `net_send::seal_request_wire`, shaped
//! around that one message. Sealing the viewing key needed the same thing, and a second copy of an
//! envelope format is worse than a second copy of most code: the two sides have to agree byte for
//! byte, and a drift shows up as "wrong key or tampering" with no way to tell which end is wrong.
//!
//! The shape is hybrid because the alternative does not fit: sealing a whole body once per device
//! multiplies it by the signer count, which is what overflowed the relay's 128 KiB cap in #63. So
//! the body is encrypted ONCE under a random key, and only that 32-byte key is sealed per device.
//!
//! `konclave-seal` deliberately does not host this: it does cryptography, not wire formats, and
//! giving it serde to carry a JSON shape would put the boundary in the wrong place.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A body encrypted once, plus one small sealed box of the body key per recipient device.
///
/// `kind` is carried so a reader can tell an envelope from the plaintext it replaced without
/// guessing, which is what makes the compat path (below) safe to keep.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SealedEnvelope {
    pub kind: String,
    /// Hex of the body, encrypted under a random key with `konclave_seal::seal_body`.
    pub body: String,
    /// device pubkey (hex) -> hex of that device's sealed copy of the body key.
    pub boxes: BTreeMap<String, String>,
}

fn hexenc(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hexdec(s: &str, what: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("{what}: odd hex length"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("{what}: {e}")))
        .collect()
}

/// Seal `plaintext` to every device in `device_pubs`.
///
/// Returns `Ok(None)` when there are no devices - the caller decides what that means. For the
/// signing request it means the plaintext compat path (a device on an older build still has to
/// receive something it understands); for the viewing key it means the vault has not migrated yet.
/// Making it an explicit `None` rather than an empty envelope stops a caller from confusing "sealed
/// to nobody" with "sealed", which would serve an unopenable blob and look like it worked.
pub fn seal_to_devices(
    kind: &str,
    plaintext: &[u8],
    device_pubs: &[String],
) -> Result<Option<SealedEnvelope>, String> {
    if device_pubs.is_empty() {
        return Ok(None);
    }
    let key = konclave_seal::random_key();
    let body = hexenc(&konclave_seal::seal_body(&key, plaintext));
    let mut boxes = BTreeMap::new();
    for ph in device_pubs {
        let pk: [u8; 32] = hexdec(ph, "device pubkey")?
            .try_into()
            .map_err(|_| "device pubkey must be 32 bytes".to_string())?;
        // AAD = the recipient's own pubkey, so a box cannot be lifted out of one device's slot and
        // replayed into another's.
        let sealed_key = konclave_seal::seal(&pk, &key, &pk).map_err(|e| format!("seal: {e}"))?;
        boxes.insert(ph.clone(), hexenc(&sealed_key));
    }
    Ok(Some(SealedEnvelope {
        kind: kind.to_string(),
        body,
        boxes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use konclave_seal::DeviceKey;

    fn dev() -> (DeviceKey, String) {
        let k = DeviceKey::generate();
        let p = hexenc(&k.public_bytes());
        (k, p)
    }

    /// The round trip, through the same primitives the browser uses.
    #[test]
    fn every_named_device_opens_it_and_gets_the_same_body() {
        let (ka, pa) = dev();
        let (kb, pb) = dev();
        let env = seal_to_devices("test-kind", b"the viewing key", &[pa.clone(), pb.clone()])
            .unwrap()
            .expect("two devices means an envelope");

        for (k, p) in [(&ka, &pa), (&kb, &pb)] {
            let mine = hexdec(&env.boxes[p], "box").unwrap();
            let body_key: [u8; 32] = konclave_seal::open(k, &mine, &hexdec(p, "pub").unwrap())
                .expect("my own box opens")
                .try_into()
                .expect("32 bytes");
            let body = konclave_seal::open_body(&body_key, &hexdec(&env.body, "body").unwrap())
                .expect("and the body with it");
            assert_eq!(body, b"the viewing key");
        }
    }

    /// The property the AAD is there for. Without it a box is a portable ciphertext, and an
    /// attacker who can write the envelope could move one device's box into another's slot.
    #[test]
    fn a_box_cannot_be_replayed_into_another_devices_slot() {
        let (ka, pa) = dev();
        let (_kb, pb) = dev();
        let env = seal_to_devices("k", b"secret", &[pa.clone(), pb.clone()])
            .unwrap()
            .unwrap();
        let bs_box = hexdec(&env.boxes[&pb], "box").unwrap();
        assert!(
            konclave_seal::open(&ka, &bs_box, &hexdec(&pa, "pub").unwrap()).is_err(),
            "A's key must not open B's box, even under A's own AAD"
        );
    }

    /// One body, not one per device: this is what kept #63 under the relay's 128 KiB cap, and it is
    /// the reason the shape is hybrid rather than the obvious seal-per-recipient.
    #[test]
    fn the_body_is_encrypted_once_however_many_devices_there_are() {
        let pubs: Vec<String> = (0..6).map(|_| dev().1).collect();
        let big = vec![7u8; 40_000];
        let one = seal_to_devices("k", &big, &pubs[..1]).unwrap().unwrap();
        let six = seal_to_devices("k", &big, &pubs).unwrap().unwrap();
        assert_eq!(one.body.len(), six.body.len(), "the body does not multiply");
        assert_eq!(six.boxes.len(), 6, "only the small key boxes do");
    }

    /// `None`, never an empty envelope. A caller must be unable to confuse "sealed to nobody" with
    /// "sealed" - that mistake serves an unopenable blob and looks like success.
    #[test]
    fn no_devices_is_an_explicit_none() {
        assert_eq!(seal_to_devices("k", b"x", &[]).unwrap(), None);
    }

    #[test]
    fn a_malformed_device_pubkey_is_refused_rather_than_skipped() {
        assert!(seal_to_devices("k", b"x", &["nothex".into()]).is_err());
        assert!(
            seal_to_devices("k", b"x", &["ab".into()]).is_err(),
            "a short key is not silently padded"
        );
    }
}

//! What a seat's signing share signs besides the threshold signature: one certificate per seat at
//! creation, read by the device that signs it and by the coordinator that verifies it, so the bytes
//! have one definition. Also the canonical form of a vault's public key package.
//!
//! A statement is typed. The one signer of free bytes is the room's, always under its own domain, so
//! it cannot produce a statement. Never under the group key, never with a randomizer, and a statement
//! is never 32 bytes, so it is never shaped like a sighash.

use pasta_curves::group::ff::Field;
use pasta_curves::group::{Group, GroupEncoding};
use pasta_curves::pallas;
use rand::rngs::OsRng;
use reddsa::orchard::SpendAuth;
use sha2::{Digest, Sha256};

/// The most seats a vault may have. The one definition; the wasm and the screens read or pin it.
pub const N_MAX: u16 = 16;

const ROOM_DOMAIN: &[u8] = b"konclave-room-v1\0";
const SEAT_DOMAIN: &[u8] = b"konclave-seat-v1\0";
const PKP_DOMAIN: &[u8] = b"konclave-pkp-v1\0";
const READKEY_DOMAIN: &[u8] = b"konclave-readkey-v1\0";

/// A quorum the signing library accepts: frost-core refuses fewer than 2 signers.
pub fn quorum_is_possible(t: u16, n: u16) -> bool {
    t >= 2 && t <= n && n <= N_MAX
}

/// What one seat states about the vault it was created into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatStatement {
    pub vault_id: [u8; 32],
    pub cp: u32,
    pub t: u16,
    pub n: u16,
    pub seat: u16,
    pub pkp_digest: [u8; 32],
    pub read_key_hash: [u8; 32],
    pub comms_pub: [u8; 32],
    pub write_pub: [u8; 32],
}

fn lp(out: &mut Vec<u8>, field: &[u8; 32]) {
    out.extend_from_slice(&(field.len() as u32).to_be_bytes());
    out.extend_from_slice(field);
}

/// The bytes a seat signs. Variable-looking fields are length-prefixed as in `write_message`.
pub fn seat_message(st: &SeatStatement) -> Vec<u8> {
    let mut out = SEAT_DOMAIN.to_vec();
    lp(&mut out, &st.vault_id);
    out.extend_from_slice(&st.cp.to_be_bytes());
    out.extend_from_slice(&st.t.to_be_bytes());
    out.extend_from_slice(&st.n.to_be_bytes());
    out.extend_from_slice(&st.seat.to_be_bytes());
    for field in [
        &st.pkp_digest,
        &st.read_key_hash,
        &st.comms_pub,
        &st.write_pub,
    ] {
        lp(&mut out, field);
    }
    out
}

/// The certificate: a RedPallas signature by the seat's signing share. `None` for bytes that are not
/// a scalar.
pub fn sign_seat(share: &[u8; 32], st: &SeatStatement) -> Option<[u8; 64]> {
    let key = reddsa::SigningKey::<SpendAuth>::try_from(*share).ok()?;
    Some(<[u8; 64]>::from(key.sign(OsRng, &seat_message(st))))
}

/// True iff `sig` is the signature of the share behind `verifying_share` over this statement.
pub fn verify_seat(verifying_share: &[u8; 32], st: &SeatStatement, sig: &[u8; 64]) -> bool {
    // Not the identity, which the library allows as a key.
    if point_of(verifying_share).is_err() {
        return false;
    }
    let Ok(key) = reddsa::VerificationKey::<SpendAuth>::try_from(*verifying_share) else {
        return false;
    };
    key.verify(&seat_message(st), &reddsa::Signature::from(*sig))
        .is_ok()
}

fn room_message(msg: &[u8]) -> Vec<u8> {
    let mut out = ROOM_DOMAIN.to_vec();
    out.extend_from_slice(msg);
    out
}

/// A room message, signed with this device's share. `None` for bytes that are not a scalar.
pub fn sign_room(share: &[u8; 32], msg: &[u8]) -> Option<[u8; 64]> {
    let key = reddsa::SigningKey::<SpendAuth>::try_from(*share).ok()?;
    Some(<[u8; 64]>::from(key.sign(OsRng, &room_message(msg))))
}

/// True iff `sig` is the signature of the share behind `verifying_share` over this room message.
pub fn verify_room(verifying_share: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    // Not the identity, as in `verify_seat`.
    if point_of(verifying_share).is_err() {
        return false;
    }
    let Ok(key) = reddsa::VerificationKey::<SpendAuth>::try_from(*verifying_share) else {
        return false;
    };
    key.verify(&room_message(msg), &reddsa::Signature::from(*sig))
        .is_ok()
}

/// Whether a sealed box to this comms key would be safe: not a key of small order.
pub fn comms_key_is_usable(key: &[u8; 32]) -> bool {
    crate::seal(key, b"check", b"").is_ok()
}

/// A write key the coordinator can verify with: a point, not a small-order one, in its canonical
/// encoding. `to_bytes` hands back the bytes it was given, so the comparison is on the decoded point.
pub fn write_key_is_usable(key: &[u8; 32]) -> bool {
    ed25519_dalek::VerifyingKey::from_bytes(key)
        .is_ok_and(|vk| !vk.is_weak() && vk.to_edwards().compress().to_bytes() == *key)
}

/// One seat's certificate as the device and the coordinator hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatProof {
    pub seat: u16,
    pub comms_pub: [u8; 32],
    pub write_pub: [u8; 32],
    pub read_key_hash: [u8; 32],
    pub sig: [u8; 64],
}

impl SeatProof {
    /// Only a certificate whose keys can be used proves a seat. A key another seat also names is
    /// usable: nothing can tell which of them holds it.
    pub fn keys_are_usable(&self) -> bool {
        comms_key_is_usable(&self.comms_pub) && write_key_is_usable(&self.write_pub)
    }
}

/// A certificate as it travels and as it is kept: lower-case hex, read in Rust only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProofJson {
    pub seat: u16,
    pub comms_pub: String,
    pub write_pub: String,
    pub read_key_hash: String,
    pub sig: String,
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lower_hex_bytes<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    crate::hex::decode(text)?.try_into().ok()
}

impl From<&SeatProof> for ProofJson {
    fn from(p: &SeatProof) -> Self {
        ProofJson {
            seat: p.seat,
            comms_pub: hex_lower(&p.comms_pub),
            write_pub: hex_lower(&p.write_pub),
            read_key_hash: hex_lower(&p.read_key_hash),
            sig: hex_lower(&p.sig),
        }
    }
}

impl ProofJson {
    pub fn parse(&self) -> Option<SeatProof> {
        Some(SeatProof {
            seat: self.seat,
            comms_pub: lower_hex_bytes(&self.comms_pub)?,
            write_pub: lower_hex_bytes(&self.write_pub)?,
            read_key_hash: lower_hex_bytes(&self.read_key_hash)?,
            sig: lower_hex_bytes(&self.sig)?,
        })
    }
}

/// What the coordinator stores for a read key: never the key.
pub fn read_key_hash(read_key: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update(READKEY_DOMAIN)
        .chain_update(read_key)
        .finalize()
        .into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    Shape,
    Quorum,
    NotThisVault,
    BadPoint,
    NotOnePolynomial,
}

/// A vault's public key package, independent of the signing library's own serialization. `shares[i]`
/// is seat `i + 1`'s verifying share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkpCanonical {
    pub group_key: [u8; 32],
    pub t: u16,
    pub shares: Vec<[u8; 32]>,
}

impl PkpCanonical {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = PKP_DOMAIN.to_vec();
        out.extend_from_slice(&self.group_key);
        out.extend_from_slice(&self.t.to_be_bytes());
        out.extend_from_slice(&(self.shares.len() as u16).to_be_bytes());
        for share in &self.shares {
            out.extend_from_slice(share);
        }
        out
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, PackageError> {
        let rest = bytes.strip_prefix(PKP_DOMAIN).ok_or(PackageError::Shape)?;
        if rest.len() < 36 {
            return Err(PackageError::Shape);
        }
        let (head, shares) = rest.split_at(36);
        let t = u16::from_be_bytes([head[32], head[33]]);
        let n = u16::from_be_bytes([head[34], head[35]]);
        if shares.len() != n as usize * 32 {
            return Err(PackageError::Shape);
        }
        if !quorum_is_possible(t, n) {
            return Err(PackageError::Quorum);
        }
        let mut group_key = [0; 32];
        group_key.copy_from_slice(&head[..32]);
        let shares = shares.as_chunks::<32>().0.to_vec();
        Ok(Self {
            group_key,
            t,
            shares,
        })
    }

    pub fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.encode()).into()
    }
}

/// The package belongs to this vault and lies on one polynomial of degree `t - 1`. The vault check
/// comes first, before any arithmetic. Holding a share is a separate question, for the certificates.
pub fn verify_package(pkp: &PkpCanonical, vault_id: &[u8; 32]) -> Result<(), PackageError> {
    if pkp.group_key != *vault_id {
        return Err(PackageError::NotThisVault);
    }
    let n = u16::try_from(pkp.shares.len()).map_err(|_| PackageError::Quorum)?;
    if !quorum_is_possible(pkp.t, n) {
        return Err(PackageError::Quorum);
    }
    // A group key with an odd y can never be a vault's spend-validating key.
    if pkp.group_key[31] & 0x80 != 0 {
        return Err(PackageError::BadPoint);
    }
    // The polynomial is fixed by its value at 0 (the group key) and at seats 1..t-1.
    let mut known = vec![point_of(&pkp.group_key)?];
    let shares = pkp
        .shares
        .iter()
        .map(point_of)
        .collect::<Result<Vec<_>, _>>()?;
    let t = pkp.t as usize;
    known.extend_from_slice(&shares[..t - 1]);
    for (index, share) in shares.iter().enumerate().skip(t - 1) {
        if interpolate(&known, index as u64 + 1) != *share {
            return Err(PackageError::NotOnePolynomial);
        }
    }
    Ok(())
}

/// A canonical point that is not the identity.
fn point_of(bytes: &[u8; 32]) -> Result<pallas::Point, PackageError> {
    let point: pallas::Point =
        Option::from(pallas::Point::from_bytes(bytes)).ok_or(PackageError::BadPoint)?;
    if bool::from(point.is_identity()) || point.to_bytes() != *bytes {
        return Err(PackageError::BadPoint);
    }
    Ok(point)
}

/// The value at `x` of the polynomial whose values at 0, 1, ... are `known`, in the exponent.
fn interpolate(known: &[pallas::Point], x: u64) -> pallas::Point {
    let scalar = |v: usize| pallas::Scalar::from(v as u64);
    let at = pallas::Scalar::from(x);
    let mut sum = pallas::Point::identity();
    for (j, point) in known.iter().enumerate() {
        let mut numerator = pallas::Scalar::ONE;
        let mut denominator = pallas::Scalar::ONE;
        for m in (0..known.len()).filter(|m| *m != j) {
            numerator *= at - scalar(m);
            denominator *= scalar(j) - scalar(m);
        }
        // `j != m` and both are at most N_MAX, so the denominator is never zero.
        sum += *point * (numerator * denominator.invert().unwrap());
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use pasta_curves::group::ff::PrimeField;

    fn point(s: u64) -> pallas::Point {
        pallas::Point::generator() * pallas::Scalar::from(s)
    }
    fn bytes(p: pallas::Point) -> [u8; 32] {
        p.to_bytes()
    }
    /// The package of the polynomial with these coefficients, the values worked out here and not
    /// through the function under test. The constant is moved up until the group key has an even y,
    /// which is what a real creation yields.
    fn package(coefficients: &[u64], n: u16) -> PkpCanonical {
        let mut c = coefficients.to_vec();
        while bytes(point(c[0]))[31] & 0x80 != 0 {
            c[0] += 1;
        }
        let f = |x: u64| c.iter().rev().fold(0u64, |acc, k| acc * x + k);
        PkpCanonical {
            group_key: bytes(point(c[0])),
            t: c.len() as u16,
            shares: (1..=n as u64).map(|x| bytes(point(f(x)))).collect(),
        }
    }
    fn honest() -> PkpCanonical {
        package(&[5, 7], 3)
    }
    /// The verifying share of a scalar: under the spend-authorization basepoint, not the curve's.
    fn public(k: &pallas::Scalar) -> [u8; 32] {
        let key = reddsa::SigningKey::<SpendAuth>::try_from(k.to_repr()).unwrap();
        <[u8; 32]>::from(reddsa::VerificationKey::from(&key))
    }
    fn statement() -> SeatStatement {
        SeatStatement {
            vault_id: [0xaa; 32],
            cp: 3,
            t: 2,
            n: 3,
            seat: 2,
            pkp_digest: [0xbb; 32],
            read_key_hash: [0xcc; 32],
            comms_pub: [0xdd; 32],
            write_pub: [0xee; 32],
        }
    }

    #[test]
    fn the_quorum_floor_and_ceiling_are_the_librarys_and_ours() {
        assert!(quorum_is_possible(2, 2));
        assert!(quorum_is_possible(2, 16));
        assert!(quorum_is_possible(16, 16));
        assert!(!quorum_is_possible(1, 2), "frost-core refuses one signer");
        assert!(!quorum_is_possible(0, 2));
        assert!(!quorum_is_possible(3, 2));
        assert!(!quorum_is_possible(2, 17));
        assert_eq!(N_MAX, 16);
    }

    #[test]
    fn seat_message_matches_the_table_byte_for_byte_and_is_207_bytes() {
        let mut want = b"konclave-seat-v1\0".to_vec();
        let lp = [0u8, 0, 0, 32];
        want.extend_from_slice(&lp);
        want.extend_from_slice(&[0xaa; 32]);
        want.extend_from_slice(&[0, 0, 0, 3, 0, 2, 0, 3, 0, 2]); // cp, t, n, seat
        for filler in [0xbb, 0xcc, 0xdd, 0xee] {
            want.extend_from_slice(&lp);
            want.extend_from_slice(&[filler; 32]);
        }
        assert_eq!(seat_message(&statement()), want);
        assert_eq!(want.len(), 207);
    }

    #[test]
    fn a_certificates_json_form_round_trips_in_lower_case_only() {
        let p = SeatProof {
            seat: 2,
            comms_pub: [0xab; 32],
            write_pub: [0xcd; 32],
            read_key_hash: [0xef; 32],
            sig: [0x12; 64],
        };
        let json = ProofJson::from(&p);
        assert_eq!(json.parse(), Some(p));
        let upper = ProofJson {
            comms_pub: json.comms_pub.to_uppercase(),
            ..json.clone()
        };
        assert_eq!(upper.parse(), None);
        let short = ProofJson {
            sig: "abcd".into(),
            ..json
        };
        assert_eq!(short.parse(), None);
    }

    #[test]
    fn usable_keys_are_refused_for_small_order_and_non_canonical_forms() {
        assert!(!comms_key_is_usable(&[0; 32]));
        assert!(comms_key_is_usable(&[9; 32]));
        assert!(!write_key_is_usable(&[0; 32]));
        let good = ed25519_dalek::SigningKey::from_bytes(&[3; 32])
            .verifying_key()
            .to_bytes();
        assert!(write_key_is_usable(&good));
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(!write_key_is_usable(&identity), "small order");
    }

    #[test]
    fn no_konclave_domain_is_a_prefix_of_another() {
        // Written out: the write one lives in this crate, the vote one is reserved for the change
        // that defines it.
        let all: [&[u8]; 6] = [
            ROOM_DOMAIN,
            SEAT_DOMAIN,
            PKP_DOMAIN,
            READKEY_DOMAIN,
            b"konclave-write-v1\0",
            b"konclave-vote-v2\0",
        ];
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                assert!(i == j || !b.starts_with(a), "{i} is a prefix of {j}");
            }
        }
    }

    #[test]
    fn pkp_digest_and_read_key_hash_golden_vectors() {
        // Computed outside this code, with Python's hashlib, over the bytes of the plan's table.
        let pkp = PkpCanonical {
            group_key: [0xaa; 32],
            t: 2,
            shares: vec![[1; 32], [2; 32], [3; 32]],
        };
        assert_eq!(pkp.encode().len(), 148);
        assert_eq!(
            pkp.digest().to_vec(),
            crate::hex::decode("ab07f477d5ba78cad925de158f4656df009398fa4284c6f5274d9b6d5cb27f26")
                .unwrap()
        );
        assert_eq!(
            read_key_hash(&[0x11; 32]).to_vec(),
            crate::hex::decode("3fd3719f250651e308bcf70a0a2edcd097ba4617fb2ecae684683e9333fa12ac")
                .unwrap()
        );
    }

    #[test]
    fn a_package_survives_encode_and_parse() {
        let pkp = honest();
        assert_eq!(PkpCanonical::parse(&pkp.encode()), Ok(pkp));
    }

    #[test]
    fn parse_refuses_a_bad_shape_and_an_impossible_quorum() {
        let good = honest().encode();
        assert_eq!(
            PkpCanonical::parse(&good[..good.len() - 1]),
            Err(PackageError::Shape)
        );
        assert_eq!(PkpCanonical::parse(b""), Err(PackageError::Shape));
        let mut other_domain = good.clone();
        other_domain[0] ^= 1;
        assert_eq!(PkpCanonical::parse(&other_domain), Err(PackageError::Shape));
        for (t, n) in [(1u16, 3u16), (4, 3), (2, 17)] {
            let pkp = PkpCanonical {
                group_key: [0; 32],
                t,
                shares: vec![[0; 32]; n as usize],
            };
            assert_eq!(
                PkpCanonical::parse(&pkp.encode()),
                Err(PackageError::Quorum)
            );
        }
    }

    #[test]
    fn parse_takes_exactly_the_package_and_nothing_around_it() {
        let good = honest().encode();
        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(PkpCanonical::parse(&trailing), Err(PackageError::Shape));
        assert_eq!(
            PkpCanonical::parse(&good[..16]),
            Err(PackageError::Shape),
            "domain only"
        );
        assert_eq!(
            PkpCanonical::parse(&good[..51]),
            Err(PackageError::Shape),
            "header cut"
        );
        let mut last_of_domain = good.clone();
        last_of_domain[15] ^= 1;
        assert_eq!(
            PkpCanonical::parse(&last_of_domain),
            Err(PackageError::Shape)
        );
    }

    #[test]
    fn an_honest_package_is_accepted() {
        let pkp = honest();
        assert_eq!(verify_package(&pkp, &pkp.group_key), Ok(()));
    }

    #[test]
    fn a_real_dealers_package_is_accepted_and_its_shares_sign_certificates() {
        use reddsa::frost::redpallas as frost;
        for (t, n) in [(2u16, 2u16), (2, 3), (3, 4), (5, 16)] {
            let (secrets, public) = frost::keys::generate_with_dealer(
                n,
                t,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .expect("a dealer");
            let group_key: [u8; 32] = public
                .verifying_key()
                .serialize()
                .unwrap()
                .try_into()
                .unwrap();
            let mut shares = Vec::new();
            for seat in 1..=n {
                let id = frost::Identifier::try_from(seat).unwrap();
                let vs = public.verifying_shares().get(&id).unwrap();
                shares.push(<[u8; 32]>::try_from(vs.serialize().unwrap()).unwrap());
            }
            let pkp = PkpCanonical {
                group_key,
                t,
                shares: shares.clone(),
            };
            assert_eq!(verify_package(&pkp, &group_key), Ok(()), "{t}-of-{n}");

            let id = frost::Identifier::try_from(n).unwrap();
            let share: [u8; 32] = secrets
                .get(&id)
                .unwrap()
                .signing_share()
                .serialize()
                .try_into()
                .unwrap();
            let st = SeatStatement {
                t,
                n,
                seat: n,
                ..statement()
            };
            let sig = sign_seat(&share, &st).expect("a share is a scalar");
            assert!(verify_seat(&shares[n as usize - 1], &st, &sig));
            assert!(!verify_seat(&shares[0], &st, &sig), "another seat's share");
        }
    }

    #[test]
    fn a_package_whose_group_key_is_not_the_vault_id_is_refused_before_any_arithmetic() {
        // The shares here are not even points: the answer must still be about the vault.
        let pkp = PkpCanonical {
            group_key: [9; 32],
            t: 2,
            shares: vec![[0xff; 32]; 3],
        };
        assert_eq!(
            verify_package(&pkp, &[8; 32]),
            Err(PackageError::NotThisVault)
        );
    }

    /// Every seat of every shape, t == n included, where every share is on the line only if the
    /// comparison reaches it.
    #[test]
    fn a_package_with_any_seat_off_the_polynomial_is_refused() {
        let shapes: [(&[u64], u16); 6] = [
            (&[5, 7], 2),
            (&[5, 7, 3], 3),
            (&[5, 7, 3, 2, 9, 1, 4, 8, 6, 2, 5, 3, 7, 1, 2, 9], 16),
            (&[5, 7], 3),
            (&[5, 7, 3], 5),
            (&[5, 7, 3, 2, 9], 16),
        ];
        for (coefficients, n) in shapes {
            let good = package(coefficients, n);
            assert_eq!(verify_package(&good, &good.group_key), Ok(()));
            for seat in 0..n as usize {
                let mut bad = good.clone();
                bad.shares[seat] = bytes(point(1_000_003 + seat as u64));
                assert_eq!(
                    verify_package(&bad, &bad.group_key),
                    Err(PackageError::NotOnePolynomial),
                    "seat {seat} of {n}"
                );
            }
        }
    }

    #[test]
    fn an_odd_y_group_key_is_refused() {
        let mut c = 5;
        while bytes(point(c))[31] & 0x80 == 0 {
            c += 1;
        }
        let f = |x: u64| c + 7 * x;
        let pkp = PkpCanonical {
            group_key: bytes(point(c)),
            t: 2,
            shares: (1..=3).map(|x| bytes(point(f(x)))).collect(),
        };
        assert_eq!(
            verify_package(&pkp, &pkp.group_key),
            Err(PackageError::BadPoint)
        );
    }

    /// `PkpCanonical`'s fields are public, so the check cannot lean on `parse`.
    #[test]
    fn verify_package_itself_refuses_an_impossible_quorum() {
        let good = honest();
        for (t, n) in [(0u16, 3usize), (1, 3), (4, 3), (2, 17), (2, 0)] {
            let pkp = PkpCanonical {
                t,
                shares: vec![good.shares[0]; n],
                ..good.clone()
            };
            assert_eq!(
                verify_package(&pkp, &pkp.group_key),
                Err(PackageError::Quorum)
            );
        }
    }

    #[test]
    fn a_certificate_under_the_identity_does_not_verify() {
        let base: pallas::Point =
            Option::from(pallas::Point::from_bytes(&public(&pallas::Scalar::ONE))).unwrap();
        let s = pallas::Scalar::from(1234u64);
        let mut forged = [0; 64];
        forged[..32].copy_from_slice(&bytes(base * s));
        forged[32..].copy_from_slice(&s.to_repr());
        assert!(!verify_seat(&[0; 32], &statement(), &forged));
    }

    #[test]
    fn an_identity_or_non_canonical_point_in_the_package_is_refused() {
        let mut identity = honest();
        identity.shares[0] = bytes(pallas::Point::identity());
        assert_eq!(
            verify_package(&identity, &identity.group_key.clone()),
            Err(PackageError::BadPoint)
        );

        let mut identity_key = honest();
        identity_key.group_key = bytes(pallas::Point::identity());
        assert_eq!(
            verify_package(&identity_key, &identity_key.group_key.clone()),
            Err(PackageError::BadPoint)
        );

        let mut not_a_point = honest();
        not_a_point.shares[1] = [0xff; 32];
        assert_eq!(
            verify_package(&not_a_point, &not_a_point.group_key.clone()),
            Err(PackageError::BadPoint)
        );
    }

    /// The check is about shape, not about who holds a share.
    #[test]
    fn a_package_on_one_polynomial_passes_whoever_made_it() {
        let y = loop {
            let y = pallas::Point::random(OsRng);
            if bytes(y)[31] & 0x80 == 0 {
                break y;
            }
        };
        let vs1 = pallas::Point::random(OsRng);
        let pkp = PkpCanonical {
            group_key: bytes(y),
            t: 2,
            shares: vec![
                bytes(vs1),
                bytes(vs1.double() - y),
                bytes(vs1.double() + vs1 - y.double()),
            ],
        };
        assert_eq!(verify_package(&pkp, &bytes(y)), Ok(()));
    }

    /// Made once by konclave-wasm's `room_auth::sign_with_share` at 105203d, share = [7; 32]. A room
    /// signature a device made before this code existed must still verify.
    #[test]
    fn a_room_signature_made_by_the_released_app_still_verifies() {
        let vs: [u8; 32] =
            crate::hex::decode("ab8f01a0845e54f646dafb878cd67f166334c322d0327b62433ee7cc0f0a6087")
                .unwrap()
                .try_into()
                .unwrap();
        let sig: [u8; 64] = crate::hex::decode(
            "39e1666bb6c736099117837f3c0a29b1fc3da8eec41955ef0e669eb4dc230408\
             9502964e8c47db397f6f63ea6ab52bb44fe40bef79069026af5aa56a9f87a412",
        )
        .unwrap()
        .try_into()
        .unwrap();
        assert!(verify_room(&vs, b"created:1:fixture", &sig));
        assert!(!verify_room(&vs, b"created:2:fixture", &sig));
    }

    #[test]
    fn a_room_signature_and_a_certificate_never_verify_as_each_other() {
        let k = pallas::Scalar::from(41u64);
        let vs = public(&k);
        let st = statement();
        let cert = sign_seat(&k.to_repr(), &st).unwrap();
        // The closest a room message can come: the statement's own bytes after the room's domain.
        let room = sign_room(&k.to_repr(), &seat_message(&st)).unwrap();
        assert!(verify_room(&vs, &seat_message(&st), &room));
        assert!(!verify_seat(&vs, &st, &room));
        assert!(!verify_room(&vs, &seat_message(&st), &cert));
    }

    #[test]
    fn a_room_signature_under_the_identity_does_not_verify() {
        let base: pallas::Point =
            Option::from(pallas::Point::from_bytes(&public(&pallas::Scalar::ONE))).unwrap();
        let s = pallas::Scalar::from(1234u64);
        let mut forged = [0; 64];
        forged[..32].copy_from_slice(&bytes(base * s));
        forged[32..].copy_from_slice(&s.to_repr());
        assert!(!verify_room(&[0; 32], b"any message", &forged));
    }

    #[test]
    fn a_certificate_for_anything_else_does_not_verify() {
        let k = pallas::Scalar::from(41u64);
        let vs = public(&k);
        let st = statement();
        let sig = sign_seat(&k.to_repr(), &st).unwrap();
        assert!(verify_seat(&vs, &st, &sig));
        let others = [
            SeatStatement {
                read_key_hash: [0; 32],
                ..st.clone()
            },
            SeatStatement {
                seat: 3,
                ..st.clone()
            },
            SeatStatement {
                vault_id: [0; 32],
                ..st.clone()
            },
            SeatStatement {
                pkp_digest: [0; 32],
                ..st.clone()
            },
            SeatStatement {
                write_pub: [0; 32],
                ..st.clone()
            },
            SeatStatement {
                comms_pub: [0; 32],
                ..st.clone()
            },
            SeatStatement {
                cp: 2,
                ..st.clone()
            },
            SeatStatement { t: 3, ..st.clone() },
            SeatStatement { n: 4, ..st.clone() },
        ];
        for other in others {
            assert!(!verify_seat(&vs, &other, &sig), "{other:?}");
        }
        assert!(!verify_seat(&[0xff; 32], &st, &sig), "not a key");
    }
}

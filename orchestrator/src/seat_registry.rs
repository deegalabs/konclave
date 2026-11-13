//! Who may pin a protocol-3 vault: the count of its seats' certificates over one package and one read
//! key. `tally` is pure, so a refused count leaves no trace to clean up; the doors below it write in
//! the order that recovers. The bytes and the package check live in `konclave_seal::share_sig`.

use crate::helper::{
    holds_pinned_forms, is_lower_hex_32, load_device_records, pin_path, read_authorized,
    read_key_state, record_fee_report, record_pinned_seats, register_device, register_proven_seat,
    register_vault, replace_file, same_key, state_with_protocol, stored_registration,
    write_read_key, write_synced, DeviceError, HelperConfig, ReadKey, ReadKeyForm, RegisterError,
    StoredRegistration, VaultRegistration,
};
use crate::tools::ToolError;
use konclave_seal::share_sig::{
    verify_package, verify_seat, PackageError, PkpCanonical, SeatStatement, N_MAX,
};
pub use konclave_seal::share_sig::{ProofJson, SeatProof};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TallyOk {
    /// The one read key at least `t` seats proved.
    pub read_key_hash: [u8; 32],
    /// Every proven seat, one who proved another read key included: it holds its seat and its reads
    /// stay refused, since its key does not hash to the pinned value.
    pub seats: Vec<SeatProof>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinError {
    Package(PackageError),
    BundleInvalid,
    NeedsTProofs,
    ReadKeySplit,
}

fn same_statement(a: &SeatProof, b: &SeatProof) -> bool {
    a.comms_pub == b.comms_pub && a.write_pub == b.write_pub && a.read_key_hash == b.read_key_hash
}

/// The count, in this order: the package, then each proof, then one read key with `t` seats.
pub fn tally(
    pkp: &PkpCanonical,
    vault_id: &[u8; 32],
    cp: u32,
    proofs: &[SeatProof],
) -> Result<TallyOk, PinError> {
    verify_package(pkp, vault_id).map_err(PinError::Package)?;
    let n = pkp.shares.len() as u16;
    if proofs.len() > n as usize {
        return Err(PinError::BundleInvalid);
    }

    // Within that limit, only what verifies counts for anything. The poster of the bundle is the one
    // member it can refuse: nobody else writes into their request.
    let digest = pkp.digest();
    let verified = proofs.iter().filter(|proof| {
        (1..=n).contains(&proof.seat) && proof.keys_are_usable() && {
            let statement = SeatStatement {
                vault_id: *vault_id,
                cp,
                t: pkp.t,
                n,
                seat: proof.seat,
                pkp_digest: digest,
                read_key_hash: proof.read_key_hash,
                comms_pub: proof.comms_pub,
                write_pub: proof.write_pub,
            };
            verify_seat(&pkp.shares[proof.seat as usize - 1], &statement, &proof.sig)
        }
    });

    // A seat's own signature on one statement counts once, however many times it signed it. Two
    // statements from one seat are that bundle's refusal. A key named by two seats is not: nothing
    // proves who holds it, and the poster could not tell which of them lies.
    let mut by_seat: BTreeMap<u16, &SeatProof> = BTreeMap::new();
    for proof in verified {
        match by_seat.get(&proof.seat) {
            Some(earlier) if !same_statement(earlier, proof) => {
                return Err(PinError::BundleInvalid)
            }
            Some(_) => {}
            None => {
                by_seat.insert(proof.seat, proof);
            }
        }
    }
    let seats: Vec<SeatProof> = by_seat.into_values().cloned().collect();

    let mut count: BTreeMap<[u8; 32], u16> = BTreeMap::new();
    for proof in &seats {
        *count.entry(proof.read_key_hash).or_default() += 1;
    }
    let mut enough = count.iter().filter(|(_, seats)| **seats >= pkp.t);
    match (enough.next(), enough.next()) {
        (None, _) => Err(PinError::NeedsTProofs),
        (Some(_), Some(_)) => Err(PinError::ReadKeySplit),
        (Some((hash, _)), None) => Ok(TallyOk {
            read_key_hash: *hash,
            seats,
        }),
    }
}

/// What pinning writes beside the vault: public material, kept so a member can later read every
/// seat's certificate. Device records stay in `device-keys.json`: this is not a second registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinRecord {
    pub pkp_hex: String,
    pub pkp_digest: String,
    pub t: u16,
    pub n: u16,
    pub cp: u32,
    pub seats: Vec<u16>,
    pub proofs: Vec<ProofJson>,
    pub pinned_at_unix: u64,
}

#[derive(Debug)]
pub enum RegisterPinError {
    Pin(PinError),
    /// The vault exists and is not closed, or holds another package.
    NotClosed,
    /// A key file, a registration or a pin that is there and cannot be read.
    Unreadable,
    Write(ToolError),
    Register(RegisterError),
    Device(DeviceError),
}

/// Registers a new protocol-3 vault and pins it, in the one order that recovers: nothing before the
/// count, the closed key file before the engine, the pinned one last. A failure part way leaves a
/// closed vault that refuses every read, and a bundle that counts finishes it.
pub fn register_and_pin(
    cfg: &HelperConfig,
    group_key: &str,
    name: &str,
    cp: u32,
    pkp: &PkpCanonical,
    proofs: &[SeatProof],
) -> Result<VaultRegistration, RegisterPinError> {
    let vaults_dir = cfg.vaults_dir.as_path();
    // A vault already on disk has one way forward, whichever request or restart finds it.
    match stored_registration(vaults_dir, group_key) {
        StoredRegistration::Loaded(reg) => {
            match read_key_state(vaults_dir, &reg) {
                ReadKey::Unreadable => return Err(RegisterPinError::Unreadable),
                ReadKey::Pinned(hash) => confirm_pin(vaults_dir, &reg, &hash, pkp, proofs)?,
                _ => pin_existing_closed(vaults_dir, &reg, pkp, proofs)?,
            }
            return Ok(reg);
        }
        StoredRegistration::Unreadable => return Err(RegisterPinError::Unreadable),
        StoredRegistration::Absent => {}
    }
    let counted = count_new_bundle(group_key, cp, pkp, proofs)?;
    match state_with_protocol(vaults_dir, group_key, Some(cp)) {
        ReadKey::Closed => {}
        ReadKey::Unreadable => return Err(RegisterPinError::Unreadable),
        _ => return Err(RegisterPinError::NotClosed),
    }
    write_read_key(vaults_dir, group_key, &ReadKeyForm::Closed).map_err(RegisterPinError::Write)?;
    let n = pkp.shares.len() as u16;
    let reg = register_vault(cfg, group_key, name, pkp.t, n, Some(cp))
        .map_err(RegisterPinError::Register)?;
    finish_pin(vaults_dir, group_key, cp, pkp, &counted)?;
    Ok(reg)
}

/// Every member posts its own bundle, so a second one that counts to the same package and key is the
/// normal case: it writes nothing. Anything else on a pinned vault is a conflict.
fn confirm_pin(
    vaults_dir: &Path,
    reg: &VaultRegistration,
    pinned_hash: &[u8; 32],
    pkp: &PkpCanonical,
    proofs: &[SeatProof],
) -> Result<(), RegisterPinError> {
    let pin = load_pin(vaults_dir, &reg.vault_id).ok_or(RegisterPinError::Unreadable)?;
    let vault_id = is_lower_hex_32(&reg.vault_id).ok_or(RegisterPinError::Unreadable)?;
    let cp = reg.cp.ok_or(RegisterPinError::Unreadable)?;
    match tally(pkp, &vault_id, cp, proofs) {
        Ok(counted)
            if counted.read_key_hash == *pinned_hash && hex(&pkp.digest()) == pin.pkp_digest =>
        {
            Ok(())
        }
        _ => Err(RegisterPinError::NotClosed),
    }
}

/// Finishes a vault a failure left closed. The same count, against the same rule.
pub fn pin_existing_closed(
    vaults_dir: &Path,
    reg: &VaultRegistration,
    pkp: &PkpCanonical,
    proofs: &[SeatProof],
) -> Result<(), RegisterPinError> {
    let cp = reg
        .cp
        .filter(|_| holds_pinned_forms(reg.cp))
        .ok_or(RegisterPinError::NotClosed)?;
    if read_key_state(vaults_dir, reg) != ReadKey::Closed
        || pkp.t != reg.threshold
        || pkp.shares.len() != reg.total as usize
    {
        return Err(RegisterPinError::NotClosed);
    }
    let vault_id = is_lower_hex_32(&reg.vault_id).ok_or(RegisterPinError::Pin(
        PinError::Package(PackageError::NotThisVault),
    ))?;
    let counted = tally(pkp, &vault_id, cp, proofs).map_err(RegisterPinError::Pin)?;
    finish_pin(vaults_dir, &reg.vault_id, cp, pkp, &counted)
}

/// Device records, then the pin, then the pinned key file, which is what makes the rest count.
fn finish_pin(
    vaults_dir: &Path,
    vault: &str,
    cp: u32,
    pkp: &PkpCanonical,
    counted: &TallyOk,
) -> Result<(), RegisterPinError> {
    let n = pkp.shares.len() as u16;
    let seats: Vec<(String, u16, String)> = counted
        .seats
        .iter()
        .map(|s| (hex(&s.comms_pub), s.seat, hex(&s.write_pub)))
        .collect();
    record_pinned_seats(vaults_dir, vault, n, &seats).map_err(RegisterPinError::Device)?;
    let record = PinRecord {
        pkp_hex: hex(&pkp.encode()),
        pkp_digest: hex(&pkp.digest()),
        t: pkp.t,
        n,
        cp,
        seats: counted.seats.iter().map(|s| s.seat).collect(),
        proofs: counted.seats.iter().map(ProofJson::from).collect(),
        pinned_at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    };
    let json = serde_json::to_vec(&record)
        .map_err(|e| RegisterPinError::Write(ToolError::parse("creation-pin", e.to_string())))?;
    replace_file(
        &pin_path(vaults_dir, vault),
        &vaults_dir.join(vault),
        &json,
        write_synced,
    )
    .map_err(|e| RegisterPinError::Write(ToolError::Io(e)))?;
    write_read_key(
        vaults_dir,
        vault,
        &ReadKeyForm::Pinned(counted.read_key_hash),
    )
    .map_err(RegisterPinError::Write)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The digest of a pinned vault's package, worked out from the package itself, for serving.
pub fn pinned_digest(vaults_dir: &Path, reg: &VaultRegistration) -> Option<String> {
    if !matches!(read_key_state(vaults_dir, reg), ReadKey::Pinned(_)) {
        return None;
    }
    let pin = load_pin(vaults_dir, &reg.vault_id)?;
    let pkp = PkpCanonical::parse(&konclave_seal::hex::decode(&pin.pkp_hex)?).ok()?;
    Some(hex(&pkp.digest()))
}

/// The count of a NEW vault's bundle, group key included. ONE function: the registration handler
/// counts with it, and so does the coordinator's admission before a new vault spends an address's
/// allowance or takes a lock, so the two cannot read the key or the proofs by different rules.
pub fn count_new_bundle(
    group_key: &str,
    cp: u32,
    pkp: &PkpCanonical,
    proofs: &[SeatProof],
) -> Result<TallyOk, RegisterPinError> {
    let vault_id = is_lower_hex_32(group_key).ok_or(RegisterPinError::Pin(PinError::Package(
        PackageError::NotThisVault,
    )))?;
    tally(pkp, &vault_id, cp, proofs).map_err(RegisterPinError::Pin)
}

/// A registration's bundle, read for its shape only: what costs nothing runs before admission, and
/// the crypto once, in the handler.
pub fn parse_bundle(pkp_hex: &str, proofs: &[ProofJson]) -> Option<(PkpCanonical, Vec<SeatProof>)> {
    if proofs.len() > N_MAX as usize {
        return None;
    }
    let pkp = PkpCanonical::parse(&konclave_seal::hex::decode(pkp_hex)?).ok()?;
    let proofs = proofs
        .iter()
        .map(ProofJson::parse)
        .collect::<Option<Vec<_>>>()?;
    Some((pkp, proofs))
}

/// A device asking to be recorded.
#[derive(Debug, Clone)]
pub struct DeviceClaim<'a> {
    pub comms: &'a str,
    pub seat: Option<u16>,
    pub write_pub: Option<&'a str>,
    pub proof: Option<&'a SeatProof>,
    /// The height from which the device's build accepts the lower network fee (ZIP 2009). Absent
    /// clears the seat's report; see [`crate::helper::record_fee_report`].
    pub fee_from: Option<u32>,
}

/// What a device's claim came to. The route maps this and decides nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum DeviceOutcome {
    /// Recorded, or (false) already recorded exactly so.
    Recorded {
        added: bool,
    },
    NeedsReadKey,
    Closed,
    SeatNeedsProof,
    SeatBound,
    Unreadable,
}

/// The one door for a device on a vault. An older vault keeps its rule; a pinned one takes a seat only
/// with that seat's own certificate over the pinned package and key.
pub fn offer_device(
    vaults_dir: &Path,
    reg: &VaultRegistration,
    read_token: Option<&str>,
    claim: &DeviceClaim,
) -> Result<DeviceOutcome, DeviceError> {
    let hash = match read_key_state(vaults_dir, reg) {
        ReadKey::Unreadable => return Ok(DeviceOutcome::Unreadable),
        ReadKey::Closed => return Ok(DeviceOutcome::Closed),
        ReadKey::Absent | ReadKey::Set(_) => {
            if !read_authorized(vaults_dir, reg, read_token) {
                return Ok(DeviceOutcome::NeedsReadKey);
            }
            let added = register_device(
                vaults_dir,
                &reg.vault_id,
                reg.total,
                claim.comms,
                claim.seat,
                claim.write_pub,
            )?;
            record_fee_report(
                vaults_dir,
                &reg.vault_id,
                claim.comms,
                claim.seat,
                claim.fee_from,
            )?;
            return Ok(DeviceOutcome::Recorded { added });
        }
        ReadKey::Pinned(hash) => hash,
    };
    let (Some(seat), Some(write_pub)) = (claim.seat, claim.write_pub) else {
        return Ok(DeviceOutcome::SeatNeedsProof);
    };
    let (comms, write_pub) = (claim.comms.trim(), write_pub.trim());
    let Some(pin) = load_pin(vaults_dir, &reg.vault_id) else {
        return Ok(DeviceOutcome::Unreadable);
    };
    let proven = claim
        .proof
        .is_some_and(|p| proof_holds(reg, &pin, &hash, seat, comms, write_pub, p));
    let records =
        load_device_records(vaults_dir, &reg.vault_id).map_err(DeviceError::Unreadable)?;
    // Answered by reading: on a shared comms key a writer would see a conflict that is not one.
    match records.iter().find(|r| r.seat == Some(seat)) {
        Some(_) if !proven && !read_authorized(vaults_dir, reg, read_token) => {
            Ok(DeviceOutcome::SeatNeedsProof)
        }
        Some(record)
            if same_key(&record.comms, comms)
                && record
                    .write
                    .as_deref()
                    .is_some_and(|w| same_key(w, write_pub)) =>
        {
            // Still answered by reading as to WHO holds the seat; only the report is written, under
            // the same lock, and only when it changed. `added` keeps meaning "a new record".
            record_fee_report(vaults_dir, &reg.vault_id, comms, Some(seat), claim.fee_from)?;
            Ok(DeviceOutcome::Recorded { added: false })
        }
        Some(_) => Ok(DeviceOutcome::SeatBound),
        None if !proven => Ok(DeviceOutcome::SeatNeedsProof),
        None => {
            let added =
                register_proven_seat(vaults_dir, &reg.vault_id, reg.total, comms, seat, write_pub)?;
            record_fee_report(vaults_dir, &reg.vault_id, comms, Some(seat), claim.fee_from)?;
            Ok(DeviceOutcome::Recorded { added })
        }
    }
}

/// The seat's own certificate, for exactly this claim, over the pinned package and read key. The
/// digest is worked out here from the package, not read from the record beside it.
fn proof_holds(
    reg: &VaultRegistration,
    pin: &PinRecord,
    pinned_hash: &[u8; 32],
    seat: u16,
    comms: &str,
    write_pub: &str,
    proof: &SeatProof,
) -> bool {
    let Some(pkp) =
        konclave_seal::hex::decode(&pin.pkp_hex).and_then(|bytes| PkpCanonical::parse(&bytes).ok())
    else {
        return false;
    };
    let (Some(vault_id), Some(cp)) = (is_lower_hex_32(&reg.vault_id), reg.cp) else {
        return false;
    };
    let n = pkp.shares.len() as u16;
    proof.seat == seat
        && (1..=n).contains(&seat)
        && hex(&proof.comms_pub) == comms
        && hex(&proof.write_pub) == write_pub
        && proof.read_key_hash == *pinned_hash
        && pkp.group_key == vault_id
        && verify_seat(
            &pkp.shares[seat as usize - 1],
            &SeatStatement {
                vault_id,
                cp,
                t: pkp.t,
                n,
                seat,
                pkp_digest: pkp.digest(),
                read_key_hash: proof.read_key_hash,
                comms_pub: proof.comms_pub,
                write_pub: proof.write_pub,
            },
            &proof.sig,
        )
}

/// The pin of a vault, or `None` when it has none or it cannot be read.
pub fn load_pin(vaults_dir: &Path, vault: &str) -> Option<PinRecord> {
    let json = std::fs::read_to_string(pin_path(vaults_dir, vault)).ok()?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use konclave_seal::share_sig::sign_seat;
    use rand::rngs::OsRng;
    use reddsa::frost::redpallas as frost;

    const CP: u32 = 3;

    struct Vault {
        pkp: PkpCanonical,
        id: [u8; 32],
        shares: Vec<[u8; 32]>,
    }

    fn vault(t: u16, n: u16) -> Vault {
        let (secrets, public) =
            frost::keys::generate_with_dealer(n, t, frost::keys::IdentifierList::Default, OsRng)
                .unwrap();
        let id: [u8; 32] = public
            .verifying_key()
            .serialize()
            .unwrap()
            .try_into()
            .unwrap();
        let (mut verifying, mut shares) = (Vec::new(), Vec::new());
        for seat in 1..=n {
            let who = frost::Identifier::try_from(seat).unwrap();
            let vs = public.verifying_shares().get(&who).unwrap();
            verifying.push(<[u8; 32]>::try_from(vs.serialize().unwrap()).unwrap());
            let share = secrets.get(&who).unwrap().signing_share().serialize();
            shares.push(<[u8; 32]>::try_from(share).unwrap());
        }
        Vault {
            pkp: PkpCanonical {
                group_key: id,
                t,
                shares: verifying,
            },
            id,
            shares,
        }
    }

    fn comms(seat: u16) -> [u8; 32] {
        konclave_seal::device_key_from_share(&seat.to_be_bytes()).public_bytes()
    }
    fn write(seat: u16) -> [u8; 32] {
        ed25519_dalek::SigningKey::from_bytes(&[seat as u8 + 1; 32])
            .verifying_key()
            .to_bytes()
    }

    fn proof_with(v: &Vault, signer: u16, seat: u16, hash: [u8; 32]) -> SeatProof {
        let st = SeatStatement {
            vault_id: v.id,
            cp: CP,
            t: v.pkp.t,
            n: v.pkp.shares.len() as u16,
            seat,
            pkp_digest: v.pkp.digest(),
            read_key_hash: hash,
            comms_pub: comms(seat),
            write_pub: write(seat),
        };
        SeatProof {
            seat,
            comms_pub: st.comms_pub,
            write_pub: st.write_pub,
            read_key_hash: hash,
            sig: sign_seat(&v.shares[signer as usize - 1], &st).unwrap(),
        }
    }
    fn proof_at(v: &Vault, seat: u16, hash: [u8; 32], cp: u32) -> SeatProof {
        let st = SeatStatement {
            vault_id: v.id,
            cp,
            t: v.pkp.t,
            n: v.pkp.shares.len() as u16,
            seat,
            pkp_digest: v.pkp.digest(),
            read_key_hash: hash,
            comms_pub: comms(seat),
            write_pub: write(seat),
        };
        SeatProof {
            seat,
            comms_pub: st.comms_pub,
            write_pub: st.write_pub,
            read_key_hash: hash,
            sig: sign_seat(&v.shares[seat as usize - 1], &st).unwrap(),
        }
    }
    fn proof(v: &Vault, seat: u16, hash: [u8; 32]) -> SeatProof {
        proof_with(v, seat, seat, hash)
    }

    const A: [u8; 32] = [0xaa; 32];
    const B: [u8; 32] = [0xbb; 32];

    #[test]
    fn t_proofs_on_one_hash_pin_the_hash_and_the_seats() {
        let v = vault(2, 3);
        let ok = tally(&v.pkp, &v.id, CP, &[proof(&v, 1, A), proof(&v, 3, A)]).unwrap();
        assert_eq!(ok.read_key_hash, A);
        assert_eq!(ok.seats.iter().map(|s| s.seat).collect::<Vec<_>>(), [1, 3]);
    }

    #[test]
    fn more_than_t_agreeing_proofs_pin_and_every_seat_is_recorded() {
        let v = vault(2, 3);
        let all = [proof(&v, 1, A), proof(&v, 2, A), proof(&v, 3, A)];
        let ok = tally(&v.pkp, &v.id, CP, &all).unwrap();
        assert_eq!(ok.read_key_hash, A);
        assert_eq!(ok.seats.len(), 3);
    }

    /// The read key file has one writer with two callers, and only the helper names the file.
    #[test]
    fn the_read_key_file_has_one_writer() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let production = |file: &str| {
            let text = std::fs::read_to_string(root.join(file)).unwrap();
            // The read-key tests sit in the middle of helper.rs, above the production that follows.
            let (before, rest) = text
                .split_once("mod read_key_form_tests")
                .unwrap_or((text.as_str(), ""));
            let after = rest
                .split_once("mod recipients_tests")
                .map_or("", |(_, a)| a);
            let whole = format!("{before}{after}");
            whole
                .split("#[cfg(test)]\nmod tests")
                .next()
                .unwrap()
                .to_string()
        };
        let call = ["write_read", "_key("].concat();
        assert_eq!(
            production("helper.rs").matches(call.as_str()).count(),
            2,
            "itself and the offer"
        );
        assert_eq!(
            production("seat_registry.rs")
                .matches(call.as_str())
                .count(),
            2,
            "closed and pinned"
        );
        let file = ["read-key", ".json"].concat();
        assert_eq!(
            production("helper.rs")
                .matches(format!("\"{file}\"").as_str())
                .count(),
            1
        );
        assert_eq!(
            production("seat_registry.rs")
                .matches(file.as_str())
                .count(),
            0
        );
    }

    #[test]
    fn t_minus_1_real_proofs_are_refused() {
        let v = vault(3, 4);
        let two = [proof(&v, 1, A), proof(&v, 2, A)];
        assert_eq!(tally(&v.pkp, &v.id, CP, &two), Err(PinError::NeedsTProofs));
        assert_eq!(tally(&v.pkp, &v.id, CP, &[]), Err(PinError::NeedsTProofs));
    }

    #[test]
    fn t_minus_1_real_proofs_plus_a_forged_certificate_are_refused() {
        let v = vault(2, 3);
        let forged = proof_with(&v, 1, 2, A); // seat 2's statement, signed by seat 1's share
        let both = [proof(&v, 1, A), forged];
        assert_eq!(tally(&v.pkp, &v.id, CP, &both), Err(PinError::NeedsTProofs));
    }

    #[test]
    fn a_forged_certificate_within_n_cannot_stop_t_real_ones() {
        let v = vault(2, 3);
        let forged = proof_with(&v, 1, 3, B);
        let ok = tally(
            &v.pkp,
            &v.id,
            CP,
            &[proof(&v, 1, A), proof(&v, 2, A), forged],
        )
        .unwrap();
        assert_eq!(ok.read_key_hash, A);
        assert_eq!(ok.seats.len(), 2, "the forged one is not a proven seat");
    }

    #[test]
    fn one_dissenting_proven_seat_does_not_freeze_the_tally() {
        let v = vault(2, 3);
        let ok = tally(
            &v.pkp,
            &v.id,
            CP,
            &[proof(&v, 1, A), proof(&v, 2, B), proof(&v, 3, A)],
        )
        .unwrap();
        assert_eq!(ok.read_key_hash, A);
        assert_eq!(ok.seats.len(), 3, "the dissenter holds its seat");
    }

    #[test]
    fn two_hashes_each_with_t_seats_pin_nothing() {
        let v = vault(2, 4);
        let all = [
            proof(&v, 1, A),
            proof(&v, 2, A),
            proof(&v, 3, B),
            proof(&v, 4, B),
        ];
        assert_eq!(tally(&v.pkp, &v.id, CP, &all), Err(PinError::ReadKeySplit));
    }

    #[test]
    fn a_seat_proven_twice_counts_once() {
        let v = vault(2, 3);
        let p = proof(&v, 1, A);
        assert_eq!(
            tally(&v.pkp, &v.id, CP, &[p.clone(), p]),
            Err(PinError::NeedsTProofs)
        );
    }

    /// A proof with these keys, really signed by that seat's share.
    fn signed_with_keys(
        v: &Vault,
        seat: u16,
        comms_pub: [u8; 32],
        write_pub: [u8; 32],
    ) -> SeatProof {
        signed_with_hash(v, seat, comms_pub, write_pub, A)
    }

    fn signed_with_hash(
        v: &Vault,
        seat: u16,
        comms_pub: [u8; 32],
        write_pub: [u8; 32],
        read_key_hash: [u8; 32],
    ) -> SeatProof {
        let st = SeatStatement {
            vault_id: v.id,
            cp: CP,
            t: v.pkp.t,
            n: v.pkp.shares.len() as u16,
            seat,
            pkp_digest: v.pkp.digest(),
            read_key_hash,
            comms_pub,
            write_pub,
        };
        SeatProof {
            seat,
            comms_pub,
            write_pub,
            read_key_hash,
            sig: sign_seat(&v.shares[seat as usize - 1], &st).unwrap(),
        }
    }

    #[test]
    fn more_proofs_than_seats_and_two_statements_from_one_seat_are_refused() {
        let v = vault(2, 2);
        let (a, b) = (proof(&v, 1, A), proof(&v, 2, A));
        let too_many = [a.clone(), b.clone(), a.clone()];
        assert_eq!(
            tally(&v.pkp, &v.id, CP, &too_many),
            Err(PinError::BundleInvalid)
        );
        let two_statements = [a.clone(), proof(&v, 1, B)];
        assert_eq!(
            tally(&v.pkp, &v.id, CP, &two_statements),
            Err(PinError::BundleInvalid)
        );
    }

    /// The signature is randomized, so one seat signing one statement twice gives two different proofs.
    #[test]
    fn a_seat_signing_the_same_statement_twice_counts_once() {
        let v = vault(2, 3);
        let twice = [proof(&v, 1, A), proof(&v, 1, A), proof(&v, 2, A)];
        assert_eq!(tally(&v.pkp, &v.id, CP, &twice).unwrap().seats.len(), 2);
    }

    /// A repeated key is not a handle on the bundle: the poster cannot tell which of two certificates
    /// over one key lies, and a claim on a key its signer cannot open costs only the claimant.
    #[test]
    fn a_seats_signed_key_on_another_seat_does_not_stop_the_bundle() {
        let v = vault(2, 3);
        let (a, b) = (proof(&v, 1, A), proof(&v, 2, A));
        for claim in [
            signed_with_keys(&v, 3, a.comms_pub, write(3)),
            signed_with_keys(&v, 3, comms(3), a.write_pub),
        ] {
            let ok = tally(&v.pkp, &v.id, CP, &[a.clone(), b.clone(), claim]).unwrap();
            assert_eq!(ok.seats.len(), 3);
        }
    }

    /// An unusable key cannot be recorded, so it proves no seat, and it refuses nothing.
    #[test]
    fn a_seats_signed_unusable_key_does_not_count_and_does_not_stop_the_bundle() {
        let v = vault(2, 3);
        let (a, b) = (proof(&v, 1, A), proof(&v, 2, A));
        for bad in [
            signed_with_keys(&v, 3, [0; 32], write(3)),
            signed_with_keys(&v, 3, comms(3), [0; 32]),
        ] {
            let ok = tally(&v.pkp, &v.id, CP, &[a.clone(), b.clone(), bad.clone()]).unwrap();
            assert_eq!(ok.seats, [a.clone(), b.clone()]);
            assert_eq!(
                tally(&v.pkp, &v.id, CP, &[a.clone(), bad]),
                Err(PinError::NeedsTProofs)
            );
        }
    }

    /// Everything here carries a signature that does not verify and fits within `n`, and the answer
    /// stays the two real seats' whatever it claims.
    #[test]
    fn a_proof_that_does_not_verify_changes_nothing() {
        let v = vault(2, 3);
        let (a, b) = (proof(&v, 1, A), proof(&v, 2, A));
        let junk = SeatProof {
            sig: [7; 64],
            ..proof(&v, 3, A)
        };
        for bad in [
            junk.clone(),
            SeatProof {
                comms_pub: [0; 32],
                ..junk.clone()
            },
            SeatProof {
                write_pub: [0; 32],
                ..junk.clone()
            },
            SeatProof {
                seat: 0,
                ..junk.clone()
            },
            SeatProof {
                seat: 9,
                ..junk.clone()
            },
            SeatProof {
                seat: 1,
                ..junk.clone()
            },
            SeatProof {
                comms_pub: a.comms_pub,
                ..junk.clone()
            },
            SeatProof {
                write_pub: a.write_pub,
                ..junk.clone()
            },
        ] {
            let ok = tally(&v.pkp, &v.id, CP, &[a.clone(), b.clone(), bad.clone()]);
            assert_eq!(ok.unwrap().seats, [a.clone(), b.clone()], "{bad:?}");
            let first = tally(&v.pkp, &v.id, CP, &[bad.clone(), b.clone(), a.clone()]);
            assert_eq!(first.unwrap().seats, [a.clone(), b.clone()], "{bad:?}");
        }
    }

    #[test]
    fn a_larger_quorum_counts_to_its_own_t() {
        let v = vault(3, 5);
        let three = [proof(&v, 2, A), proof(&v, 4, A), proof(&v, 5, A)];
        assert_eq!(tally(&v.pkp, &v.id, CP, &three).unwrap().seats.len(), 3);
        assert_eq!(
            tally(&v.pkp, &v.id, CP, &three[..2]),
            Err(PinError::NeedsTProofs)
        );
    }

    #[test]
    fn the_package_comes_first_and_answers_for_itself() {
        let v = vault(2, 2);
        let proofs = [proof(&v, 1, A), proof(&v, 2, A)];
        assert_eq!(
            tally(&v.pkp, &[0; 32], CP, &proofs),
            Err(PinError::Package(PackageError::NotThisVault))
        );
    }

    #[test]
    fn a_certificate_binds_the_protocol_and_the_package() {
        let v = vault(2, 2);
        let proofs = [proof(&v, 1, A), proof(&v, 2, A)];
        assert_eq!(
            tally(&v.pkp, &v.id, CP + 1, &proofs),
            Err(PinError::NeedsTProofs)
        );
        let other = vault(2, 2);
        assert_ne!(other.id, v.id);
        assert!(tally(&other.pkp, &other.id, CP, &proofs).is_err());
    }

    /// A polynomial of degree 1 also fits t = 3, so the package check passes and only the statement,
    /// which the seats signed with t = 2, tells them apart.
    #[test]
    fn a_certificate_binds_the_quorum() {
        let v = vault(2, 4);
        let proofs = [proof(&v, 1, A), proof(&v, 2, A), proof(&v, 3, A)];
        let raised = PkpCanonical {
            t: 3,
            ..v.pkp.clone()
        };
        assert_eq!(
            tally(&raised, &v.id, CP, &proofs),
            Err(PinError::NeedsTProofs)
        );
    }

    #[test]
    fn the_first_proof_of_a_seat_is_the_one_kept() {
        let v = vault(2, 3);
        let (first, second) = (proof(&v, 1, A), proof(&v, 1, A));
        let ok = tally(&v.pkp, &v.id, CP, &[first.clone(), second, proof(&v, 2, A)]).unwrap();
        assert_eq!(ok.seats[0], first);
    }

    #[test]
    fn one_seat_saying_two_things_about_any_field_is_refused() {
        let v = vault(2, 3);
        for other in [
            signed_with_keys(&v, 1, comms(9), write(1)),
            signed_with_keys(&v, 1, comms(1), write(9)),
        ] {
            let bundle = [proof(&v, 1, A), other];
            assert_eq!(
                tally(&v.pkp, &v.id, CP, &bundle),
                Err(PinError::BundleInvalid)
            );
        }
    }

    mod pinning {
        use super::*;
        use crate::helper::load_registration;
        use std::os::unix::fs::PermissionsExt;
        use std::path::PathBuf;

        /// A coordinator whose fake engine answers with this vault's own pair: a vault made from the
        /// repository's real vector cannot have a dealer's package, so the identity check is what
        /// this fixture has to get past, and it uses a package whose group key IS the vector's ak.
        fn coordinator(name: &str, fail_devtool: bool) -> (HelperConfig, PathBuf) {
            let dir =
                std::env::temp_dir().join(format!("konclave-pin-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let exe = |file: &str, body: String| {
                let p = dir.join(file);
                std::fs::write(&p, body).unwrap();
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
                for _ in 0..200 {
                    match std::process::Command::new(&p).arg("--probe").output() {
                        Err(e) if e.raw_os_error() == Some(26) => {
                            std::thread::sleep(std::time::Duration::from_millis(10))
                        }
                        _ => break,
                    }
                }
                p
            };
            let sign = exe(
                "fake-sign",
                "#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\ncat \"$(dirname \"$0\")/identity\"\n".to_string(),
            );
            let devtool = exe(
                "fake-devtool",
                if fail_devtool {
                    "#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\nexit 1\n".to_string()
                } else {
                    "#!/bin/sh\ncase \"$4\" in\n  init-fvk) mkdir -p \"$3\"; printf 'network = \"main\"\\nbirthday = 3400000\\n' > \"$3/keys.toml\" ;;\n  list-addresses) echo 'Account AccountUuid(11111111-1111-1111-1111-111111111111)' ;;\nesac\n".to_string()
                },
            );
            let cfg = HelperConfig {
                zcash_sign: sign,
                devtool,
                lightwalletd: "unused:443".into(),
                network: "main".into(),
                konclave_signer: PathBuf::from("/unused"),
                vaults_dir: dir.join("vaults"),
                relays: Vec::new(),
                send_max_polls: crate::helper::DEFAULT_SEND_MAX_POLLS,
            };
            (cfg, dir)
        }

        /// A vault the fake engine can answer for: a real dealer's package whose even group key is
        /// the `ak` of a key this test derives, so `protocol_3_receivers` passes for real.
        fn answer_for(dir: &Path, v: &Vault) {
            use zcash_address::unified::{Encoding, Fvk, Revision, Ufvk, Uitem};
            let fvk = orchard_fvk_with_ak(&v.id);
            let ufvk = Ufvk::try_from_items(Revision::R0, vec![Uitem::Data(Fvk::Orchard(fvk))])
                .unwrap()
                .encode(&zcash_protocol::consensus::NetworkType::Main);
            let r = konclave_seal::receivers::vault_receivers(
                &ufvk,
                zcash_protocol::consensus::NetworkType::Main,
                &v.id,
            )
            .unwrap();
            std::fs::write(
                dir.join("identity"),
                format!(
                    "Orchard-only unified address: \"{}\"\nUnified Full Viewing Key: \"{ufvk}\"\n",
                    r.external_ua
                ),
            )
            .unwrap();
        }

        /// What `zcash-sign generate --ak` does: the group key as `ak`, the rest from a key of ours.
        fn orchard_fvk_with_ak(ak: &[u8; 32]) -> [u8; 96] {
            let mut sk = [7u8; 32];
            loop {
                let spending: Option<orchard::keys::SpendingKey> =
                    orchard::keys::SpendingKey::from_bytes(sk).into();
                if let Some(spending) = spending {
                    let mut bytes = orchard::keys::FullViewingKey::from(&spending).to_bytes();
                    bytes[..32].copy_from_slice(ak);
                    if orchard::keys::FullViewingKey::from_bytes(&bytes).is_some() {
                        return bytes;
                    }
                }
                sk[0] = sk[0].wrapping_add(1);
            }
        }

        fn read_key() -> [u8; 32] {
            [0x42; 32]
        }
        fn hash() -> [u8; 32] {
            konclave_seal::share_sig::read_key_hash(&read_key())
        }

        /// A later creation protocol is pinned by the same path: the coordinator's minimum is a number,
        /// and every pinning rule reads `cp >= 3`. Certificates signed for another protocol than the
        /// one registered do not count.
        #[test]
        fn a_protocol_4_vault_is_pinned_and_certificates_for_3_do_not_count_for_it() {
            let (cfg, dir) = coordinator("cp4", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let stale = [proof_at(&v, 1, hash(), 3), proof_at(&v, 2, hash(), 3)];
            assert!(register_and_pin(&cfg, &id, "v", 4, &v.pkp, &stale).is_err());
            let proofs = [proof_at(&v, 1, hash(), 4), proof_at(&v, 2, hash(), 4)];
            let reg = register_and_pin(&cfg, &id, "v", 4, &v.pkp, &proofs).unwrap();
            assert_eq!(reg.cp, Some(4));
            assert_eq!(
                read_key_state(&cfg.vaults_dir, &reg),
                ReadKey::Pinned(hash())
            );
        }

        #[test]
        fn t_proofs_register_and_pin_a_vault_born_readable() {
            let (cfg, dir) = coordinator("ok", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            let reg = register_and_pin(&cfg, &id, "v", CP, &v.pkp, &proofs).unwrap();

            assert_eq!(reg.cp, Some(CP));
            assert_eq!(
                read_key_state(&cfg.vaults_dir, &reg),
                ReadKey::Pinned(hash())
            );
            assert!(read_authorized(
                &cfg.vaults_dir,
                &reg,
                Some(&hex(&read_key()))
            ));
            let records = load_device_records(&cfg.vaults_dir, &id).unwrap();
            assert_eq!(records.len(), 2, "every proven seat");
            let pin = load_pin(&cfg.vaults_dir, &id).unwrap();
            assert_eq!(pin.seats, [1, 2]);
            assert_eq!(pin.proofs.len(), 2, "kept, for a member to read later");
            assert_eq!(pin.pkp_digest, hex(&v.pkp.digest()));
            assert_eq!(pin.pkp_hex, hex(&v.pkp.encode()));
        }

        #[test]
        fn a_refused_count_writes_nothing_at_all() {
            let (cfg, dir) = coordinator("refused", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let one = [proof(&v, 1, hash())];
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &v.pkp, &one),
                Err(RegisterPinError::Pin(PinError::NeedsTProofs))
            ));
            assert!(!cfg.vaults_dir.join(&id).exists());
        }

        #[test]
        fn another_vaults_id_is_refused_before_anything() {
            let (cfg, dir) = coordinator("other-id", false);
            let (v, other) = (vault(2, 2), vault(2, 2));
            answer_for(&dir, &v);
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            assert!(register_and_pin(&cfg, &hex(&other.id), "v", CP, &v.pkp, &proofs).is_err());
            assert!(!cfg.vaults_dir.join(hex(&other.id)).exists());
        }

        #[test]
        fn a_failure_after_closed_leaves_it_closed_and_the_same_bundle_pins_it_later() {
            let (cfg, dir) = coordinator("engine-fails", true);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &v.pkp, &proofs),
                Err(RegisterPinError::Register(_))
            ));
            let open = crate::helper::reg_for_read_key(&id, Some(CP));
            assert_eq!(read_key_state(&cfg.vaults_dir, &open), ReadKey::Closed);

            let (good, _keep) = coordinator("engine-works", false);
            let good = HelperConfig {
                vaults_dir: cfg.vaults_dir.clone(),
                zcash_sign: cfg.zcash_sign.clone(),
                ..good
            };
            let reg = register_and_pin(&good, &id, "v", CP, &v.pkp, &proofs).unwrap();
            assert_eq!(
                read_key_state(&cfg.vaults_dir, &reg),
                ReadKey::Pinned(hash())
            );
            assert_eq!(
                load_registration(&cfg.vaults_dir, &id).unwrap().cp,
                Some(CP)
            );
        }

        #[test]
        fn a_closed_vault_is_finished_by_the_same_rule_and_only_by_it() {
            let (cfg, dir) = coordinator("existing", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let reg = crate::helper::register_vault(&cfg, &id, "v", 2, 3, Some(CP)).unwrap();
            assert_eq!(read_key_state(&cfg.vaults_dir, &reg), ReadKey::Closed);

            let one = [proof(&v, 1, hash())];
            assert!(pin_existing_closed(&cfg.vaults_dir, &reg, &v.pkp, &one).is_err());
            assert_eq!(read_key_state(&cfg.vaults_dir, &reg), ReadKey::Closed);

            let proofs = [proof(&v, 1, hash()), proof(&v, 3, hash())];
            pin_existing_closed(&cfg.vaults_dir, &reg, &v.pkp, &proofs).unwrap();
            assert_eq!(
                read_key_state(&cfg.vaults_dir, &reg),
                ReadKey::Pinned(hash())
            );
            assert_eq!(load_device_records(&cfg.vaults_dir, &id).unwrap().len(), 2);
        }

        /// A vault on disk gets the same answer through either entrance.
        #[test]
        fn both_entrances_refuse_the_same_mismatches() {
            let (cfg, dir) = coordinator("entrances", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let reg = crate::helper::register_vault(&cfg, &id, "v", 2, 3, Some(CP)).unwrap();
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            let dropped = PkpCanonical {
                shares: v.pkp.shares[..2].to_vec(),
                ..v.pkp.clone()
            };
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &dropped, &proofs),
                Err(RegisterPinError::NotClosed)
            ));
            // Certificates for another protocol than the one the vault was registered under.
            let later = [
                proof_at(&v, 1, hash(), CP + 1),
                proof_at(&v, 2, hash(), CP + 1),
            ];
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP + 1, &v.pkp, &later),
                Err(RegisterPinError::Pin(PinError::NeedsTProofs))
            ));
            assert_eq!(read_key_state(&cfg.vaults_dir, &reg), ReadKey::Closed);
        }

        /// The same polynomial also fits a larger t, so only the registration can refuse it.
        #[test]
        fn a_package_with_another_quorum_than_the_registration_does_not_finish_it() {
            let (cfg, dir) = coordinator("quorum", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let reg = crate::helper::register_vault(&cfg, &id, "v", 2, 3, Some(CP)).unwrap();
            let raised = PkpCanonical {
                t: 3,
                ..v.pkp.clone()
            };
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            assert!(matches!(
                pin_existing_closed(&cfg.vaults_dir, &reg, &raised, &proofs),
                Err(RegisterPinError::NotClosed)
            ));
            let dropped = PkpCanonical {
                shares: v.pkp.shares[..2].to_vec(),
                ..v.pkp.clone()
            };
            assert!(matches!(
                pin_existing_closed(&cfg.vaults_dir, &reg, &dropped, &proofs),
                Err(RegisterPinError::NotClosed)
            ));
        }

        #[test]
        fn a_stored_package_cannot_be_replaced() {
            let (cfg, dir) = coordinator("replace", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            let reg = register_and_pin(&cfg, &id, "v", CP, &v.pkp, &proofs).unwrap();
            let before = load_pin(&cfg.vaults_dir, &id).unwrap();
            let other = [proof(&v, 1, [9; 32]), proof(&v, 2, [9; 32])];
            assert!(matches!(
                pin_existing_closed(&cfg.vaults_dir, &reg, &v.pkp, &other),
                Err(RegisterPinError::NotClosed)
            ));
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &v.pkp, &other),
                Err(RegisterPinError::NotClosed)
            ));
            assert_eq!(load_pin(&cfg.vaults_dir, &id).unwrap(), before);
            assert_eq!(
                read_key_state(&cfg.vaults_dir, &reg),
                ReadKey::Pinned(hash())
            );
        }

        #[test]
        fn a_vault_older_than_protocol_3_cannot_be_pinned() {
            let (cfg, dir) = coordinator("legacy", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let reg = crate::helper::register_vault(&cfg, &id, "v", 2, 3, Some(2)).unwrap();
            let proofs = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            assert!(matches!(
                pin_existing_closed(&cfg.vaults_dir, &reg, &v.pkp, &proofs),
                Err(RegisterPinError::NotClosed)
            ));
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &v.pkp, &proofs),
                Err(RegisterPinError::NotClosed)
            ));
            assert!(load_pin(&cfg.vaults_dir, &id).is_none());
        }

        #[test]
        fn the_pin_writes_records_while_the_vault_is_closed() {
            // The state only turns pinned after the records exist, and a dissenter is recorded.
            let (cfg, dir) = coordinator("dissent", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let proofs = [
                proof(&v, 1, hash()),
                proof(&v, 2, [9; 32]),
                proof(&v, 3, hash()),
            ];
            register_and_pin(&cfg, &id, "v", CP, &v.pkp, &proofs).unwrap();
            let records = load_device_records(&cfg.vaults_dir, &id).unwrap();
            assert_eq!(records.len(), 3);
            assert!(records
                .iter()
                .all(|r| r.seat.is_some() && r.write.is_some()));
        }

        /// The member at seat 3 certifies its own seat with seat 2's comms key. That must cost seat 2
        /// nothing: its own proof still records it, and boxes to that key open only for seat 2.
        #[test]
        fn a_seat_cannot_be_denied_by_another_seats_certificate() {
            let (cfg, dir) = coordinator("deny", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let claim = signed_with_hash(&v, 3, comms(2), write(3), hash());
            let bundle = [proof(&v, 1, hash()), claim];
            let reg = register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle).unwrap();
            assert_eq!(
                read_key_state(&cfg.vaults_dir, &reg),
                ReadKey::Pinned(hash())
            );

            let own = proof(&v, 2, hash());
            crate::helper::register_proven_seat(
                &cfg.vaults_dir,
                &id,
                3,
                &hex(&own.comms_pub),
                own.seat,
                &hex(&own.write_pub),
            )
            .unwrap();
            let records = load_device_records(&cfg.vaults_dir, &id).unwrap();
            let seats: Vec<_> = records.iter().filter_map(|r| r.seat).collect();
            assert_eq!(seats.len(), 3);
            for seat in 1..=3 {
                assert!(seats.contains(&seat), "{seats:?}");
            }
            // One box for the shared key: the envelope files boxes by key.
            let keys = crate::helper::load_device_keys(&cfg.vaults_dir, &id).unwrap();
            let sealed = crate::envelope::seal_to_devices("t", b"x", &keys)
                .unwrap()
                .unwrap();
            assert_eq!(sealed.boxes.len(), 2);
        }

        #[test]
        fn a_proven_seat_keeps_what_it_recorded() {
            let (cfg, dir) = coordinator("keep", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let bundle = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle).unwrap();
            let again = |c: [u8; 32], w: [u8; 32]| {
                crate::helper::register_proven_seat(&cfg.vaults_dir, &id, 3, &hex(&c), 1, &hex(&w))
            };
            assert!(
                !again(comms(1), write(1)).unwrap(),
                "the same triple changes nothing"
            );
            assert!(again(comms(3), write(1)).is_err(), "another comms key");
            assert!(again(comms(1), write(3)).is_err(), "another write key");
            assert!(
                crate::helper::register_proven_seat(
                    &cfg.vaults_dir,
                    &id,
                    3,
                    &hex(&comms(3)),
                    4,
                    &hex(&write(3))
                )
                .is_err(),
                "outside the vault's seats"
            );
        }

        /// H-I2: an attempt that failed leaves nothing a later bundle has to fight.
        #[test]
        fn a_failed_attempts_records_do_not_stop_the_honest_bundle() {
            let (cfg, dir) = coordinator("leftover", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let pin = cfg.vaults_dir.join(&id).join("creation-pin.json");
            std::fs::create_dir_all(&pin).unwrap();
            let other = signed_with_hash(&v, 2, comms(8), write(8), hash());
            let first = [proof(&v, 1, hash()), other];
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &v.pkp, &first),
                Err(RegisterPinError::Write(_))
            ));
            std::fs::remove_dir_all(&pin).unwrap();

            let honest = [
                proof(&v, 1, hash()),
                proof(&v, 2, hash()),
                proof(&v, 3, hash()),
            ];
            register_and_pin(&cfg, &id, "v", CP, &v.pkp, &honest).unwrap();
            let records = load_device_records(&cfg.vaults_dir, &id).unwrap();
            assert_eq!(records.len(), 3);
            let two = records.iter().find(|r| r.seat == Some(2)).unwrap();
            assert_eq!(
                two.comms,
                hex(&comms(2)),
                "the failed attempt's key is gone"
            );
        }

        /// H-I4: the order is the design. The engine fails unless the closed file is already there.
        #[test]
        fn no_protocol_3_registration_exists_without_a_read_key_file() {
            let (cfg, dir) = coordinator("order-closed", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let strict = dir.join("strict-devtool");
            std::fs::write(
                &strict,
                "#!/bin/sh\ncase \"$4\" in\n  init-fvk) [ -e \"$(dirname \"$3\")/read-key.json\" ] || exit 1; mkdir -p \"$3\"; printf 'network = \"main\"\\nbirthday = 3400000\\n' > \"$3/keys.toml\" ;;\n  list-addresses) echo 'Account AccountUuid(11111111-1111-1111-1111-111111111111)' ;;\nesac\n",
            )
            .unwrap();
            std::fs::set_permissions(&strict, std::fs::Permissions::from_mode(0o755)).unwrap();
            for _ in 0..200 {
                match std::process::Command::new(&strict).output() {
                    Err(e) if e.raw_os_error() == Some(26) => {
                        std::thread::sleep(std::time::Duration::from_millis(10))
                    }
                    _ => break,
                }
            }
            let cfg = HelperConfig {
                devtool: strict,
                ..cfg
            };
            let bundle = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            register_and_pin(&cfg, &hex(&v.id), "v", CP, &v.pkp, &bundle).unwrap();
        }

        #[test]
        fn records_come_before_the_pin_and_the_pin_before_the_pinned_file() {
            for (name, blocked) in [
                ("device-keys.json", "records"),
                ("creation-pin.json", "pin"),
            ] {
                let (cfg, dir) = coordinator(blocked, false);
                let v = vault(2, 3);
                answer_for(&dir, &v);
                let id = hex(&v.id);
                let vault_dir = cfg.vaults_dir.join(&id);
                std::fs::create_dir_all(vault_dir.join(name)).unwrap();
                let bundle = [proof(&v, 1, hash()), proof(&v, 2, hash())];
                assert!(register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle).is_err());
                let open = crate::helper::reg_for_read_key(&id, Some(CP));
                assert_eq!(
                    read_key_state(&cfg.vaults_dir, &open),
                    ReadKey::Closed,
                    "{name}"
                );
                if blocked == "records" {
                    assert!(
                        load_pin(&cfg.vaults_dir, &id).is_none(),
                        "no pin without records"
                    );
                    assert!(!vault_dir.join("creation-pin.json").exists());
                }
            }
        }

        #[test]
        fn a_directory_with_a_key_and_no_registration_is_not_overwritten() {
            let (cfg, dir) = coordinator("orphan", false);
            let v = vault(2, 3);
            answer_for(&dir, &v);
            let id = hex(&v.id);
            let file = cfg.vaults_dir.join(&id).join("read-key.json");
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "\"abcd\"").unwrap();
            let bundle = [proof(&v, 1, hash()), proof(&v, 2, hash())];
            assert!(matches!(
                register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle),
                Err(RegisterPinError::Unreadable)
            ));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "\"abcd\"");
        }

        mod offering {
            use super::*;

            /// A vault pinned by seats 1 and 2 of a 2-of-3.
            fn pinned(name: &str) -> (HelperConfig, Vault, String, VaultRegistration) {
                let (cfg, dir) = coordinator(name, false);
                let v = vault(2, 3);
                answer_for(&dir, &v);
                let id = hex(&v.id);
                let bundle = [proof(&v, 1, hash()), proof(&v, 2, hash())];
                let reg = register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle).unwrap();
                (cfg, v, id, reg)
            }
            fn claim_of<'a>(
                c: &'a str,
                w: &'a str,
                seat: u16,
                p: Option<&'a SeatProof>,
            ) -> DeviceClaim<'a> {
                DeviceClaim {
                    comms: c,
                    seat: Some(seat),
                    write_pub: Some(w),
                    proof: p,
                    fee_from: None,
                }
            }
            fn token() -> String {
                hex(&read_key())
            }

            #[test]
            fn an_unrecorded_seat_with_its_own_proof_is_recorded() {
                let (cfg, v, id, reg) = pinned("offer-own");
                let p = proof(&v, 3, hash());
                let (c, w) = (hex(&p.comms_pub), hex(&p.write_pub));
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &claim_of(&c, &w, 3, Some(&p)))
                        .unwrap(),
                    DeviceOutcome::Recorded { added: true }
                );
                let seats = load_device_records(&cfg.vaults_dir, &id).unwrap();
                assert!(seats.iter().any(|r| r.seat == Some(3)));
            }

            /// B2 (audit F7): on a pinned vault the exact registered triple is answered by reading, and
            /// the seat's fee report is still written, under the same door, without moving the seat.
            #[test]
            fn a_pinned_seat_reports_and_a_registration_without_it_clears_the_report() {
                use crate::helper::seat_fee_reports;
                let (cfg, v, id, reg) = pinned("offer-report");
                let p = proof(&v, 1, hash());
                let (c, w) = (hex(&p.comms_pub), hex(&p.write_pub));
                let with = |h: Option<u32>| DeviceClaim {
                    fee_from: h,
                    ..claim_of(&c, &w, 1, None)
                };
                let tok = token();
                let before =
                    std::fs::read(cfg.vaults_dir.join(&id).join("device-keys.json")).unwrap();
                assert_eq!(
                    seat_fee_reports(&cfg.vaults_dir, &id, 3),
                    vec![None, None, None]
                );
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, Some(&tok), &with(Some(3_590_000)))
                        .unwrap(),
                    DeviceOutcome::Recorded { added: false },
                    "`added` still means a new record"
                );
                assert_eq!(
                    seat_fee_reports(&cfg.vaults_dir, &id, 3),
                    vec![Some(3_590_000), None, None]
                );
                // Same claim again: nothing to write.
                let once =
                    std::fs::read(cfg.vaults_dir.join(&id).join("device-keys.json")).unwrap();
                offer_device(&cfg.vaults_dir, &reg, Some(&tok), &with(Some(3_590_000))).unwrap();
                assert_eq!(
                    std::fs::read(cfg.vaults_dir.join(&id).join("device-keys.json")).unwrap(),
                    once
                );
                // The seat and keys are what they were: only the report differs from the first file.
                let recs = load_device_records(&cfg.vaults_dir, &id).unwrap();
                assert_eq!(
                    recs.iter()
                        .find(|r| r.seat == Some(1))
                        .unwrap()
                        .write
                        .as_deref(),
                    Some(w.as_str())
                );
                assert_ne!(before, once);
                offer_device(&cfg.vaults_dir, &reg, Some(&tok), &with(None)).unwrap();
                assert_eq!(
                    seat_fee_reports(&cfg.vaults_dir, &id, 3),
                    vec![None, None, None]
                );
                // Another seat's keys under seat 1 are still bound, and report nothing.
                let (c7, w7) = (hex(&comms(7)), hex(&write(7)));
                let other = DeviceClaim {
                    fee_from: Some(1),
                    ..claim_of(&c7, &w7, 1, None)
                };
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, Some(&tok), &other).unwrap(),
                    DeviceOutcome::SeatBound
                );
                assert_eq!(seat_fee_reports(&cfg.vaults_dir, &id, 3)[0], None);
            }

            #[test]
            fn devicekey_with_another_seats_proof_is_refused() {
                let (cfg, v, id, reg) = pinned("offer-other");
                let other = proof(&v, 2, hash());
                let (c, w) = (hex(&comms(3)), hex(&write(3)));
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        Some(&token()),
                        &claim_of(&c, &w, 3, Some(&other))
                    )
                    .unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
                let forged = SeatProof {
                    seat: 3,
                    comms_pub: comms(3),
                    write_pub: write(3),
                    ..other
                };
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        Some(&token()),
                        &claim_of(&c, &w, 3, Some(&forged))
                    )
                    .unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
                assert_eq!(load_device_records(&cfg.vaults_dir, &id).unwrap().len(), 2);
            }

            #[test]
            fn a_proof_for_other_keys_than_the_claim_or_another_read_key_is_refused() {
                let (cfg, v, _id, reg) = pinned("offer-mismatch");
                let p = proof(&v, 3, hash());
                let (w, other_c) = (hex(&p.write_pub), hex(&comms(9)));
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        None,
                        &claim_of(&other_c, &w, 3, Some(&p))
                    )
                    .unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
                // A true certificate cannot carry somebody else's write key onto the seat.
                let (c, other_w) = (hex(&p.comms_pub), hex(&write(9)));
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        None,
                        &claim_of(&c, &other_w, 3, Some(&p))
                    )
                    .unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
                let dissent = proof(&v, 3, [9; 32]);
                let (c, w) = (hex(&dissent.comms_pub), hex(&dissent.write_pub));
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        None,
                        &claim_of(&c, &w, 3, Some(&dissent))
                    )
                    .unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
            }

            #[test]
            fn the_exact_recorded_triple_is_a_no_op_with_a_token_or_a_proof_and_nothing_else() {
                let (cfg, v, id, reg) = pinned("offer-exact");
                let p = proof(&v, 1, hash());
                let (c, w) = (hex(&p.comms_pub), hex(&p.write_pub));
                let done = DeviceOutcome::Recorded { added: false };
                let before =
                    std::fs::read(cfg.vaults_dir.join(&id).join("device-keys.json")).unwrap();
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        Some(&token()),
                        &claim_of(&c, &w, 1, None)
                    )
                    .unwrap(),
                    done
                );
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &claim_of(&c, &w, 1, Some(&p)))
                        .unwrap(),
                    done
                );
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &claim_of(&c, &w, 1, None)).unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
                assert_eq!(
                    std::fs::read(cfg.vaults_dir.join(&id).join("device-keys.json")).unwrap(),
                    before
                );
            }

            /// With a shared comms key the exact triple still answers: it is read, not written.
            #[test]
            fn the_exact_triple_of_a_seat_on_a_shared_key_is_not_a_conflict() {
                let (cfg, dir) = coordinator("offer-shared", false);
                let v = vault(2, 3);
                answer_for(&dir, &v);
                let id = hex(&v.id);
                let claim = signed_with_hash(&v, 3, comms(1), write(3), hash());
                let bundle = [proof(&v, 1, hash()), claim];
                let reg = register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle).unwrap();
                let (c, w) = (hex(&comms(1)), hex(&write(3)));
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        Some(&token()),
                        &claim_of(&c, &w, 3, None)
                    )
                    .unwrap(),
                    DeviceOutcome::Recorded { added: false }
                );
            }

            #[test]
            fn a_recorded_seat_with_other_keys_is_bound() {
                let (cfg, v, _id, reg) = pinned("offer-bound");
                let p = signed_with_hash(&v, 1, comms(7), write(7), hash());
                let (c, w) = (hex(&comms(7)), hex(&write(7)));
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        Some(&token()),
                        &claim_of(&c, &w, 1, Some(&p))
                    )
                    .unwrap(),
                    DeviceOutcome::SeatBound
                );
            }

            #[test]
            fn a_comms_only_registration_on_a_pinned_vault_is_refused() {
                let (cfg, _v, _id, reg) = pinned("offer-comms");
                let c = hex(&comms(3));
                let only = DeviceClaim {
                    comms: &c,
                    seat: None,
                    write_pub: None,
                    proof: None,
                    fee_from: None,
                };
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, Some(&token()), &only).unwrap(),
                    DeviceOutcome::SeatNeedsProof
                );
            }

            #[test]
            fn a_closed_vault_takes_no_device_and_an_unreadable_one_answers_so() {
                let (cfg, dir) = coordinator("offer-closed", false);
                let v = vault(2, 3);
                answer_for(&dir, &v);
                let id = hex(&v.id);
                let reg = crate::helper::register_vault(&cfg, &id, "v", 2, 3, Some(CP)).unwrap();
                let p = proof(&v, 1, hash());
                let (c, w) = (hex(&p.comms_pub), hex(&p.write_pub));
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &claim_of(&c, &w, 1, Some(&p)))
                        .unwrap(),
                    DeviceOutcome::Closed
                );
                std::fs::write(cfg.vaults_dir.join(&id).join("read-key.json"), "{").unwrap();
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &claim_of(&c, &w, 1, Some(&p)))
                        .unwrap(),
                    DeviceOutcome::Unreadable
                );
            }

            #[test]
            fn an_older_vault_keeps_its_rule() {
                let (cfg, dir) = coordinator("offer-legacy", false);
                let v = vault(2, 3);
                answer_for(&dir, &v);
                let id = hex(&v.id);
                let reg = crate::helper::register_vault(&cfg, &id, "v", 2, 3, Some(2)).unwrap();
                let (c, w) = (hex(&comms(1)), hex(&write(1)));
                let plain = claim_of(&c, &w, 1, None);
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &plain).unwrap(),
                    DeviceOutcome::Recorded { added: true },
                    "no key yet: open, as today"
                );
                crate::helper::set_read_key(&cfg.vaults_dir, &id, &token()).unwrap();
                let (c2, w2) = (hex(&comms(2)), hex(&write(2)));
                assert_eq!(
                    offer_device(&cfg.vaults_dir, &reg, None, &claim_of(&c2, &w2, 2, None))
                        .unwrap(),
                    DeviceOutcome::NeedsReadKey
                );
                assert_eq!(
                    offer_device(
                        &cfg.vaults_dir,
                        &reg,
                        Some(&token()),
                        &claim_of(&c2, &w2, 2, None)
                    )
                    .unwrap(),
                    DeviceOutcome::Recorded { added: true }
                );
            }

            #[test]
            fn a_lost_key_file_beside_a_pin_is_unreadable_and_cannot_be_pinned_again() {
                let (cfg, v, id, reg) = pinned("offer-lost");
                std::fs::remove_file(cfg.vaults_dir.join(&id).join("read-key.json")).unwrap();
                assert_eq!(read_key_state(&cfg.vaults_dir, &reg), ReadKey::Unreadable);
                let bundle = [proof(&v, 1, hash()), proof(&v, 3, hash())];
                assert!(register_and_pin(&cfg, &id, "v", CP, &v.pkp, &bundle).is_err());
                assert_eq!(load_device_records(&cfg.vaults_dir, &id).unwrap().len(), 2);
            }

            /// CB-B1: the member who never registers, or names another's key, does not turn sealing off.
            #[test]
            fn protocol_3_never_sends_in_the_clear() {
                use crate::helper::{recipients_for, reg_for_read_key, DeviceRecord};
                let reg = VaultRegistration {
                    threshold: 2,
                    total: 3,
                    ..reg_for_read_key("v", Some(CP))
                };
                let rec = |c: &str, seat: Option<u16>| DeviceRecord {
                    comms: c.to_string(),
                    seat,
                    write: seat.map(|_| "w".to_string()),
                    fee_from: None,
                };
                let two_of_three = [rec("aa", Some(1)), rec("bb", Some(2))];
                for signed in [true, false] {
                    assert_eq!(
                        recipients_for(&reg, &two_of_three, signed).unwrap(),
                        ["aa", "bb"]
                    );
                    let shared = [rec("aa", Some(1)), rec("AA", Some(3))];
                    assert!(
                        recipients_for(&reg, &shared, signed).is_err(),
                        "one key is below t"
                    );
                    let seatless = [rec("aa", Some(1)), rec("bb", None)];
                    assert!(
                        recipients_for(&reg, &seatless, signed).is_err(),
                        "a record with no seat"
                    );
                    assert!(recipients_for(&reg, &[], signed).is_err());
                }
                let no_write = DeviceRecord {
                    comms: "bb".into(),
                    seat: Some(2),
                    write: None,
                    fee_from: None,
                };
                assert!(recipients_for(&reg, &[rec("aa", Some(1)), no_write], true).is_err());
                let outside = [rec("aa", Some(1)), rec("bb", Some(99))];
                assert!(
                    recipients_for(&reg, &outside, true).is_err(),
                    "a seat outside the vault"
                );
                let none = VaultRegistration {
                    threshold: 0,
                    total: 0,
                    ..reg.clone()
                };
                assert!(
                    recipients_for(&none, &[], true).is_err(),
                    "never an empty list"
                );
                let three = [rec("aa", Some(1)), rec("bb", Some(2)), rec("BB", Some(3))];
                assert_eq!(
                    recipients_for(&reg, &three, false).unwrap().len(),
                    2,
                    "a shared key counts once"
                );
            }

            #[test]
            fn an_older_vault_keeps_its_count() {
                use crate::helper::{recipients_for, reg_for_read_key, DeviceRecord};
                let reg = VaultRegistration {
                    threshold: 2,
                    total: 2,
                    ..reg_for_read_key("v", Some(2))
                };
                let rec = |c: &str| DeviceRecord {
                    comms: c.to_string(),
                    seat: None,
                    write: None,
                    fee_from: None,
                };
                assert_eq!(
                    recipients_for(&reg, &[rec("aa"), rec("bb")], false).unwrap(),
                    ["aa", "bb"]
                );
                assert_eq!(
                    recipients_for(&reg, &[rec("aa")], true).unwrap(),
                    Vec::<String>::new()
                );
                assert!(recipients_for(&reg, &[rec("aa")], false).is_err());
            }
        }
    }
}

//! Fixtures for the reader tests of the action bound: PCZTs made with orchard's public builder,
//! wrapped by pczt's creator. Written for these tests and never deployed; the coordinator builds
//! through the wallet, not through this. Each bundle is finalized the way the coordinator's is
//! (padding spends signed with their own key, which is then cleared), so what is left awaiting a
//! signature is what a device is asked to sign.
#![allow(dead_code)]

use orchard::builder::{Builder, BundleType};
use orchard::bundle::{BundleVersion, Flags, TxVersion as OrchardTxVersion};
use orchard::keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey};
use orchard::note::{Note, RandomSeed, Rho};
use orchard::value::NoteValue;
use orchard::Address;
use pczt::roles::creator::Creator;
use zcash_primitives::transaction::builder::PcztParts;
use zcash_primitives::transaction::TxVersion;
use zcash_protocol::consensus::{BlockHeight, BranchId, MainNetwork};

fn rng() -> rand10::rand_core::UnwrapErr<rand10::rngs::SysRng> {
    rand10::rand_core::UnwrapErr(rand10::rngs::SysRng)
}

/// A key and the two receivers a vault would use: the one it is paid at and the one it keeps change at.
pub struct Key {
    pub sk: SpendingKey,
    pub fvk: FullViewingKey,
}

impl Key {
    pub fn new(seed: u8) -> Key {
        let sk = SpendingKey::from_bytes([seed; 32]).expect("a usable spending key");
        let fvk = FullViewingKey::from(&sk);
        Key { sk, fvk }
    }
    pub fn external(&self) -> Address {
        self.fvk.address_at(0u32, Scope::External)
    }
    pub fn internal(&self) -> Address {
        self.fvk.address_at(0u32, Scope::Internal)
    }
    pub fn ask(&self) -> SpendAuthorizingKey {
        SpendAuthorizingKey::from(&self.sk)
    }
}

pub fn raw(a: &Address) -> [u8; 43] {
    a.to_raw_address_bytes()
}

const EMPTY_MEMO: [u8; 512] = {
    let mut m = [0u8; 512];
    m[0] = 0xF6;
    m
};

/// What one bundle is asked to do.
pub struct Plan<'a> {
    /// Ironwood (cross-address transfers allowed) or Orchard in a v6 transaction (not allowed).
    pub ironwood: bool,
    /// Override the flags the version defaults to.
    pub flags: Option<Flags>,
    /// Notes of the given keys to spend, each at the key's external receiver.
    pub spends: Vec<(&'a Key, u64)>,
    /// Payments to anyone.
    pub outputs: Vec<(Address, u64)>,
    /// Change to a key's internal receiver (the wallet-controlled kind).
    pub changes: Vec<(&'a Key, u64)>,
    /// Make a bundle even when nothing is asked of it (it is then padding only).
    pub required: bool,
}

impl<'a> Plan<'a> {
    pub fn new(ironwood: bool) -> Self {
        Plan {
            ironwood,
            flags: None,
            spends: vec![],
            outputs: vec![],
            changes: vec![],
            required: false,
        }
    }
}

fn version(ironwood: bool) -> BundleVersion {
    if ironwood {
        BundleVersion::ironwood_v3()
    } else {
        BundleVersion::orchard_v3()
    }
}

/// Build one bundle for a PCZT and finalize its IO. The actions are those orchard's builder makes
/// (padded to two).
pub fn bundle(plan: &Plan) -> orchard::pczt::Bundle {
    let v = version(plan.ironwood);
    let flags = plan.flags.unwrap_or_else(|| v.default_flags());
    let bundle_type = BundleType::Transactional {
        bundle_required: plan.required,
        pad_to_minimum: Some(2),
    };
    let mut b = Builder::new_with_anchor_deferred(bundle_type, v, flags, OrchardTxVersion::V6)
        .expect("a builder");
    for (n, (key, value)) in plan.spends.iter().enumerate() {
        let mut rho = [0u8; 32];
        rho[0] = n as u8 + 1;
        rho[1] = *value as u8;
        let rho = Rho::from_bytes(&rho).expect("a field element");
        let rseed = RandomSeed::from_bytes([n as u8 + 7; 32], &rho).expect("a usable seed");
        let note = Note::from_parts(
            key.external(),
            NoteValue::from_raw(*value),
            rho,
            rseed,
            v.note_version(),
        )
        .expect("a note");
        b.add_spend_unwitnessed(key.fvk.clone(), note)
            .expect("a spend");
    }
    for (addr, value) in &plan.outputs {
        b.add_output(None, *addr, NoteValue::from_raw(*value), EMPTY_MEMO)
            .expect("an output");
    }
    for (key, value) in &plan.changes {
        b.add_change_output(
            key.fvk.clone(),
            None,
            key.internal(),
            NoteValue::from_raw(*value),
            EMPTY_MEMO,
        )
        .expect("a change output");
    }
    let (mut bundle, _) = b.build_for_pczt(rng()).expect("a bundle");
    bundle.finalize_io([0u8; 32], rng()).expect("finalized");
    bundle
}

/// Sign the spend of action `i` as `key` (a key other than the vault's: that spend then arrives
/// already signed).
pub fn sign_as(bundle: &mut orchard::pczt::Bundle, i: usize, key: &Key) {
    bundle.actions_mut()[i]
        .sign([0u8; 32], &key.ask(), rng())
        .expect("the key of that spend");
}

/// Indexes of the actions whose spend holds `value`.
pub fn actions_spending(bundle: &orchard::pczt::Bundle, value: u64) -> Vec<usize> {
    bundle
        .actions()
        .iter()
        .enumerate()
        .filter(|(_, a)| a.spend().value().map(|v| v.inner()) == Some(value))
        .map(|(i, _)| i)
        .collect()
}

/// A v6 PCZT around an Orchard and an Ironwood bundle (either may be absent).
pub fn pczt(
    orchard: Option<orchard::pczt::Bundle>,
    ironwood: Option<orchard::pczt::Bundle>,
) -> Vec<u8> {
    pczt_expiring(orchard, ironwood, 3_500_000)
}

/// `pczt` with the block it expires at, for the readers that check the header against a clock.
pub fn pczt_expiring(
    orchard: Option<orchard::pczt::Bundle>,
    ironwood: Option<orchard::pczt::Bundle>,
    expiry: u32,
) -> Vec<u8> {
    let parts = PcztParts {
        params: MainNetwork,
        version: TxVersion::V6,
        consensus_branch_id: BranchId::Nu6_3,
        lock_time: 0,
        expiry_height: BlockHeight::from_u32(expiry),
        transparent: None,
        sapling: None,
        orchard,
        ironwood,
    };
    Creator::build_from_parts(parts)
        .expect("a PCZT")
        .serialize()
        .expect("a serialized PCZT")
}

/// The vault's viewing key as a PCZT's spends carry it: the first spend of either pool that has
/// one. A builder's or the wallet's file carries it; the published copy does not, which is why a
/// device brings its own. The test's stand-in for the device's key.
pub fn fvk_in(pczt_bytes: &[u8]) -> FullViewingKey {
    try_fvk_in(pczt_bytes).expect("the PCZT carries the vault's key on a spend")
}

/// `fvk_in` for a PCZT that may carry no valued spend (and so needs no key to be read).
pub fn try_fvk_in(pczt_bytes: &[u8]) -> Option<FullViewingKey> {
    use pczt::roles::verifier::{OrchardError, Verifier};
    let mut found: Option<FullViewingKey> = None;
    let mut take = |b: &orchard::pczt::Bundle| -> Result<(), OrchardError<()>> {
        if found.is_none() {
            found = b
                .actions()
                .iter()
                .filter(|a| a.spend().value().is_some_and(|v| v.inner() > 0))
                .find_map(|a| a.spend().fvk().clone());
        }
        Ok(())
    };
    // A parse of the pool that has no bundle is an error to ignore: the other pool has the spends.
    let _ = Verifier::new(pczt::Pczt::parse(pczt_bytes).unwrap()).with_orchard(&mut take);
    let _ = Verifier::new(pczt::Pczt::parse(pczt_bytes).unwrap()).with_ironwood(&mut take);
    found
}

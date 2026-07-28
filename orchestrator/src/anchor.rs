//! Exploratory (branch `explore/proposal-anchor`, NOT merged): an immutable, private commitment to
//! a proposal's content, for a Zcash-anchored timestamp + a future zkTimestamp proof. See
//! `temp/ANCHOR-DESIGN.md` for the full flow and the open decisions to align on.
//!
//! `c = commit(canonical(content))`. `canonical` is a DETERMINISTIC serialization of a proposal's
//! **immutable content**; the commitment `c` is public (written into a shielded Orchard memo, the
//! mined block being the timestamp). A separate Noir/BN254 circuit later proves
//! `Poseidon(content) == c` without revealing the content, so anyone can verify "this proposal
//! existed at block N" without seeing it.
//!
//! Two deliberate boundaries:
//! - `canonical` is **hash-independent** and is the security-relevant part: the field set + order
//!   must be stable across devices so every device commits to the same bytes. This is the real
//!   foundation and is fully tested.
//! - `commit` uses SHA-256 as a **PLACEHOLDER algorithm**. The real commitment must be a zk-friendly
//!   **Poseidon over BN254** with the exact params the Noir circuit uses; that swap is trivial once
//!   the circuit is chosen. Do NOT treat this hash as final.

use sha2::{Digest, Sha256};

/// A proposal's IMMUTABLE content — exactly what the anchor commits to (never the mutable state or
/// votes). The precise field set is an open decision (see the design note); kept minimal + explicit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalContent {
    pub vault_id: String,
    pub kind: String, // "payment" | "payroll"
    pub to_address: Option<String>,
    pub value_zat: u64,
    pub memo: Option<String>,
    pub created_at: i64,
}

/// Bumped if the canonical layout ever changes, so old and new commitments never collide silently.
const CANON_VERSION: u8 = 1;

fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_le_bytes());
    out.extend_from_slice(b);
}

fn put_opt(out: &mut Vec<u8>, v: &Option<String>) {
    match v {
        None => out.push(0),
        Some(s) => {
            out.push(1);
            put_bytes(out, s.as_bytes());
        }
    }
}

/// Deterministic, unambiguous serialization of the immutable content: a version byte then
/// length-prefixed fields in a fixed order, so two devices always produce identical bytes for the
/// same proposal (and a different field always yields different bytes). Hash-independent.
pub fn canonical(c: &ProposalContent) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(CANON_VERSION);
    put_bytes(&mut out, c.vault_id.as_bytes());
    put_bytes(&mut out, c.kind.as_bytes());
    put_opt(&mut out, &c.to_address);
    out.extend_from_slice(&c.value_zat.to_le_bytes());
    put_opt(&mut out, &c.memo);
    out.extend_from_slice(&c.created_at.to_le_bytes());
    out
}

/// PLACEHOLDER commitment: SHA-256 over a domain-separated canonical serialization. The final
/// commitment is Poseidon-BN254 (params to match the Noir circuit); this stands in so the
/// canonical + memo-anchor flow can be built and tested now. Returns the 32-byte commitment `c`.
pub fn commit(c: &ProposalContent) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"konclave:proposal-anchor:v1"); // domain separation
    h.update(canonical(c));
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ProposalContent {
        ProposalContent {
            vault_id: "vault-1".into(),
            kind: "payment".into(),
            to_address: Some("u1recipient".into()),
            value_zat: 50_000,
            memo: Some("reembolso".into()),
            created_at: 1_900_000_000,
        }
    }

    #[test]
    fn canonical_is_deterministic() {
        assert_eq!(canonical(&sample()), canonical(&sample()));
        assert_eq!(commit(&sample()), commit(&sample()));
    }

    #[test]
    fn any_field_change_changes_the_commitment() {
        let base = commit(&sample());
        let variants = [
            ProposalContent {
                vault_id: "vault-2".into(),
                ..sample()
            },
            ProposalContent {
                kind: "payroll".into(),
                ..sample()
            },
            ProposalContent {
                to_address: Some("u1other".into()),
                ..sample()
            },
            ProposalContent {
                value_zat: 50_001,
                ..sample()
            },
            ProposalContent {
                memo: Some("outro".into()),
                ..sample()
            },
            ProposalContent {
                created_at: 1_900_000_001,
                ..sample()
            },
        ];
        for v in &variants {
            assert_ne!(
                commit(v),
                base,
                "a changed field must change the commitment"
            );
        }
    }

    #[test]
    fn none_and_empty_are_distinguishable() {
        // A missing optional field must not collide with an empty-string one (length-prefix + tag).
        let a = ProposalContent {
            memo: None,
            ..sample()
        };
        let b = ProposalContent {
            memo: Some(String::new()),
            ..sample()
        };
        assert_ne!(commit(&a), commit(&b));
        let c = ProposalContent {
            to_address: None,
            ..sample()
        };
        let d = ProposalContent {
            to_address: Some(String::new()),
            ..sample()
        };
        assert_ne!(commit(&c), commit(&d));
    }

    #[test]
    fn field_boundaries_are_unambiguous() {
        // Moving a byte across a field boundary must change the bytes (length-prefixing prevents the
        // classic "ab|c" vs "a|bc" collision).
        let x = ProposalContent {
            vault_id: "ab".into(),
            kind: "c".into(),
            ..sample()
        };
        let y = ProposalContent {
            vault_id: "a".into(),
            kind: "bc".into(),
            ..sample()
        };
        assert_ne!(canonical(&x), canonical(&y));
    }

    #[test]
    fn commitment_is_32_bytes() {
        assert_eq!(commit(&sample()).len(), 32);
    }
}

//! Authoritative Zcash address validation (audit M2).
//!
//! The domain layer ([`crate::validation::AddressKind`]) keeps a fast, dependency-free
//! prefix heuristic that drives the "this destination is public" UX warning. It is
//! deliberately NON-authoritative: `starts_with("u1")` happily accepts `u1recipientxxx`,
//! a testnet `utest…` re-typed as `u1…`, or a Sapling-only address — any of which the
//! transaction builder would then try to pay, locking the funds (destructive-suite §8:
//! "Sapling address instead of Orchard → risk of locked funds").
//!
//! This module does the real decode via `zcash_address` (bech32m / base58 + checksum),
//! inspects the receiver pools, and confirms the network. It is the gate the send path
//! uses when real funds are at stake.

use std::fmt;
use std::str::FromStr;

use zcash_address::{unified, ConversionError, TryFromAddress, ZcashAddress};
use zcash_protocol::consensus::NetworkType;
use zcash_protocol::PoolType;

/// Why a destination is rejected outright (before any pool-capability policy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressError {
    /// Not a valid Zcash address: unknown encoding, bad checksum, wrong length.
    Malformed,
    /// A valid address, but not on mainnet (testnet / regtest).
    WrongNetwork,
}

impl AddressError {
    /// A human-readable, actionable message for the UI (principle §6.11).
    pub fn human(self) -> &'static str {
        match self {
            AddressError::Malformed => "this is not a valid Zcash address",
            AddressError::WrongNetwork => "this is a testnet address, not mainnet",
        }
    }
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.human())
    }
}

impl std::error::Error for AddressError {}

/// The authoritative verdict for a mainnet destination: which pools it can receive in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddressReport {
    /// Can receive Orchard funds (the shielded default this vault sends). Preferred.
    pub orchard: bool,
    /// Only transparent receivers are recognized → paying it is PUBLIC (warned exception).
    pub transparent_only: bool,
    /// Can carry an encrypted memo (a Sapling or Orchard receiver is present).
    pub memo: bool,
}

impl AddressReport {
    /// Whether an Orchard-funded vault can actually pay this destination without locking
    /// funds: an Orchard receiver (shielded) or a transparent one (public, warned). A
    /// Sapling-only or unknown-only address is NOT payable by this tooling (§8).
    pub fn is_payable(self) -> bool {
        self.orchard || self.transparent_only
    }

    /// Whether paying this destination reveals the payment on-chain (transparent-only).
    pub fn is_public(self) -> bool {
        self.transparent_only
    }
}

/// Accept-any visitor, used only to probe an address's network through
/// [`ZcashAddress::convert_if_network`]. Every address kind resolves to `Accept`, so the
/// only way the conversion can fail is a network mismatch — exactly what we test for.
struct Accept;

impl TryFromAddress for Accept {
    type Error = std::convert::Infallible;
    fn try_from_sprout(_: NetworkType, _: [u8; 64]) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Accept)
    }
    fn try_from_sapling(_: NetworkType, _: [u8; 43]) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Accept)
    }
    fn try_from_unified(
        _: NetworkType,
        _: unified::Address,
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Accept)
    }
    fn try_from_transparent_p2pkh(
        _: NetworkType,
        _: [u8; 20],
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Accept)
    }
    fn try_from_transparent_p2sh(
        _: NetworkType,
        _: [u8; 20],
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Accept)
    }
    fn try_from_tex(_: NetworkType, _: [u8; 20]) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Accept)
    }
}

/// Decode and validate a destination for a mainnet send.
///
/// Returns [`AddressError::Malformed`] for anything that is not a real Zcash address, and
/// [`AddressError::WrongNetwork`] for a valid but non-mainnet address. Otherwise returns
/// the [`AddressReport`]; the caller applies the pool policy via [`AddressReport::is_payable`].
pub fn validate_recipient(addr: &str) -> Result<AddressReport, AddressError> {
    let parsed = ZcashAddress::from_str(addr).map_err(|_| AddressError::Malformed)?;
    // Capability checks borrow `parsed`; do them before the network probe consumes it.
    let report = AddressReport {
        orchard: parsed.can_receive_as(PoolType::ORCHARD),
        transparent_only: parsed.is_transparent_only(),
        memo: parsed.can_receive_memo(),
    };
    if parsed
        .convert_if_network::<Accept>(NetworkType::Main)
        .is_err()
    {
        return Err(AddressError::WrongNetwork);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real 2-of-3 vault Orchard address from the mainnet slice (has an Orchard receiver).
    const ORCHARD_UA: &str = "u1vjgxlvz4ewnt43rkq6fzexpl639745spx369tc4j9n9l0qnt9rufxdt2pxe3jtku7lqv4gtzfqafxtf7gal5y9gmz84nkza6z5d406dr";
    // Real mainnet transparent P2PKH (t1…) and Sapling (zs1…) test vectors.
    const TRANSPARENT: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
    const SAPLING: &str =
        "zs1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle75c8v35z";
    // A valid but TESTNET unified address.
    const TESTNET_UA: &str = "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s";

    #[test]
    fn orchard_unified_is_payable_shielded() {
        let r = validate_recipient(ORCHARD_UA).expect("valid mainnet UA");
        assert!(r.orchard, "UA carries an Orchard receiver");
        assert!(r.is_payable());
        assert!(!r.is_public(), "shielded, not public");
        assert!(r.memo, "Orchard supports memos");
    }

    #[test]
    fn transparent_is_payable_but_public() {
        let r = validate_recipient(TRANSPARENT).expect("valid t-addr");
        assert!(!r.orchard);
        assert!(r.transparent_only);
        assert!(r.is_payable(), "transparent is payable (public, warned)");
        assert!(r.is_public());
        assert!(!r.memo, "transparent carries no memo");
    }

    #[test]
    fn sapling_only_is_not_payable_lock_risk() {
        // §8: a Sapling address handed to an Orchard vault would lock the funds.
        let r = validate_recipient(SAPLING).expect("valid mainnet zs-addr");
        assert!(!r.orchard);
        assert!(!r.transparent_only, "has a shielded (Sapling) receiver");
        assert!(
            !r.is_payable(),
            "Sapling-only must be refused before the builder"
        );
    }

    #[test]
    fn testnet_address_is_wrong_network() {
        assert_eq!(
            validate_recipient(TESTNET_UA),
            Err(AddressError::WrongNetwork)
        );
    }

    #[test]
    fn prefix_looks_valid_but_decode_rejects() {
        // These pass the domain prefix heuristic (`starts_with("u1")`) yet are not real
        // addresses — the exact gap this authoritative check closes.
        for bad in [
            "u1recipientxxxxxxxxxxxxxxxxxxxxxxxx",
            "u1demo",
            "u1abc",
            "garbage",
        ] {
            assert_eq!(
                validate_recipient(bad),
                Err(AddressError::Malformed),
                "{bad} must be rejected as malformed"
            );
        }
    }

    #[test]
    fn empty_is_malformed() {
        assert_eq!(validate_recipient(""), Err(AddressError::Malformed));
    }
}

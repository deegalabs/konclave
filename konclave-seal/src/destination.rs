//! The one decoder from a destination address a person typed to the Orchard receiver a note pays.
//!
//! A note commits to a raw 43-byte receiver; a person approves a unified address. The device has to
//! bring the two into one space itself, so this decoder runs on the device and in the coordinator
//! from the same code. Per ZIP 326 a receiver is scoped to the Orchard protocol, not to a pool, so
//! one decode covers an Orchard or an Ironwood output.
//!
//! Interim state, 2026-11-15: `konclave-wasm` still has its own `ua_receiver`, which does not take
//! the network. It switches to this function once the wasm crate's pending changes land, and a
//! source scan then keeps a second decoder out.

pub use zcash_protocol::consensus::NetworkType;

/// The raw Orchard receiver of `address` on `network`. Refuses an address of another network, an
/// address with no Orchard receiver (a shielded vault spend cannot pay it), and anything that is not
/// a Zcash address.
pub fn orchard_receiver(address: &str, network: NetworkType) -> Result<[u8; 43], String> {
    use zcash_address::unified::{Container, Receiver};
    use zcash_address::{unified, ConversionError, TryFromAddress, ZcashAddress};

    /// Carries out the one thing wanted: the Orchard receiver's raw bytes. Every other address kind
    /// is refused, so a Sapling or transparent destination cannot decode to nothing and be read as
    /// a match.
    struct OrchardOnly([u8; 43]);
    impl TryFromAddress for OrchardOnly {
        type Error = String;
        fn try_from_unified(
            _: NetworkType,
            ua: unified::Address,
        ) -> Result<Self, ConversionError<Self::Error>> {
            ua.items()
                .into_iter()
                .find_map(|r| match r {
                    Receiver::Orchard(bytes) => Some(OrchardOnly(bytes)),
                    _ => None,
                })
                .ok_or_else(|| {
                    ConversionError::User(
                        "this unified address has no Orchard receiver, so a shielded vault \
                         spend cannot pay it"
                            .into(),
                    )
                })
        }
    }

    let addr = ZcashAddress::try_from_encoded(address.trim())
        .map_err(|e| format!("not a Zcash address: {e}"))?;
    let OrchardOnly(bytes) = addr
        .convert_if_network::<OrchardOnly>(network)
        .map_err(|e| format!("no Orchard receiver: {e}"))?;
    Ok(bytes)
}

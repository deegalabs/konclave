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
    let _ = (address, network);
    todo!()
}

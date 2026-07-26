//! Architecture B — the helper side of a real `/net` broadcast.
//!
//! In `/net`, the browser devices hold the FROST shares and run the signing ceremony among
//! themselves over the blind relay. This helper (which NEVER sees a share) does the public,
//! non-secret work: it builds and proves the real PCZT for the vault's own address, publishes a
//! **signing request** into a relay room, waits for the aggregate FROST signature the devices
//! produce, injects it, and broadcasts. The share never leaves the browser; the helper sees only
//! public transaction data (and the view-only UFVK) — consistent with Konclave's principle of
//! "internal transparency, external privacy": whoever operates the vault already sees its ledger,
//! while the network and the relay stay blind, and no single device can spend on its own.
//!
//! This module is the wire protocol between the helper and the devices, plus the pure logic that
//! turns a proven PCZT's extract output into a request and validates the devices' response back
//! into the `(action_index, signature)` pairs that `konclave-signer inject` consumes. The relay
//! transport, the native build/prove/broadcast, and the UI ceremony are wired around it.

use serde::{Deserialize, Serialize};

use crate::signer::SigningInput;

/// One spend the ceremony must authorize: its action index and the Orchard/Ironwood randomizer
/// (alpha) it must sign under. Both are public.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpendReq {
    pub index: u32,
    /// 64-hex of the 32-byte redpallas randomizer.
    pub alpha: String,
}

/// What the helper publishes into the relay room. Carries the shielded sighash, the per-spend
/// randomizers, and the proven PCZT (hex) so each device can independently confirm what it is
/// signing (via `describeOutputs`) before it signs. No secret material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignRequest {
    /// Discriminator so a device can tell this apart from ceremony traffic in the same room.
    pub kind: String,
    /// 64-hex of the 32-byte shielded sighash.
    pub sighash: String,
    pub spends: Vec<SpendReq>,
    /// Hex of the proven PCZT bytes (well under the relay's 128 KiB message cap).
    pub pczt_hex: String,
}

/// One aggregate FROST signature the devices produced for a requested spend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SigResp {
    pub index: u32,
    /// 128-hex of the 64-byte redpallas signature.
    pub sig: String,
}

/// What the devices return over the relay: exactly one aggregate signature per requested spend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignResponse {
    pub kind: String,
    pub sigs: Vec<SigResp>,
}

/// The `kind` tags, so both sides agree on the discriminators.
pub const REQUEST_KIND: &str = "net-sign-request";
pub const RESPONSE_KIND: &str = "net-sign-response";

fn hexenc(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hexdec(s: &str, what: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("{what}: odd-length hex"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| format!("{what}: invalid hex")))
        .collect()
}

impl SignRequest {
    /// Build the request the devices sign, from a proven PCZT's extract output and its bytes.
    pub fn from_signing_input(input: &SigningInput, pczt_bytes: &[u8]) -> SignRequest {
        SignRequest {
            kind: REQUEST_KIND.to_string(),
            sighash: hexenc(&input.sighash),
            spends: input
                .randomizers
                .iter()
                .map(|r| SpendReq {
                    index: r.action_index as u32,
                    alpha: hexenc(&r.alpha),
                })
                .collect(),
            pczt_hex: hexenc(pczt_bytes),
        }
    }
}

impl SignResponse {
    /// Validate that the devices signed EXACTLY the requested spends — no missing, extra, or
    /// duplicate index — and decode each signature into the `(action_index, 64-byte sig)` form
    /// `konclave-signer inject` consumes. Any mismatch is an error, so a partially-signed or
    /// tampered response can never be injected into a broadcast (a boundary, §6.8).
    pub fn into_sigs(&self, req: &SignRequest) -> Result<Vec<(usize, [u8; 64])>, String> {
        if self.kind != RESPONSE_KIND {
            return Err(format!("unexpected response kind {:?}", self.kind));
        }
        if self.sigs.len() != req.spends.len() {
            return Err(format!(
                "expected {} signatures, got {}",
                req.spends.len(),
                self.sigs.len()
            ));
        }
        let mut out = Vec::with_capacity(self.sigs.len());
        for spend in &req.spends {
            let matches: Vec<&SigResp> = self
                .sigs
                .iter()
                .filter(|s| s.index == spend.index)
                .collect();
            match matches.as_slice() {
                [one] => {
                    let bytes = hexdec(&one.sig, "signature")?;
                    let arr: [u8; 64] = bytes.try_into().map_err(|_| {
                        format!("signature for index {} is not 64 bytes", spend.index)
                    })?;
                    out.push((spend.index as usize, arr));
                }
                [] => return Err(format!("no signature for spend index {}", spend.index)),
                _ => {
                    return Err(format!(
                        "duplicate signatures for spend index {}",
                        spend.index
                    ))
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::{Randomizer, SigningInput};

    // The extract output of the real Ironwood (V6) test vector: sighash + four per-spend alphas.
    fn ironwood_input() -> SigningInput {
        let h = |s: &str| -> [u8; 32] { hexdec(s, "t").unwrap().try_into().unwrap() };
        SigningInput {
            sighash: h("332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0"),
            randomizers: vec![
                Randomizer {
                    action_index: 0,
                    alpha: h("63267dad44b3621cd5246056295def55bd012cb053de4ba7af406e35d4ba4734"),
                },
                Randomizer {
                    action_index: 1,
                    alpha: h("1b27bf7dd00d209b49cd36397efd8c4bad9484eddc4670584de057aee5345f13"),
                },
                Randomizer {
                    action_index: 2,
                    alpha: h("913221d4e7411e6a0504b980867180a8915b35421297010400009ddcc35ade28"),
                },
                Randomizer {
                    action_index: 3,
                    alpha: h("cf92a74546950873969d7540a65ccaaaf849f73f62ca7ae50ccab671cb023512"),
                },
            ],
        }
    }

    #[test]
    fn request_carries_sighash_spends_and_pczt() {
        let req = SignRequest::from_signing_input(&ironwood_input(), &[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(req.kind, REQUEST_KIND);
        assert_eq!(
            req.sighash,
            "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0"
        );
        assert_eq!(req.spends.len(), 4);
        assert_eq!(req.spends[0].index, 0);
        assert_eq!(req.spends[3].index, 3);
        assert_eq!(req.pczt_hex, "deadbeef");
    }

    #[test]
    fn request_round_trips_through_json() {
        let req = SignRequest::from_signing_input(&ironwood_input(), &[1, 2, 3]);
        let json = serde_json::to_string(&req).unwrap();
        let back: SignRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);
    }

    fn response_for(req: &SignRequest) -> SignResponse {
        SignResponse {
            kind: RESPONSE_KIND.to_string(),
            sigs: req
                .spends
                .iter()
                .map(|s| SigResp {
                    index: s.index,
                    sig: "ab".repeat(64),
                })
                .collect(),
        }
    }

    #[test]
    fn matching_response_decodes_to_one_sig_per_spend() {
        let req = SignRequest::from_signing_input(&ironwood_input(), &[]);
        let sigs = response_for(&req).into_sigs(&req).unwrap();
        assert_eq!(sigs.len(), 4);
        assert_eq!(sigs[0], (0, [0xabu8; 64]));
        assert_eq!(sigs[3].0, 3);
    }

    #[test]
    fn response_must_cover_every_spend_exactly() {
        let req = SignRequest::from_signing_input(&ironwood_input(), &[]);

        // Missing one signature.
        let mut short = response_for(&req);
        short.sigs.pop();
        assert!(short.into_sigs(&req).is_err());

        // A signature for an index that was not requested.
        let mut wrong = response_for(&req);
        wrong.sigs[0].index = 99;
        assert!(wrong.into_sigs(&req).is_err());

        // A duplicate for one index (and none for another) — same count, still rejected.
        let mut dup = response_for(&req);
        dup.sigs[1].index = 0;
        assert!(dup.into_sigs(&req).is_err());

        // Wrong response kind.
        let mut badkind = response_for(&req);
        badkind.kind = "something-else".to_string();
        assert!(badkind.into_sigs(&req).is_err());

        // Malformed signature hex (wrong length).
        let mut badsig = response_for(&req);
        badsig.sigs[0].sig = "ab".repeat(10);
        assert!(badsig.into_sigs(&req).is_err());
    }
}

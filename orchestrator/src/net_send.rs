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

use crate::relay_client::{RelayClient, Transport};
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

/// Inject-ready signatures: one `(action_index, 64-byte redpallas signature)` per real spend.
pub type SpendSigs = Vec<(usize, [u8; 64])>;

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
    pub fn into_sigs(&self, req: &SignRequest) -> Result<SpendSigs, String> {
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

/// Publish the signing request into the relay room (the helper's first move). Returns the
/// sequence it was posted at, so a caller can start polling for the response strictly after it.
pub fn publish_request<T: Transport>(
    client: &RelayClient<T>,
    req: &SignRequest,
) -> Result<u64, String> {
    let data = serde_json::to_string(req).map_err(|e| format!("encode request: {e}"))?;
    client.post(&data)
}

/// Look for the devices' signing response after `since`. Returns `(Some(sigs), next)` once a
/// valid response has arrived — decoded into the inject-ready `(action_index, sig)` pairs — or
/// `(None, next)` while still waiting. A response that does not cover the request exactly is an
/// error, never a silent wait, so a partial or tampered reply can't slip through to a broadcast.
/// The caller owns the retry loop and its delay, keeping this synchronous and testable.
pub fn collect_response<T: Transport>(
    client: &RelayClient<T>,
    req: &SignRequest,
    since: u64,
) -> Result<(Option<SpendSigs>, u64), String> {
    let (hit, next) = client.find(since, |d| d.contains(RESPONSE_KIND))?;
    match hit {
        Some(msg) => {
            let resp: SignResponse =
                serde_json::from_str(&msg.data).map_err(|e| format!("decode response: {e}"))?;
            Ok((Some(resp.into_sigs(req)?), next))
        }
        None => Ok((None, next)),
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

    // ---- The relay handshake, end to end in-process (helper <-> relay <-> device) ----

    use crate::relay::RelayState;
    use crate::relay_client::{RelayClient, Transport};
    use std::sync::Arc;

    /// A test transport routing straight to a real `RelayState` (no sockets, fixed clock), so the
    /// handshake test exercises the client, the relay, and this flow together.
    struct LocalRelay {
        state: Arc<RelayState>,
    }
    impl Transport for LocalRelay {
        fn post(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            let raw = &url[url.find("/api/relay/").unwrap()..];
            let path = raw.split('?').next().unwrap();
            let r = self.state.handle("POST", path, raw, body, 1000);
            (r.status == 200)
                .then_some(r.body)
                .ok_or(format!("relay {}", r.status))
        }
        fn get(&self, url: &str) -> Result<Vec<u8>, String> {
            let raw = &url[url.find("/api/relay/").unwrap()..];
            let path = raw.split('?').next().unwrap();
            let r = self.state.handle("GET", path, raw, &[], 1000);
            (r.status == 200)
                .then_some(r.body)
                .ok_or(format!("relay {}", r.status))
        }
    }
    fn client(state: Arc<RelayState>, from: &str) -> RelayClient<LocalRelay> {
        RelayClient::new(LocalRelay { state }, "", "vault-room", from)
    }

    #[test]
    fn helper_publishes_and_collects_the_devices_signatures() {
        let state = Arc::new(RelayState::new());
        let helper = client(state.clone(), "helper");
        let device = client(state, "device");

        let req = SignRequest::from_signing_input(&ironwood_input(), &[0xaa, 0xbb]);

        // Helper posts the request.
        publish_request(&helper, &req).unwrap();

        // Before the device responds, the helper is still waiting (no response yet).
        let (waiting, since) = collect_response(&helper, &req, 0).unwrap();
        assert!(waiting.is_none(), "no signatures until the devices respond");

        // The device reads the request off the relay and posts a (simulated) aggregate response.
        let p = device.poll(0).unwrap();
        let got: SignRequest = serde_json::from_str(
            &p.messages
                .iter()
                .find(|m| m.data.contains(REQUEST_KIND))
                .unwrap()
                .data,
        )
        .unwrap();
        assert_eq!(
            got, req,
            "the device sees exactly what the helper published"
        );
        let resp = response_for(&got); // stand-in aggregate signatures (message-flow test)
        device.post(&serde_json::to_string(&resp).unwrap()).unwrap();

        // The helper collects and assembles the inject-ready pairs.
        let (sigs, _) = collect_response(&helper, &req, since).unwrap();
        let sigs = sigs.expect("the devices' response is now present");
        assert_eq!(sigs.len(), 4);
        assert_eq!(sigs[0], (0, [0xabu8; 64]));
    }
}

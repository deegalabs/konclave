//! A real creation's bundle, made by the device's WASM (fixture), read by the coordinator's own code.
//! The other half is ui/src/creation-crossing.test.ts. Without this the two sides only agree with
//! their own copies of each other.
use orchestrator::seat_registry::{parse_bundle, tally, ProofJson};

fn h(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn hx(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/creation-crossing.json")).unwrap()
}

#[test]
fn the_device_bundle_tallies_on_the_coordinator() {
    let d = fixture();
    let id: [u8; 32] = h(d["groupKey"].as_str().unwrap()).try_into().unwrap();
    let proofs: Vec<ProofJson> = serde_json::from_value(d["bundle"]["proofs"].clone()).unwrap();
    let (pkp, seats) = parse_bundle(d["bundle"]["pkp"].as_str().unwrap(), &proofs).expect("parse");
    assert_eq!(
        hx(&pkp.digest()),
        d["digest"].as_str().unwrap(),
        "digest, device against coordinator"
    );
    let ok = tally(&pkp, &id, 3, &seats).expect("tally");
    assert_eq!(
        hx(&ok.read_key_hash),
        hx(&konclave_seal::share_sig::read_key_hash(
            &h(d["readKey"].as_str().unwrap()).try_into().unwrap()
        )),
    );
    assert!(tally(&pkp, &id, 2, &seats).is_err(), "another protocol");
    assert_eq!(
        format!("{:?}", tally(&pkp, &id, 3, &seats[..1]).err().unwrap()),
        "NeedsTProofs"
    );
}

#[test]
fn the_certificate_of_an_unlock_is_the_same_seat_as_the_creation() {
    let d = fixture();
    let id: [u8; 32] = h(d["groupKey"].as_str().unwrap()).try_into().unwrap();
    let proofs: Vec<ProofJson> = serde_json::from_value(d["bundle"]["proofs"].clone()).unwrap();
    let (pkp, seats) = parse_bundle(d["bundle"]["pkp"].as_str().unwrap(), &proofs).expect("parse");
    let unlock: Vec<ProofJson> = d["seats"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| serde_json::from_str(s["cert"].as_str().unwrap()).unwrap())
        .collect();
    let (_, again) =
        parse_bundle(d["bundle"]["pkp"].as_str().unwrap(), &unlock).expect("parse unlock");
    tally(&pkp, &id, 3, &again).expect("tally of unlock certificates");
    for u in &again {
        let same = seats.iter().find(|s| s.seat == u.seat).unwrap();
        assert_eq!(u.comms_pub, same.comms_pub);
    }
}

#[test]
fn the_viewing_key_derives_what_the_device_is_told() {
    let d = fixture();
    let id: [u8; 32] = h(d["groupKey"].as_str().unwrap()).try_into().unwrap();
    let u = &d["ufvks"];
    let net = zcash_protocol::consensus::NetworkType::Main;
    let r = konclave_seal::receivers::vault_receivers(u["K"].as_str().unwrap(), net, &id).unwrap();
    assert_eq!(r.external_ua, u["externalK"].as_str().unwrap());
    assert_eq!(r.internal_ua, u["internalK"].as_str().unwrap());
    assert!(
        konclave_seal::receivers::vault_receivers(u["foreignAk"].as_str().unwrap(), net, &id)
            .is_err()
    );
}

//! What a vault's viewing key derives: its one deposit address and its one change receiver, one
//! definition for the device and the coordinator. Exact on purpose: anything in the key or an address beyond the one Orchard item is refused, which is why
//! this reads `items_as_parsed` (`items` leaves metadata out) and is not the destination decoder.

use orchard::keys::{FullViewingKey, Scope};
use zcash_address::unified::{self, Address, Container, Encoding, Receiver, Revision, Uitem};
use zcash_protocol::consensus::NetworkType;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiversError {
    DoesNotParse,
    WrongNetwork,
    NotOrchardOnly,
    NotRevision0,
    BadOrchardKey,
    NotThisVault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultReceivers {
    pub external: [u8; 43],
    pub internal: [u8; 43],
    pub external_ua: String,
    pub internal_ua: String,
}

/// The receivers of THIS vault's viewing key: `ak` is the vault's own group key, which a device
/// takes from its own package and the coordinator from the vault id. There is no way to ask this
/// without it.
pub fn vault_receivers(
    ufvk: &str,
    network: NetworkType,
    ak: &[u8; 32],
) -> Result<VaultReceivers, ReceiversError> {
    let (bytes, receivers) = derive(ufvk, network)?;
    if bytes[..32] != ak[..] {
        return Err(ReceiversError::NotThisVault);
    }
    Ok(receivers)
}

/// Exactly one Orchard key, revision 0, on this network.
fn derive(ufvk: &str, network: NetworkType) -> Result<([u8; 96], VaultReceivers), ReceiversError> {
    let (net, revision, parsed) =
        unified::Ufvk::decode(ufvk).map_err(|_| ReceiversError::DoesNotParse)?;
    if net != network {
        return Err(ReceiversError::WrongNetwork);
    }
    if revision != Revision::R0 {
        return Err(ReceiversError::NotRevision0);
    }
    let [Uitem::Data(unified::Fvk::Orchard(bytes))] = parsed.items_as_parsed() else {
        return Err(ReceiversError::NotOrchardOnly);
    };
    // `from_bytes` refuses an `ak` with an odd y or the identity, and bytes that are not a key.
    let fvk = FullViewingKey::from_bytes(bytes).ok_or(ReceiversError::BadOrchardKey)?;
    let external = fvk.address_at(0u32, Scope::External).to_raw_address_bytes();
    let internal = fvk.address_at(0u32, Scope::Internal).to_raw_address_bytes();
    Ok((
        *bytes,
        VaultReceivers {
            external,
            internal,
            external_ua: single_receiver_ua(external, network)?,
            internal_ua: single_receiver_ua(internal, network)?,
        },
    ))
}

/// True iff `ua` is exactly this one Orchard receiver, revision 0, on this network.
pub fn ua_is_exactly(ua: &str, network: NetworkType, raw: &[u8; 43]) -> bool {
    let Ok((net, revision, parsed)) = Address::decode(ua) else {
        return false;
    };
    net == network
        && revision == Revision::R0
        && matches!(
            parsed.items_as_parsed(),
            [Uitem::Data(Receiver::Orchard(only))] if only == raw
        )
}

fn single_receiver_ua(raw: [u8; 43], network: NetworkType) -> Result<String, ReceiversError> {
    Address::try_from_items(Revision::R0, vec![Uitem::Data(Receiver::Orchard(raw))])
        .map(|ua| ua.encode(&network))
        .map_err(|_| ReceiversError::BadOrchardKey)
}

#[cfg(test)]
mod tests {
    use super::*;
    use unified::{Fvk, MetadataItem, Ufvk};
    use NetworkType::{Main, Test};

    // A real pair, from `zcash-sign generate`, the same as orchestrator/src/helper.rs's tests. Not
    // produced by the function under test.
    const UFVK: &str = "uview1z2nst9y9367acqqykyws80hrc3df87ffnwvtvx3ggf3tvx342sncxxfztdgfk67a0xk4c0wptspqyc4k59ucqrtxgdka96ktjudm5gr65d8aaq6js0jpwrfryrafzu82axyezm9e6y5r96z7hk8a04zpvs5896xeze9pmpwwymh5h7xeae79wscp2c08j";
    const EXTERNAL: &str = "u1cl9hwu3v580lgfuz9z9u8wp9scpy4c2yzcre7kvghtfuyyvsan33g0fgmkyx246mtq6s5x2qzraetalqfhkmul2agejjxynqxvz5e3el";
    const INTERNAL: &str = "u1d06pafex5wdk529qnu4lnsdkukajnzncx27gn2t4a6mq7hj4tdx78xe4vl65n97hcq7n7tpu6dqz3kn49yrggdwh25ernx0sag0pvgn2";

    fn orchard() -> [u8; 96] {
        let (_, _, u) = Ufvk::decode(UFVK).unwrap();
        match u.items_as_parsed() {
            [Uitem::Data(Fvk::Orchard(b))] => *b,
            other => panic!("the vector is one Orchard key: {other:?}"),
        }
    }
    fn ufvk_of(rev: Revision, items: Vec<Uitem<Fvk>>, net: NetworkType) -> String {
        Ufvk::try_from_items(rev, items).unwrap().encode(&net)
    }
    fn data_orchard() -> Uitem<Fvk> {
        Uitem::Data(Fvk::Orchard(orchard()))
    }
    /// For the cases about the key's shape: the `ak` check is not what refuses them.
    fn of_the_vectors_key(ufvk: &str, net: NetworkType) -> Result<VaultReceivers, ReceiversError> {
        let ak: [u8; 32] = orchard()[..32].try_into().unwrap();
        vault_receivers(ufvk, net, &ak)
    }
    fn ua_of(rev: Revision, items: Vec<Uitem<Receiver>>, net: NetworkType) -> String {
        Address::try_from_items(rev, items).unwrap().encode(&net)
    }

    #[test]
    fn the_real_zcash_sign_pair_derives_its_own_external_address() {
        let r = of_the_vectors_key(UFVK, Main).unwrap();
        assert_eq!(r.external_ua, EXTERNAL);
        assert_eq!(
            r.internal_ua, INTERNAL,
            "orchestrator's change_receiver gives this string"
        );
        assert_ne!(r.internal, r.external);
        assert!(ua_is_exactly(EXTERNAL, Main, &r.external));
        assert!(ua_is_exactly(&r.internal_ua, Main, &r.internal));
    }

    #[test]
    fn the_key_of_the_vault_is_accepted_and_another_is_refused() {
        let o = orchard();
        let ak: [u8; 32] = o[..32].try_into().unwrap();
        assert!(vault_receivers(UFVK, Main, &ak).is_ok());
        let mut other = ak;
        other[0] ^= 1;
        assert_eq!(
            vault_receivers(UFVK, Main, &other),
            Err(ReceiversError::NotThisVault)
        );
    }

    #[test]
    fn it_refuses_a_ufvk_with_a_transparent_item() {
        let u = ufvk_of(
            Revision::R0,
            vec![data_orchard(), Uitem::Data(Fvk::P2pkh([3; 65]))],
            Main,
        );
        assert_eq!(
            of_the_vectors_key(&u, Main),
            Err(ReceiversError::NotOrchardOnly)
        );
    }

    #[test]
    fn it_refuses_a_ufvk_with_a_sapling_item() {
        let u = ufvk_of(
            Revision::R0,
            vec![data_orchard(), Uitem::Data(Fvk::Sapling([3; 128]))],
            Main,
        );
        assert_eq!(
            of_the_vectors_key(&u, Main),
            Err(ReceiversError::NotOrchardOnly)
        );
    }

    #[test]
    fn it_refuses_a_ufvk_with_an_unknown_item() {
        let unknown = Uitem::Data(Fvk::Unknown {
            typecode: 0x7f,
            data: vec![1; 32],
        });
        let u = ufvk_of(Revision::R0, vec![data_orchard(), unknown], Main);
        assert_eq!(
            of_the_vectors_key(&u, Main),
            Err(ReceiversError::NotOrchardOnly)
        );
    }

    /// The one `items()` would let through: it filters metadata, so it still sees one key.
    #[test]
    fn it_refuses_revision_0_with_a_metadata_item_only_the_parsed_list_shows() {
        let meta = Uitem::Metadata(MetadataItem::Unknown {
            typecode: 0xC0,
            data: vec![1],
        });
        let u = ufvk_of(Revision::R0, vec![data_orchard(), meta], Main);
        let (_, _, parsed) = Ufvk::decode(&u).unwrap();
        assert_eq!(
            parsed.items().len(),
            1,
            "what makes this case the dangerous one"
        );
        assert_eq!(
            of_the_vectors_key(&u, Main),
            Err(ReceiversError::NotOrchardOnly)
        );
    }

    /// Metadata the library defines cannot be in revision 0 at all: it never reaches our check. If
    /// a library bump lets it through, this fails and the case above must cover it.
    #[test]
    fn the_library_refuses_a_defined_metadata_item_in_revision_0() {
        let expiry = Uitem::Metadata(MetadataItem::ExpiryHeight(3_600_000));
        assert!(Ufvk::try_from_items(Revision::R0, vec![data_orchard(), expiry]).is_err());
    }

    #[test]
    fn it_refuses_revision_2_plain_and_with_an_expiry() {
        let plain = ufvk_of(Revision::R2, vec![data_orchard()], Main);
        assert_eq!(
            of_the_vectors_key(&plain, Main),
            Err(ReceiversError::NotRevision0)
        );
        let expiry = Uitem::Metadata(MetadataItem::ExpiryHeight(3_600_000));
        let with = ufvk_of(Revision::R2, vec![data_orchard(), expiry], Main);
        assert_eq!(
            of_the_vectors_key(&with, Main),
            Err(ReceiversError::NotRevision0)
        );
    }

    #[test]
    fn it_refuses_the_wrong_network_and_what_does_not_parse() {
        let test = ufvk_of(Revision::R0, vec![data_orchard()], Test);
        assert_eq!(
            of_the_vectors_key(&test, Main),
            Err(ReceiversError::WrongNetwork)
        );
        assert_eq!(
            of_the_vectors_key(UFVK, Test),
            Err(ReceiversError::WrongNetwork)
        );
        assert_eq!(
            of_the_vectors_key("uview1x2w3", Main),
            Err(ReceiversError::DoesNotParse)
        );
        assert_eq!(
            of_the_vectors_key("", Main),
            Err(ReceiversError::DoesNotParse)
        );
    }

    /// Each of these carries the `ak` it is checked against, so only the key's own parse can refuse.
    #[test]
    fn it_refuses_orchard_bytes_that_are_not_a_key() {
        let good = orchard();
        let mut odd_ak = good;
        odd_ak[31] |= 0x80;
        let mut identity_ak = good;
        identity_ak[..32].fill(0);
        let mut bad_nk = good;
        bad_nk[32..64].fill(0xff);
        let mut bad_rivk = good;
        bad_rivk[64..].fill(0xff);
        for key in [odd_ak, identity_ak, bad_nk, bad_rivk] {
            let u = ufvk_of(Revision::R0, vec![Uitem::Data(Fvk::Orchard(key))], Main);
            let ak: [u8; 32] = key[..32].try_into().unwrap();
            assert_eq!(
                vault_receivers(&u, Main, &ak),
                Err(ReceiversError::BadOrchardKey)
            );
        }
    }

    #[test]
    fn the_ak_is_compared_whole_and_the_network_comes_from_the_caller() {
        let ak: [u8; 32] = orchard()[..32].try_into().unwrap();
        for index in [0, 15, 31] {
            let mut other = ak;
            other[index] ^= 1;
            assert_eq!(
                vault_receivers(UFVK, Main, &other),
                Err(ReceiversError::NotThisVault)
            );
        }
        let test = ufvk_of(Revision::R0, vec![data_orchard()], Test);
        let r = vault_receivers(&test, Test, &ak).unwrap();
        assert!(r.external_ua.starts_with("utest1"), "{}", r.external_ua);
        assert!(r.internal_ua.starts_with("utest1"), "{}", r.internal_ua);
        assert!(ua_is_exactly(&r.external_ua, Test, &r.external));
        assert!(!ua_is_exactly(&r.external_ua, Main, &r.external));
    }

    #[test]
    fn ua_is_exactly_compares_the_whole_receiver() {
        let raw = of_the_vectors_key(UFVK, Main).unwrap().external;
        for index in [0, 21, 42] {
            let mut other = raw;
            other[index] ^= 1;
            assert!(!ua_is_exactly(EXTERNAL, Main, &other), "byte {index}");
        }
    }

    #[test]
    fn ua_is_exactly_refuses_anything_but_the_one_receiver() {
        let raw = of_the_vectors_key(UFVK, Main).unwrap().external;
        let mine = || Uitem::Data(Receiver::Orchard(raw));
        assert!(ua_is_exactly(
            &ua_of(Revision::R0, vec![mine()], Main),
            Main,
            &raw
        ));

        let with_transparent = ua_of(
            Revision::R0,
            vec![mine(), Uitem::Data(Receiver::P2pkh([1; 20]))],
            Main,
        );
        assert!(!ua_is_exactly(&with_transparent, Main, &raw));
        let with_meta = ua_of(
            Revision::R0,
            vec![
                mine(),
                Uitem::Metadata(MetadataItem::Unknown {
                    typecode: 0xC0,
                    data: vec![1],
                }),
            ],
            Main,
        );
        assert!(!ua_is_exactly(&with_meta, Main, &raw));
        assert!(!ua_is_exactly(
            &ua_of(Revision::R2, vec![mine()], Main),
            Main,
            &raw
        ));
        assert!(!ua_is_exactly(
            &ua_of(Revision::R0, vec![mine()], Test),
            Main,
            &raw
        ));
        let other = [7u8; 43];
        assert!(!ua_is_exactly(EXTERNAL, Main, &other));
        assert!(!ua_is_exactly("", Main, &raw));
    }
}

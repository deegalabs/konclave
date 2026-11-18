//! Setup-side check for the Node export drill. The private registration arrives on stdin.
//! Only the two public receivers go back through the pipe, for the device fingerprint.
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use konclave_seal::{hex::decode_exact, receivers::vault_receivers};
use orchestrator::helper::{read_wallet_birthday, VaultRegistration};
use zcash_protocol::consensus::NetworkType;

fn receivers(reg: &VaultRegistration, wallet_floor: Option<u64>) -> Option<serde_json::Value> {
    if Some(reg.birthday?) != wallet_floor {
        return None;
    }
    let ak = decode_exact(&reg.vault_id)?;
    let r = vault_receivers(&reg.ufvk, NetworkType::Test, &ak).ok()?;
    if r.external_ua != reg.address || r.internal_ua != reg.change_receiver {
        return None;
    }
    Some(serde_json::json!([
        r.external.as_slice(),
        r.internal.as_slice()
    ]))
}

fn checked() -> Option<serde_json::Value> {
    let wallet = PathBuf::from(std::env::args_os().nth(1)?);
    let reg: VaultRegistration = serde_json::from_reader(io::stdin().lock()).ok()?;
    if wallet != Path::new(&reg.wallet_dir) {
        return None;
    }
    receivers(&reg, read_wallet_birthday(&wallet))
}

fn main() -> ExitCode {
    if !io::stdin().is_terminal() && !io::stdout().is_terminal() {
        if let Some(public) = checked() {
            println!("{public}");
            return ExitCode::SUCCESS;
        }
    }
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::keys::{FullViewingKey, SpendingKey};
    use zcash_address::unified::{Encoding, Fvk, Revision, Ufvk, Uitem};

    // One fresh Orchard key exercises the native adapter alone. Nothing here makes an export.
    #[test]
    fn binds_both_receivers_to_the_testnet_key_group_and_wallet_floor() {
        let sk = loop {
            if let Some(key) = Option::<SpendingKey>::from(SpendingKey::from_bytes(rand::random()))
            {
                break key;
            }
        };
        let fvk = FullViewingKey::from(&sk).to_bytes();
        let ak = fvk[..32].try_into().unwrap();
        let key = Ufvk::try_from_items(Revision::R0, vec![Uitem::Data(Fvk::Orchard(fvk))]).unwrap();
        let test = key.encode(&NetworkType::Test);
        let pair = vault_receivers(&test, NetworkType::Test, &ak).unwrap();
        let mut reg: VaultRegistration = serde_json::from_value(serde_json::json!({
            "vault_id": ak.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "ufvk": test, "address": pair.external_ua, "change_receiver": pair.internal_ua,
            "birthday": 23, "wallet_dir": "", "account": "",
        }))
        .unwrap();
        assert!(receivers(&reg, Some(23)).is_some());
        assert!(receivers(&reg, Some(24)).is_none());
        assert!(receivers(&reg, None).is_none());
        reg.birthday = None;
        assert!(receivers(&reg, None).is_none());
        reg.birthday = Some(23);
        std::mem::swap(&mut reg.address, &mut reg.change_receiver);
        assert!(receivers(&reg, Some(23)).is_none());
        std::mem::swap(&mut reg.address, &mut reg.change_receiver);
        reg.ufvk = key.encode(&NetworkType::Main);
        assert!(receivers(&reg, Some(23)).is_none());
        reg.ufvk = test;
        reg.vault_id = "00".repeat(32);
        assert!(receivers(&reg, Some(23)).is_none());
    }
}

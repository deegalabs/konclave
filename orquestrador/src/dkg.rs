//! DKG vault creation (5-F): create a vault by **Distributed Key Generation** through the
//! app — the key is NEVER reconstituted; each participant computes only its own share via
//! `frostd`. Mirrors the proven Phase-2 recipe (docs/VERTICAL_SLICE.md).
//!
//! Single-device demo: all participants run here as threads; the product runs one per
//! device. The new shares are sealed at rest (5-E); no cleartext share is left on disk.

use std::collections::BTreeMap;
use std::thread;
use std::time::Duration;

use crate::ceremony::Frostd;
use crate::secrets;
use crate::send::SendConfig;
use crate::tools::{run, run_text_all, ToolError};

/// The result of creating a DKG vault (public material + sealed config paths).
#[derive(Debug, Clone)]
pub struct DkgVault {
    pub group_pubkey: String,
    pub orchard_address: String,
    pub ufvk: String,
    pub wallet_dir: String,
    /// (name, comm pubkey, sealed config path) per member.
    pub members: Vec<(String, String, String)>,
    /// The vault passphrase ("palavra do cofre"), generated here and shown ONCE. The
    /// shares are sealed under a key derived from it — without it they do not open.
    pub passphrase: String,
    /// KDF salt for the passphrase (persist with the vault; not a secret).
    pub salt: Vec<u8>,
    /// Sealed verifier to check the passphrase on unlock (persist with the vault).
    pub verifier: Vec<u8>,
}

fn err(what: &str, detail: impl Into<String>) -> ToolError {
    ToolError::parse(what, detail.into())
}

/// Create a `threshold`-of-`members.len()` vault by DKG.
pub fn create_vault_dkg(
    sc: &SendConfig,
    name: &str,
    threshold: u16,
    member_names: &[String],
) -> Result<DkgVault, ToolError> {
    let zcash_sign = sc
        .zcash_sign
        .as_ref()
        .ok_or_else(|| err("dkg", "zcash_sign não configurado"))?;
    let vaults_dir = sc
        .vaults_dir
        .as_ref()
        .ok_or_else(|| err("dkg", "vaults_dir não configurado"))?;
    let n = member_names.len();
    if n < 2 || threshold < 1 || threshold as usize > n {
        return Err(err("dkg", format!("quórum inválido {threshold}-de-{n}")));
    }

    // Fresh vault dir + one config per member.
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let vdir = format!("{vaults_dir}/{slug}-{}", short_id());
    std::fs::create_dir_all(&vdir).map_err(ToolError::Io)?;
    let configs: Vec<String> = (0..n).map(|i| format!("{vdir}/m{i}.toml")).collect();

    // 1) init each participant's config (comm keypair).
    for cfg in &configs {
        run(&sc.frost_client, &["init", "-c", cfg.as_str()], None)?;
    }

    // 2) export each contact.
    let mut contacts = Vec::with_capacity(n);
    for (nm, cfg) in member_names.iter().zip(&configs) {
        let out = run_text_all(
            &sc.frost_client,
            &["export", "-c", cfg.as_str(), "--name", nm.as_str()],
            None,
        )?;
        contacts.push(parse_contact(&out)?);
    }

    // 3) everyone imports everyone else's contact.
    for (i, cfg) in configs.iter().enumerate() {
        for (j, contact) in contacts.iter().enumerate() {
            if i != j {
                run(
                    &sc.frost_client,
                    &["import", "-c", cfg.as_str(), contact.as_str()],
                    None,
                )?;
            }
        }
    }

    // Name -> pubkey from two address books (covers every member).
    let mut pubkeys: BTreeMap<String, String> = BTreeMap::new();
    for cfg in [&configs[0], &configs[1]] {
        let out = run_text_all(&sc.frost_client, &["contacts", "-c", cfg.as_str()], None)?;
        for (nm, pk) in parse_contacts(&out) {
            pubkeys.entry(nm).or_insert(pk);
        }
    }
    let pk_of = |nm: &str| -> Result<String, ToolError> {
        pubkeys
            .get(nm)
            .cloned()
            .ok_or_else(|| err("dkg", format!("pubkey de {nm} não encontrada")))
    };

    // -S for the creator: the OTHER members' pubkeys.
    let other_pks: Vec<String> = member_names[1..]
        .iter()
        .map(|nm| pk_of(nm))
        .collect::<Result<_, _>>()?;
    let s_list = other_pks.join(",");

    // 4) frostd fresh (killed on drop).
    let _frostd = Frostd::start(
        &sc.frostd,
        &sc.frostd_cert,
        &sc.frostd_key,
        &sc.frostd_ip,
        sc.frostd_port,
    )?;
    thread::sleep(Duration::from_millis(900));

    // 5) DKG: creator (with -S) + joiners, concurrent.
    let desc = format!("Konclave — {name}");
    run_dkg_all(sc, &configs, &desc, &threshold.to_string(), &s_list)?;

    // 6) group pubkey.
    let group_pubkey = parse_group_pubkey(&run_text_all(
        &sc.frost_client,
        &["groups", "-c", configs[0].as_str()],
        None,
    )?)?;

    // 7) Orchard address + UFVK.
    let gen = run_text_all(
        zcash_sign,
        &[
            "generate",
            "--ak",
            group_pubkey.as_str(),
            "--network",
            "main",
        ],
        None,
    )?;
    let (orchard_address, ufvk) = parse_generate(&gen)?;

    // 8) view-only wallet.
    let wallet_dir = format!("{vdir}/wallet");
    run(
        &sc.devtool,
        &[
            "wallet",
            "-w",
            wallet_dir.as_str(),
            "init-fvk",
            "--name",
            name,
            "--fvk",
            ufvk.as_str(),
            "-s",
            sc.lightwalletd.as_str(),
            "--connection",
            "direct",
        ],
        None,
    )?;

    // 9) generate the vault passphrase, derive the sealing key from it, seal each config
    //    under it (5-E + "palavra do cofre"), remove plaintext. Without the word, the
    //    sealed shares do not open — no sealing key sits on disk.
    let passphrase = secrets::generate_passphrase().map_err(|e| err("secrets", e.to_string()))?;
    let salt = secrets::generate_salt().map_err(|e| err("secrets", e.to_string()))?;
    let key = secrets::derive_key(&passphrase, &salt).map_err(|e| err("secrets", e.to_string()))?;
    let verifier = secrets::make_verifier(&key).map_err(|e| err("secrets", e.to_string()))?;
    let mut members = Vec::with_capacity(n);
    for (nm, cfg) in member_names.iter().zip(&configs) {
        let plaintext = std::fs::read(cfg).map_err(ToolError::Io)?;
        let blob = secrets::seal(&plaintext, &key).map_err(|e| err("secrets", e.to_string()))?;
        let sealed = format!("{cfg}.sealed");
        std::fs::write(&sealed, &blob).map_err(ToolError::Io)?;
        let _ = std::fs::remove_file(cfg);
        members.push((nm.clone(), pk_of(nm)?, sealed));
    }

    Ok(DkgVault {
        group_pubkey,
        orchard_address,
        ufvk,
        wallet_dir,
        members,
        passphrase,
        salt: salt.to_vec(),
        verifier,
    })
}

/// Run the DKG for all participants concurrently (RedPallas / Rerandomized FROST). The
/// creator passes the other participants via `-S`; joiners omit it. Prompts auto-confirmed.
fn run_dkg_all(
    sc: &SendConfig,
    configs: &[String],
    desc: &str,
    threshold: &str,
    s_list: &str,
) -> Result<(), ToolError> {
    let confirm = b"y\ny\ny\ny\n".as_slice();

    // Creator (config[0]) with -S.
    let creator = {
        let (fc, cfg, server) = (
            sc.frost_client.clone(),
            configs[0].clone(),
            sc.server_url.clone(),
        );
        let (desc, t, s) = (desc.to_string(), threshold.to_string(), s_list.to_string());
        thread::spawn(move || {
            run(
                &fc,
                &[
                    "dkg",
                    "-c",
                    cfg.as_str(),
                    "-C",
                    "redpallas",
                    "-t",
                    t.as_str(),
                    "-d",
                    desc.as_str(),
                    "-s",
                    server.as_str(),
                    "-S",
                    s.as_str(),
                ],
                Some(confirm),
            )
        })
    };
    thread::sleep(Duration::from_millis(500));

    // Joiners.
    let mut joiners = Vec::new();
    for cfg in &configs[1..] {
        let (fc, cfg, server) = (sc.frost_client.clone(), cfg.clone(), sc.server_url.clone());
        let (desc, t) = (desc.to_string(), threshold.to_string());
        joiners.push(thread::spawn(move || {
            run(
                &fc,
                &[
                    "dkg",
                    "-c",
                    cfg.as_str(),
                    "-C",
                    "redpallas",
                    "-t",
                    t.as_str(),
                    "-d",
                    desc.as_str(),
                    "-s",
                    server.as_str(),
                ],
                Some(confirm),
            )
        }));
    }
    for j in joiners {
        j.join()
            .map_err(|_| err("dkg", "joiner thread panicked"))??;
    }
    creator
        .join()
        .map_err(|_| err("dkg", "creator thread panicked"))??;
    Ok(())
}

// ---- parsers (unit-tested against real tool output) ----

fn parse_contact(out: &str) -> Result<String, ToolError> {
    out.split_whitespace()
        .find(|t| t.starts_with("zffrost1"))
        .map(str::to_string)
        .ok_or_else(|| err("dkg", "contato exportado sem string zffrost1"))
}

fn parse_contacts(out: &str) -> Vec<(String, String)> {
    let mut res = Vec::new();
    let mut name: Option<String> = None;
    for line in out.lines() {
        let l = line.trim();
        if let Some(n) = l.strip_prefix("Name:") {
            name = Some(n.trim().to_string());
        } else if let Some(pk) = l.strip_prefix("Public Key:") {
            if let Some(nm) = name.take() {
                res.push((nm, pk.trim().to_string()));
            }
        }
    }
    res
}

fn parse_group_pubkey(out: &str) -> Result<String, ToolError> {
    out.lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix("Public key ")
                .map(|s| s.trim().to_string())
        })
        .ok_or_else(|| err("dkg", "saída de groups sem 'Public key'"))
}

fn parse_generate(out: &str) -> Result<(String, String), ToolError> {
    let addr = extract_quoted(out, "unified address:")?;
    let ufvk = extract_quoted(out, "Viewing Key:")?;
    Ok((addr, ufvk))
}

fn extract_quoted(out: &str, after: &str) -> Result<String, ToolError> {
    for line in out.lines() {
        if let Some(idx) = line.find(after) {
            let rest = &line[idx + after.len()..];
            if let (Some(a), Some(b)) = (rest.find('"'), rest.rfind('"')) {
                if b > a {
                    return Ok(rest[a + 1..b].to_string());
                }
            }
        }
    }
    Err(err(
        "dkg",
        format!("não achei valor entre aspas após '{after}'"),
    ))
}

fn short_id() -> String {
    let mut b = [0u8; 4];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_group_pubkey() {
        let out = "Group \"Konclave DKG vault\"\nPublic key 0ab93649e62dd68858ed57af1e7f7743cc2a4912110d7fb547d35c8c8494ee34\nThreshold: 2\n";
        assert_eq!(
            parse_group_pubkey(out).unwrap(),
            "0ab93649e62dd68858ed57af1e7f7743cc2a4912110d7fb547d35c8c8494ee34"
        );
    }

    #[test]
    fn parses_generate_address_and_ufvk() {
        let out = "Orchard-only unified address: \"u14g48z7mn\"\nUnified Full Viewing Key: \"uview1x2w3\"\n";
        let (a, u) = parse_generate(out).unwrap();
        assert_eq!(a, "u14g48z7mn");
        assert_eq!(u, "uview1x2w3");
    }

    #[test]
    fn parses_contacts_names_and_pubkeys() {
        let out = "Name: bob\nPublic Key: f647b57b\nzffrost1qqp\n\nName: carol\nPublic Key: c85e8ebd\nzffrost1qqz\n";
        let cs = parse_contacts(out);
        assert_eq!(
            cs,
            vec![
                ("bob".into(), "f647b57b".into()),
                ("carol".into(), "c85e8ebd".into())
            ]
        );
    }

    #[test]
    fn parses_contact_string() {
        let out = "Your contact: zffrost1qqpkymmzy\n";
        assert_eq!(parse_contact(out).unwrap(), "zffrost1qqpkymmzy");
    }
}

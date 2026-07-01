//! `konclave` — the local bridge binary (ADR-0004).
//!
//! `konclave serve` binds **127.0.0.1** and serves the Rosto bundle + JSON API from the
//! tested Orquestrador core. This is a local daemon, not a network service.

use std::path::PathBuf;
use std::process::ExitCode;

use orquestrador::send::{orchestrate_send, SendConfig, SpendPlan};
use orquestrador::server::{self, Config, LiveWallet};
use orquestrador::store::Store;

const DEFAULT_PORT: u16 = 4762;
const DEFAULT_WEB: &str = "rosto/dist";
const DEFAULT_DB: &str = "konclave.db";

/// `konclave seal --in <file> --out <file.sealed> --key <keyfile>` — seal a secret file
/// (e.g. a frost-client config holding a share) at rest with XChaCha20-Poly1305. Creates
/// the 32-byte key (0600) on first use. The ceremony unseals it to an ephemeral file.
fn run_seal(args: &[String]) -> Result<(), String> {
    let mut input: Option<String> = None;
    let mut output: Option<String> = None;
    let mut key_file: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut next = || it.next().ok_or_else(|| format!("faltou valor para {a}"));
        match a.as_str() {
            "--in" => input = Some(next()?.clone()),
            "--out" => output = Some(next()?.clone()),
            "--key" => key_file = Some(next()?.clone()),
            other => return Err(format!("opção desconhecida: {other}")),
        }
    }
    let input = input.ok_or("--in <arquivo> é obrigatório")?;
    let output = output.ok_or("--out <arquivo.sealed> é obrigatório")?;
    let key_file = key_file.ok_or("--key <arquivo-chave> é obrigatório")?;

    let key: [u8; 32] = if std::path::Path::new(&key_file).exists() {
        let b = std::fs::read(&key_file).map_err(|e| format!("lendo chave: {e}"))?;
        if b.len() != 32 {
            return Err(format!("chave deve ter 32 bytes, tem {}", b.len()));
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&b);
        k
    } else {
        let k = orquestrador::secrets::generate_key().map_err(|e| format!("gerar chave: {e}"))?;
        write_private_key(&key_file, &k)?;
        eprintln!("chave de selagem criada em {key_file} (0600)");
        k
    };

    let plaintext = std::fs::read(&input).map_err(|e| format!("lendo {input}: {e}"))?;
    let sealed = orquestrador::secrets::seal(&plaintext, &key).map_err(|e| format!("selar: {e}"))?;
    std::fs::write(&output, &sealed).map_err(|e| format!("escrevendo {output}: {e}"))?;
    println!("selado {input} -> {output} ({} bytes)", sealed.len());
    Ok(())
}

fn write_private_key(path: &str, key: &[u8; 32]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("criar arquivo de chave: {e}"))?;
        f.write_all(key).map_err(|e| format!("escrever chave: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, key).map_err(|e| format!("escrever chave: {e}"))?;
    }
    Ok(())
}

/// `konclave create-vault --ceremony <json> --name <name> --threshold <t> --members a,b,c`
/// — create a vault by DKG (test harness; the same orchestration backs the HTTP endpoint).
fn run_create_vault(args: &[String]) -> Result<(), String> {
    let mut ceremony: Option<PathBuf> = None;
    let mut name: Option<String> = None;
    let mut threshold: Option<u16> = None;
    let mut members: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut next = || it.next().ok_or_else(|| format!("faltou valor para {a}"));
        match a.as_str() {
            "--ceremony" => ceremony = Some(PathBuf::from(next()?)),
            "--name" => name = Some(next()?.clone()),
            "--threshold" => threshold = Some(next()?.parse().map_err(|_| "threshold inválido".to_string())?),
            "--members" => members = next()?.split(',').map(|s| s.trim().to_string()).collect(),
            other => return Err(format!("opção desconhecida: {other}")),
        }
    }
    let ceremony = ceremony.ok_or("--ceremony <json> é obrigatório")?;
    let name = name.ok_or("--name é obrigatório")?;
    let threshold = threshold.ok_or("--threshold é obrigatório")?;
    if members.len() < 2 {
        return Err("--members precisa de ao menos 2 nomes (ex.: Alice,Bob,Carol)".into());
    }

    let text = std::fs::read_to_string(&ceremony).map_err(|e| format!("lendo {}: {e}", ceremony.display()))?;
    let sc: SendConfig = serde_json::from_str(&text).map_err(|e| format!("config inválida: {e}"))?;

    eprintln!("DKG: criando cofre '{name}' {threshold}-de-{} ({})", members.len(), members.join(","));
    let v = orquestrador::dkg::create_vault_dkg(&sc, &name, threshold, &members)
        .map_err(|e| format!("DKG: {e}"))?;

    println!("GROUP {}", v.group_pubkey);
    println!("ADDRESS {}", v.orchard_address);
    println!("WALLET {}", v.wallet_dir);
    for (nm, pk, cfg) in &v.members {
        println!("MEMBER {nm} {pk} {cfg}");
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => match run_serve(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("erro: {e}");
                ExitCode::from(1)
            }
        },
        Some("sign-send") => match run_sign_send(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("erro: {e}");
                ExitCode::from(1)
            }
        },
        Some("seal") => match run_seal(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("erro: {e}");
                ExitCode::from(1)
            }
        },
        Some("create-vault") => match run_create_vault(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("erro: {e}");
                ExitCode::from(1)
            }
        },
        Some("-h") | Some("--help") | None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("comando desconhecido: {other}\n");
            print_usage();
            ExitCode::from(2)
        }
    }
}

fn print_usage() {
    eprintln!(
        "konclave — ponte local do Konclave\n\
         \n\
         USO:\n\
         \x20 konclave serve [OPÇÕES]\n\
         \n\
         OPÇÕES de `serve`:\n\
         \x20 --port <N>        porta em 127.0.0.1 (padrão {DEFAULT_PORT})\n\
         \x20 --web <DIR>       bundle do Rosto (padrão {DEFAULT_WEB})\n\
         \x20 --db <PATH>       banco local SQLite (padrão {DEFAULT_DB})\n\
         \x20 --demo            semear cofre + propostas de exemplo se o banco estiver vazio\n\
         \x20 --devtool <PATH>  binário zcash-devtool (habilita /api/balance ao vivo)\n\
         \x20 --wallet <DIR>    diretório da carteira do zcash-devtool\n\
         \x20 --server <URI>    servidor lightwalletd (ex.: https://zec.rocks:443)\n\
         \x20 --ceremony <JSON> config da cerimônia FROST (habilita o envio real)\n"
    );
}

fn run_serve(args: &[String]) -> Result<(), String> {
    let mut port = DEFAULT_PORT;
    let mut web = PathBuf::from(DEFAULT_WEB);
    let mut db = DEFAULT_DB.to_string();
    let mut demo = false;
    let mut devtool: Option<PathBuf> = None;
    let mut wallet_dir: Option<String> = None;
    let mut server_uri: Option<String> = None;
    let mut ceremony_path: Option<PathBuf> = None;

    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut next = || it.next().ok_or_else(|| format!("faltou valor para {a}"));
        match a.as_str() {
            "--port" => port = next()?.parse().map_err(|_| "porta inválida".to_string())?,
            "--web" => web = PathBuf::from(next()?),
            "--db" => db = next()?.clone(),
            "--demo" => demo = true,
            "--devtool" => devtool = Some(PathBuf::from(next()?)),
            "--wallet" => wallet_dir = Some(next()?.clone()),
            "--server" => server_uri = Some(next()?.clone()),
            "--ceremony" => ceremony_path = Some(PathBuf::from(next()?)),
            other => return Err(format!("opção desconhecida: {other}")),
        }
    }

    if demo {
        let mut store = Store::open(&db).map_err(|e| format!("abrir banco: {e}"))?;
        server::seed_demo(&mut store).map_err(|e| format!("semear demo: {e}"))?;
        eprintln!("demo: cofre e propostas de exemplo prontos em {db}");
    }

    // Live balance is only available when all three wallet inputs are present.
    let wallet = match (devtool, wallet_dir, server_uri) {
        (Some(devtool), Some(wallet_dir), Some(server)) => {
            eprintln!("carteira ao vivo: {} @ {server}", wallet_dir);
            Some(Box::new(LiveWallet { devtool, wallet_dir, server }) as Box<_>)
        }
        (None, None, None) => None,
        _ => {
            return Err(
                "para /api/balance ao vivo, forneça os três: --devtool, --wallet e --server".into(),
            )
        }
    };

    let ceremony = match ceremony_path {
        Some(p) => {
            let text = std::fs::read_to_string(&p)
                .map_err(|e| format!("lendo cerimônia {}: {e}", p.display()))?;
            let sc: SendConfig = serde_json::from_str(&text)
                .map_err(|e| format!("config de cerimônia inválida: {e}"))?;
            eprintln!("envio ao vivo habilitado (cerimônia FROST): grupo {}", sc.group);
            Some(sc)
        }
        None => None,
    };

    let cfg = Config { web_dir: web, db_path: db, wallet, ceremony };
    server::serve(cfg, port).map_err(|e| format!("servidor: {e}"))
}

/// `konclave sign-send --ceremony <json> --to <addr> --value-zat <n> [--memo <m>] [--dry-run]`
/// — drive the full FROST ceremony + (optionally) broadcast. Test harness for step 2c;
/// the same orchestration backs the HTTP send endpoint.
fn run_sign_send(args: &[String]) -> Result<(), String> {
    let mut ceremony: Option<PathBuf> = None;
    let mut to: Option<String> = None;
    let mut value_zat: Option<u64> = None;
    let mut memo: Option<String> = None;
    let mut dry_run = false;

    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut next = || it.next().ok_or_else(|| format!("faltou valor para {a}"));
        match a.as_str() {
            "--ceremony" => ceremony = Some(PathBuf::from(next()?)),
            "--to" => to = Some(next()?.clone()),
            "--value-zat" => {
                value_zat = Some(next()?.parse().map_err(|_| "value-zat inválido".to_string())?)
            }
            "--memo" => memo = Some(next()?.clone()),
            "--dry-run" => dry_run = true,
            other => return Err(format!("opção desconhecida: {other}")),
        }
    }

    let ceremony = ceremony.ok_or("--ceremony <json> é obrigatório")?;
    let to = to.ok_or("--to <endereço> é obrigatório")?;
    let value_zat = value_zat.ok_or("--value-zat <zatoshis> é obrigatório")?;

    let text = std::fs::read_to_string(&ceremony)
        .map_err(|e| format!("lendo {}: {e}", ceremony.display()))?;
    let sc: SendConfig =
        serde_json::from_str(&text).map_err(|e| format!("config de cerimônia inválida: {e}"))?;

    if dry_run {
        eprintln!("== DRY-RUN: assina mas NÃO transmite (nenhum fundo se move) ==");
    } else {
        eprintln!("== ENVIO REAL: vai transmitir à mainnet ==");
    }
    eprintln!("destino {to} · valor {value_zat} zat");

    let plan = SpendPlan::Payment { to: to.clone(), value_zat, memo: memo.clone() };
    // Harness: the first `threshold` members act as the approvers.
    let approvers: Vec<String> = sc.members.iter().take(sc.threshold).map(|m| m.name.clone()).collect();
    let outcome = orchestrate_send(&sc, &plan, &approvers, dry_run)
        .map_err(|e| format!("cerimônia/envio: {e}"))?;

    eprintln!("sighash assinado: {}", outcome.sighash);
    eprintln!("PCZT assinado: {}", outcome.signed_pczt);
    match outcome.txid {
        Some(txid) => println!("TXID {txid}"),
        None => println!("DRY-RUN OK (PCZT assinado, sem broadcast)"),
    }
    Ok(())
}

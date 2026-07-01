//! `konclave` — the local bridge binary (ADR-0004).
//!
//! `konclave serve` binds **127.0.0.1** and serves the Rosto bundle + JSON API from the
//! tested Orquestrador core. This is a local daemon, not a network service.

use std::path::PathBuf;
use std::process::ExitCode;

use orquestrador::send::{orchestrate_send, SendConfig};
use orquestrador::server::{self, Config, LiveWallet};
use orquestrador::store::Store;

const DEFAULT_PORT: u16 = 4762;
const DEFAULT_WEB: &str = "rosto/dist";
const DEFAULT_DB: &str = "konclave.db";

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

    let outcome = orchestrate_send(&sc, &to, value_zat, memo.as_deref(), dry_run)
        .map_err(|e| format!("cerimônia/envio: {e}"))?;

    eprintln!("sighash assinado: {}", outcome.sighash);
    eprintln!("PCZT assinado: {}", outcome.signed_pczt);
    match outcome.txid {
        Some(txid) => println!("TXID {txid}"),
        None => println!("DRY-RUN OK (PCZT assinado, sem broadcast)"),
    }
    Ok(())
}

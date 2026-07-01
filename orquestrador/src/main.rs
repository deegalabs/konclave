//! `konclave` — the local bridge binary (ADR-0004).
//!
//! `konclave serve` binds **127.0.0.1** and serves the Rosto bundle + JSON API from the
//! tested Orquestrador core. This is a local daemon, not a network service.

use std::path::PathBuf;
use std::process::ExitCode;

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
         \x20 --server <URI>    servidor lightwalletd (ex.: https://zec.rocks:443)\n"
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

    let cfg = Config { web_dir: web, db_path: db, wallet };
    server::serve(cfg, port).map_err(|e| format!("servidor: {e}"))
}

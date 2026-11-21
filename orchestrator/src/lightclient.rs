//! Every call that reaches a light-client server goes through here: the arguments that name the
//! server, and how long the call may take before it is stopped.
//!
//! `zcash-devtool` in `--connection direct` mode has no timeout of its own, so a server that accepts
//! the connection and never answers holds the calling worker, and the vault's lock with it, for as
//! long as it hangs. A call made with [`run`] is stopped at its deadline instead, and the caller gets
//! an error it already handles. A source scan (`every_server_call_is_made_here`) keeps it the only
//! place that names a server.

use std::path::Path;
use std::time::Duration;

use crate::tools::ToolError;

/// How long a broadcast may take. A broadcast that is stopped may still have reached the network:
/// the send's attempt record stays, as it does for any broadcast error (`send_record`), so nothing
/// signs again on the strength of a timeout.
pub const BROADCAST_WITHIN: Duration = Duration::from_secs(120);

/// How long a short call to a server may take: registering a viewing key (`init-fvk`), reading the
/// chain's tip (`get-info`).
pub const CALL_WITHIN: Duration = Duration::from_secs(120);

/// The kind of call, which decides its deadline.
#[derive(Debug, Clone, Copy)]
pub enum Call {
    Broadcast,
    Short,
    /// A wallet sync, with the deadline the wallet module gives it (its `SYNC_WITHIN`).
    Sync(Duration),
}

#[cfg(test)]
thread_local! {
    static WITHIN_FOR_TEST: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

/// Test only: this thread's deadline for every call made here. Thread-local, so a test that shortens
/// it cannot shorten another test's.
#[cfg(test)]
pub(crate) fn set_within_for_test(within: Option<Duration>) {
    WITHIN_FOR_TEST.with(|c| c.set(within));
}

fn within(call: Call) -> Duration {
    #[cfg(test)]
    if let Some(d) = WITHIN_FOR_TEST.with(|c| c.get()) {
        return d;
    }
    match call {
        Call::Broadcast => BROADCAST_WITHIN,
        Call::Short => CALL_WITHIN,
        Call::Sync(d) => d,
    }
}

/// Run `devtool` with `args` followed by the arguments that name `server`, stopped at the deadline
/// of `call`.
pub fn run(
    devtool: &Path,
    args: &[&str],
    server: &str,
    stdin: Option<&[u8]>,
    call: Call,
) -> Result<Vec<u8>, ToolError> {
    let mut all: Vec<&str> = args.to_vec();
    all.extend_from_slice(&["-s", server, "--connection", "direct"]);
    crate::tools::run_within(devtool, &all, stdin, within(call))
}

/// The same, with stdout decoded as UTF-8.
pub fn run_text(
    devtool: &Path,
    args: &[&str],
    server: &str,
    stdin: Option<&[u8]>,
    call: Call,
) -> Result<String, ToolError> {
    let out = run(devtool, args, server, stdin, call)?;
    String::from_utf8(out).map_err(|e| ToolError::parse("utf-8 output", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No call names a server anywhere else: a call that does is a call with no deadline. Reads the
    /// production code (top-level test modules skipped, as `the_wallet_is_synced_and_stamped_in_one_place`
    /// reads it) of every crate that could call the engine, recursively; each root must hold sources,
    /// so a vanished root does not pass by being empty. The needle is a quote followed by the flag, so
    /// `"--connection=direct"` is caught as well, and it is assembled from parts so this file's own
    /// test does not match it.
    #[test]
    fn every_server_call_is_made_here() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        fn production(src: &str) -> String {
            let mut code = Vec::new();
            let mut lines = src.lines().peekable();
            while let Some(line) = lines.next() {
                if line == "#[cfg(test)]" && lines.peek().is_some_and(|n| n.starts_with("mod ")) {
                    for skipped in lines.by_ref() {
                        if skipped == "}" {
                            break;
                        }
                    }
                    continue;
                }
                code.push(line);
            }
            code.join("\n")
        }
        let needle = ["\"", "--conn", "ection"].concat();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut files = Vec::new();
        for crate_src in ["orchestrator/src", "helper-server/src", "src-tauri/src"] {
            let before = files.len();
            walk(&root.join(crate_src), &mut files);
            assert!(
                files.len() > before,
                "the scan found sources under {crate_src}"
            );
        }
        let offenders: Vec<String> = files
            .iter()
            .filter(|f| !f.ends_with("orchestrator/src/lightclient.rs"))
            .filter(|f| production(&std::fs::read_to_string(f).unwrap()).contains(&needle))
            .map(|f| f.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "server named outside lightclient: {offenders:?}"
        );
    }

    /// A server that never answers is stopped at the deadline, for every kind of call.
    #[cfg(unix)]
    #[test]
    fn a_server_that_never_answers_is_stopped_at_the_deadline() {
        let dir = std::env::temp_dir().join(format!("konclave-lightclient-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hang = dir.join("devtool");
        crate::test_exec::write_script(&hang, "#!/bin/sh\nexec sleep 30\n");
        set_within_for_test(Some(Duration::from_millis(300)));
        for call in [
            Call::Broadcast,
            Call::Short,
            Call::Sync(Duration::from_secs(600)),
        ] {
            let started = std::time::Instant::now();
            let r = run(&hang, &["pczt", "send"], "zec.rocks:443", Some(b"x"), call);
            assert!(r.is_err(), "{call:?} returned without the server answering");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{call:?} was not stopped"
            );
        }
        set_within_for_test(None);
        std::fs::remove_dir_all(&dir).ok();
    }
}

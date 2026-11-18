//! The coordinator tells "this answer is wrong" from "the check did not run" by the exit status of
//! `konclave-signer inject` alone. These run the built binary, so the status is the one `main`
//! really exits with, not the one a function returns.

use konclave_seal::spends::INJECT_EXIT_SIGNATURE_REJECTED;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_konclave-signer");
const PROVEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/vectors/ironwood_single_spend.proven.pczt"
);

fn out_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "konclave-signer-exit-{name}-{}",
        std::process::id()
    ))
}

fn inject(pczt: &str, out: &std::path::Path, sig: &str) -> Option<i32> {
    Command::new(BIN)
        .args(["inject", pczt, out.to_str().unwrap(), "--sig", sig])
        .output()
        .expect("the signer runs")
        .status
        .code()
}

#[test]
fn a_refused_signature_exits_with_the_refusal_status() {
    let out = out_path("refused");
    let zero = format!("0:{}", "00".repeat(64));
    assert_eq!(
        inject(PROVEN, &out, &zero),
        Some(INJECT_EXIT_SIGNATURE_REJECTED)
    );
    let past_the_end = format!("99:{}", "00".repeat(64));
    assert_eq!(
        inject(PROVEN, &out, &past_the_end),
        Some(INJECT_EXIT_SIGNATURE_REJECTED)
    );
    assert!(!out.exists(), "nothing is written for a refused signature");
}

#[test]
fn a_check_that_did_not_run_exits_with_another_status() {
    let out = out_path("unread");
    let zero = format!("0:{}", "00".repeat(64));
    let code = inject("/nonexistent/konclave.pczt", &out, &zero);
    assert_ne!(code, Some(INJECT_EXIT_SIGNATURE_REJECTED));
    assert_ne!(code, Some(0));
}

#[test]
fn a_valid_signature_exits_zero() {
    let out = out_path("valid");
    let sig = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/ironwood_single_spend.sig0.raw"
    ))
    .unwrap();
    let hex: String = sig.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(inject(PROVEN, &out, &format!("0:{hex}")), Some(0));
    std::fs::remove_file(&out).ok();
}

#[test]
fn the_signer_says_which_status_it_refuses_with() {
    let out = Command::new(BIN).arg("inject-statuses").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        format!("{{\"signature_rejected\":{INJECT_EXIT_SIGNATURE_REJECTED}}}")
    );
}

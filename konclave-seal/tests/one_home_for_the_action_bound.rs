//! Source scan: how many actions a payment may carry is decided in ONE place,
//! `konclave-seal/src/spends.rs` (`check_action_bound`, fed by `bundle_shape`).
//!
//! The device reads a bundle's spends and outputs, and a second reader that counted them its own way
//! (the coordinator's build check, a screen estimating a fee) would be a second rule that could be
//! changed without the first. This fails the build if another crate reads a spend's value against its
//! nullifier, compares an action count with spends or outputs, or calls the rule from somewhere that
//! was not decided. A line that is only a comment is not code. The scan is of text, so it asks for
//! what the rule is made of and not for every way of writing a comparison; it is a net, and the rule
//! itself is tested in `action_bound.rs`. `konclave-seal/src` is outside the scan by design: it is
//! where the rule lives, and the readers a plant would use (`bundle_fee`, `action_count`) are public.

use std::path::{Path, PathBuf};

const ROOTS: &[&str] = &[
    "orchestrator/src",
    "helper-server/src",
    "konclave-wasm/src",
    "konclave-signer/src",
    "konclave-http/src",
    "relay-server/src",
    "src-tauri/src",
];

/// Where the rule is called from: the device's reading of a payment, and nowhere else. The
/// coordinator does not call it (decided for the interim; a guard there would be an early warning
/// and not a defence, and it needs its own deploy). Adding a caller means adding a line here.
const CALLERS: &[&str] = &["konclave-wasm/src/lib.rs"];

/// Places that read what the bound reads for another reason. Each excuses one exact piece of code
/// (`snippet`, whitespace removed), not the file: a new use of the same name beside it is still
/// found. An entry whose snippet is no longer there fails the test, so the list cannot outlive what
/// it excuses.
const EXCEPTIONS: &[(&str, &str, &str)] = &[
    // (file, snippet, why)
    (
        "orchestrator/src/validation.rs",
        "constGRACE_ACTIONS:u64=2;",
        "the bridge's fee ESTIMATE for a preview has its own constant; it is not the signing rule and never refuses a signature",
    ),
    (
        "orchestrator/src/validation.rs",
        "GRACE_ACTIONS.max(logical_actions)",
        "the same estimate: the fee it shows is billed at least two actions",
    ),
    (
        "konclave-signer/src/main.rs",
        "konclave_seal::epochs::GRACE_ACTIONSasusize",
        "builds the builder's FeeRule from the one constant in konclave-seal::epochs; it counts nothing",
    ),
    (
        "orchestrator/src/pczt.rs",
        "a.spend().value().is_some(),",
        "a test that the published copy keeps each spend's value; it counts nothing",
    ),
    (
        "konclave-signer/src/main.rs",
        "ifletSome(x)=a.spend().value(){ifx.inner()>0{v.push(x.inner());}}",
        "a test of the builder's note selection lists the values of the notes a PCZT spends; it counts nothing and refuses nothing",
    ),
];

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn files(dir: &Path, ext: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if p.is_dir() {
            if name != "node_modules" && name != "wasm-pkg" && name != "target" {
                files(&p, ext, out);
            }
        } else if p
            .extension()
            .is_some_and(|x| ext.contains(&x.to_string_lossy().as_ref()))
        {
            out.push(p);
        }
    }
}

/// The text of a file with whole-line comments removed.
fn code_of(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|l| !l.trim_start().starts_with("//") && !l.trim_start().starts_with('*'))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rust_sources() -> Vec<(String, String)> {
    let mut all = vec![];
    for r in ROOTS {
        files(&repo().join(r), &["rs"], &mut all);
    }
    all.into_iter()
        .map(|p| (p.display().to_string(), code_of(&p)))
        .collect()
}

/// What counting a bundle's spends against its outputs looks like in Rust (whitespace removed first).
fn rust_count_needles(code: &str) -> Vec<String> {
    let code: String = code.split_whitespace().collect();
    let mut found = vec![];
    for n in [
        "verify_nullifier(",
        "verify_cv_net(",
        ".rcv()",
        ".bsk()",
        ".max(GRACE_ACTIONS",
        "to_sign+paying",
        "cmp::max(2,",
        "GRACE_ACTIONS",
        "spend().value()",
        ".actions>",
    ] {
        if code.contains(n) {
            found.push(n.to_string());
        }
    }
    // `spends_to_sign(..)` counted: the list is for the ceremony, not for a bound.
    for (i, _) in code.match_indices("spends_to_sign(") {
        let stmt = code[i..].split(';').next().unwrap_or("");
        if stmt.contains(".len()") || stmt.contains(".count()") {
            found.push("spends_to_sign(..) counted".to_string());
        }
    }
    // `action_count(..)` / `action_count_of(..)` compared in the same expression: the rule rewritten
    // with the public reader. The expression ends at `;` or `{`; `->` and `=>` are not comparisons.
    for (i, _) in code.match_indices("action_count") {
        let stmt = code[i..].split([';', '{']).next().unwrap_or("");
        if stmt.replace("->", "").replace("=>", "").contains(")>")
            || stmt.contains(")?>")
            || stmt.contains(")<")
        {
            found.push("action_count(..) compared".to_string());
        }
    }
    found
}

#[test]
fn the_scan_would_find_a_second_count() {
    assert!(!rust_count_needles("a.verify_cv_net().is_ok()").is_empty());
    assert!(!rust_count_needles("a.spend().verify_nullifier(Some(&fvk)).is_ok()").is_empty());
    assert!(!rust_count_needles("let r = action.rcv();").is_empty());
    assert!(!rust_count_needles("let b = bundle.bsk();").is_empty());
    assert!(rust_count_needles("a.clear_rcv();").is_empty());
    assert!(!rust_count_needles("let n=spends_to_sign(b)?.len();").is_empty());
    assert!(!rust_count_needles("let enough = (to_sign + paying).max(2);").is_empty());
    assert!(!rust_count_needles("x.max(GRACE_ACTIONS as usize)").is_empty());
    assert!(!rust_count_needles("x > std::cmp::max(2, spends.max(outputs))").is_empty());
    assert!(
        !rust_count_needles("a.spend().value().map_or(false, |v| v.inner() > 5000)").is_empty()
    );
    assert!(!rust_count_needles("let billed = GRACE_ACTIONS.max(n);").is_empty());
    assert!(
        !rust_count_needles("if bundle_fee(p, true).unwrap().actions > outputs.max(2) {}")
            .is_empty()
    );
    assert!(!rust_count_needles("if spends::action_count(&p) > outputs.len() { x }").is_empty());
    assert!(!rust_count_needles("if action_count_of(&b)? > n {").is_empty());
    assert!(rust_count_needles("fn action_count_of(b: &[u8]) -> Result<usize, E> {").is_empty());
    assert!(rust_count_needles("let a = action_count_of(&b)?;").is_empty());
    assert!(rust_count_needles("for (i, a) in spends_to_sign(b)? { sign(i, a); }").is_empty());
}

#[test]
fn no_other_crate_counts_spends_against_outputs() {
    let mut used = vec![false; EXCEPTIONS.len()];
    for (path, code) in rust_sources() {
        let mut flat: String = code.split_whitespace().collect();
        for (i, (p, snippet, _)) in EXCEPTIONS.iter().enumerate() {
            if path.ends_with(p) && flat.contains(snippet) {
                used[i] = true;
                // One occurrence only: a copy of the excused code elsewhere is a second reading.
                flat = flat.replacen(snippet, "", 1);
            }
        }
        let found = rust_count_needles(&flat);
        assert!(
            found.is_empty(),
            "{path}: reads what the action bound reads ({found:?}); it lives in konclave-seal::spends only"
        );
    }
    for (i, u) in used.iter().enumerate() {
        assert!(
            u,
            "{:?} is excused but no longer there: remove it from EXCEPTIONS",
            EXCEPTIONS[i]
        );
    }
}

#[test]
fn the_rule_is_called_from_the_device_only() {
    let mut called_from_device = false;
    for (path, code) in rust_sources() {
        let flat: String = code.split_whitespace().collect();
        let calls = flat.contains("check_action_bound(") || flat.contains("bundle_shape(");
        let allowed = CALLERS.iter().any(|c| path.ends_with(c));
        if allowed {
            called_from_device |= calls;
        } else {
            assert!(
                !calls,
                "{path}: calls the action bound; add it to CALLERS only when that was decided"
            );
        }
    }
    assert!(
        called_from_device,
        "the device no longer calls the action bound where CALLERS says"
    );
}

/// What a screen comparing an action count with its spends or outputs looks like.
fn ui_count_needles(code: &str) -> Vec<&'static str> {
    let code: String = code.split_whitespace().collect();
    [
        "actions>",
        "actions<",
        "actions>outputs",
        "actions>=outputs",
        "actions>spends",
        "actions>=spends",
        "actions>Math.max(",
        "outputs.length+spends",
        "spends.length+outputs",
        "actions.length>outputs",
        "actions.length>spends",
    ]
    .into_iter()
    .filter(|n| code.contains(n))
    .collect()
}

#[test]
fn no_screen_compares_an_action_count_with_spends_or_outputs() {
    assert!(!ui_count_needles("if (p.actions > outputs.length) {}").is_empty());
    assert!(!ui_count_needles("if (actions > nOut + 1) {}").is_empty());
    assert!(!ui_count_needles("return a.actions <= 2").is_empty());
    assert!(ui_count_needles("const fee = marginal * actions").is_empty());
    let mut all = vec![];
    files(&repo().join("ui/src"), &["ts", "tsx"], &mut all);
    assert!(all.len() > 20, "the UI sources were not found");
    for p in all {
        let name = p.display().to_string();
        if name.contains(".test.") {
            continue;
        }
        let found = ui_count_needles(&code_of(&p));
        assert!(
            found.is_empty(),
            "{name}: compares an action count with spends or outputs ({found:?}); the device's reading decides this"
        );
    }
}

/// `SpendKey::NotChecked` reads no spend and leaves the action bound off, so it is for the readings
/// that sign nothing: the two previews (`readPayment`, `describeOutputs`) and the test-only
/// `read_payment`. It is named in no other function, and in no other crate; the reading a device
/// signs on (`read_for_signing_with`, through `read_payment_with`) takes an optional key and cannot
/// be handed it.
#[test]
fn the_unchecked_reading_is_reached_only_by_the_previews() {
    const PREVIEWS: &[&str] = &["describe_outputs_with", "read_payment"];
    let mut seen = vec![];
    for (path, code) in rust_sources() {
        for (i, _) in code.match_indices("NotChecked") {
            assert!(
                path.ends_with("konclave-wasm/src/lib.rs"),
                "{path}: names SpendKey::NotChecked; only the previews in konclave-wasm may"
            );
            // The function the mention sits in: the last `fn name(` before it.
            let before = &code[..i];
            let at = before.rfind("fn ").expect("a function around it");
            let name: String = before[at + 3..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            assert!(
                PREVIEWS.contains(&name.as_str()),
                "`{name}` names SpendKey::NotChecked; only {PREVIEWS:?} may"
            );
            seen.push(name);
        }
    }
    for p in PREVIEWS {
        assert!(
            seen.iter().any(|n| n == p),
            "{p} no longer reads unchecked: remove it from PREVIEWS"
        );
    }
}

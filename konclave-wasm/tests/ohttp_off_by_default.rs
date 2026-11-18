//! Oblivious HTTP is not in the default build of `konclave-wasm`, which is the wasm every member
//! downloads (`ui/src/wasm-pkg`): it would add some 45 KB gzipped for code nothing reaches yet.
//! Checked on the resolved tree of the default features, so a default that quietly turns it on
//! fails here and not in a bundle-size review.

fn tree(extra: &[&str]) -> String {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut args = vec!["tree", "-p", "konclave-wasm", "-e", "normal"];
    args.extend_from_slice(extra);
    let out = std::process::Command::new(cargo)
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree");
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn wasm_default_links_no_oblivious_http() {
    let t = tree(&[]);
    for banned in ["konclave-ohttp v", "── ohttp v", "bhttp v", "hpke v"] {
        assert!(
            !t.contains(banned),
            "{banned} is in the default build:\n{t}"
        );
    }
}

#[test]
fn the_feature_brings_it_in() {
    let t = tree(&["--features", "ohttp"]);
    assert!(t.contains("konclave-ohttp v"), "{t}");
}

/// The wasm embeds the line number of each panic site, so a declaration above them changes the bytes
/// of the DEFAULT build even with the feature off. It must stay the last item of `lib.rs`.
#[test]
fn the_ohttp_module_is_declared_last() {
    let src = include_str!("../src/lib.rs");
    let at = src
        .find("pub mod ohttp_api;")
        .expect("the module is declared");
    let after = &src[at + "pub mod ohttp_api;".len()..];
    assert!(
        after.trim().is_empty(),
        "code after `pub mod ohttp_api;` moves the panic line numbers of the default wasm"
    );
    let before = &src[..at];
    assert!(before.trim_end().ends_with("#[cfg(feature = \"ohttp\")]"));
}

/// A `default = [...]` line in `[features]`, even an empty one, enables the feature "default", which
/// rustc is given and which changes the bytes of the wasm (measured: 45 bytes, a different sha256).
/// The default build is pinned to the committed package by `wasm_default_unchanged` in
/// `konclave-ohttp`'s acceptance; this is the cheap guard that names the cause.
#[test]
fn the_manifest_has_no_default_feature_entry() {
    let toml = include_str!("../Cargo.toml");
    let features = toml.split("[features]").nth(1).expect("a [features] table");
    let features = features.split("\n[").next().unwrap();
    assert!(
        !features
            .lines()
            .any(|l| l.trim_start().starts_with("default")),
        "a `default` entry changes the bytes of the default wasm:\n{features}"
    );
}

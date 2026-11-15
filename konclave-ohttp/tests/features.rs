//! A client-only build (the browser's) does not carry the server half of the `ohttp` crate, and a
//! server-only build does not carry the client half: each feature of this crate forwards to the
//! same one of the crate's own. Checked on the resolved tree, not the manifest text.

fn ohttp_features(extra: &[&str]) -> String {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut args = vec!["tree", "-p", "konclave-ohttp", "--no-default-features"];
    args.extend_from_slice(extra);
    args.extend_from_slice(&["-e", "normal", "--depth", "1", "-f", "{p} [{f}]"]);
    let out = std::process::Command::new(cargo)
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree");
    let tree = String::from_utf8(out.stdout).unwrap();
    tree.lines()
        .find(|l| l.contains("── ohttp v"))
        .unwrap_or_else(|| panic!("ohttp is not linked:\n{tree}"))
        .to_string()
}

#[test]
fn the_client_half_links_no_ohttp_server() {
    let line = ohttp_features(&["--features", "client"]);
    assert!(line.contains("client"), "{line}");
    assert!(
        !line.contains("server"),
        "the server half is linked: {line}"
    );
    assert!(!line.contains("stream"), "{line}");
}

#[test]
fn the_server_half_links_no_ohttp_client() {
    let line = ohttp_features(&["--features", "server"]);
    assert!(line.contains("server"), "{line}");
    assert!(
        !line.contains("client"),
        "the client half is linked: {line}"
    );
}

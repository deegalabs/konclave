//! A forwarding setting the coordinator does not understand stops it with exit code 2 before it
//! runs a migration or binds: a restart loop on a typo must not touch the vaults on every turn.

use std::process::Command;

#[test]
fn a_setting_that_is_not_understood_stops_the_coordinator_before_it_touches_the_vaults() {
    let vaults = std::env::temp_dir().join(format!("kc-fwd-refused-{}", std::process::id()));
    std::fs::create_dir_all(&vaults).unwrap();
    for bad in ["abc", "9", "-1", "1.5"] {
        let out = Command::new(env!("CARGO_BIN_EXE_helper-server"))
            .env("KONCLAVE_TRUSTED_PROXY_HOPS", bad)
            .env("KONCLAVE_VAULTS_DIR", &vaults)
            .env("KONCLAVE_HELPER_ADDR", "127.0.0.1:1")
            .output()
            .expect("run the coordinator");
        assert_eq!(out.status.code(), Some(2), "value {bad:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("KONCLAVE_TRUSTED_PROXY_HOPS must be a whole number"),
            "value {bad:?}: {err}"
        );
        assert!(
            !err.contains("registrations:") && !err.contains("listening"),
            "it must stop before the registry and the bind: {err}"
        );
    }
    assert_eq!(
        std::fs::read_dir(&vaults).unwrap().count(),
        0,
        "nothing was written to the vaults directory"
    );
    std::fs::remove_dir_all(&vaults).ok();
}

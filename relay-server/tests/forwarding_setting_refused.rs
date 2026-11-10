//! A forwarding setting the relay does not understand stops it at boot with exit code 2, before it
//! binds, instead of quietly running with the default.

use std::process::Command;

#[test]
fn a_setting_that_is_not_understood_stops_the_relay_with_exit_code_2() {
    for bad in ["abc", "9", "-1", "1.5"] {
        let out = Command::new(env!("CARGO_BIN_EXE_relay-server"))
            .env("KONCLAVE_TRUSTED_PROXY_HOPS", bad)
            .env("PORT", "1")
            .output()
            .expect("run the relay");
        assert_eq!(out.status.code(), Some(2), "value {bad:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("KONCLAVE_TRUSTED_PROXY_HOPS must be a whole number"),
            "value {bad:?}: {err}"
        );
        assert!(
            !err.contains("listening"),
            "it must stop before it binds: {err}"
        );
    }
}

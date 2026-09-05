//! One Content-Security-Policy, shared by every surface that serves the wallet UI (#268).
//!
//! The app holds a FROST key share in the browser and signs in WASM on the device. The whole
//! key-share guarantee rests on no attacker script running on the origin, and nothing enforced that:
//! no CSP on Vercel, none on the local bridge, `"csp": null` on Tauri. This is the backstop.
//!
//! The one rule that matters is `script-src` with NO `'unsafe-inline'` (so an injected `<script>` or
//! inline handler cannot run), plus `'wasm-unsafe-eval'` (the WASM signer needs it). `style-src`
//! keeps `'unsafe-inline'` deliberately - React sets inline style attributes, and style injection
//! cannot execute code, so it is a far lower risk than script injection. `connect-src` lists what
//! the app fetches: the hosted helper and relay, and CoinGecko for the USD price. Explorer and
//! GitHub links are `<a target=_blank>`, not fetches, so they are not listed.
//!
//! # The staging hosts are a deliberate, named exception (#370)
//!
//! `connect-src` also admits `konclave-helper-staging` and `konclave-relay-staging`, which
//! production itself never contacts. That is a real widening and it is recorded here rather than
//! left to be discovered.
//!
//! **Why it is needed.** `VITE_RELAY_BASE` and `VITE_HELPER_BASE` already point the client at
//! another coordination plane, so a staging environment is otherwise pure configuration. But the
//! policy is a static string mirrored into `ui/vercel.json`, so a preview build aimed at staging
//! would have its requests **blocked by the browser, silently** - a CSP refusal is not an error a
//! `fetch` catch block reports as anything recognisable. Without this, the first person to try
//! loses a day to it, which is the day #370 exists to prevent.
//!
//! **Why the cost is small.** These are our own hosts, and the property this file exists to
//! guarantee is `script-src` without `'unsafe-inline'`: there is no injected script to exfiltrate
//! *with*. A wider `connect-src` matters when an attacker already runs code on the origin, which is
//! the thing prevented above.
//!
//! **What would be better.** Compute the policy per build, so production lists production and only
//! a staging build lists staging. That needs the policy to stop being a literal mirrored into two
//! static config files, and it needs the drift test below to stop comparing literal strings.
//! Vercel's `vercel.ts` supports it. It is the right end state; it should not be what blocks a
//! staging environment from existing.

/// The canonical policy, verbatim, mirrored into `ui/vercel.json` and `src-tauri/tauri.conf.json`.
pub const CSP: &str = "default-src 'self'; \
script-src 'self' 'wasm-unsafe-eval'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; \
font-src 'self'; \
connect-src 'self' https://konclave-helper-production.up.railway.app https://konclave-relay-production.up.railway.app https://konclave-helper-staging.up.railway.app https://konclave-relay-staging.up.railway.app https://api.coingecko.com; \
frame-ancestors 'none'; \
base-uri 'self'; \
object-src 'none'; \
form-action 'self'";

/// The full security-header set served with every document.
pub fn security_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Content-Security-Policy", CSP),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "strict-origin-when-cross-origin"),
        // frame-ancestors 'none' in the CSP is the modern control; X-Frame-Options is the fallback
        // for engines that do not honour it.
        ("X-Frame-Options", "DENY"),
    ]
}

/// True iff a policy actually blocks inline script - a `script-src` directive that does NOT allow
/// `'unsafe-inline'`. This is the property the whole CSP exists to guarantee; a policy that fails it
/// is worse than none, because it looks protective and is not.
pub fn blocks_inline_script(csp: &str) -> bool {
    directive(csp, "script-src")
        .map(|v| !v.split_whitespace().any(|t| t == "'unsafe-inline'"))
        .unwrap_or(false)
}

/// True iff the policy lets the WASM signer run (`script-src` includes `'wasm-unsafe-eval'`).
pub fn allows_wasm(csp: &str) -> bool {
    directive(csp, "script-src")
        .map(|v| v.split_whitespace().any(|t| t == "'wasm-unsafe-eval'"))
        .unwrap_or(false)
}

/// True iff `connect-src` allows a fetch to `host`.
pub fn allows_connect(csp: &str, host: &str) -> bool {
    directive(csp, "connect-src")
        .map(|v| v.split_whitespace().any(|t| t == host))
        .unwrap_or(false)
}

/// The value of one directive (everything after its name up to the `;`), if present.
fn directive<'a>(csp: &'a str, name: &str) -> Option<&'a str> {
    csp.split(';')
        .map(str::trim)
        .find_map(|d| d.strip_prefix(name).map(str::trim))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_canonical_policy_blocks_inline_script_and_allows_wasm() {
        assert!(
            blocks_inline_script(CSP),
            "script-src must not allow 'unsafe-inline'"
        );
        assert!(allows_wasm(CSP), "the WASM signer needs 'wasm-unsafe-eval'");
    }

    #[test]
    fn a_policy_that_allows_inline_script_is_rejected() {
        // The failure mode the check exists for: a CSP that looks protective but lets injected
        // script run. This must be caught, not passed.
        let unsafe_csp = "default-src 'self'; script-src 'self' 'unsafe-inline'";
        assert!(!blocks_inline_script(unsafe_csp));
    }

    /// The staging hosts are admitted ON PURPOSE (#370), and this pins that so removing them breaks
    /// a test rather than breaking a staging environment silently. A CSP refusal is not an error a
    /// `fetch` reports as anything recognisable, so the failure it would cause is invisible until
    /// someone spends a day on it. If the staging environment is ever retired, delete this test in
    /// the same change that narrows the policy - deliberately, not by discovery.
    #[test]
    fn the_policy_admits_the_staging_coordination_plane() {
        for host in [
            "https://konclave-helper-staging.up.railway.app",
            "https://konclave-relay-staging.up.railway.app",
        ] {
            assert!(
                allows_connect(CSP, host),
                "{host} must stay in connect-src: a preview aimed at staging fails silently without it"
            );
        }
        // The widening is exactly two hosts of ours, and it does NOT touch the property this file
        // exists for: an injected script still cannot run, so there is nothing to exfiltrate with.
        assert!(blocks_inline_script(CSP));
    }

    #[test]
    fn the_canonical_policy_allows_exactly_the_hosts_the_app_fetches() {
        assert!(allows_connect(
            CSP,
            "https://konclave-helper-production.up.railway.app"
        ));
        assert!(allows_connect(
            CSP,
            "https://konclave-relay-production.up.railway.app"
        ));
        assert!(allows_connect(CSP, "https://api.coingecko.com"));
        assert!(
            allows_connect(CSP, "'self'"),
            "the local bridge is same-origin"
        );
        // Production also admits the two staging hosts, which production never contacts. That is
        // the deliberate exception in this module's docs, pinned by the test above.
        // A host we do NOT fetch must not be allowed (explorers/GitHub are links, not fetches).
        assert!(!allows_connect(CSP, "https://evil.example.com"));
    }

    /// The three surfaces must carry the SAME policy. A drift - a directive tightened in one place
    /// and not another - is exactly how a CSP silently stops matching what the app needs, or stops
    /// protecting it. This reads the deployed configs and fails if either differs from `CSP`.
    #[test]
    fn vercel_and_tauri_carry_the_canonical_policy() {
        fn norm(s: &str) -> String {
            s.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let canon = norm(CSP);

        let vercel: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("ui/vercel.json")).unwrap())
                .unwrap();
        let vcsp = vercel["headers"][0]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["key"] == "Content-Security-Policy")
            .and_then(|h| h["value"].as_str())
            .unwrap();
        assert_eq!(
            norm(vcsp),
            canon,
            "ui/vercel.json CSP drifted from csp::CSP"
        );

        let tauri: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("src-tauri/tauri.conf.json")).unwrap(),
        )
        .unwrap();
        // The csp lives under app.security.csp in tauri v2; fall back to a scan for older shapes.
        let tcsp = tauri
            .pointer("/app/security/csp")
            .and_then(|v| v.as_str())
            .or_else(|| {
                tauri
                    .pointer("/tauri/security/csp")
                    .and_then(|v| v.as_str())
            })
            .expect("tauri.conf.json has a csp string");
        assert_eq!(
            norm(tcsp),
            canon,
            "src-tauri/tauri.conf.json CSP drifted from csp::CSP"
        );
    }

    #[test]
    fn the_header_set_carries_the_csp_and_the_hardening_headers() {
        let h = security_headers();
        assert!(h
            .iter()
            .any(|(k, v)| *k == "Content-Security-Policy" && blocks_inline_script(v)));
        assert!(h.iter().any(|(k, _)| *k == "X-Content-Type-Options"));
        assert!(h.iter().any(|(k, _)| *k == "Referrer-Policy"));
    }
}

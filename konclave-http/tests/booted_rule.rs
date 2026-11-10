//! The rule a server boots with is the rule its requests are counted under.
//!
//! A unit test cannot show this: the crate's own tests set a rule per thread, which skips the boot.
//! This file is its own process, so it can set the variable, boot the rule the way a server's `main`
//! does, and ask for an address the way the worker loop does.

use konclave_http::{
    boot_forwarding_rule, forwarding_rule, request_client_address, ForwardingRule,
};

#[test]
fn the_booted_rule_is_the_one_a_request_is_counted_under() {
    std::env::set_var(konclave_http::TRUSTED_PROXY_HOPS_VAR, "1");
    // The same call a server's `main` makes, so a boot that validated the setting and did not record
    // it fails here.
    assert_eq!(boot_forwarding_rule("test"), ForwardingRule::TrustedHops(1));
    assert_eq!(forwarding_rule(), ForwardingRule::TrustedHops(1));
    // A client wrote 203.0.113.66; the one proxy appended the address it saw.
    let counted = request_client_address(["203.0.113.66, 198.51.100.20"], Some("192.0.2.1"));
    assert_eq!(counted.to_string(), "198.51.100.20");
}

//! Oblivious traffic: which routes it may reach, where it comes from, and what it may spend.
//!
//! Requests that arrive through an OHTTP relay carry no client address: the relay's address is the
//! only one the gateway sees, and it is the same for everybody. Three rules follow, and each lives
//! here and nowhere else, beside the address type they are about:
//!
//! - [`OBLIVIOUS_ROUTES`] and [`route_is_oblivious`]: the routes that may be reached obliviously.
//!   A route that would join an IP to a vault (a send, a proposal, a registration) is not on it.
//! - [`Origin`]: direct (an address) or oblivious (none). Oblivious traffic can never be turned
//!   into a [`ClientAddress`], so it can never be counted in an address bucket.
//! - [`ObliviousBudget`]: one budget for ALL oblivious traffic together, kept apart from every
//!   address bucket, so a flood through the relay cannot spend the direct path's allowance and
//!   direct traffic cannot spend this one.
//!
//! No dependency, and nothing about OHTTP itself: the HPKE and the message format are in
//! `konclave-ohttp`, which neither server's mailbox nor the relay needs to link to use these.

use crate::{ClientAddress, RateKey, RateLimiter};

/// The header the OHTTP relay uses to present its shared secret to the gateway. It is the relay's
/// and the gateway's, and a name that exists twice is a name that can drift: the relay sends it and
/// the helper reads it, both from here.
pub const RELAY_SECRET_HEADER: &str = "X-Konclave-Relay-Secret";

/// (method, path without query string): the routes that may be reached obliviously in this proof of concept.
/// Vault creation (`POST /api/vault`), sends, proposals and votes are NOT here: they stay direct.
pub const OBLIVIOUS_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/vault/balance"),
    ("GET", "/api/vault/transactions"),
    ("GET", "/api/vault/ceremonies"),
    ("GET", "/api/vault/proposals"),
    ("GET", "/api/vault/ledger"),
    ("GET", "/api/vault/members"),
    ("GET", "/api/health"),
];

/// True if `method` and `path` are on [`OBLIVIOUS_ROUTES`]. The query string is ignored; the path
/// before it must match exactly, so a trailing slash or a traversal (`/balance/../send`) is refused.
#[must_use]
pub fn route_is_oblivious(method: &str, path: &str) -> bool {
    let bare = path.split('?').next().unwrap_or("");
    OBLIVIOUS_ROUTES
        .iter()
        .any(|(m, p)| *m == method && *p == bare)
}

/// Where a request came from. There is no way to read an address out of `Oblivious`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Origin {
    Direct(ClientAddress),
    Oblivious,
}

impl Origin {
    /// The address bucket this origin is counted in, if it has one. `Oblivious` has none: it is
    /// counted in the [`ObliviousBudget`] and in nothing else.
    #[must_use]
    pub fn address_key(&self) -> Option<RateKey> {
        match self {
            Origin::Direct(addr) => Some(RateKey::address(addr)),
            Origin::Oblivious => None,
        }
    }
}

/// Window and ceiling of the global oblivious budget. Proof-of-concept values: honest use is about 4 requests
/// per 10 s per tab, so this admits some thirty tabs at once, and it is deliberately below what a
/// single direct address may do (300), so the whole oblivious path is never the larger half. To be
/// replaced by tokens, which are not built.
pub const OBLIVIOUS_WINDOW_SECS: i64 = 10;
pub const OBLIVIOUS_MAX: u32 = 120;

/// One fixed-window budget for every oblivious request together.
pub struct ObliviousBudget {
    limiter: RateLimiter,
    max: u32,
}

impl ObliviousBudget {
    #[must_use]
    pub fn new() -> Self {
        Self::with_max(OBLIVIOUS_MAX)
    }

    #[must_use]
    pub fn with_max(max: u32) -> Self {
        Self {
            limiter: RateLimiter::new(OBLIVIOUS_WINDOW_SECS, 4),
            max,
        }
    }

    /// Count one oblivious request; false when the budget for this window is spent. A refused
    /// request is counted too, as in [`RateLimiter::allow`].
    pub fn allow(&self, now: i64) -> bool {
        self.limiter.allow(&RateKey::oblivious(), now, self.max)
    }
}

impl Default for ObliviousBudget {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    const T0: i64 = 1_800_000_000;

    #[test]
    fn every_listed_route_is_reachable() {
        for (m, p) in OBLIVIOUS_ROUTES {
            assert!(route_is_oblivious(m, p), "{m} {p}");
        }
        assert!(route_is_oblivious("GET", "/api/vault/balance?vault=abc"));
    }

    #[test]
    fn a_route_outside_the_list_is_refused() {
        for (m, p) in [
            ("POST", "/api/vault/send"),
            ("POST", "/api/vault/proposals"),
            ("POST", "/api/vault"),
            ("GET", "/api/vault"),
            ("GET", "/api/vault/ledger.csv"),
            ("GET", "/api/vault/ufvk"),
            ("GET", "/api/vault/balance/"),
            ("GET", "/api/vault/balance/../send"),
            ("POST", "/api/vault/balance"),
            ("GET", "/api/ohttp"),
            ("GET", "/"),
            ("GET", ""),
            ("get", "/api/health"),
        ] {
            assert!(!route_is_oblivious(m, p), "{m} {p} was reachable");
        }
    }

    #[test]
    fn oblivious_traffic_has_no_address_bucket() {
        let a = ClientAddress::from_ip(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)));
        assert!(Origin::Direct(a).address_key().is_some());
        assert!(Origin::Oblivious.address_key().is_none());
    }

    #[test]
    fn the_budget_is_global_and_ends_with_its_window() {
        let b = ObliviousBudget::with_max(3);
        for i in 0..3 {
            assert!(b.allow(T0), "request {i}");
        }
        assert!(!b.allow(T0), "the fourth in the window");
        assert!(b.allow(T0 + OBLIVIOUS_WINDOW_SECS), "the next window");
    }

    #[test]
    fn the_budget_shares_nothing_with_an_address_bucket() {
        let a = ClientAddress::from_ip(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)));
        let b = ObliviousBudget::with_max(1);
        let l = RateLimiter::new(OBLIVIOUS_WINDOW_SECS, 4);
        assert!(b.allow(T0));
        assert!(!b.allow(T0));
        assert!(
            l.allow(&RateKey::address(&a), T0, 1),
            "address bucket untouched"
        );
        assert!(!l.allow(&RateKey::address(&a), T0, 1));
        assert!(!b.allow(T0));
        let unknown = ClientAddress::unknown();
        assert_ne!(RateKey::address(&unknown), RateKey::oblivious());
    }
}

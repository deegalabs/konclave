#![cfg(all(feature = "client", feature = "server"))]
mod scenarios;

macro_rules! t {
    ($($n:ident),*) => { $( #[test] fn $n() { scenarios::$n().unwrap(); } )* };
}
t!(
    round_trip,
    tamper_request,
    tamper_response,
    truncation,
    replay,
    stale_date,
    future_date,
    missing_date,
    unknown_key_id,
    route_allowlist,
    forbidden_header,
    replay_full_no_evict,
    padding_buckets,
    response_authenticates_first,
    response_buckets_exponential,
    wasm_default_unchanged
);

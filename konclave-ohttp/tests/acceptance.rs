#![cfg(all(feature = "client", feature = "server"))]
//! Writes `ohttp-acceptance.json` at the workspace root, and says for EVERY row where its result
//! came from. A row this run measured says `"source": "measured: ..."`. A row whose result belongs
//! to another crate's tests, the browser or a script is NOT measured here: it is kept as the file
//! already says it and is marked `"source": "carried: <the test that produces it>"`, so a reader
//! never takes a preserved line for a fresh one. A carried row the file does not mention is
//! NOT_RUN, never a silent PASS.
mod scenarios;

use std::fmt::Write as _;

const MEASURED_BY: &str = "measured: konclave-ohttp tests/acceptance.rs";

const RELAY_MEASURED_BY: &str =
    "measured: konclave-ohttp tests/acceptance.rs, by running the konclave-ohttp-relay test suite";

/// The relay's rows and the tests of `konclave-ohttp-relay` (its unit tests, `tests/relay.rs` and
/// `tests/tls.rs`) each one needs. A row is PASS only when every test it names printed `ok` in this
/// run. There is no row for an SPKI pin: the relay does not pin (see `upstream.rs`).
const RELAY_ROWS: &[(&str, &[&str])] = &[
    (
        "relay_tls_to_gateway",
        &[
            "a_valid_chain_and_name_succeed_and_the_secret_arrives_over_tls",
            "a_valid_chain_from_an_unknown_ca_fails",
            "an_expired_certificate_fails",
            "a_certificate_for_another_name_fails",
            "the_bundled_roots_do_not_trust_a_test_ca",
            "only_tls_1_3_is_spoken_and_the_secret_never_goes_to_a_tls_1_2_server",
            "alpn_is_http_1_1_even_when_the_server_prefers_h2",
            "boot_rules_for_the_gateway_url",
            "the_header_strip_and_the_client_ip_hold_over_tls",
            "through_the_relay_a_refused_certificate_a_redirect_and_a_bad_answer_are_typed_502s",
        ],
    ),
    (
        "relay_webpki_and_hostname_no_pin",
        &[
            "any_trusted_ca_may_issue_for_the_gateway_name_and_that_is_the_decision",
            "a_certificate_for_another_name_fails",
            "a_valid_chain_from_an_unknown_ca_fails",
        ],
    ),
    (
        "relay_plain_hop_is_opt_in_and_loud",
        &[
            "the_secret_never_travels_on_the_plain_path_unless_opted_in",
            "the_boot_line_says_loudly_when_the_hop_is_plain",
            "the_binary_says_loudly_at_boot_when_the_hop_is_plain",
        ],
    ),
    (
        "relay_no_redirect_followed",
        &["a_redirect_is_not_followed"],
    ),
    (
        "relay_ignores_environment_proxy",
        &["an_environment_proxy_is_ignored"],
    ),
    (
        "relay_no_compression",
        &["no_compression_is_asked_for_and_an_encoded_answer_is_refused"],
    ),
    (
        "relay_one_attempt_over_tls",
        &["one_attempt_and_the_gateways_refusal_passes_through_over_tls"],
    ),
    (
        "relay_upstream_timeouts",
        &[
            "a_gateway_that_goes_silent_is_cut_at_the_bound",
            "the_total_timeout_cuts_a_gateway_that_drips",
            "the_connect_timeout_bounds_a_gateway_that_never_answers_the_connect",
            "every_deadline_is_under_what_the_client_waits",
        ],
    ),
    (
        "relay_dns_off_the_request_path",
        &[
            "the_name_is_resolved_at_boot_and_never_per_request",
            "upstream::tests::a_failed_refresh_keeps_the_last_good_addresses",
        ],
    ),
    (
        "relay_idle_connections_do_not_stall",
        &[
            "idle_connections_from_one_address_do_not_stall_another_client",
            "one_address_cannot_hold_more_than_its_share_of_connections",
            "the_head_cap_and_the_global_cap_each_refuse_at_accept",
            "the_body_cap_refuses_without_reading_the_body",
            "the_connection_deadline_closes_a_connection_whatever_it_is_waiting_for",
        ],
    ),
    (
        "relay_flood_limit_on_every_path",
        &[
            "a_flood_of_unknown_paths_from_one_address_gets_429",
            "the_flood_limit",
        ],
    ),
    (
        "relay_slow_connections_cut",
        &[
            "a_slow_body_is_cut_and_does_not_hold_the_relay",
            "a_connection_that_never_finishes_its_headers_is_let_go",
        ],
    ),
    (
        "relay_malformed_requests_refused",
        &[
            "malformed_requests_are_refused_and_nothing_reaches_the_gateway",
            "mutated_requests_never_break_the_relay_or_the_strip",
            "pipelined_requests_are_not_served",
        ],
    ),
    (
        "relay_oversize_refused",
        &[
            "oversize_refused",
            "the_body_cap_holds_on_the_wire",
            "the_size_cap_is_the_largest_request_bucket",
            "a_large_answer_comes_back_whole",
        ],
    ),
    (
        "relay_panic_in_a_connection_stays_in_it",
        &["a_panic_in_a_connection_task_does_not_stop_the_relay"],
    ),
    ("relay_requires_proxy_hops", &["relay_requires_proxy_hops"]),
    (
        "relay_cut_mid_request",
        &[
            "relay_cut_mid_request",
            "an_unreachable_gateway_is_a_typed_502_with_no_fallback",
        ],
    ),
    (
        "gateway_never_sees_client_ip",
        &["gateway_never_sees_client_ip"],
    ),
    ("header_strip_canary", &["header_strip_canary"]),
    ("relay_no_retry_on_5xx", &["no_retries_on_a_5xx"]),
    (
        "relay_wrong_content_type_refused",
        &[
            "wrong_content_type_refused",
            "other_paths_and_methods_are_refused",
        ],
    ),
    (
        "relay_slow_bodies_of_one_64_and_small_bodies_are_bounded",
        &[
            "slow_bodies_from_one_prefix_do_not_take_the_relay_from_everyone",
            "bodies_are_bounded_by_bytes_received",
            "a_small_declared_body_gets_a_short_deadline",
        ],
    ),
    (
        "relay_declared_large_nothing_sent_is_dropped_in_the_progress_window",
        &["declared_large_and_nothing_sent_is_dropped_fast"],
    ),
    (
        "relay_one_v6_48_holds_at_most_16_body_slots",
        &["one_slash_48_cannot_take_every_body_slot"],
    ),
    (
        "relay_four_ipv4_cannot_take_the_byte_budget_and_16_fill_the_request_reserve",
        &[
            "four_ipv4_clients_cannot_take_the_byte_budget",
            "sixteen_addresses_is_what_it_takes_to_fill_the_request_reserve",
        ],
    ),
    (
        "relay_unread_answers_stay_counted_until_the_connection_ends",
        &["unread_answers_stay_in_the_budget"],
    ),
    (
        "relay_expect_refused_on_every_path_flood_included",
        &[
            "expect_on_another_path_gets_no_100_continue",
            "expect_gets_no_100_continue_when_the_flood_limit_is_hit",
        ],
    ),
    (
        "relay_drain_is_capped_at_64_kib_and_200_ms",
        &["the_drain_is_short"],
    ),
    (
        "relay_answer_counted_in_the_byte_budget",
        &["the_answer_is_counted_in_the_budget_and_given_back"],
    ),
    (
        "relay_cors_allow_list",
        &["cors_is_an_allow_list_with_max_age"],
    ),
    (
        "relay_end_to_end_sealed_request_fake_gateway",
        &["a_sealed_request_goes_through_the_relay_and_the_answer_opens"],
    ),
    (
        "relay_tree_is_small_and_links_no_hpke",
        &[
            "the_relay_tree_is_small_and_has_no_proc_macros",
            "the_relay_links_no_hpke_in_its_normal_dependencies",
        ],
    ),
];

/// `cargo test` of the whole relay crate, as { test name -> "ok" | "FAILED" | ... }. A test is
/// keyed by its name as `cargo test` prints it (`upstream::tests::...` for a unit test).
fn run_relay_tests() -> std::collections::HashMap<String, String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let out = std::process::Command::new(cargo)
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
        .args(["test", "--locked", "-p", "konclave-ohttp-relay"])
        .output()
        .expect("run cargo test for the relay");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let l = l.strip_prefix("test ")?;
            let (name, result) = l.split_once(" ... ")?;
            Some((name.to_string(), result.trim().to_string()))
        })
        .collect()
}

#[test]
fn acceptance() {
    type Check = (&'static str, fn() -> Result<(), String>);
    let checks: Vec<Check> = vec![
        ("round_trip", scenarios::round_trip),
        ("tampered_byte_request_refused", scenarios::tamper_request),
        ("tampered_byte_response_refused", scenarios::tamper_response),
        (
            "truncated_request_and_response_refused",
            scenarios::truncation,
        ),
        ("replay_refused", scenarios::replay),
        ("stale_date_refused", scenarios::stale_date),
        ("future_date_refused", scenarios::future_date),
        ("missing_date_refused", scenarios::missing_date),
        ("unknown_key_id_typed_error", scenarios::unknown_key_id),
        (
            "route_outside_allowlist_refused",
            scenarios::route_allowlist,
        ),
        ("forbidden_header_refused", scenarios::forbidden_header),
        (
            "replay_set_full_does_not_evict",
            scenarios::replay_full_no_evict,
        ),
        ("padded_sizes_on_buckets", scenarios::padding_buckets),
        (
            "response_fields_only_after_authentication",
            scenarios::response_authenticates_first,
        ),
        (
            "response_buckets_exponential",
            scenarios::response_buckets_exponential,
        ),
        ("wasm_default_unchanged", scenarios::wasm_default_unchanged),
    ];
    let mut failed = Vec::new();
    let mut rows = Vec::new();
    for (name, f) in &checks {
        let row = match f() {
            Ok(()) => serde_json::json!({"name": name, "result": "PASS", "source": MEASURED_BY}),
            Err(why) => {
                failed.push(format!("{name}: {why}"));
                serde_json::json!({"name": name, "result": "FAIL", "source": MEASURED_BY, "detail": why})
            }
        };
        rows.push(row);
    }
    // Checks another crate's tests, the browser or a script produce. This harness cannot run them.
    // Each is (name, the test that produces it, what to say when the file says nothing).
    let carried: &[(&str, &str, &str)] = &[
        ("pin_binds_full_config", "konclave-ohttp tests/pin.rs + ui/src/oblivious-transport.test.ts + .stack.test.ts", ""),
        ("fixed_byte_vectors", "konclave-ohttp tests/vectors.rs", ""),
        ("client_only_build_links_no_ohttp_server", "konclave-ohttp tests/features.rs", ""),
        ("relay_secret_required_before_read", "helper-server oblivious_dispatch::relay_secret_required_before_read", ""),
        ("budget_before_decapsulate", "helper-server oblivious_dispatch::budget_before_decapsulate", ""),
        ("no_cors_on_gateway", "helper-server oblivious_dispatch::no_cors_on_gateway", ""),
        ("typed_date_refusal", "helper-server oblivious_dispatch::typed_date_refusal + ui .stack.test.ts", ""),
        ("gateway_under_guarded", "helper-server oblivious_dispatch::gateway_under_guarded", ""),
        ("gateway_key_is_a_file", "helper-server oblivious_dispatch::the_key_file_and_the_secret_decide_the_boot", ""),
        ("gateway_key_file_private", "helper-server oblivious_dispatch::a_key_file_open_to_others_stops_the_boot + the_key_file_reader_refuses_a_file_others_can_read", ""),
        ("relay_address_is_a_v6_slash_64", "konclave-http tests::a_v6_slash_64_is_one_key_for_the_relay_and_other_keys_are_unchanged (only the relay asks for it; RateKey::address is unchanged)", ""),
        ("gateway_refuses_every_published_test_key", "konclave-ohttp tests/test_vector.rs::every_known_test_key_is_refused_as_a_key + no_key_file_text_the_server_accepts_is_written_in_the_repository + helper-server oblivious_dispatch::the_key_file_and_the_secret_decide_the_boot", ""),
        ("gateway_invalid_or_unreadable_key_file_stops_the_boot", "helper-server oblivious_dispatch::the_key_file_and_the_secret_decide_the_boot", ""),
        ("relay_hops_one_parser", "konclave-http tests::a_required_setting_refuses_blank_and_shares_the_parser (the relay's require_hops_choice calls it)", ""),
        ("relay_through_the_real_helper_gateway", "konclave-ohttp-relay tests/relay.rs::through_the_relay_to_the_real_helper_gateway (it PASSES, skipped, when KONCLAVE_TEST_HELPER_BIN is unset, so this run cannot measure it)", ""),
        ("idempotent_mailbox_retry", "no test: the mailbox is not a gateway yet", "needs the mailbox as a gateway, which is not built"),
        ("count_of_requests_and_bytes_per_hour_per_tab", "no test: measured on staging", "needs the mailbox as a gateway, which is not built; measured on staging"),
        ("wasm_client_round_trip_in_browser", "ui/e2e/oblivious-wasm-browser.spec.ts (needs the binaries and a wasm built with --features ohttp)", ""),
        ("browser_capture_lists_every_host_getting_the_ip", "no test: after private mode exists in the UI", "after private mode exists in the UI"),
        ("oblivious_budget_does_not_starve_direct", "helper-server oblivious_dispatch::oblivious_budget_does_not_starve_direct", ""),
        ("one_dispatch_fn_shared_with_serve", "helper-server oblivious_dispatch::one_dispatch_fn_shared_with_serve", ""),
        ("oblivious_creation_refused", "helper-server oblivious_dispatch::oblivious_creation_refused", ""),
        ("route_outside_list_refused_at_dispatch", "helper-server oblivious_dispatch::a_route_outside_the_list_is_refused_at_the_dispatch", ""),
        ("feature_off_changes_nothing", "helper-server oblivious_dispatch::feature_off_changes_nothing", ""),
        ("relay_tls_handshake_against_the_real_edge", "no test: needs the staging gateway", "needs a handshake of this ClientConfig against the real platform edge; not possible from the build machine"),
        ("per_vault_quota_after_authentication", "no test: not built", "needs a hook inside each handler's read-key / write-signature check; open decision"),
        ("wasm_api_native_round_trip", "konclave-wasm tests/ohttp_api.rs (--features ohttp)", ""),
        ("wasm_links_only_the_client_half", "konclave-wasm tests/ohttp_api.rs::wasm_links_only_the_client_half (--features ohttp)", ""),
        ("wasm_default_links_no_ohttp", "konclave-wasm tests/ohttp_off_by_default.rs", ""),
        ("transport_fails_closed_no_direct_fallback", "ui/src/oblivious-transport.test.ts", ""),
        ("transport_typed_error_per_failure", "ui/src/oblivious-transport.test.ts + .stack.test.ts", ""),
        ("transport_wasm_through_relay_to_real_helper", "ui/src/oblivious-transport.stack.test.ts (needs the binaries and a wasm built with --features ohttp)", ""),
        ("transport_reachable_from_nothing", "ui/src/oblivious-transport.test.ts", ""),
    ];
    // The relay's rows ARE measured here: this runs the relay's own tests (a real TLS gateway on
    // loopback, certificates made at test time, a fake plain gateway) and writes a row only from the
    // lines `cargo test` printed for the tests that row names. A test that is missing from the
    // output, or not `ok`, makes its row FAIL.
    let relay_run = run_relay_tests();
    for (name, tests) in RELAY_ROWS {
        let missing: Vec<&str> = tests
            .iter()
            .copied()
            .filter(|t| relay_run.get(*t).map(String::as_str) != Some("ok"))
            .collect();
        let row = if missing.is_empty() {
            serde_json::json!({"name": name, "result": "PASS", "source": RELAY_MEASURED_BY, "detail": format!("konclave-ohttp-relay: {}", tests.join(" + "))})
        } else {
            failed.push(format!("{name}: not ok or not run: {missing:?}"));
            serde_json::json!({"name": name, "result": "FAIL", "source": RELAY_MEASURED_BY, "detail": format!("not ok or not run: {missing:?}")})
        };
        rows.push(row);
    }
    let old: serde_json::Value = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ohttp-acceptance.json"
    ))
    .ok()
    .and_then(|t| serde_json::from_str(&t).ok())
    .unwrap_or(serde_json::Value::Null);
    for (name, produced_by, when_silent) in carried {
        let source = format!("carried: {produced_by}");
        let mut row = old["checks"]
            .as_array()
            .and_then(|a| a.iter().find(|c| c["name"] == *name))
            .cloned()
            .unwrap_or_else(|| {
                serde_json::json!({"name": name, "result": "NOT_RUN", "detail": if when_silent.is_empty() { "not recorded yet by the run that produces it" } else { when_silent }})
            });
        row["source"] = serde_json::Value::String(source);
        rows.push(row);
    }
    let mut json = String::from(
        "{\n  \"written_by\": \"konclave-ohttp tests/acceptance.rs\",\n  \"note\": \"A row with source 'measured: ...' was measured by the run that wrote this file. A row with source 'carried: <test>' keeps the result of that test from its own run; it is not re-measured here.\",\n  \"checks\": [\n",
    );
    let lines: Vec<String> = rows.iter().map(|r| format!("    {r}")).collect();
    json.push_str(&lines.join(",\n"));
    write!(json, "\n  ]\n}}\n").unwrap();
    std::fs::write(
        concat!(env!("CARGO_MANIFEST_DIR"), "/../ohttp-acceptance.json"),
        json,
    )
    .unwrap();
    assert!(failed.is_empty(), "{failed:?}");
}

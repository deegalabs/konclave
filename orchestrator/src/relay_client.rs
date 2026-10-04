//! A minimal client for the blind relay (Architecture B, helper side).
//!
//! The helper posts a signing request into a room and polls the room for the devices' response.
//! The HTTP transport is abstracted behind [`Transport`] so the post/poll logic is unit-tested
//! against the real in-process [`crate::relay::RelayState`] with no network dependency; the live
//! wiring supplies a thin blocking HTTP transport. The relay wire format (mirrored here):
//!   - POST `/api/relay/{room}`  body `{"from","data"}`   -> `{"seq","peers"}`
//!   - GET  `/api/relay/{room}?since={seq}&from={tag}`     -> `{"messages":[{seq,from,data}],"next","peers"}`

use serde::Deserialize;

/// The HTTP transport the client rides on. `post`/`get` return the raw response body bytes, or a
/// human-readable error. Kept tiny so a real impl (blocking HTTP) and a test impl (routing to
/// `RelayState::handle`) are both trivial.
pub trait Transport {
    fn post(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String>;
    fn get(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// One message read back from a room.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct InMsg {
    pub seq: u64,
    pub from: String,
    pub data: String,
}

/// The result of a poll: the new messages and the sequence to pass as `since` next time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Poll {
    pub messages: Vec<InMsg>,
    pub next: u64,
}

#[derive(Deserialize)]
struct PostResp {
    seq: u64,
}

#[derive(Deserialize)]
struct PollResp {
    messages: Vec<InMsg>,
    next: u64,
}

/// A client bound to one relay base URL, room, and `from` tag.
pub struct RelayClient<T: Transport> {
    transport: T,
    /// Base URL with no trailing slash, e.g. `https://relay.example` (may be empty for a
    /// path-only transport in tests).
    base: String,
    room: String,
    from: String,
}

impl<T: Transport> RelayClient<T> {
    pub fn new(
        transport: T,
        base: impl Into<String>,
        room: impl Into<String>,
        from: impl Into<String>,
    ) -> Self {
        RelayClient {
            transport,
            base: base.into(),
            room: room.into(),
            from: from.into(),
        }
    }

    /// Post an opaque `data` string into the room; returns the assigned sequence number.
    pub fn post(&self, data: &str) -> Result<u64, String> {
        self.check_room()?;
        let url = format!("{}/api/relay/{}", self.base, self.room);
        let body = serde_json::to_vec(&serde_json::json!({ "from": self.from, "data": data }))
            .map_err(|e| e.to_string())?;
        let resp = self.transport.post(&url, &body)?;
        let v: PostResp = serde_json::from_slice(&resp).map_err(|e| format!("post resp: {e}"))?;
        Ok(v.seq)
    }

    /// Poll for everything after `since`. Marks this client present in the room (via `from`).
    pub fn poll(&self, since: u64) -> Result<Poll, String> {
        self.check_room()?;
        let url = format!(
            "{}/api/relay/{}?since={}&from={}",
            self.base, self.room, since, self.from
        );
        let resp = self.transport.get(&url)?;
        let v: PollResp = serde_json::from_slice(&resp).map_err(|e| format!("poll resp: {e}"))?;
        Ok(Poll {
            messages: v.messages,
            next: v.next,
        })
    }

    /// The room is part of the URL this client calls, so a name that could shape the path or the
    /// query is refused here, where the URL is composed, and not left to each caller (#270).
    fn check_room(&self) -> Result<(), String> {
        if valid_room(&self.room) {
            Ok(())
        } else {
            Err("invalid room name".into())
        }
    }

    /// Poll once and return the first message (after `since`, in sequence order) whose `data`
    /// satisfies `pred`, along with the sequence to continue from. `None` if none matched yet.
    /// The caller owns the retry loop and its delay, so this stays synchronous and testable.
    pub fn find<F>(&self, since: u64, pred: F) -> Result<(Option<InMsg>, u64), String>
    where
        F: Fn(&str) -> bool,
    {
        let p = self.poll(since)?;
        let hit = p.messages.iter().find(|m| pred(&m.data)).cloned();
        Ok((hit, p.next))
    }
}

/// Why a relay base named by a request was refused (#270).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayRefusal {
    /// This process has no relay configured, so it publishes nowhere.
    NoneConfigured,
    /// The request named a relay that is not one of this process's own.
    NotOurs,
}

impl RelayRefusal {
    /// The reason, for the caller to answer with. It never lists the relays that are allowed.
    pub fn message(self) -> &'static str {
        match self {
            RelayRefusal::NoneConfigured => "this coordinator has no relay configured",
            RelayRefusal::NotOurs => "this coordinator only talks to its own relay",
        }
    }
}

/// The relay a request may publish to, out of the ones this process was configured with (#270).
///
/// The relay base used to come from the request and go to `curl` unchecked: the coordinator would
/// fetch any URL from its own network, and on a vault where not every seat had registered a device
/// key the signing request - who the vault pays and how much - went out in clear text to whatever
/// address the request named.
///
/// The match is exact, apart from trailing slashes, and what comes back is the CONFIGURED string,
/// so the bytes `curl` receives always come from the operator's configuration and never from the
/// request.
pub fn configured_relay<'a>(
    requested: &str,
    configured: &'a [String],
) -> Result<&'a str, RelayRefusal> {
    if configured.is_empty() {
        return Err(RelayRefusal::NoneConfigured);
    }
    let requested = requested.trim_end_matches('/');
    configured
        .iter()
        .map(|c| c.trim_end_matches('/'))
        .find(|c| *c == requested)
        .ok_or(RelayRefusal::NotOurs)
}

/// The relay bases in a configuration value (comma-separated), as `(accepted, rejected)`.
///
/// Accepted only as `https://host[:port]`, lowercase, with no userinfo, path, query or fragment: a
/// relay is an origin, and anything more is either a mistake or a way to aim the coordinator
/// somewhere else. The rejected entries are returned so the caller can say so at boot.
pub fn parse_relay_config(raw: &str) -> (Vec<String>, Vec<String>) {
    let mut accepted: Vec<String> = Vec::new();
    let mut rejected = Vec::new();
    for entry in raw.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let base = entry.trim_end_matches('/');
        if is_https_origin(base) {
            if !accepted.iter().any(|a| a == base) {
                accepted.push(base.to_string());
            }
        } else {
            rejected.push(entry.to_string());
        }
    }
    (accepted, rejected)
}

fn is_https_origin(base: &str) -> bool {
    let Some(authority) = base.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    let host_ok = !host.is_empty()
        && !host.starts_with(['.', '-'])
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    let port_ok = match port {
        None => true,
        Some(p) => p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n > 0),
    };
    host_ok && port_ok
}

/// A room name this client may put in a URL: 1 to 64 ASCII letters, digits, `-` or `_`. The app's
/// rooms are an 8-character code or 32 hex characters; nothing in this set can add a path segment,
/// a query or an escape.
pub fn valid_room(room: &str) -> bool {
    (1..=64).contains(&room.len())
        && room
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The arguments for one `curl` call (#270): no `.curlrc`, no proxy, https only (redirects
/// included), and the URL after `--`, so no value can ever be read as an option.
///
/// `-q` has to be the FIRST argument, which is the only place curl honours it. Without it curl
/// reads `$HOME/.curlrc`, and the coordinator's HOME is its durable volume: a file there could add
/// a second URL, a different address for the relay's name, or `insecure`. `--noproxy "*"` keeps a
/// proxy variable in the environment from routing the request elsewhere. With both, every byte
/// that decides where the request goes is on this command line.
fn curl_args(post: bool, url: &str) -> Vec<&str> {
    let mut args = vec![
        "-q",
        "-sS",
        "--noproxy",
        "*",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
    ];
    if post {
        args.extend([
            "-X",
            "POST",
            "-H",
            "content-type: application/json",
            "--data-binary",
            "@-",
        ]);
    }
    args.extend(["--", url]);
    args
}

/// The production transport: shell out to `curl`. The orchestrator already depends on external
/// binaries (frostd, frost-client, zcash-devtool, konclave-signer), so `curl` is a consistent,
/// dependency-free way to speak plain HTTP to the relay. The POST body goes over stdin so a large
/// PCZT hex never hits an argv length limit.
pub struct CurlTransport {
    /// The curl to run: `curl` from PATH, always, outside tests. A test points it at a recorder
    /// to see the argv the transport really passes.
    program: std::path::PathBuf,
}

impl Default for CurlTransport {
    fn default() -> Self {
        CurlTransport {
            program: "curl".into(),
        }
    }
}

impl Transport for CurlTransport {
    fn post(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new(&self.program)
            .args(curl_args(true, url))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("curl spawn: {e}"))?;
        {
            let mut stdin = child.stdin.take().ok_or("curl: no stdin")?;
            stdin
                .write_all(body)
                .map_err(|e| format!("curl stdin: {e}"))?;
        } // closing stdin here lets curl finish reading the body
        let out = child.wait_with_output().map_err(|e| format!("curl: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "curl POST failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(out.stdout)
    }

    fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        let out = std::process::Command::new(&self.program)
            .args(curl_args(false, url))
            .output()
            .map_err(|e| format!("curl: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "curl GET failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(out.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::RelayState;
    use std::sync::Arc;

    /// A test transport that routes straight to a real `RelayState`, so these tests exercise the
    /// client AND the relay together, in-process, with no sockets. A fixed clock keeps it pure.
    struct LocalRelay {
        state: Arc<RelayState>,
    }

    impl LocalRelay {
        fn split_path(url: &str) -> (String, String) {
            // url is ".../api/relay/{room}[?query]"; return (clean_path, raw_path_with_query).
            let start = url.find("/api/relay/").expect("relay url");
            let raw = url[start..].to_string();
            let clean = raw.split('?').next().unwrap_or(&raw).to_string();
            (clean, raw)
        }
    }

    impl Transport for LocalRelay {
        fn post(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            let (path, raw) = Self::split_path(url);
            let r = self.state.handle("POST", &path, &raw, body, 1000);
            if r.status != 200 {
                return Err(format!("relay {}", r.status));
            }
            Ok(r.body)
        }
        fn get(&self, url: &str) -> Result<Vec<u8>, String> {
            let (path, raw) = Self::split_path(url);
            let r = self.state.handle("GET", &path, &raw, &[], 1000);
            if r.status != 200 {
                return Err(format!("relay {}", r.status));
            }
            Ok(r.body)
        }
    }

    fn client(state: Arc<RelayState>, from: &str) -> RelayClient<LocalRelay> {
        RelayClient::new(LocalRelay { state }, "", "room-xyz", from)
    }

    #[test]
    fn post_then_poll_round_trips_the_message() {
        let state = Arc::new(RelayState::new());
        let helper = client(state.clone(), "helper");
        let seq = helper.post("hello-devices").unwrap();
        assert_eq!(seq, 1);

        // A different client in the same room reads it back.
        let device = client(state, "device");
        let p = device.poll(0).unwrap();
        assert_eq!(p.messages.len(), 1);
        assert_eq!(p.messages[0].data, "hello-devices");
        assert_eq!(p.messages[0].from, "helper");
        assert_eq!(p.next, 1);

        // Polling again from `next` yields nothing new.
        assert!(device.poll(p.next).unwrap().messages.is_empty());
    }

    #[test]
    fn find_returns_the_first_matching_message() {
        let state = Arc::new(RelayState::new());
        let helper = client(state.clone(), "helper");
        helper.post("net-sign-request:...").unwrap();
        helper.post("ceremony-noise").unwrap();
        helper.post("net-sign-response:...").unwrap();

        let reader = client(state, "reader");
        let (hit, next) = reader
            .find(0, |d| d.starts_with("net-sign-response"))
            .unwrap();
        assert_eq!(hit.unwrap().data, "net-sign-response:...");
        assert_eq!(next, 3);

        // Nothing matches -> None, but `next` still advances so we don't re-scan.
        let (miss, _) = reader.find(0, |d| d == "absent").unwrap();
        assert!(miss.is_none());
    }

    #[test]
    fn a_request_gets_only_a_configured_relay_and_the_configured_bytes() {
        let ours = vec![
            "https://relay.konclave.xyz".to_string(),
            "https://konclave-relay-production.up.railway.app".to_string(),
        ];
        assert_eq!(
            configured_relay("https://relay.konclave.xyz", &ours),
            Ok("https://relay.konclave.xyz")
        );
        assert_eq!(
            configured_relay("https://relay.konclave.xyz/", &ours),
            Ok("https://relay.konclave.xyz"),
            "a trailing slash is the same relay, and the configured spelling is what is used"
        );
        assert_eq!(
            configured_relay("https://konclave-relay-production.up.railway.app", &ours),
            Ok("https://konclave-relay-production.up.railway.app")
        );
        for other in [
            "https://evil.example",
            "http://relay.konclave.xyz",
            "-K/etc/passwd",
            "--config=/etc/passwd",
            "https://relay.konclave.xyz@evil.example",
            "https://relay.konclave.xyz.evil.example",
            "https://relay.konclave.xyz:8443",
            "https://relay.konclave.xyz/api",
            "HTTPS://RELAY.KONCLAVE.XYZ",
            " https://relay.konclave.xyz",
            "",
        ] {
            assert_eq!(
                configured_relay(other, &ours),
                Err(RelayRefusal::NotOurs),
                "{other:?}"
            );
        }
        assert_eq!(
            configured_relay("https://relay.konclave.xyz", &[]),
            Err(RelayRefusal::NoneConfigured),
            "with no relay configured there is no default to fall back on"
        );
    }

    #[test]
    fn a_relay_configuration_accepts_only_https_origins() {
        let (ok, bad) = parse_relay_config(
            " https://relay.konclave.xyz/ , https://konclave-relay-staging.up.railway.app,,\
             https://relay.konclave.xyz, https://relay.test:8443",
        );
        assert_eq!(
            ok,
            vec![
                "https://relay.konclave.xyz",
                "https://konclave-relay-staging.up.railway.app",
                "https://relay.test:8443",
            ]
        );
        assert!(bad.is_empty(), "{bad:?}");

        for wrong in [
            "http://relay.konclave.xyz",
            "relay.konclave.xyz",
            "https://",
            "https://user@relay.konclave.xyz",
            "https://relay.konclave.xyz/api/relay",
            "https://relay.konclave.xyz?x=1",
            "https://relay.konclave.xyz#x",
            "https://Relay.Konclave.xyz",
            "https://relay konclave.xyz",
            "https://-relay.xyz",
            "https://relay.xyz:0",
            "https://relay.xyz:99999",
            "https://relay.xyz:",
        ] {
            let (ok, bad) = parse_relay_config(wrong);
            assert!(ok.is_empty(), "{wrong:?} was accepted");
            assert_eq!(bad, vec![wrong.to_string()], "{wrong:?}");
        }
        assert_eq!(parse_relay_config(""), (vec![], vec![]));
    }

    #[test]
    fn a_room_is_a_plain_name() {
        for ok in [
            "ABCD2345",
            "0123456789abcdef0123456789abcdef",
            "room-xyz",
            "vault_room",
        ] {
            assert!(valid_room(ok), "{ok:?}");
        }
        let long = "A".repeat(65);
        for bad in [
            "",
            "a/b",
            "x?since=99",
            "..",
            "r%2F",
            "a b",
            "sala\u{e9}",
            "#x",
            long.as_str(),
        ] {
            assert!(!valid_room(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_client_refuses_to_compose_a_url_around_an_invalid_room() {
        let state = Arc::new(RelayState::new());
        let c = RelayClient::new(LocalRelay { state }, "", "x?since=9", "helper");
        assert!(c.post("data").is_err());
        assert!(c.poll(0).is_err());
    }

    #[test]
    fn curl_takes_https_only_and_the_url_after_the_end_of_options() {
        for post in [true, false] {
            let args = curl_args(post, "-K/etc/passwd");
            let w = args.windows(2).collect::<Vec<_>>();
            // `-q` is only honoured as the FIRST argument, and it is what keeps curl from reading a
            // `.curlrc`; the coordinator's HOME is the durable volume.
            assert_eq!(args[0], "-q", "{args:?}");
            assert!(w.contains(&["--noproxy", "*"].as_slice()), "{args:?}");
            assert!(w.contains(&["--proto", "=https"].as_slice()), "{args:?}");
            assert!(
                w.contains(&["--proto-redir", "=https"].as_slice()),
                "{args:?}"
            );
            assert_eq!(args[args.len() - 2..], ["--", "-K/etc/passwd"], "{args:?}");
        }
        assert!(curl_args(true, "u")
            .windows(2)
            .any(|w| w == ["--data-binary", "@-"]));
    }

    /// The transport itself runs curl with exactly those arguments, for both methods: the argument
    /// test above says nothing about the code that spawns the process. A recorder stands in for
    /// curl and writes down the argv it was given.
    #[cfg(unix)]
    #[test]
    fn the_transport_runs_curl_with_exactly_the_hardened_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("konclave-fake-curl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("argv");
        let program = dir.join("curl");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' \"$@\" > '{}'\nprintf ok\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t = CurlTransport { program };
        // A freshly written script can be briefly busy while another test thread forks.
        let retry = |call: &dyn Fn() -> Result<Vec<u8>, String>| {
            for _ in 0..20 {
                match call() {
                    Err(e) if e.contains("busy") => {
                        std::thread::sleep(std::time::Duration::from_millis(20))
                    }
                    other => return other,
                }
            }
            call()
        };
        let url = "https://relay.test/api/relay/ROOM2345";
        let recorded = || {
            std::fs::read_to_string(&log)
                .unwrap()
                .lines()
                .map(str::to_string)
                .collect::<Vec<_>>()
        };

        assert_eq!(retry(&|| t.get(url)).unwrap(), b"ok");
        assert_eq!(recorded(), curl_args(false, url));
        assert_eq!(retry(&|| t.post(url, b"{}")).unwrap(), b"ok");
        assert_eq!(recorded(), curl_args(true, url));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

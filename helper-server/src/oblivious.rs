//! The oblivious gateway's glue to the coordinator: the switch, the key, the relay's secret, the two
//! endpoints, and nothing else. The HPKE and the message format are `konclave-ohttp`'s; which
//! routes, the origin type and the budget are `konclave-http`'s; the request itself is run by
//! `crate::dispatch`, the same function a direct request goes through. This file decides none of
//! those.

use konclave_ohttp::{
    encapsulate_response, key_config_from_text, Gateway, InnerRequest, Refusal, Rejected,
    ResponseCtx,
};
use tiny_http::Method;

use crate::Resp;

/// The switch. Anything but `1` leaves the whole feature off: no key is read, `/api/ohttp` and
/// `/api/ohttp-keys` are routes the coordinator does not have, and a request goes exactly where it
/// went before.
pub const SWITCH_VAR: &str = "KONCLAVE_OHTTP";
/// With the switch on, the file holding the gateway's key: ONE line, `<key id 0-255> <64 hex>`
/// (the id the operator chooses, then 32 bytes of secret key material). The key is the file's, so a
/// restart is the same key; a new key is a new file with a new id. Nothing generates one.
pub const KEY_FILE_VAR: &str = "KONCLAVE_OHTTP_KEY_FILE";
/// With the switch on, the secret the OHTTP relay sends in [`RELAY_SECRET_HEADER`]. The gateway
/// reads nothing of a request that does not carry it.
pub const RELAY_SECRET_VAR: &str = "KONCLAVE_OHTTP_RELAY_SECRET";
pub use konclave_http::RELAY_SECRET_HEADER;
/// Shorter than this is a word, not a secret.
pub const MIN_SECRET_LEN: usize = 16;
pub const EXCHANGE_PATH: &str = "/api/ohttp";
pub const KEYS_PATH: &str = "/api/ohttp-keys";

/// What the gateway answers itself, as opposed to handing to the inner dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Keys,
    Exchange,
}

/// The gateway and the secret of the relay allowed to use it.
pub struct Gate {
    pub gateway: Gateway,
    secret: Vec<u8>,
}

impl Gate {
    /// True if `presented` is the relay's secret. Compared with `orchestrator::helper::ct_eq`, the
    /// repo's one constant-time byte compare, which reveals only the length and not where a wrong
    /// byte is. An empty secret never matches.
    #[must_use]
    pub fn secret_ok(&self, presented: Option<&str>) -> bool {
        let given = presented.map_or(&[][..], str::as_bytes);
        !self.secret.is_empty() && orchestrator::helper::ct_eq(given, &self.secret)
    }
}

/// What the environment asked for.
pub enum Boot {
    /// The switch is not on.
    Off,
    On(Gate),
    /// The switch is on without what it needs to be on safely: the coordinator must not start.
    Refuse(String),
}

/// Decide the gateway from the environment's values. `read_file` reads the key file. Pure, so each
/// outcome is a test.
pub fn boot_with(
    switch: Option<&str>,
    key_file: Option<&str>,
    secret: Option<&str>,
    read_file: impl FnOnce(&str) -> std::io::Result<String>,
    now: i64,
) -> Boot {
    boot_inner(
        switch,
        key_file,
        secret,
        read_file,
        now,
        key_config_from_text,
    )
}

/// [`boot_with`] that accepts the repository's known test keys, for this crate's own tests. It
/// exists only in a test build; the boot the coordinator runs is `boot_with`, which refuses them.
#[cfg(test)]
pub(crate) fn boot_with_test_keys(
    switch: Option<&str>,
    key_file: Option<&str>,
    secret: Option<&str>,
    read_file: impl FnOnce(&str) -> std::io::Result<String>,
    now: i64,
) -> Boot {
    boot_inner(
        switch,
        key_file,
        secret,
        read_file,
        now,
        konclave_ohttp::key_config_from_text_for_tests,
    )
}

fn boot_inner(
    switch: Option<&str>,
    key_file: Option<&str>,
    secret: Option<&str>,
    read_file: impl FnOnce(&str) -> std::io::Result<String>,
    now: i64,
    parse_key: fn(&str) -> Result<konclave_ohttp::KeyConfig, konclave_ohttp::KeyFileError>,
) -> Boot {
    if switch != Some("1") {
        return Boot::Off;
    }
    let Some(path) = key_file.filter(|p| !p.is_empty()) else {
        return Boot::Refuse(format!(
            "{SWITCH_VAR}=1 needs {KEY_FILE_VAR}: the gateway's key is a file the operator provides, never one made at boot"
        ));
    };
    let Some(secret) = secret.filter(|s| s.len() >= MIN_SECRET_LEN) else {
        return Boot::Refuse(format!(
            "{SWITCH_VAR}=1 needs {RELAY_SECRET_VAR} of at least {MIN_SECRET_LEN} characters: the gateway answers only the relay that holds it"
        ));
    };
    let mut text = match read_file(path) {
        Ok(t) => t,
        // A file that cannot be read for its permissions is not "no gateway": the operator asked
        // for one, and its key is exposed or out of reach. Stop, like a missing key file does.
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Boot::Refuse(format!(
                "{SWITCH_VAR}=1 but the key file named by {KEY_FILE_VAR} is not readable only by this process (mode 0600 or 0400 is required)"
            ))
        }
        // Missing, unreadable for any other reason: the same. A switch that is on and a gateway
        // that quietly is not would look like a gateway that is on.
        Err(_) => {
            return Boot::Refuse(format!(
                "{SWITCH_VAR}=1 but the key file named by {KEY_FILE_VAR} could not be read"
            ))
        }
    };
    let parsed = parse_key(&text);
    // The text held the key material in hex: do not leave it behind.
    zeroize::Zeroize::zeroize(&mut text);
    let config = match parsed {
        Ok(c) => c,
        Err(e) => {
            return Boot::Refuse(format!(
                "{SWITCH_VAR}=1 but the key file named by {KEY_FILE_VAR} is not usable: {e}"
            ))
        }
    };
    match Gateway::new(config, now) {
        Ok(gateway) => Boot::On(Gate {
            gateway,
            secret: secret.as_bytes().to_vec(),
        }),
        Err(_) => Boot::Refuse(format!(
            "{SWITCH_VAR}=1 but the key in {KEY_FILE_VAR} could not be loaded"
        )),
    }
}

/// The key file as the boot reads it. On unix a file that group or others can read is refused
/// (`PermissionDenied`, with no word of the file in the message): the key is a secret and a volume
/// is shared. The mode is read from the OPEN file, so it cannot change between the check and the
/// read.
pub fn read_key_file(path: &str) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file.metadata()?.permissions().mode() & 0o077 != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the key file is readable by group or others",
            ));
        }
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

/// [`boot_with`] on the real environment and file system. Logs one line; refuses to start (exit 2)
/// when the switch is on without a key file or a relay secret.
pub fn boot_from_env(now: i64) -> Option<Gate> {
    let var = |k: &str| std::env::var(k).ok();
    match boot_with(
        var(SWITCH_VAR).as_deref(),
        var(KEY_FILE_VAR).as_deref(),
        var(RELAY_SECRET_VAR).as_deref(),
        read_key_file,
        now,
    ) {
        Boot::Off => None,
        Boot::Refuse(why) => {
            eprintln!("konclave-helper: {why}");
            std::process::exit(2);
        }
        Boot::On(gate) => {
            // The key configuration is public: the line is how the operator gets what the bundle pins.
            eprintln!(
                "oblivious gateway: ON ({SWITCH_VAR}=1), key id {}",
                gate.gateway.key_id()
            );
            Some(gate)
        }
    }
}

/// Which gateway endpoint a request is for. With no gateway it is none, for every request.
pub fn endpoint(gate: Option<&Gate>, method: &Method, path: &str) -> Option<Endpoint> {
    gate?;
    let bare = path.split('?').next().unwrap_or(path);
    match (method, bare) {
        (Method::Get, KEYS_PATH) => Some(Endpoint::Keys),
        (Method::Post, EXCHANGE_PATH) => Some(Endpoint::Exchange),
        _ => None,
    }
}

/// True for the paths the gateway owns when it is on. These answers carry NO CORS header: the only
/// caller of `/api/ohttp` is the relay, server to server, and a page that could reach it directly
/// would hand the coordinator its address in a request that claims not to.
#[must_use]
pub fn owns_path(gate_on: bool, path: &str) -> bool {
    let bare = path.split('?').next().unwrap_or(path);
    gate_on && (bare == EXCHANGE_PATH || bare == KEYS_PATH)
}

/// An answer that is not JSON: the caller sends it, with no CORS headers.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Answer {
    fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.as_bytes().to_vec(),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: Vec::new(),
        }
    }
}

/// The media type of a refusal the gateway makes itself, outside and inside the seal.
pub const PROBLEM_TYPE: &str = "application/problem+json";

/// The relay's secret was missing or wrong: nothing was read.
pub fn forbidden() -> Answer {
    Answer::json(403, r#"{"error":"forbidden"}"#)
}

/// The oblivious budget is spent: nothing was read. The outer answer, because nothing was opened.
pub fn budget_spent() -> Answer {
    Answer::json(429, r#"{"error":"rate limited"}"#)
}

pub fn keys(gate: &Gate) -> Answer {
    match gate.gateway.config_list() {
        Ok(body) => Answer {
            status: 200,
            content_type: "application/ohttp-keys",
            body,
        },
        Err(_) => Answer::empty(500),
    }
}

/// An unplanned failure while serving the gateway: an answer that says nothing, so the worker lives.
pub fn failed() -> Answer {
    Answer::empty(500)
}

fn sealed(ctx: ResponseCtx, status: u16, content_type: &str, body: &[u8]) -> Answer {
    match encapsulate_response(ctx, status, content_type, body) {
        Ok(body) => Answer {
            status: 200,
            content_type: "message/ohttp-res",
            body,
        },
        Err(_) => Answer::empty(500),
    }
}

/// The answer to a request the gateway refused. A refusal after the request opened is SEALED, typed,
/// so the client can say what is wrong (its clock, a replay, a full set) and nobody else can read
/// which check failed. An unknown key id is answered outside, typed too: the id is public, and the
/// client's right response is "update the app", never "fetch another key". Anything else is a bare
/// 400 and says nothing.
pub fn refusal_answer(rejected: Rejected, now: i64) -> Answer {
    let Rejected { refusal, ctx } = rejected;
    match (refusal, ctx) {
        (Refusal::UnknownKeyId(_), _) => Answer {
            status: 401,
            content_type: PROBLEM_TYPE,
            body: br#"{"type":"key_mismatch"}"#.to_vec(),
        },
        (Refusal::StaleDate | Refusal::FutureDate, Some(ctx)) => sealed(
            ctx,
            400,
            PROBLEM_TYPE,
            format!(r#"{{"type":"clock_skew","server_time":{now}}}"#).as_bytes(),
        ),
        (Refusal::Replay, Some(ctx)) => sealed(ctx, 409, PROBLEM_TYPE, br#"{"type":"replayed"}"#),
        (Refusal::ReplaySetFull, Some(ctx)) => {
            sealed(ctx, 503, PROBLEM_TYPE, br#"{"type":"busy"}"#)
        }
        _ => Answer::empty(400),
    }
}

/// One encapsulated request, ALREADY admitted (secret checked, budget charged, body read): open it,
/// have `run` answer the inner request, seal the answer. `run` is the dispatch with the oblivious
/// origin and the only thing that touches the coordinator.
pub fn exchange(
    gate: &Gate,
    now: i64,
    enc: &[u8],
    run: impl FnOnce(&InnerRequest) -> Resp,
) -> Answer {
    let (inner, ctx) = match gate.gateway.open(enc, now) {
        Ok(opened) => opened,
        Err(rejected) => return refusal_answer(rejected, now),
    };
    let answer = run(&inner);
    sealed(
        ctx,
        answer.status,
        "application/json",
        answer.body.as_bytes(),
    )
}

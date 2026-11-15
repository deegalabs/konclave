//! The gateway half: open a request, check it, seal the answer.

use std::{collections::HashMap, sync::Mutex};

use ohttp::hpke::{Aead, Kdf, Kem};
use sha2::{Digest, Sha256};

use crate::{
    bhttp_map,
    padding::{self, RESPONSE_OVERHEAD},
    InnerRequest, Refusal,
};

/// A request is accepted when its date is within this many seconds of `now`, either side.
pub const WINDOW_SECS: i64 = 300;
/// How many distinct requests the replay set holds. Full means new requests are refused.
pub const REPLAY_CAPACITY: usize = 65_536;

/// Generate a fresh, random key configuration (X25519 / HKDF-SHA256 / AES-128-GCM only). For tests
/// and tools: a gateway that serves people takes its key from a file ([`key_config_from_text`]),
/// because a key made at boot is a new key at every restart and a configuration nobody can pin.
pub fn generate_key_config(key_id: u8) -> Result<ohttp::KeyConfig, ohttp::Error> {
    ohttp::KeyConfig::new(
        key_id,
        Kem::X25519Sha256,
        vec![ohttp::SymmetricSuite::new(Kdf::HkdfSha256, Aead::Aes128Gcm)],
    )
}

/// Why a key file was refused. The text never contains any of the file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyFileError {
    #[error("the key file must be one line: <key id 0-255> <64 hex characters>")]
    Shape,
    #[error("the key id is not a whole number from 0 to 255")]
    KeyId,
    #[error("the key material is not 64 hex characters")]
    Material,
    #[error("the key material is all zeros")]
    Zeros,
    #[error(
        "the key material is a published test key, which everyone who reads the repository knows"
    )]
    TestVector,
    #[error("the key could not be derived")]
    Derive,
}

/// The gateway's persistent key configuration from the text of its key file: a key id the OPERATOR
/// chooses, a space, and 32 bytes of secret key material in hex (`openssl rand -hex 32`). The key
/// pair is derived from the material (HPKE `DeriveKeyPair`), so the same file is the same key after
/// every restart, and a new key is a new file with a new id: an id is never reused for another key.
///
/// Every key the repository publishes (`KNOWN_TEST_KEYS`: the test vector `000102...1f` and the other
/// fixed key its tests used) is refused: a gateway on one would let anyone who read the repository
/// open its requests. Tests that need it use
/// `key_config_from_text_for_tests`, which exists only behind the `test-keys` feature.
pub fn key_config_from_text(text: &str) -> Result<ohttp::KeyConfig, KeyFileError> {
    key_config(text, false)
}

/// [`key_config_from_text`] that also accepts the known test keys, for the tests that need a
/// fixed key. Compiled only with the `test-keys` feature, and no server code path calls it (the
/// coordinator's boot reads `key_config_from_text`; a test scans for the other).
#[cfg(feature = "test-keys")]
#[doc(hidden)]
pub fn key_config_from_text_for_tests(text: &str) -> Result<ohttp::KeyConfig, KeyFileError> {
    key_config(text, true)
}

/// EVERY key this repository publishes, in lowercase hex: the first is the test vector (bytes 0
/// to 31), the others the fixed patterns the coordinator's and the relay's tests used. A gateway on any of them would let
/// whoever reads the repository open its requests, so [`key_config_from_text`] refuses them all and
/// only `key_config_from_text_for_tests` accepts them. The tests build their key files from THIS
/// list (`test_key_text`), so a key cannot be published in a test without being refused here: do
/// not write a key file's text anywhere else (a test scans for it).
const KNOWN_TEST_KEYS: [&str; 3] = [
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "8f2a4c6e8092b4d6f80a1c3e5072849ab1c3d5e7f90a2c4e6081a3c5e7092b4d",
    "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
];

/// The text of a key file made of the `which`th known test key and key id `id`. Behind the
/// `test-keys` feature, like the function that accepts it.
#[cfg(feature = "test-keys")]
#[doc(hidden)]
pub fn test_key_text(which: usize, id: u8) -> String {
    format!("{id} {}", KNOWN_TEST_KEYS[which])
}

fn key_config(text: &str, allow_test_keys: bool) -> Result<ohttp::KeyConfig, KeyFileError> {
    let mut parts = text.trim_end_matches(['\n', '\r']).split(' ');
    let (Some(id), Some(material), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(KeyFileError::Shape);
    };
    let key_id: u8 = id.parse().map_err(|_| KeyFileError::KeyId)?;
    if material.len() != 64 || !material.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(KeyFileError::Material);
    }
    let mut ikm = [0u8; 32];
    for (i, byte) in ikm.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&material[2 * i..2 * i + 2], 16)
            .map_err(|_| KeyFileError::Material)?;
    }
    let config = if ikm == [0u8; 32] {
        Err(KeyFileError::Zeros)
    } else if !allow_test_keys
        && KNOWN_TEST_KEYS
            .iter()
            .any(|k| k.eq_ignore_ascii_case(material))
    {
        Err(KeyFileError::TestVector)
    } else {
        ohttp::KeyConfig::derive(
            key_id,
            Kem::X25519Sha256,
            vec![ohttp::SymmetricSuite::new(Kdf::HkdfSha256, Aead::Aes128Gcm)],
            &ikm,
        )
        .map_err(|_| KeyFileError::Derive)
    };
    // The secret does not outlive the derivation on this stack.
    zeroize::Zeroize::zeroize(&mut ikm);
    config
}

/// SHA-256s of accepted encapsulated requests, each kept until its date leaves the window.
/// Refuse-on-full: a full set rejects new entries and never evicts an old one, because evicting
/// would let an attacker who can fill it make an old request replayable.
#[derive(Debug)]
pub struct ReplaySet {
    capacity: usize,
    entries: HashMap<[u8; 32], i64>,
}

impl ReplaySet {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Record `hash`, valid until `expires` (unix seconds). Entries past their expiry at `now`
    /// are dropped first: they could only be replayed as stale, which is refused anyway.
    pub fn insert(&mut self, hash: [u8; 32], now: i64, expires: i64) -> Result<(), Refusal> {
        self.entries.retain(|_, exp| *exp >= now);
        if self.entries.contains_key(&hash) {
            return Err(Refusal::Replay);
        }
        if self.entries.len() >= self.capacity {
            return Err(Refusal::ReplaySetFull);
        }
        self.entries.insert(hash, expires);
        Ok(())
    }
}

/// Held between decapsulating a request and answering it. Single use.
pub struct ResponseCtx(ohttp::ServerResponse);

impl std::fmt::Debug for ResponseCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ResponseCtx")
    }
}

pub struct Gateway {
    server: ohttp::Server,
    key_id: u8,
    floor_unix: i64,
    replay: Mutex<ReplaySet>,
}

impl Gateway {
    /// `floor_unix` is the boot time: a request dated before it is refused, because the replay
    /// set did not exist then and cannot vouch that the request is new.
    pub fn new(config: ohttp::KeyConfig, floor_unix: i64) -> Result<Self, ohttp::Error> {
        Self::with_capacity(config, floor_unix, REPLAY_CAPACITY)
    }

    pub fn with_capacity(
        config: ohttp::KeyConfig,
        floor_unix: i64,
        capacity: usize,
    ) -> Result<Self, ohttp::Error> {
        let key_id = *config.encode()?.first().ok_or(ohttp::Error::Format)?;
        Ok(Self {
            server: ohttp::Server::new(config)?,
            key_id,
            floor_unix,
            replay: Mutex::new(ReplaySet::new(capacity)),
        })
    }

    /// The key configuration list to serve (application/ohttp-keys).
    pub fn config_list(&self) -> Result<Vec<u8>, ohttp::Error> {
        let one = self.server.config().encode()?;
        let mut out = u16::try_from(one.len())
            .map_err(|_| ohttp::Error::Format)?
            .to_be_bytes()
            .to_vec();
        out.extend_from_slice(&one);
        Ok(out)
    }

    #[must_use]
    pub fn key_id(&self) -> u8 {
        self.key_id
    }

    /// How many requests the replay set remembers now.
    #[must_use]
    pub fn replay_len(&self) -> usize {
        self.replay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// Open and check one encapsulated request, and keep the means to answer it if it opened.
    ///
    /// Which ROUTES may be reached is not decided here (that is `konclave_http::route_is_oblivious`,
    /// applied by the dispatch). The replay entry is recorded LAST, after the request
    /// authenticated, parsed and passed every other check, so garbage cannot fill the set.
    ///
    /// A refusal that comes AFTER the request opened (a date outside the window, a replay, a full
    /// set) carries the [`ResponseCtx`]: the answer to it can be sealed, so only the sender can
    /// read which check failed and it is no oracle for anyone else. A refusal before that point
    /// (an unknown key id, a size off the table, a body that does not decrypt) carries none: there
    /// is nobody to seal to.
    pub fn open(&self, enc: &[u8], now_unix: i64) -> Result<(InnerRequest, ResponseCtx), Rejected> {
        let early = |refusal| Rejected { refusal, ctx: None };
        let first = enc.first().ok_or_else(|| early(Refusal::NotPadded))?;
        if *first != self.key_id {
            return Err(early(Refusal::UnknownKeyId(*first)));
        }
        if enc.len() > *padding::REQUEST_BUCKETS.last().unwrap_or(&0) {
            return Err(early(Refusal::TooLarge));
        }
        if !padding::is_request_bucket(enc.len()) {
            return Err(early(Refusal::NotPadded));
        }
        let hash: [u8; 32] = Sha256::digest(enc).into();
        let (plain, resp) = self
            .server
            .decapsulate(enc)
            .map_err(|_| early(Refusal::Undecryptable))?;
        let ctx = ResponseCtx(resp);
        let req = match bhttp_map::decode_request(&plain) {
            Ok(r) => r,
            Err(refusal) => {
                return Err(Rejected {
                    refusal,
                    ctx: Some(ctx),
                })
            }
        };
        let late = |refusal, ctx| Rejected {
            refusal,
            ctx: Some(ctx),
        };
        if req.date_unix < self.floor_unix || now_unix - req.date_unix > WINDOW_SECS {
            return Err(late(Refusal::StaleDate, ctx));
        }
        if req.date_unix - now_unix > WINDOW_SECS {
            return Err(late(Refusal::FutureDate, ctx));
        }
        if let Err(refusal) = self
            .replay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(hash, now_unix, req.date_unix + WINDOW_SECS)
        {
            return Err(late(refusal, ctx));
        }
        Ok((req, ctx))
    }

    /// [`Gateway::open`] for a caller that only wants the reason.
    pub fn decapsulate(
        &self,
        enc: &[u8],
        now_unix: i64,
    ) -> Result<(InnerRequest, ResponseCtx), Refusal> {
        self.open(enc, now_unix).map_err(|r| r.refusal)
    }
}

/// A refused request: why, and the means to answer it when it opened far enough to have them.
pub struct Rejected {
    pub refusal: Refusal,
    pub ctx: Option<ResponseCtx>,
}

impl std::fmt::Debug for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Rejected")
            .field("refusal", &self.refusal)
            .field("has_ctx", &self.ctx.is_some())
            .finish()
    }
}

/// Build the encapsulated, padded response.
pub fn encapsulate_response(
    ctx: ResponseCtx,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<Vec<u8>, Refusal> {
    let mut plain =
        bhttp_map::encode_response(status, content_type, body).map_err(Refusal::Response)?;
    let bucket = padding::response_bucket(plain.len() + RESPONSE_OVERHEAD)
        .ok_or(Refusal::Response("too large"))?;
    padding::pad_to(&mut plain, RESPONSE_OVERHEAD, bucket);
    let wire = ctx
        .0
        .encapsulate(&plain)
        .map_err(|_| Refusal::Response("seal"))?;
    debug_assert_eq!(wire.len(), bucket);
    Ok(wire)
}

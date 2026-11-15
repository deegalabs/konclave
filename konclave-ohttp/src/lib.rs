//! Konclave's Oblivious HTTP layer (RFC 9458 over BHTTP, RFC 9292). See Cargo.toml.

mod bhttp_map;
pub mod padding;

#[cfg(feature = "client")]
mod client;
#[cfg(feature = "server")]
mod server;

#[cfg(feature = "client")]
pub use client::{open_response, seal_request, ClientConfig, ClientCtx};
#[cfg(feature = "server")]
pub use ohttp::KeyConfig;
#[cfg(feature = "server")]
pub use server::{
    encapsulate_response, generate_key_config, key_config_from_text, Gateway, KeyFileError,
    Rejected, ReplaySet, ResponseCtx, REPLAY_CAPACITY, WINDOW_SECS,
};

#[cfg(all(feature = "server", feature = "test-keys"))]
#[doc(hidden)]
pub use server::{key_config_from_text_for_tests, test_key_text};

/// Header names an inner request may carry. Anything else is refused.
pub const HDR_CONTENT_TYPE: &str = "content-type";
pub const HDR_READ: &str = "x-konclave-read";
pub const HDR_DATE: &str = "x-konclave-date";

/// The request inside the encapsulation. `date_unix` is required: the gateway refuses a request
/// that is stale or from the future, which bounds how long a captured request could be replayed.
#[derive(Clone, PartialEq, Eq)]
pub struct InnerRequest {
    pub method: String,
    pub path: String,
    pub content_type: String,
    pub read_key: Option<String>,
    pub body: Vec<u8>,
    pub date_unix: i64,
}

/// `Debug` names every field but the read key and the body: a credential does not belong in a log
/// or a failed assertion.
impl std::fmt::Debug for InnerRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InnerRequest")
            .field("method", &self.method)
            .field("path", &self.path)
            .field("content_type", &self.content_type)
            .field("read_key", &self.read_key.as_ref().map(|_| "<set>"))
            .field("body_len", &self.body.len())
            .field("date_unix", &self.date_unix)
            .finish()
    }
}

/// Why the gateway refused a request. Every variant maps to one answer and none carries content.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("unknown key id {0}")]
    UnknownKeyId(u8),
    #[error("the encapsulated request is not a padded size")]
    NotPadded,
    #[error("the request is too large")]
    TooLarge,
    #[error("the request could not be opened")]
    Undecryptable,
    #[error("the inner request is malformed: {0}")]
    Malformed(&'static str),
    /// A header outside the three the transport carries. It does not name the header: nothing of
    /// the request is carried in a refusal.
    #[error("a header that is not allowed")]
    ForbiddenHeader,
    #[error("the date header is missing")]
    MissingDate,
    #[error("the date header is not a number")]
    BadDate,
    #[error("the request is older than the window")]
    StaleDate,
    #[error("the request is dated in the future")]
    FutureDate,
    #[error("replayed request")]
    Replay,
    #[error("the replay set is full")]
    ReplaySetFull,
    #[error("the response could not be built: {0}")]
    Response(&'static str),
}

/// Client-side failures. `open_response` returns none of the response's fields on any of them.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClientError {
    #[error("the key configuration is not usable")]
    BadConfig,
    #[error("the request could not be built: {0}")]
    BadRequest(&'static str),
    #[error("the response did not authenticate")]
    NotAuthentic,
    #[error("the response is malformed: {0}")]
    BadResponse(&'static str),
}

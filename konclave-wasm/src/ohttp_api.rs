//! The browser-facing Oblivious HTTP client: parse the PINNED key configuration, seal one request,
//! open its answer. (The configuration is the bundle's bytes; `ohttpSeal` is the only place they are
//! parsed, and refuses anything that is not exactly one supported entry.) Everything real is in `konclave-ohttp`'s client half; this file only gives it
//! a shape JavaScript can hold (the wasm wrappers at the bottom are one-line calls into it).
//!
//! The headers an inner request may carry are the crate's: content type and the read key. The date
//! is a required field of the request, not a header chosen here. Nothing else can be passed.

use std::cell::RefCell;

use konclave_ohttp::{ClientConfig, ClientCtx, ClientError, InnerRequest};

/// Why the client refused. The `code` strings are the contract with `oblivious-transport.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OhttpError {
    BadConfig,
    BadRequest,
    NotAuthentic,
    BadResponse,
    ContextUsed,
}

impl OhttpError {
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            Self::BadConfig => "bad_config",
            Self::BadRequest => "bad_request",
            Self::NotAuthentic => "not_authentic",
            Self::BadResponse => "bad_response",
            Self::ContextUsed => "context_used",
        }
    }
}

impl From<ClientError> for OhttpError {
    fn from(e: ClientError) -> Self {
        match e {
            ClientError::BadConfig => Self::BadConfig,
            ClientError::BadRequest(_) => Self::BadRequest,
            ClientError::NotAuthentic => Self::NotAuthentic,
            ClientError::BadResponse(_) => Self::BadResponse,
        }
    }
}

/// The opened answer. Produced only after the response authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Between sealing and opening. Opaque to JavaScript; opens exactly once.
pub struct Pending(RefCell<Option<ClientCtx>>);

impl Pending {
    pub fn open(&self, bytes: &[u8]) -> Result<Answer, OhttpError> {
        let ctx = self.0.borrow_mut().take().ok_or(OhttpError::ContextUsed)?;
        let (status, content_type, body) = konclave_ohttp::open_response(ctx, bytes)?;
        Ok(Answer {
            status,
            content_type,
            body,
        })
    }
}

/// The key id of a configuration (exactly one supported entry, or it is refused). Native tests and
/// tools; there is no JavaScript binding, because the app never reads a key id off a configuration
/// to decide whether to trust it (that was the first, broken pin).
pub fn key_id(list: &[u8]) -> Result<u8, OhttpError> {
    Ok(ClientConfig::parse(list)?.key_id())
}

/// Seal one request. `path` carries the query. Returns the padded wire bytes and the context.
pub fn seal(
    list: &[u8],
    method: &str,
    path: &str,
    read_key: Option<String>,
    content_type: &str,
    body: &[u8],
    date_unix: i64,
) -> Result<(Vec<u8>, Pending), OhttpError> {
    let config = ClientConfig::parse(list)?;
    let (wire, ctx) = konclave_ohttp::seal_request(
        &config,
        InnerRequest {
            method: method.to_string(),
            path: path.to_string(),
            content_type: content_type.to_string(),
            read_key,
            body: body.to_vec(),
            date_unix,
        },
    )?;
    Ok((wire, Pending(RefCell::new(Some(ctx)))))
}

#[cfg(target_arch = "wasm32")]
mod js {
    use super::{seal, Answer, OhttpError, Pending};
    use wasm_bindgen::prelude::*;

    fn je(e: OhttpError) -> JsValue {
        JsValue::from_str(&format!("ohttp:{}", e.code()))
    }

    /// A sealed request. `wire()` is what goes to the relay; `open()` consumes the answer.
    #[wasm_bindgen]
    pub struct OhttpSealed {
        wire: Vec<u8>,
        pending: Pending,
    }

    #[wasm_bindgen]
    impl OhttpSealed {
        pub fn wire(&self) -> Vec<u8> {
            self.wire.clone()
        }

        pub fn open(&self, response: &[u8]) -> Result<OhttpAnswer, JsValue> {
            self.pending.open(response).map(OhttpAnswer).map_err(je)
        }
    }

    #[wasm_bindgen]
    pub struct OhttpAnswer(Answer);

    #[wasm_bindgen]
    impl OhttpAnswer {
        pub fn status(&self) -> u16 {
            self.0.status
        }

        #[wasm_bindgen(js_name = contentType)]
        pub fn content_type(&self) -> String {
            self.0.content_type.clone()
        }

        pub fn body(&self) -> Vec<u8> {
            self.0.body.clone()
        }
    }

    #[wasm_bindgen(js_name = ohttpSeal)]
    pub fn ohttp_seal(
        config: &[u8],
        method: &str,
        path: &str,
        read_key: Option<String>,
        content_type: &str,
        body: &[u8],
        date_unix: f64,
    ) -> Result<OhttpSealed, JsValue> {
        let (wire, pending) = seal(
            config,
            method,
            path,
            read_key,
            content_type,
            body,
            date_unix as i64,
        )
        .map_err(je)?;
        Ok(OhttpSealed { wire, pending })
    }
}

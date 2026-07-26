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
        let url = format!("{}/api/relay/{}", self.base, self.room);
        let body = serde_json::to_vec(&serde_json::json!({ "from": self.from, "data": data }))
            .map_err(|e| e.to_string())?;
        let resp = self.transport.post(&url, &body)?;
        let v: PostResp = serde_json::from_slice(&resp).map_err(|e| format!("post resp: {e}"))?;
        Ok(v.seq)
    }

    /// Poll for everything after `since`. Marks this client present in the room (via `from`).
    pub fn poll(&self, since: u64) -> Result<Poll, String> {
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
}

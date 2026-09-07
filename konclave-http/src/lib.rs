//! The HTTP-serving rules the helper and the relay must apply IDENTICALLY.
//!
//! Both are public servers on the open internet, and both fixed a body read with no ceiling - but
//! in two files called `concurrency.rs`, one per server, and only ONE of them actually got the cap. The helper went on reading an unbounded body from a public POST for the
//! fifteen days between #269 being filed and someone noticing that the release notes claimed
//! otherwise.
//!
//! That is this repo's dominant defect shape, and the answer that works here is the same one that
//! worked for the write message in `konclave-seal`: the rule lives in ONE place that both callers
//! read. A third copy cannot drift from the other two if there is no third copy.
//!
//! The worker pool deliberately stays OUT of here, and finding out why is the reason this crate is
//! small. The two look like one duplicated rule and are not: the helper sizes at
//! `(parallelism * 4).clamp(16, 64)` because a send holds a worker for as long as the quorum takes,
//! the relay at `(parallelism * 2).clamp(4, 32)` because it is in-memory mailbox work behind one
//! mutex. Sharing them would have quietly shrunk the helper's pool - on the service whose outage
//! came from being too serial. Same shape is not the same rule.
//!
//! Deliberately dependency-free. The relay depends on `tiny_http`, `serde` and `serde_json` and
//! nothing else, on purpose - it is a blind mailbox and its bus factor is its smallness. Sharing
//! through `orchestrator` would have dragged the whole engine-facing crate into it, so this crate
//! carries no dependencies at all and stays something either server can take without argument.

/// How much of a request body to read.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadPlan {
    /// Over the ceiling before a byte is read: do not buffer it at all.
    Skip,
    /// Read at most this many bytes.
    Read(u64),
}

/// The largest request body either server will buffer.
///
/// Generous for the JSON both actually take - a relay message is capped at 128 KiB once parsed, and
/// the helper's biggest real body is a payroll of a few hundred lines - while still bounded, which
/// is the whole point. A cap that is never hit in normal use is a cap doing its job.
pub const MAX_BODY: u64 = 2 * 1024 * 1024;

/// Decide how much of a body to read from its declared `Content-Length`.
///
/// The hole this closes: a body with NO `Content-Length` (chunked, or a dribbling client) was read
/// unbounded. Absent is not the same as small, so it gets the same ceiling as any other body.
pub fn body_read_cap(content_length: Option<u64>) -> ReadPlan {
    match content_length {
        Some(n) if n > MAX_BODY => ReadPlan::Skip,
        Some(n) => ReadPlan::Read(n),
        None => ReadPlan::Read(MAX_BODY),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_over_the_ceiling_is_never_buffered() {
        assert_eq!(body_read_cap(Some(MAX_BODY + 1)), ReadPlan::Skip);
    }

    #[test]
    fn a_body_at_the_ceiling_is_read() {
        assert_eq!(body_read_cap(Some(MAX_BODY)), ReadPlan::Read(MAX_BODY));
    }

    #[test]
    fn an_absent_content_length_is_capped_not_unbounded() {
        // The #390 hole. A client that declares nothing must not be trusted more than one that does.
        assert_eq!(body_read_cap(None), ReadPlan::Read(MAX_BODY));
    }

    #[test]
    fn a_declared_length_is_read_exactly() {
        assert_eq!(body_read_cap(Some(1234)), ReadPlan::Read(1234));
        assert_eq!(body_read_cap(Some(0)), ReadPlan::Read(0));
    }
}

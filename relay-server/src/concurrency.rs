//! Keeping the relay responsive: a worker pool so one slow connection can't stall the whole
//! mailbox, and a bounded body read so an unknown-length body can't be buffered without limit.
//!
//! The relay served requests in a single-threaded loop and read the body inline with no read
//! timeout, so one connection that declared a body and then dribbled it held the only thread and
//! took the entire relay - every room, every vault's DKG/signing, and /health - down from a single
//! IP, no flood (#390). This is the same shape as the helper's #375, fixed there in #384 and never
//! addressed here.

/// How much of a request body to read.
pub enum ReadPlan {
    /// Content-Length declares more than the cap: read nothing, reject.
    Skip,
    /// Read at most this many bytes.
    Read(u64),
}

/// The largest body the relay will buffer. A relay message is capped at `MAX_DATA` (128 KiB) once
/// parsed; this is the raw-body ceiling before parsing, generous enough for headers/encoding.
pub const MAX_BODY: u64 = 2 * 1024 * 1024;

/// Decide how much of the body to read from its declared Content-Length.
///
/// The hole this closes: a body with NO Content-Length (chunked / unknown length) was read
/// unbounded. It must be read with a hard ceiling like any other.
pub fn body_read_cap(content_length: Option<u64>) -> ReadPlan {
    match content_length {
        Some(n) if n > MAX_BODY => ReadPlan::Skip,
        Some(n) => ReadPlan::Read(n),
        // An absent Content-Length (chunked / unknown length) is read with the same ceiling as
        // any other body - not unbounded (#390).
        None => ReadPlan::Read(MAX_BODY),
    }
}

/// How many connections to serve at once. The relay does pure in-memory mailbox work behind one
/// `Mutex`, so this is only about not letting a stalled reader block everyone; a modest pool over
/// the machine's parallelism is plenty.
pub fn worker_count(env: Option<&str>, parallelism: usize) -> usize {
    if let Some(n) = env.and_then(|s| s.trim().parse::<usize>().ok()) {
        if n > 0 {
            return n.min(256);
        }
    }
    (parallelism * 4).clamp(8, 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit(plan: ReadPlan) -> Option<u64> {
        match plan {
            ReadPlan::Skip => None,
            ReadPlan::Read(n) => Some(n),
        }
    }

    #[test]
    fn a_declared_body_within_the_cap_is_read_whole() {
        assert_eq!(limit(body_read_cap(Some(1000))), Some(1000));
        assert_eq!(limit(body_read_cap(Some(MAX_BODY))), Some(MAX_BODY));
    }

    #[test]
    fn a_declared_body_over_the_cap_is_rejected() {
        assert!(matches!(body_read_cap(Some(MAX_BODY + 1)), ReadPlan::Skip));
        assert!(matches!(body_read_cap(Some(9_999_999_999)), ReadPlan::Skip));
    }

    #[test]
    fn an_undeclared_body_is_read_bounded_not_unbounded() {
        // THE #390 hole: a chunked/unknown-length body must NOT be read without a ceiling.
        match body_read_cap(None) {
            ReadPlan::Read(n) => assert!(
                n <= MAX_BODY,
                "an undeclared body was read up to {n}, past the cap"
            ),
            ReadPlan::Skip => { /* rejecting it outright is also acceptable */ }
        }
    }

    #[test]
    fn worker_count_is_bounded_and_env_overridable() {
        assert_eq!(worker_count(Some("6"), 8), 6);
        assert_eq!(worker_count(Some("0"), 4), 16); // garbage/zero → computed value (4*4)
        assert_eq!(worker_count(None, 1), 8);
        assert_eq!(worker_count(None, 4), 16);
        assert_eq!(worker_count(None, 64), 64); // capped
        assert_eq!(worker_count(Some("9999"), 8), 256); // capped
    }
}

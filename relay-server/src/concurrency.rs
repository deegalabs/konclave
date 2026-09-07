//! Keeping the relay responsive: a worker pool so one slow connection can't stall the whole
//! mailbox. The bounded body read moved to `konclave-http`, because the helper needed the same
//! ceiling and having it here is precisely why the helper went without one (#269). The pool stays:
//! it looks like the same rule as the helper's and is not - see that crate's header.
//!
//! The relay served requests in a single-threaded loop and read the body inline with no read
//! timeout, so one connection that declared a body and then dribbled it held the only thread and
//! took the entire relay - every room, every vault's DKG/signing, and /health - down from a single
//! IP, no flood (#390). This is the same shape as the helper's #375, fixed there in #384 and never
//! addressed here.

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

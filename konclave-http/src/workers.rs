//! What a server does when one of its request workers ends: it ends too, with a failure code.
//!
//! The helper and the relay each ran a pool of request workers and `join`ed them at the end of
//! `main`. A worker that panicked outside the handler's own guard died alone, the rest went on with
//! fewer hands, and when the last had gone `main` returned and the process exited 0. A platform
//! that restarts a service on failure reads 0 as a clean stop, so a server could thin out to nothing
//! and stay down, with nothing in the log to say it had stopped serving.
//!
//! A worker never ends on purpose: it serves until the process stops. So ending at all, by a panic
//! or by returning, is a failure of the whole server, and the process exits with
//! [`WORKER_ENDED_EXIT`] at once, while the platform can still restart it. Exiting on the FIRST end,
//! not when the pool is empty, matters: tiny_http's accept thread stops for good on an accept error
//! and hands that error to one worker, so the others would wait forever and the pool never empties.
//!
//! The cost is that requests in flight on the other workers end with it. A send that had reached its
//! broadcast wrote its record to the volume first, and the coordinator reports it as held when it
//! starts again; a send still collecting its signatures had broadcast nothing and is signed again.
//!
//! A panic INSIDE a request's handler is not a worker ending: [`guard`] turns it into that request's
//! 5xx, and only what fails outside the handler reaches the rule below.
//!
//! One rule for the pooled servers ([`run_workers`]) and the single-loop bridge ([`run_in_place`]),
//! because the same rule in three files is how the body ceiling once reached only one server.

use std::sync::mpsc;
use std::sync::Arc;

/// The exit code of a server whose request worker ended.
///
/// Not 0, so a restart-on-failure policy restarts it. Also not 101 (a panic on the main thread) or 2
/// (a setting refused at boot), so the log of a restart says which of the three it was.
pub const WORKER_ENDED_EXIT: i32 = 70;

/// Run `workers` copies of a server's request loop and never return.
///
/// The first worker to end, by panicking or by returning, ends the process with
/// [`WORKER_ENDED_EXIT`]. A worker that cannot be started at boot ends it the same way.
pub fn run_workers<F>(service: &str, workers: usize, work: F) -> !
where
    F: Fn() + Send + Sync + 'static,
{
    let work = Arc::new(work);
    let (ended, first_end) = mpsc::channel::<bool>();
    for _ in 0..workers.max(1) {
        let (work, ended) = (Arc::clone(&work), ended.clone());
        let started = std::thread::Builder::new().spawn(move || {
            // Reports on drop, so a panic that unwinds out of `work` is reported as well as a return.
            let _watch = Watch(ended);
            work();
        });
        if let Err(e) = started {
            eprintln!("{service}: a request worker could not be started ({e}); exiting");
            std::process::exit(WORKER_ENDED_EXIT);
        }
    }
    drop(ended);
    // Every worker holds a sender and reports before it lets go, so this answers on the first end.
    let panicked = first_end.recv().unwrap_or(true);
    worker_ended(service, panicked)
}

/// Run a server's single request loop on this thread and never return.
///
/// The same rule as [`run_workers`] for a server with one loop: when the loop ends, by panicking
/// or by returning, the process exits with [`WORKER_ENDED_EXIT`].
pub fn run_in_place(service: &str, work: impl FnOnce()) -> ! {
    let ended = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
    worker_ended(service, ended.is_err())
}

/// Run one request's handler and catch a panic in it, so one bad request costs its own answer and not
/// the worker (which, under [`run_workers`], would cost the whole process).
///
/// `None` means the handler panicked; the caller answers it with a 5xx of its own choosing. Shared
/// state the handler held is the caller's concern: the servers recover a poisoned mutex and go on.
pub fn guard<T>(work: impl FnOnce() -> T) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).ok()
}

fn worker_ended(service: &str, panicked: bool) -> ! {
    let how = if panicked { "panicked" } else { "stopped" };
    eprintln!("{service}: a request worker {how}; exiting so the service is restarted");
    std::process::exit(WORKER_ENDED_EXIT)
}

/// Sends whether its thread is unwinding when it is dropped, which is when the worker ends.
struct Watch(mpsc::Sender<bool>);

impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self.0.send(std::thread::panicking());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_handler_that_panics_is_caught_and_one_that_returns_is_passed_through() {
        assert_eq!(super::guard(|| 7), Some(7));
        assert_eq!(super::guard(|| -> i32 { panic!("handler failed") }), None);
    }
}

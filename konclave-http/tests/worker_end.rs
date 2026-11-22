//! A server whose request worker ends must end with it, with a code that is not 0.
//!
//! Before this rule the helper and the relay each ran a pool of request workers and `join`ed them.
//! A worker that panicked outside the handler's own guard died quietly, the others went on, and when
//! the last one had gone `main` returned and the process exited 0. A platform that restarts a
//! service on failure reads 0 as a clean stop and does not restart it, so the server could thin out
//! to nothing and then stay down.
//!
//! The rule is checked in a child process, because what it does is end the process: this test
//! binary runs itself again with `KC_WORKER_END_CHILD` set, and the child runs the pool.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CHILD: &str = "KC_WORKER_END_CHILD";

/// Run in the child: the shape of a server, some workers that keep serving and one that ends.
fn child(mode: &str) -> ! {
    let serve_forever = || loop {
        std::thread::sleep(Duration::from_millis(50));
    };
    match mode {
        "pool-panic" => {
            let n = std::sync::atomic::AtomicUsize::new(0);
            konclave_http::run_workers("test-server", 3, move || {
                if n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    std::thread::sleep(Duration::from_millis(100));
                    panic!("a worker panics outside the handler's guard");
                }
                serve_forever()
            })
        }
        "pool-return" => {
            let n = std::sync::atomic::AtomicUsize::new(0);
            konclave_http::run_workers("test-server", 3, move || {
                if n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    std::thread::sleep(Duration::from_millis(100));
                    return;
                }
                serve_forever()
            })
        }
        "in-place-panic" => konclave_http::run_in_place("test-server", || {
            std::thread::sleep(Duration::from_millis(100));
            panic!("the only worker panics");
        }),
        "in-place-return" => konclave_http::run_in_place("test-server", || {}),
        other => panic!("unknown child mode {other}"),
    }
}

/// Run this test binary again as the child, and wait (bounded) for it to end.
fn run_child(test: &str, mode: &str) -> (Option<i32>, String) {
    let mut c = Command::new(std::env::current_exe().unwrap())
        .args([test, "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, mode)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run the child");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = c.try_wait().unwrap() {
            let mut err = String::new();
            use std::io::Read;
            c.stderr.take().unwrap().read_to_string(&mut err).unwrap();
            return (status.code(), err);
        }
        if Instant::now() > deadline {
            let _ = c.kill();
            let _ = c.wait();
            panic!("{mode}: the process was still running 20 s after its worker ended");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn check(test: &str, mode: &str, said: &str) {
    if let Ok(m) = std::env::var(CHILD) {
        child(&m);
    }
    let (code, err) = run_child(test, mode);
    assert_eq!(
        code,
        Some(konclave_http::WORKER_ENDED_EXIT),
        "{mode}: {err}"
    );
    assert_ne!(konclave_http::WORKER_ENDED_EXIT, 0);
    assert!(
        err.contains(&format!("test-server: a request worker {said}")),
        "{mode}: the log must say which server stopped and why: {err}"
    );
}

#[test]
fn one_worker_panicking_ends_the_server_with_a_failure_code() {
    check(
        "one_worker_panicking_ends_the_server_with_a_failure_code",
        "pool-panic",
        "panicked",
    );
}

#[test]
fn one_worker_returning_ends_the_server_with_a_failure_code() {
    check(
        "one_worker_returning_ends_the_server_with_a_failure_code",
        "pool-return",
        "stopped",
    );
}

#[test]
fn the_single_loop_panicking_ends_the_server_with_the_same_code() {
    check(
        "the_single_loop_panicking_ends_the_server_with_the_same_code",
        "in-place-panic",
        "panicked",
    );
}

#[test]
fn the_single_loop_returning_ends_the_server_with_the_same_code() {
    check(
        "the_single_loop_returning_ends_the_server_with_the_same_code",
        "in-place-return",
        "stopped",
    );
}

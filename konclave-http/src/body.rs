//! How long a request may take to arrive, and how many slow ones one address may hold.
//!
//! The byte ceiling (`body_read_cap`) bounds how MUCH a body may be. It said nothing about how
//! LONG one may take, and a worker reads every body over 1,024 bytes itself (tiny_http buffers
//! smaller ones on its own thread). So a client that announces a large body and then sends nothing
//! held a worker for as long as it kept the connection open, and a handful of such connections
//! held every worker, `/health` included. The pool (#384, #393) only raised the number of
//! connections that took.
//!
//! Three limits close it, and they live here so both public servers and the bridge apply the same
//! ones:
//!
//! - [`listen`] puts a timeout on every read and write of every accepted connection, so a read that
//!   gets nothing ends;
//! - [`read_body`] puts a total deadline on the body, so a client that drips one byte just inside
//!   that timeout still ends;
//! - [`BodySlots`] caps how many bodies one address may be sending at once, so the deadline is not
//!   simply restarted on every worker in parallel.

use std::io::{self, Read};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use crate::ClientAddress;

/// The longest any single read or write on a connection may block.
pub const SOCKET_TIMEOUT: Duration = Duration::from_secs(15);

/// The longest a whole request body may take to arrive. The real bodies are a few kilobytes and
/// the largest a payroll of some hundred lines, so this is generous for any connection that is
/// actually sending.
pub const BODY_DEADLINE: Duration = Duration::from_secs(20);

/// The largest body tiny_http reads into memory itself, on its own thread, before a worker ever
/// sees the request (`tiny_http` 0.12, `request.rs`). Anything larger is read by the worker.
pub const BUFFERED_BY_TINY_HTTP: u64 = 1024;

/// How many bodies one address may be sending at the same time, past which it gets a `429`.
pub const BODIES_PER_ADDRESS: usize = 2;

/// Bind `addr` with [`SOCKET_TIMEOUT`] on the listening socket. On Linux an accepted socket
/// inherits the listener's receive and send timeouts, which is how the timeout reaches the
/// connections tiny_http accepts on its own thread: it gives us no hook on the accepted socket.
/// Serve it with `tiny_http::Server::from_listener(listener, None)`.
///
/// Elsewhere (the desktop bridge on macOS or Windows, loopback only) the listener is returned
/// without the timeout; [`read_body`] still bounds the body between reads.
pub fn listen(addr: &str) -> io::Result<TcpListener> {
    listen_with_timeout(addr, SOCKET_TIMEOUT)
}

/// [`listen`] with another timeout. For tests, which cannot wait the production one out.
pub fn listen_with_timeout(addr: &str, timeout: Duration) -> io::Result<TcpListener> {
    let listener = TcpListener::bind(addr)?;
    sockopt::set_timeouts(&listener, timeout)?;
    Ok(listener)
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
mod sockopt {
    use std::io;
    use std::net::TcpListener;
    use std::os::fd::AsRawFd;
    use std::time::Duration;

    // `struct timeval` on 64-bit Linux: `time_t` and `suseconds_t` are both 64-bit.
    #[repr(C)]
    struct Timeval {
        tv_sec: i64,
        tv_usec: i64,
    }

    extern "C" {
        fn setsockopt(
            fd: i32,
            level: i32,
            name: i32,
            value: *const core::ffi::c_void,
            len: u32,
        ) -> i32;
    }

    // asm-generic values, shared by x86_64 and aarch64.
    const SOL_SOCKET: i32 = 1;
    const SO_RCVTIMEO: i32 = 20;
    const SO_SNDTIMEO: i32 = 21;

    pub fn set_timeouts(listener: &TcpListener, t: Duration) -> io::Result<()> {
        let tv = Timeval {
            tv_sec: i64::try_from(t.as_secs()).unwrap_or(i64::MAX),
            tv_usec: i64::from(t.subsec_micros()),
        };
        for name in [SO_RCVTIMEO, SO_SNDTIMEO] {
            // SAFETY: a valid open fd, a pointer to a live `Timeval` and its exact size.
            let rc = unsafe {
                setsockopt(
                    listener.as_raw_fd(),
                    SOL_SOCKET,
                    name,
                    (&tv as *const Timeval).cast(),
                    std::mem::size_of::<Timeval>() as u32,
                )
            };
            if rc != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
mod sockopt {
    pub fn set_timeouts(_: &std::net::TcpListener, _: std::time::Duration) -> std::io::Result<()> {
        Ok(())
    }
}

/// Whether reading this body may block a worker: anything tiny_http has not already buffered.
/// A protocol upgrade hands over the raw connection and `Expect: 100-continue` defers the read, so
/// both count whatever length they announce.
pub fn body_may_block(content_length: Option<u64>, expects_continue: bool, upgrade: bool) -> bool {
    match content_length {
        Some(0) => upgrade,
        Some(n) if n <= BUFFERED_BY_TINY_HTTP => expects_continue || upgrade,
        _ => true,
    }
}

/// Why a body could not be read.
#[derive(Debug)]
pub enum BodyError {
    /// The deadline passed, or a single read timed out: answer `408`.
    TooSlow,
    /// The connection failed some other way. Nothing useful can be answered.
    Io(io::Error),
}

/// Read at most `limit` bytes, giving up once `deadline` has passed. A read that blocks is bounded
/// by the socket's own timeout (see [`listen`]), so the whole read ends within about
/// `deadline + SOCKET_TIMEOUT` however the client sends.
pub fn read_body(
    reader: &mut dyn Read,
    limit: u64,
    deadline: Duration,
) -> Result<Vec<u8>, BodyError> {
    let end = Instant::now() + deadline;
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    while (out.len() as u64) < limit {
        if Instant::now() >= end {
            return Err(BodyError::TooSlow);
        }
        let want =
            usize::try_from((limit - out.len() as u64).min(buf.len() as u64)).unwrap_or(buf.len());
        match reader.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Err(BodyError::TooSlow)
            }
            Err(e) => return Err(BodyError::Io(e)),
        }
    }
    Ok(out)
}

/// How many bodies each address is sending right now.
#[derive(Default)]
pub struct BodySlots {
    busy: std::sync::Mutex<std::collections::HashMap<ClientAddress, usize>>,
}

/// One body being read. Dropping it frees the slot, however the read ended.
pub struct BodySlot<'a> {
    slots: &'a BodySlots,
    addr: ClientAddress,
}

impl BodySlots {
    pub fn new() -> Self {
        Self::default()
    }

    /// A slot for `addr`, or `None` when it already sends `max` bodies. Every request with no
    /// address shares one count, as everywhere else in this crate.
    pub fn try_take(&self, addr: ClientAddress, max: usize) -> Option<BodySlot<'_>> {
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let n = busy.entry(addr).or_insert(0);
        if *n >= max {
            return None;
        }
        *n += 1;
        Some(BodySlot { slots: self, addr })
    }

    /// How many addresses hold a slot. For tests.
    pub fn holders(&self) -> usize {
        self.busy.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for BodySlot<'_> {
    fn drop(&mut self) {
        let mut busy = self.slots.busy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = busy.get_mut(&self.addr) {
            *n -= 1;
            if *n == 0 {
                busy.remove(&self.addr);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    #[test]
    fn an_accepted_connection_inherits_the_listener_timeouts() {
        let l = listen("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let _c = std::net::TcpStream::connect(addr).unwrap();
        let (s, _) = l.accept().unwrap();
        assert_eq!(s.read_timeout().unwrap(), Some(SOCKET_TIMEOUT));
        assert_eq!(s.write_timeout().unwrap(), Some(SOCKET_TIMEOUT));
    }

    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    #[test]
    fn a_body_that_never_comes_ends_at_the_socket_timeout() {
        // A shorter timeout than production so the test does not wait 10 s; same mechanism.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        sockopt::set_timeouts(&l, Duration::from_millis(200)).unwrap();
        let mut c = std::net::TcpStream::connect(l.local_addr().unwrap()).unwrap();
        c.write_all(b"x").unwrap();
        let (mut s, _) = l.accept().unwrap();
        let t = Instant::now();
        let r = read_body(&mut s, 4096, Duration::from_secs(30));
        assert!(matches!(r, Err(BodyError::TooSlow)), "{r:?}");
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    /// One byte per call, each call slow: the per-read timeout never fires, the deadline must.
    struct Drip(Duration);
    impl Read for Drip {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(self.0);
            buf[0] = b'a';
            Ok(1)
        }
    }

    #[test]
    fn a_dripping_body_ends_at_the_deadline() {
        let t = Instant::now();
        let r = read_body(
            &mut Drip(Duration::from_millis(20)),
            1 << 20,
            Duration::from_millis(200),
        );
        assert!(matches!(r, Err(BodyError::TooSlow)));
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_whole_body_is_read_and_capped_at_the_limit() {
        let data = vec![7u8; 5000];
        assert_eq!(
            read_body(&mut &data[..], 10_000, BODY_DEADLINE)
                .unwrap()
                .len(),
            5000
        );
        assert_eq!(
            read_body(&mut &data[..], 100, BODY_DEADLINE).unwrap().len(),
            100
        );
    }

    #[test]
    fn only_bodies_tiny_http_has_not_buffered_may_block() {
        assert!(!body_may_block(Some(0), false, false));
        assert!(!body_may_block(Some(1024), false, false));
        assert!(body_may_block(Some(1025), false, false));
        assert!(body_may_block(None, false, false));
        assert!(body_may_block(Some(10), true, false));
        assert!(body_may_block(Some(0), false, true));
    }

    #[test]
    fn an_address_holds_at_most_max_slots_and_gets_them_back() {
        let slots = BodySlots::new();
        let a = ClientAddress::from_ip("203.0.113.7".parse().unwrap());
        let b = ClientAddress::from_ip("203.0.113.8".parse().unwrap());
        let s1 = slots.try_take(a, 2).unwrap();
        let _s2 = slots.try_take(a, 2).unwrap();
        assert!(slots.try_take(a, 2).is_none());
        assert!(
            slots.try_take(b, 2).is_some(),
            "another address is not limited by a"
        );
        drop(s1);
        assert!(slots.try_take(a, 2).is_some());
    }

    #[test]
    fn a_freed_address_leaves_no_entry() {
        let slots = BodySlots::new();
        let a = ClientAddress::unknown();
        drop(slots.try_take(a, 1).unwrap());
        assert_eq!(slots.holders(), 0);
    }
}

use std::io::Read;
use std::io::Result as IoResult;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Konclave patch: the most a dropped reader drains to keep the connection usable.
const DRAIN_MAX_BYTES: usize = 64 * 1024;
/// Konclave patch: how long a drain may take, checked between reads.
const DRAIN_MAX_TIME: Duration = Duration::from_secs(1);
/// Konclave patch: the drain buffer, fixed, whatever the declared length.
const DRAIN_CHUNK: usize = 8 * 1024;

/// A `Reader` that reads exactly the number of bytes from a sub-reader.
///
/// If the limit is reached, it returns EOF. If the limit is not reached
/// when the destructor is called, the remaining bytes will be read and
/// thrown away.
///
/// Konclave patch: the remainder is drained through a fixed buffer, and only up to
/// `DRAIN_MAX_BYTES` and `DRAIN_MAX_TIME`. When the drain does not finish, `abandoned` is set, and
/// the connection reads nothing more (see `client.rs`), since the next request would start inside
/// this body.
pub struct EqualReader<R>
where
    R: Read,
{
    reader: R,
    size: usize,
    last_read_signal: Sender<IoResult<()>>,
    abandoned: Option<Arc<AtomicBool>>,
}

impl<R> EqualReader<R>
where
    R: Read,
{
    pub fn new(reader: R, size: usize) -> (EqualReader<R>, Receiver<IoResult<()>>) {
        let (tx, rx) = channel();

        let r = EqualReader {
            reader,
            size,
            last_read_signal: tx,
            abandoned: None,
        };

        (r, rx)
    }

    /// Konclave patch: the flag to set when the drain on drop gives up.
    pub fn abandon_with(mut self, flag: Arc<AtomicBool>) -> Self {
        self.abandoned = Some(flag);
        self
    }
}

impl<R> Read for EqualReader<R>
where
    R: Read,
{
    fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
        if self.size == 0 {
            return Ok(0);
        }

        let buf = if buf.len() < self.size {
            buf
        } else {
            &mut buf[..self.size]
        };

        match self.reader.read(buf) {
            Ok(len) => {
                self.size -= len;
                Ok(len)
            }
            err @ Err(_) => err,
        }
    }
}

impl<R> Drop for EqualReader<R>
where
    R: Read,
{
    fn drop(&mut self) {
        let mut remaining_to_read = self.size;
        if remaining_to_read == 0 {
            return;
        }
        let mut finished = false;

        if remaining_to_read <= DRAIN_MAX_BYTES {
            let started = Instant::now();
            let mut buf = [0u8; DRAIN_CHUNK];

            while remaining_to_read > 0 && started.elapsed() < DRAIN_MAX_TIME {
                let want = remaining_to_read.min(buf.len());

                match self.reader.read(&mut buf[..want]) {
                    Err(e) => {
                        self.last_read_signal.send(Err(e)).ok();
                        break;
                    }
                    Ok(0) => {
                        self.last_read_signal.send(Ok(())).ok();
                        break;
                    }
                    Ok(other) => {
                        remaining_to_read -= other;
                    }
                }
            }
            finished = remaining_to_read == 0;
        }

        if !finished {
            if let Some(flag) = &self.abandoned {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EqualReader;
    use std::io::Read;

    #[test]
    fn test_limit() {
        use std::io::Cursor;

        let mut org_reader = Cursor::new("hello world".to_string().into_bytes());

        {
            let (mut equal_reader, _) = EqualReader::new(org_reader.by_ref(), 5);

            let mut string = String::new();
            equal_reader.read_to_string(&mut string).unwrap();
            assert_eq!(string, "hello");
        }

        let mut string = String::new();
        org_reader.read_to_string(&mut string).unwrap();
        assert_eq!(string, " world");
    }

    #[test]
    fn test_not_enough() {
        use std::io::Cursor;

        let mut org_reader = Cursor::new("hello world".to_string().into_bytes());

        {
            let (mut equal_reader, _) = EqualReader::new(org_reader.by_ref(), 5);

            let mut vec = [0];
            equal_reader.read_exact(&mut vec).unwrap();
            assert_eq!(vec[0], b'h');
        }

        let mut string = String::new();
        org_reader.read_to_string(&mut string).unwrap();
        assert_eq!(string, " world");
    }

    // Konclave patch tests.

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// A reader that never ends and counts what it hands out.
    struct Endless(usize);
    impl Read for Endless {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
    }

    #[test]
    fn a_huge_declared_length_is_abandoned_without_reading_or_allocating() {
        let flag = Arc::new(AtomicBool::new(false));
        let mut source = Endless(0);
        {
            let (r, _) = EqualReader::new(&mut source, usize::MAX / 2);
            let _r = r.abandon_with(flag.clone());
        }
        assert_eq!(source.0, 0);
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn a_small_remainder_is_drained_and_the_connection_kept() {
        use std::io::Cursor;
        let flag = Arc::new(AtomicBool::new(false));
        let mut org_reader = Cursor::new(vec![7u8; 20_000]);
        {
            let (r, _) = EqualReader::new(org_reader.by_ref(), 10_000);
            let _r = r.abandon_with(flag.clone());
        }
        assert_eq!(org_reader.position(), 10_000);
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn a_remainder_past_the_cap_is_abandoned() {
        let flag = Arc::new(AtomicBool::new(false));
        let mut source = Endless(0);
        {
            let (r, _) = EqualReader::new(&mut source, super::DRAIN_MAX_BYTES + 1);
            let _r = r.abandon_with(flag.clone());
        }
        assert_eq!(source.0, 0);
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn a_body_that_ends_early_is_abandoned() {
        use std::io::Cursor;
        let flag = Arc::new(AtomicBool::new(false));
        let mut org_reader = Cursor::new(vec![7u8; 100]);
        {
            let (r, _) = EqualReader::new(org_reader.by_ref(), 1_000);
            let _r = r.abandon_with(flag.clone());
        }
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn a_drain_that_takes_too_long_is_abandoned() {
        /// One byte per 300 ms.
        struct Slow;
        impl Read for Slow {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(std::time::Duration::from_millis(300));
                buf[0] = 0;
                Ok(1)
            }
        }
        let flag = Arc::new(AtomicBool::new(false));
        let started = std::time::Instant::now();
        {
            let (r, _) = EqualReader::new(Slow, 1_000);
            let _r = r.abandon_with(flag.clone());
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(flag.load(Ordering::SeqCst));
    }
}

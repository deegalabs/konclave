use std::io::Read;
use std::io::Result as IoResult;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;

/// A `Reader` that reads exactly the number of bytes from a sub-reader.
///
/// If the limit is reached, it returns EOF.
///
/// Konclave patch: if the limit is not reached when the destructor is called, nothing more is read
/// and `abandoned` is set, so the connection reads nothing more (see `client.rs`).
pub struct EqualReader<R>
where
    R: Read,
{
    reader: R,
    size: usize,
    // Konclave patch: nothing reads the remainder any more, so nothing is signalled.
    #[allow(dead_code)]
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
        if self.size > 0 {
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

        // Konclave patch: the rest of the body is left unread (upstream read it, " world" here).
        let mut string = String::new();
        org_reader.read_to_string(&mut string).unwrap();
        assert_eq!(string, "ello world");
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
    fn any_remainder_is_abandoned_without_reading() {
        for size in [1, 1_000, 10_000] {
            let flag = Arc::new(AtomicBool::new(false));
            let mut source = Endless(0);
            {
                let (r, _) = EqualReader::new(&mut source, size);
                let _r = r.abandon_with(flag.clone());
            }
            assert_eq!(source.0, 0, "{size}");
            assert!(flag.load(Ordering::SeqCst), "{size}");
        }
    }

    #[test]
    fn a_body_read_to_its_end_keeps_the_connection() {
        use std::io::Cursor;
        let flag = Arc::new(AtomicBool::new(false));
        let mut org_reader = Cursor::new(vec![7u8; 20_000]);
        {
            let (r, _) = EqualReader::new(org_reader.by_ref(), 10_000);
            let mut r = r.abandon_with(flag.clone());
            let mut body = Vec::new();
            r.read_to_end(&mut body).unwrap();
            assert_eq!(body.len(), 10_000);
        }
        assert!(!flag.load(Ordering::SeqCst));
    }
}

//! Running the external tools with structured error handling.
//!
//! Every invocation captures stdout/stderr and turns a non-zero exit into an
//! explicit `ToolError` carrying the tool's stderr - failures are never silent.
//! Output *parsing* lives in the per-tool modules (`wallet`, `signer`, …) so it can
//! be unit-tested against captured real output without spawning anything.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Absolute paths to the external binaries the Orchestrator drives.
#[derive(Clone, Debug)]
pub struct Tools {
    pub frost_client: PathBuf,
    pub frostd: PathBuf,
    pub zcash_sign: PathBuf,
    pub zcash_devtool: PathBuf,
    pub konclave_signer: PathBuf,
}

#[derive(Debug)]
pub enum ToolError {
    /// The process could not be started (e.g. binary missing).
    Spawn {
        program: String,
        source: std::io::Error,
    },
    /// The process exited non-zero; carries its stderr for diagnosis.
    NonZero {
        program: String,
        code: Option<i32>,
        stderr: String,
    },
    /// The output could not be parsed into the expected structure.
    Parse { what: String, detail: String },
    /// An I/O error while talking to the process.
    Io(std::io::Error),
}

impl ToolError {
    pub fn parse(what: impl Into<String>, detail: impl Into<String>) -> ToolError {
        ToolError::Parse {
            what: what.into(),
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::Spawn { program, source } => {
                write!(f, "could not start {program}: {source}")
            }
            ToolError::NonZero {
                program,
                code,
                stderr,
            } => write!(
                f,
                "{program} exited with {}: {}",
                code.map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into()),
                stderr.trim()
            ),
            ToolError::Parse { what, detail } => write!(f, "failed to parse {what}: {detail}"),
            ToolError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for ToolError {}

/// Run `program args…`, optionally feeding `stdin_data`, and capture raw stdout.
///
/// A non-zero exit is an error carrying stderr. Intended for small payloads (PCZTs
/// are a few KB); for large streaming output a threaded pump would be needed.
pub fn run(program: &Path, args: &[&str], stdin_data: Option<&[u8]>) -> Result<Vec<u8>, ToolError> {
    let program_name = program.display().to_string();
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_data.is_some() {
        command.stdin(Stdio::piped());
    }

    let mut child = command.spawn().map_err(|source| ToolError::Spawn {
        program: program_name.clone(),
        source,
    })?;

    if let Some(data) = stdin_data {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| ToolError::parse("stdin", "child stdin was not piped"))?;
        stdin.write_all(data).map_err(ToolError::Io)?;
        // Dropping `stdin` closes the pipe so the child sees EOF.
    }

    let output = child.wait_with_output().map_err(ToolError::Io)?;
    if !output.status.success() {
        return Err(ToolError::NonZero {
            program: program_name,
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(output.stdout)
}

/// [`run`] with a deadline: a program that has not finished when `within` is up is killed and the
/// call fails with an `Io` error of kind `TimedOut`.
///
/// The deadline covers the whole call: the stdin is written by a thread of its own (a child that
/// does not read cannot hold the call), the output is collected by two reader threads that hand it
/// back over a channel, and a program that exits but leaves a descendant holding its pipes is
/// answered at the deadline too. The threads are not waited for after a timeout; they end when the
/// last holder of the pipes does.
pub fn run_within(
    program: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
    within: std::time::Duration,
) -> Result<Vec<u8>, ToolError> {
    use std::io::Read;
    use std::sync::mpsc;
    let program_name = program.display().to_string();
    let timed_out = |what: &str| {
        ToolError::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("{program_name} {what} within {within:?}"),
        ))
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = command.spawn().map_err(|source| ToolError::Spawn {
        program: program_name.clone(),
        source,
    })?;
    if let Some(data) = stdin_data {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| ToolError::parse("stdin", "child stdin was not piped"))?;
        let data = data.to_vec();
        // Dropping `stdin` at the end of the thread closes the pipe so the child sees EOF. A write
        // that fails (the child exited without reading) is the child's exit status to report.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(ToolError::Io)? {
            Some(status) => break status,
            None if started.elapsed() >= within => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(timed_out("did not finish and was stopped"));
            }
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    };
    let left = || within.saturating_sub(started.elapsed());
    let stdout = out
        .recv_timeout(left())
        .map_err(|_| timed_out("exited but left its output open"))?;
    let stderr = err
        .recv_timeout(left())
        .map_err(|_| timed_out("exited but left its output open"))?;
    if !status.success() {
        return Err(ToolError::NonZero {
            program: program_name,
            code: status.code(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        });
    }
    Ok(stdout)
}

/// Convenience: run and decode stdout as UTF-8 text.
pub fn run_text(
    program: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
) -> Result<String, ToolError> {
    let out = run(program, args, stdin_data)?;
    String::from_utf8(out).map_err(|e| ToolError::parse("utf-8 output", e.to_string()))
}

/// Run and return stdout **and** stderr combined (some tools - e.g. `frost-client` -
/// write their human output to stderr). A non-zero exit is still an error.
pub fn run_text_all(
    program: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
) -> Result<String, ToolError> {
    let program_name = program.display().to_string();
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_data.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|source| ToolError::Spawn {
        program: program_name.clone(),
        source,
    })?;
    if let Some(data) = stdin_data {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| ToolError::parse("stdin", "child stdin was not piped"))?;
        stdin.write_all(data).map_err(ToolError::Io)?;
    }
    let output = child.wait_with_output().map_err(ToolError::Io)?;
    if !output.status.success() {
        return Err(ToolError::NonZero {
            program: program_name,
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let mut s = String::from_utf8_lossy(&output.stdout).into_owned();
    s.push('\n');
    s.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn run_captures_stdout() {
        assert_eq!(
            run(Path::new("/bin/echo"), &["hello"], None).unwrap(),
            b"hello\n"
        );
    }

    #[test]
    fn run_within_reads_output_and_errors_like_run_when_the_program_finishes_in_time() {
        let within = std::time::Duration::from_secs(10);
        assert_eq!(
            run_within(Path::new("/bin/echo"), &["hello"], None, within).unwrap(),
            b"hello\n"
        );
        assert_eq!(
            run_within(Path::new("/bin/cat"), &[], Some(b"piped-in"), within).unwrap(),
            b"piped-in"
        );
        let err = run_within(Path::new("/bin/false"), &[], None, within).unwrap_err();
        assert!(
            matches!(err, ToolError::NonZero { code: Some(1), .. }),
            "got {err:?}"
        );
        let err =
            run_within(Path::new("/no/such/konclave-binary-xyz"), &[], None, within).unwrap_err();
        assert!(matches!(err, ToolError::Spawn { .. }), "got {err:?}");
    }

    /// A program that outlives its deadline is stopped and the call returns an `Io` error of kind
    /// `TimedOut`, well before the program would have ended on its own, whatever it does with the
    /// pipes: a shell that leaves a grandchild holding them does not hold the call.
    #[test]
    fn run_within_stops_a_program_that_outlives_its_deadline() {
        let started = std::time::Instant::now();
        let err = run_within(
            Path::new("/bin/sh"),
            &["-c", "sleep 8 & wait"],
            None,
            std::time::Duration::from_millis(300),
        )
        .unwrap_err();
        match err {
            ToolError::Io(e) => assert_eq!(e.kind(), std::io::ErrorKind::TimedOut, "{e}"),
            other => panic!("expected a timeout, got {other:?}"),
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
    }

    /// Every path is under the deadline: a program that exits but leaves a descendant holding its
    /// pipes (`sleep` in the background), and one that is handed more stdin than a pipe holds and
    /// never reads it.
    #[test]
    fn run_within_holds_its_deadline_on_every_path() {
        let started = std::time::Instant::now();
        let e = run_within(
            Path::new("/bin/sh"),
            &["-c", "sleep 6 & exit 0"],
            None,
            std::time::Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(
            matches!(&e, ToolError::Io(x) if x.kind() == std::io::ErrorKind::TimedOut),
            "a descendant holding the pipes: {e:?}"
        );
        let big = vec![b'x'; 1 << 20];
        let e = run_within(
            Path::new("/bin/sh"),
            &["-c", "exec sleep 6"],
            Some(&big),
            std::time::Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(
            matches!(&e, ToolError::Io(x) if x.kind() == std::io::ErrorKind::TimedOut),
            "a child that does not read its stdin: {e:?}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
    }

    /// A descendant that holds only stderr after the program exited 0 is answered at the deadline too.
    #[test]
    fn run_within_holds_its_deadline_when_a_descendant_holds_only_stderr() {
        let t = std::time::Instant::now();
        let r = run_within(
            Path::new("/bin/sh"),
            &["-c", "sleep 6 >/dev/null & exit 0"],
            None,
            std::time::Duration::from_millis(300),
        );
        assert!(
            matches!(&r, Err(ToolError::Io(x)) if x.kind() == std::io::ErrorKind::TimedOut),
            "{r:?}"
        );
        assert!(t.elapsed() < std::time::Duration::from_secs(3));
    }

    /// On a timeout the program is really killed, not just abandoned.
    #[test]
    fn run_within_really_kills_a_program_past_its_deadline() {
        let pidf = std::env::temp_dir().join(format!("run-within-pid-{}", std::process::id()));
        let _ = std::fs::remove_file(&pidf);
        let script = format!("echo $$ > {}; exec sleep 30", pidf.display());
        let r = run_within(
            Path::new("/bin/sh"),
            &["-c", &script],
            None,
            std::time::Duration::from_millis(500),
        );
        assert!(r.is_err());
        let pid = std::fs::read_to_string(&pidf).unwrap().trim().to_string();
        let _ = std::fs::remove_file(&pidf);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "the program {pid} is still alive"
        );
    }

    #[test]
    fn run_passes_stdin_to_child() {
        // `cat` with no args echoes stdin - proves the pipe is wired and closed (EOF).
        let out = run(Path::new("/bin/cat"), &[], Some(b"piped-in")).unwrap();
        assert_eq!(out, b"piped-in");
    }

    #[test]
    fn run_nonzero_exit_is_error_with_code() {
        let err = run(Path::new("/bin/false"), &[], None).unwrap_err();
        assert!(
            matches!(err, ToolError::NonZero { code: Some(1), .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn run_missing_binary_is_spawn_error() {
        let err = run(Path::new("/no/such/konclave-binary-xyz"), &[], None).unwrap_err();
        assert!(matches!(err, ToolError::Spawn { .. }), "got {err:?}");
    }

    #[test]
    fn run_text_decodes_utf8() {
        assert_eq!(
            run_text(Path::new("/bin/echo"), &["olá"], None).unwrap(),
            "olá\n"
        );
    }

    #[test]
    fn run_text_all_merges_stdout_and_stderr() {
        // Some tools (frost-client) write human output to stderr - run_text_all must keep both.
        let s = run_text_all(
            Path::new("/bin/sh"),
            &["-c", "echo on-stdout; echo on-stderr 1>&2"],
            None,
        )
        .unwrap();
        assert!(
            s.contains("on-stdout") && s.contains("on-stderr"),
            "got {s:?}"
        );
    }

    #[test]
    fn run_text_all_still_errors_on_nonzero() {
        let err = run_text_all(Path::new("/bin/false"), &[], None).unwrap_err();
        assert!(matches!(err, ToolError::NonZero { .. }), "got {err:?}");
    }

    #[test]
    fn tool_error_messages_are_human_readable() {
        assert!(ToolError::parse("wallet output", "bad json")
            .to_string()
            .contains("failed to parse wallet output: bad json"));
    }
}

//! Running the external tools with structured error handling.
//!
//! Every invocation captures stdout/stderr and turns a non-zero exit into an
//! explicit `ToolError` carrying the tool's stderr — failures are never silent.
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

/// Convenience: run and decode stdout as UTF-8 text.
pub fn run_text(
    program: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
) -> Result<String, ToolError> {
    let out = run(program, args, stdin_data)?;
    String::from_utf8(out).map_err(|e| ToolError::parse("utf-8 output", e.to_string()))
}

/// Run and return stdout **and** stderr combined (some tools — e.g. `frost-client` —
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

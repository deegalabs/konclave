//! FROST ceremony orchestration: the `frostd` server lifecycle and the
//! coordinator/participant roles.
//!
//! In the product each device runs *its own* role — the coordinator collects the
//! aggregate signature, participants contribute their shares — and `frostd` relays
//! between them. These wrappers therefore model a single role; the multi-device
//! coordination is the server's job. (Our tests ran all roles on one box, which is
//! just a harness, not the product shape.)

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::tools::{run, ToolError};

/// A running `frostd` process, killed on drop so a ceremony can't leak a server.
pub struct Frostd {
    child: Child,
}

impl Frostd {
    /// Start `frostd` with TLS (a leaf cert whose CA the clients trust).
    pub fn start(
        frostd: &Path,
        tls_cert: &str,
        tls_key: &str,
        ip: &str,
        port: u16,
    ) -> Result<Frostd, ToolError> {
        let port_s = port.to_string();
        let child = Command::new(frostd)
            .args(["-c", tls_cert, "-k", tls_key, "-i", ip, "-p", &port_s])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|source| ToolError::Spawn {
                program: frostd.display().to_string(),
                source,
            })?;
        // Wait for frostd to actually accept connections instead of a fixed sleep — poll the
        // TLS port until it's listening (a real readiness handshake, not a magic timeout), up
        // to ~5s. If it never comes up, the ceremony surfaces a clear connection error next.
        if let Ok(addr) = format!("{ip}:{port}").parse::<SocketAddr>() {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
        Ok(Frostd { child })
    }

    pub fn stop(&mut self) -> std::io::Result<()> {
        self.child.kill()
    }
}

impl Drop for Frostd {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Run the coordinator role: create a signing session for `signers`, feed the message
/// (sighash) and, for redpallas, the randomizer, and return the 64-byte aggregate
/// signature once the participants have signed.
///
/// Blocks until the ceremony completes — in the product the participants run
/// concurrently on their own devices.
#[allow(clippy::too_many_arguments)]
pub fn run_coordinator(
    frost_client: &Path,
    config: &str,
    server_url: &str,
    group: &str,
    signers: &[&str],
    sighash_hex: &str,
    randomizer_hex: Option<&str>,
    signature_out_path: &str,
) -> Result<[u8; 64], ToolError> {
    let signers_csv = signers.join(",");
    let mut args: Vec<&str> = vec![
        "coordinator",
        "-c",
        config,
        "--server-url",
        server_url,
        "--group",
        group,
        "-S",
        &signers_csv,
        "-m",
        "-",
    ];
    // The coordinator reads the message (hex) from stdin, then the randomizer if `-r -`.
    let stdin = match randomizer_hex {
        Some(r) => {
            args.push("-r");
            args.push("-");
            format!("{sighash_hex}\n{r}\n")
        }
        None => format!("{sighash_hex}\n"),
    };
    args.push("-o");
    args.push(signature_out_path);

    run(frost_client, &args, Some(stdin.as_bytes()))?;

    let bytes = std::fs::read(signature_out_path).map_err(ToolError::Io)?;
    signature_from_bytes(bytes)
}

/// Run the participant role, auto-confirming the sign prompt. (In the UI the human's
/// explicit "Approve" is that confirmation; here it is fed as `y`.)
pub fn run_participant(
    frost_client: &Path,
    config: &str,
    server_url: &str,
    group: &str,
) -> Result<(), ToolError> {
    run(
        frost_client,
        &[
            "participant",
            "-c",
            config,
            "--server-url",
            server_url,
            "--group",
            group,
        ],
        Some(b"y\n"),
    )?;
    Ok(())
}

fn signature_from_bytes(bytes: Vec<u8>) -> Result<[u8; 64], ToolError> {
    let len = bytes.len();
    bytes
        .try_into()
        .map_err(|_| ToolError::parse("signature", format!("expected 64 bytes, got {len}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_requires_exactly_64_bytes() {
        // The real slice signature was 64 bytes.
        assert!(signature_from_bytes(vec![0u8; 64]).is_ok());
        assert!(matches!(
            signature_from_bytes(vec![0u8; 63]),
            Err(ToolError::Parse { .. })
        ));
        assert!(matches!(
            signature_from_bytes(vec![0u8; 65]),
            Err(ToolError::Parse { .. })
        ));
    }
}

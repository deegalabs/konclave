//! Test support: write a fake engine script that is safe to run at once. Never in a build.
//!
//! On Linux a file that some process holds open for writing cannot be executed: `exec` fails with
//! `ETXTBSY` ("Text file busy", os error 26). A test that writes a script and runs it right away can
//! hit that through no fault of its own: when another test thread forks while the script's write
//! handle is open, the child inherits the handle and keeps it until it runs its own program. The
//! script then fails to start, and the test fails at whatever it checks next (#869: a "sync past its
//! deadline" test failed in CI because its fake never started, `Text file busy`).
//!
//! The handle is closed before this returns, so no process forked after the probe below succeeds
//! can inherit it, and a child forked before it would have made the probe fail. So once one probe
//! starts the script, every later run starts it too. ONE function for every crate's tests (a source
//! scan in the tests keeps it that way), because the rule had a dozen copies and about half of the
//! fakes had none.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

/// The argument the probe runs a script with. The line [`write_script`] puts after the shebang makes
/// the script exit at once on it, so the probe never runs a fake's body (which may log a call or
/// sleep).
pub const PROBE_ARG: &str = "--konclave-exec-probe";

/// How long a script may stay busy before the test fails. A handle inherited by a forked child is
/// held only until that child runs its program: milliseconds, even on a loaded runner.
const BUSY_DEADLINE: Duration = Duration::from_secs(10);

/// Write `body` (a `#!/bin/sh` script) to `path`, make it executable, and return once it can be run.
/// Panics, naming the path, if it is still busy after [`BUSY_DEADLINE`] or cannot be run at all.
pub fn write_script(path: &Path, body: &str) {
    let rest = body.strip_prefix("#!/bin/sh\n").unwrap_or_else(|| {
        panic!(
            "{}: a fake engine script starts with #!/bin/sh",
            path.display()
        )
    });
    // A script read back from disk and rewritten already carries the line: put it in once.
    let probe = format!("[ \"$1\" = \"{PROBE_ARG}\" ] && exit 0\n");
    let rest = rest.strip_prefix(probe.as_str()).unwrap_or(rest);
    let script = format!("#!/bin/sh\n{probe}{rest}");
    std::fs::write(path, script).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| panic!("chmod {}: {e}", path.display()));
    let started = Instant::now();
    loop {
        match std::process::Command::new(path).arg(PROBE_ARG).output() {
            Ok(_) => return,
            Err(e) if e.raw_os_error() == Some(26) && started.elapsed() < BUSY_DEADLINE => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("{} cannot be run: {e}", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("konclave-test-exec-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The probe does not run the body: a fake that logs every call logs nothing for it.
    #[test]
    fn the_probe_does_not_run_the_body() {
        let d = tmp("probe");
        let log = d.join("calls.log");
        let fake = d.join("fake");
        write_script(
            &fake,
            &format!("#!/bin/sh\necho \"$1\" >> \"{}\"\n", log.display()),
        );
        assert!(!log.exists(), "the probe ran the body");
        let out = std::process::Command::new(&fake)
            .arg("sync")
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "sync\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// While any process holds the script open for writing it cannot be run, which is the condition
    /// the wait exists for. (That it runs once the handle is gone is not asserted here: another test
    /// thread forking while `held` is open keeps a copy of it for a moment, which is this very race;
    /// `write_script_waits_while_another_process_holds_the_script_open` checks the run after the wait.)
    #[test]
    fn a_script_held_open_for_writing_cannot_be_run() {
        let d = tmp("busy");
        let fake = d.join("fake");
        write_script(&fake, "#!/bin/sh\nexit 0\n");
        let held = std::fs::OpenOptions::new().write(true).open(&fake).unwrap();
        let busy = std::process::Command::new(&fake).output().unwrap_err();
        assert_eq!(busy.raw_os_error(), Some(26), "{busy}");
        drop(held);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Anything but a shell script is refused: the probe line is shell.
    #[test]
    #[should_panic(expected = "starts with #!/bin/sh")]
    fn a_script_that_is_not_shell_is_refused() {
        write_script(&tmp("notsh").join("fake"), "#!/usr/bin/env python3\n");
    }

    /// Every fake script is written by [`write_script`] and nowhere else: a second copy of the
    /// wait is how about half of the fakes came to have none.
    /// The wait itself: another process holds the script open for writing (as a child forked at the
    /// wrong moment does) while it is written, and the script still runs as soon as this returns.
    /// Without the wait this fails with "Text file busy".
    #[test]
    fn write_script_waits_while_another_process_holds_the_script_open() {
        use std::io::BufRead;
        let d = tmp("wait");
        let fake = d.join("fake");
        std::fs::write(&fake, "").unwrap();
        let mut holder = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "exec 3>>\"{}\"; echo ready; sleep 0.5",
                fake.display()
            ))
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(holder.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "ready\n");
        write_script(&fake, "#!/bin/sh\nexit 0\n");
        let out = std::process::Command::new(&fake).output();
        holder.wait().unwrap();
        assert!(out
            .expect("runs once write_script returned")
            .status
            .success());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A script read back and written again keeps one probe line, not two.
    #[test]
    fn writing_a_script_read_back_from_disk_adds_no_second_probe_line() {
        let d = tmp("again");
        let fake = d.join("fake");
        write_script(&fake, "#!/bin/sh\nexit 0\n");
        let once = std::fs::read_to_string(&fake).unwrap();
        write_script(&fake, &once);
        assert_eq!(std::fs::read_to_string(&fake).unwrap(), once);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_test_writes_an_executable_script_or_waits_for_it_by_hand() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let needles = [
            format!("0o{}", "755"),
            format!("Some({})", "26"),
            format!("ExecutableFile{}", "Busy"),
        ];
        // Every .rs under each crate's src/ and tests/, subdirectories included.
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        for crate_dir in [root.to_path_buf(), root.join("../helper-server")] {
            assert!(
                crate_dir.join("src").is_dir(),
                "{} has no src",
                crate_dir.display()
            );
            walk(&crate_dir.join("src"), &mut files);
            walk(&crate_dir.join("tests"), &mut files);
        }
        assert!(
            files.len() > 20,
            "the scan found the sources: {}",
            files.len()
        );
        let mut found = Vec::new();
        for path in files {
            if path.file_name().is_some_and(|n| n == "test_exec.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            if needles.iter().any(|n| text.contains(n.as_str())) {
                found.push(path.display().to_string());
            }
        }
        assert!(
            found.is_empty(),
            "write fakes with test_exec::write_script: {found:#?}"
        );
    }
}

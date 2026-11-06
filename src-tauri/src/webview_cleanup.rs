// Removes the service worker an earlier version left in the Windows WebView2 profile.
//
// v0.15.0 registered the web's service worker inside the desktop app. After an upgrade, WebView2
// keeps the profile, and the old worker goes on serving the old cached app, so the new page never
// runs and the window stays blank. The JavaScript retire from #834 lives in that new page, so it
// cannot help. Deleting only `EBWebView\Default\Service Worker` brought the window back on Windows
// with the vaults intact (Daniel's v0.17.0-rc.1 test). This does that, before the webview exists.
//
// That folder holds the worker registrations (`Database`), the worker scripts (`ScriptCache`) and
// the Cache API storage (`CacheStorage`). IndexedDB, where the sealed shares are, and Local Storage
// are sibling folders, and nothing here reads, writes or lists them. No `tauri` dependency, so the
// tests run on any machine.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The worker folder, relative to the app's local data folder (WebView2's user data folder).
pub const SERVICE_WORKER_DIR: [&str; 3] = ["EBWebView", "Default", "Service Worker"];
/// Holds the app version that last ran the cleanup, so it runs once per version.
pub const MARKER: &str = "sw-cleanup.version";
/// The worker folder is moved out under this prefix before it is deleted.
const RETIRED_PREFIX: &str = ".sw-retired-";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// This version already ran it.
    AlreadyDone,
    /// No worker folder was there.
    NothingToRemove,
    /// The worker folder was moved out of the profile and deleted.
    Removed,
    /// Nothing was removed and no marker written, so the next launch tries again.
    Failed(String),
}

impl std::fmt::Display for Outcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Outcome::AlreadyDone => write!(f, "already done for this version"),
            Outcome::NothingToRemove => write!(f, "no old service worker"),
            Outcome::Removed => write!(f, "removed the old service worker"),
            Outcome::Failed(why) => write!(f, "left as it was, will retry next launch: {why}"),
        }
    }
}

pub fn service_worker_dir(data_dir: &Path) -> PathBuf {
    SERVICE_WORKER_DIR
        .iter()
        .fold(data_dir.to_path_buf(), |p, s| p.join(s))
}

/// Run once per `version`. Never panics and never touches anything but the worker folder, its
/// moved-out copies and the marker. The folder is RENAMED out first: on Windows that fails as a
/// whole while any file in it is open, so the worker data is either intact or gone, never half.
pub fn retire_service_worker(data_dir: &Path, version: &str) -> Outcome {
    if !data_dir.is_dir() {
        return Outcome::NothingToRemove; // first launch: no profile yet
    }
    sweep_retired(data_dir);
    let marker = data_dir.join(MARKER);
    if fs::read_to_string(&marker).is_ok_and(|v| v.trim() == version) {
        return Outcome::AlreadyDone;
    }
    let sw = service_worker_dir(data_dir);
    let outcome = match fs::symlink_metadata(&sw) {
        Err(e) if e.kind() == ErrorKind::NotFound => Outcome::NothingToRemove,
        Err(e) => return Outcome::Failed(format!("could not inspect the folder: {e}")),
        Ok(_) => {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            let retired = data_dir.join(format!("{RETIRED_PREFIX}{stamp}-{}", std::process::id()));
            if let Err(e) = fs::rename(&sw, &retired) {
                return Outcome::Failed(format!("could not move the folder (in use?): {e}"));
            }
            // Out of the profile already; a copy that will not delete is swept next launch.
            let _ = fs::remove_dir_all(&retired);
            Outcome::Removed
        }
    };
    match fs::write(&marker, version) {
        Ok(()) => outcome,
        Err(e) => Outcome::Failed(format!("{outcome}, but could not record it: {e}")),
    }
}

/// Best effort: delete copies an earlier run moved out but could not delete.
fn sweep_retired(data_dir: &Path) {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(RETIRED_PREFIX)
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("kc-swclean-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The files a v0.15 profile holds, with what must survive and what must go.
    const KEEP: [(&str, &str); 3] = [
        (
            "EBWebView/Default/IndexedDB/http_tauri.localhost_0.indexeddb.leveldb/000003.log",
            "share",
        ),
        (
            "EBWebView/Default/Local Storage/leveldb/000003.log",
            "settings",
        ),
        ("EBWebView/Default/Preferences", "{}"),
    ];
    const GO: [&str; 3] = [
        "Database/CURRENT",
        "ScriptCache/index",
        "CacheStorage/abc/index.txt",
    ];

    fn profile(dir: &Path) {
        for (rel, body) in KEEP {
            let p = dir.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
        for rel in GO {
            let p = service_worker_dir(dir).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "old").unwrap();
        }
    }

    fn assert_kept(dir: &Path) {
        for (rel, body) in KEEP {
            assert_eq!(
                fs::read_to_string(dir.join(rel)).unwrap(),
                body,
                "{rel} must survive"
            );
        }
    }

    #[test]
    fn removes_only_the_worker_folder_and_records_the_version() {
        let t = TempDir::new("removes");
        profile(&t.0);
        assert_eq!(retire_service_worker(&t.0, "0.17.0"), Outcome::Removed);
        assert!(!service_worker_dir(&t.0).exists());
        assert_kept(&t.0);
        assert_eq!(fs::read_to_string(t.0.join(MARKER)).unwrap(), "0.17.0");
        let left: Vec<_> = fs::read_dir(&t.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            left.len(),
            2,
            "only EBWebView and the marker remain: {left:?}"
        );
    }

    #[test]
    fn runs_once_per_version() {
        let t = TempDir::new("once");
        profile(&t.0);
        retire_service_worker(&t.0, "0.17.0");
        profile(&t.0);
        assert_eq!(retire_service_worker(&t.0, "0.17.0"), Outcome::AlreadyDone);
        assert!(
            service_worker_dir(&t.0).exists(),
            "same version does nothing"
        );
        assert_eq!(retire_service_worker(&t.0, "0.17.1"), Outcome::Removed);
        assert_kept(&t.0);
    }

    #[test]
    fn absent_folder_or_absent_profile_is_fine() {
        let t = TempDir::new("absent");
        assert_eq!(
            retire_service_worker(&t.0.join("nope"), "1"),
            Outcome::NothingToRemove
        );
        assert_eq!(retire_service_worker(&t.0, "1"), Outcome::NothingToRemove);
        assert_eq!(fs::read_to_string(t.0.join(MARKER)).unwrap(), "1");
    }

    #[test]
    fn sweeps_a_copy_an_earlier_run_could_not_delete() {
        let t = TempDir::new("sweep");
        fs::create_dir_all(t.0.join(".sw-retired-1-2/ScriptCache")).unwrap();
        retire_service_worker(&t.0, "1");
        assert!(!t.0.join(".sw-retired-1-2").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_move_is_left_intact_and_retried() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempDir::new("locked");
        profile(&t.0);
        let default = t.0.join("EBWebView/Default");
        fs::set_permissions(&default, fs::Permissions::from_mode(0o555)).unwrap();
        let root = fs::write(default.join("probe"), "").is_ok(); // root ignores permissions
        let got = retire_service_worker(&t.0, "0.17.0");
        fs::set_permissions(&default, fs::Permissions::from_mode(0o755)).unwrap();
        if root {
            return;
        }
        assert!(matches!(got, Outcome::Failed(_)), "{got:?}");
        assert!(
            service_worker_dir(&t.0).join(GO[0]).exists(),
            "worker data intact"
        );
        assert!(
            !t.0.join(MARKER).exists(),
            "no marker, so the next launch retries"
        );
        assert_kept(&t.0);
    }
}

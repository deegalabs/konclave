// The installer contract: values in tauri.conf.json that an installed copy depends on.
//
// The sealed shares of the desktop app live in the WebView's IndexedDB, not in the keychain (the
// UI never calls the `secure_*` commands). That storage is keyed by two things this file pins:
//
// - the IDENTIFIER names the profile folder (`%LOCALAPPDATA%\app.konclave.desktop` on Windows,
//   the same name under the macOS and Linux data directories);
// - `useHttpsScheme` picks the page's origin on Windows (`http://tauri.localhost` when false,
//   `https://tauri.localhost` when true), and IndexedDB is per origin.
//
// Changing either one does not delete anything. It makes the next version open an empty profile,
// so every vault on the computer looks gone, with the data still on disk where the app no longer
// looks. Both are written out explicitly (relying on the default would let a Tauri release move
// it), and this test fails if either changes or goes missing.
//
// It also pins two installer choices whose change breaks an upgrade rather than the data: MSI is
// not built (the NSIS installer is the one Windows upgrade path), and the NSIS install stays per
// user (per machine moves the registry entry from HKCU to HKLM, the installer no longer finds the
// previous version, and the computer ends up with two copies).

use serde_json::Value;

const CONF: &str = include_str!("../tauri.conf.json");
const RELEASE_WORKFLOW: &str = include_str!("../../.github/workflows/desktop-release.yml");
const HOOKS: &str = include_str!("../windows/hooks.nsh");

fn conf() -> Value {
    serde_json::from_str(CONF).expect("tauri.conf.json is valid JSON")
}

#[test]
fn identifier_is_pinned() {
    assert_eq!(
        conf()["identifier"],
        "app.konclave.desktop",
        "the identifier names the folder the vaults live in; changing it hides them"
    );
}

#[test]
fn every_window_pins_http_scheme() {
    let c = conf();
    let windows = c["app"]["windows"]
        .as_array()
        .expect("app.windows is a list");
    assert!(!windows.is_empty(), "at least one window is declared");
    for w in windows {
        assert_eq!(
            w.get("useHttpsScheme"),
            Some(&Value::Bool(false)),
            "useHttpsScheme must be written out as false: the origin keys the vaults' storage"
        );
    }
}

#[test]
fn windows_ships_nsis_only() {
    let c = conf();
    let targets = c["bundle"]["targets"]
        .as_array()
        .expect("bundle.targets is an explicit list, not \"all\" (which builds an MSI)");
    let names: Vec<&str> = targets.iter().filter_map(Value::as_str).collect();
    assert!(names.contains(&"nsis"), "the Windows installer is NSIS");
    assert!(!names.contains(&"msi"), "no MSI: one Windows upgrade path");
    // Linux and macOS keep what v0.16.0 shipped; the bundler skips the types of other platforms.
    for t in ["deb", "rpm", "appimage", "app", "dmg"] {
        assert!(names.contains(&t), "{t} is still built");
    }
}

#[test]
fn nsis_installs_per_user() {
    assert_eq!(
        conf()["bundle"]["windows"]["nsis"]["installMode"],
        "currentUser",
        "per machine would not find a v0.16.0 per-user install and would install a second copy"
    );
}

// The tauri-cli the release bundles with, which the hook below was checked against.
const PINNED_CLI: &str = "2.12.4";

/// The release workflow's build steps, parsed: a comment or a commented-out line cannot satisfy it.
fn release_steps() -> Vec<yaml_rust2::Yaml> {
    let docs = yaml_rust2::YamlLoader::load_from_str(RELEASE_WORKFLOW).expect("valid YAML");
    docs[0]["jobs"]["build"]["steps"]
        .as_vec()
        .expect("jobs.build.steps is a list")
        .clone()
}

// The release installs the pinned CLI with a step of its own, and tauri-action runs that CLI
// (`tauriScript`), after it. Without `tauriScript`, tauri-action installs the newest 2.x itself and
// the pin is decoration.
#[test]
fn release_bundles_with_the_pinned_cli() {
    let steps = release_steps();
    let install = format!("cargo install tauri-cli --version {PINNED_CLI} --locked");
    let pin = steps.iter().position(|s| {
        s["run"]
            .as_str()
            .is_some_and(|r| r.lines().any(|l| l.trim() == install))
    });
    let action = steps.iter().position(|s| {
        s["uses"]
            .as_str()
            .is_some_and(|u| u.starts_with("tauri-apps/tauri-action@"))
    });
    let (pin, action) = (
        pin.expect("a step runs the pinned install"),
        action.expect("a step uses tauri-action"),
    );
    assert!(
        pin < action,
        "the CLI is installed before tauri-action runs"
    );
    assert_eq!(
        steps[action]["with"]["tauriScript"].as_str(),
        Some("cargo tauri"),
        "tauri-action runs the installed CLI, not one it installs itself"
    );
}

// The uninstall hook reads two variables internal to Tauri's NSIS template. makensis does not
// fail on an unknown variable, it warns, so a renamed variable would silently disable the
// question that protects the vaults. They were read in tauri-bundler 2.10.4, which tauri-cli
// 2.12.4 pins exactly. Moving PINNED_CLI is a decision to re-read the template
// (src/bundle/windows/nsis/installer.nsi) and this hook together.
#[test]
fn uninstall_hook_asks_before_deleting() {
    assert_eq!(
        conf()["bundle"]["windows"]["nsis"]["installerHooks"],
        "windows/hooks.nsh"
    );
    // Code only: the file's own comments name every line below, and a check a comment could
    // satisfy passes with the code gone. NSIS comments are `;`, `#` and `/* ... */`.
    let mut code = String::new();
    let mut in_block = false;
    for line in HOOKS.lines() {
        let t = line.trim_start();
        if in_block || t.starts_with("/*") {
            in_block = !t.contains("*/");
        } else if !t.starts_with(';') && !t.starts_with('#') {
            code.push_str(line);
            code.push('\n');
        }
    }
    // In this order: only when the box was ticked and this is not an update, ask with "No" as the
    // default (also a silent uninstall's answer), and on "No" clear the choice before the template
    // reads it.
    let mut at = 0;
    for step in [
        "!macro NSIS_HOOK_PREUNINSTALL",
        "${If} $DeleteAppDataCheckboxState = 1",
        "${AndIf} $UpdateMode <> 1",
        "MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2",
        "/SD IDNO IDYES konclave_delete_confirmed",
        "StrCpy $DeleteAppDataCheckboxState 0",
        "konclave_delete_confirmed:",
        "${EndIf}",
        "!macroend",
    ] {
        let found = code[at..]
            .find(step)
            .unwrap_or_else(|| panic!("hooks.nsh code has `{step}`, after the lines before it"));
        at += found + step.len();
    }
}

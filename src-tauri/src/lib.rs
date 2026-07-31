// UNVALIDATED SCAFFOLD.
//
// This file has NOT been compiled or run anywhere in this project. The dev machine's
// WSLg/GTK webview does not paint a window (docs/adr/0004-local-http-bridge.md), and no
// macOS/iOS/Android build host was available, so nothing here is validated by a real build.
// It is deliberately minimal and correct-in-principle groundwork for the plan in
// docs/TAURI-PLAN.md. Do not read a green CI signal into it: there is none yet.
//
// What it does when it DOES build on proper hardware:
//   - opens a native webview whose content is the already-built Vite/React UI
//     (tauri.conf.json -> build.frontendDist -> ../ui/dist), so the entire browser-proven
//     app (the /net DKG + FROST flow, the relay/helper protocol, the konclave-wasm crypto)
//     runs unchanged inside the OS webview;
//   - exposes three `invoke` commands that let the SAME UI persist its per-device FROST
//     share in the OS keychain instead of browser IndexedDB (ui/src/storage.ts). Only the
//     ENCRYPTED share bytes (already sealed by the UI) and public metadata are stored; the
//     plaintext share never crosses this boundary and never leaves the device.
//
// The share still never leaves the device (principle §6.3); the keychain is simply a more
// durable, OS-backed at-rest store than a browser origin's IndexedDB.

use keyring::Entry;

// A stable service name namespaces every keychain entry Konclave owns on this OS account.
const KEYCHAIN_SERVICE: &str = "app.konclave.share";

// The share bytes handed across the boundary are ALREADY ciphertext produced by the UI's
// sealing step; this layer treats them as opaque and only base64-wraps them so the keychain
// (which stores UTF-8 secrets) can hold arbitrary bytes. No plaintext key material here.
fn b64(bytes: &[u8]) -> String {
    // Dependency-free base64 (standard alphabet, padded). Kept tiny on purpose: this scaffold
    // should not drag in a crate just to move already-encrypted bytes into the keychain.
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(A[((n >> 18) & 63) as usize] as char);
        out.push(A[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { A[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = s.bytes().filter(|&c| c != b'=' && !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        let mut bits = 0;
        for &c in chunk {
            n = (n << 6) | val(c).ok_or("invalid base64 in stored share")?;
            bits += 6;
        }
        // Emit only the fully-decoded bytes for this chunk.
        n <<= 24 - bits;
        for i in 0..(bits / 8) {
            out.push(((n >> (16 - i * 8)) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Store the (already-encrypted) share bytes for `id` in the OS keychain.
/// `share_b64` is base64 of ciphertext produced by the UI; this command does not encrypt
/// or decrypt, and never sees plaintext key material.
#[tauri::command]
fn keychain_set_share(id: String, share_b64: String) -> Result<(), String> {
    // Validate the payload is well-formed base64 before writing (boundary check, §6.8).
    let _ = unb64(&share_b64)?;
    let entry = Entry::new(KEYCHAIN_SERVICE, &id).map_err(|e| e.to_string())?;
    entry.set_password(&share_b64).map_err(|e| e.to_string())
}

/// Return the stored share bytes (base64) for `id`, or an explicit "not found" error.
#[tauri::command]
fn keychain_get_share(id: String) -> Result<String, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Err(format!("no share stored on this device for id {id}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove the stored share for `id` from this device's keychain.
#[tauri::command]
fn keychain_delete_share(id: String) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Mobile (iOS/Android) enters through this function; desktop uses the same path via main.rs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            keychain_set_share,
            keychain_get_share,
            keychain_delete_share,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Konclave Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{b64, unb64};

    // A pure round-trip check of the base64 helper. This does NOT exercise Tauri or the
    // keychain (neither is available here); it only guards the byte-wrapping used at the
    // boundary. It is the only thing in this scaffold that can be honestly tested offline.
    #[test]
    fn base64_round_trips() {
        for case in [b"".as_slice(), b"a", b"ab", b"abc", b"abcd", &[0u8, 255, 1, 254, 127]] {
            assert_eq!(unb64(&b64(case)).unwrap(), case, "round-trip mismatch");
        }
    }
}

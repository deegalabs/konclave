# Testnet export drill

Use fresh, disposable material for this drill. Three Node participant contexts run the app’s creation ceremony and the checked-in WASM. Each seat has its own in-memory IndexedDB and localStorage. One process simulates the three members comparing their creation code. This exercises the harness and the existing v2 writer. Physical-device isolation, browser-created exports and funds recovery require separate evidence.

## Run the offline checks

From the checkout root, use Node 24 and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
node ui/drill/export.mjs self-test
pnpm -C ui run test src/recovery-export.test.ts src/open-export.test.ts src/dkg-ceremony.test.ts
```

The self-test generates fresh passphrases in memory. All three seats save their real packages and prove completion before the writer runs. With no helper, their storage records are pending. Their exports contain the shares and private read secret and omit wallet data. Each reopens in a separate Node process. The self-test discards the exports.

## Prepare the Linux helper

Use a private Linux host with Node 24, Rust, Python 3.11+, a free loopback port 14780, and access to the testnet lightwalletd at `testnet.zec.rocks:443`. The helper checks available disk space before admitting a fresh vault. Run the commands from the checkout root in one shell. Choose one of the two engine routes below.

```sh
set -eu
umask 077
cargo build --release --locked -p helper-server
cargo build --release --locked -p orchestrator --example check_export_receivers
export KONCLAVE_HELPER_BINARY="$PWD/target/release/helper-server"
export KONCLAVE_RECEIVER_CHECK="$PWD/target/release/examples/check_export_receivers"
git rev-parse HEAD
sha256sum "$KONCLAVE_HELPER_BINARY" "$KONCLAVE_RECEIVER_CHECK" ui/src/wasm-pkg/konclave_wasm_bg.wasm
```

### Recorded deployment artifacts

Point these variables at the two acquired files. Compare their bytes against this checkout’s `[[deploy_binary]]` entries before starting the helper.

```sh
export KONCLAVE_ZCASH_SIGN=/opt/konclave-engine/bin/zcash-sign
export KONCLAVE_DEVTOOL=/opt/konclave-engine/bin/zcash-devtool

python3 - <<'PY'
import hashlib, os, tomllib
with open('engine/versions.lock', 'rb') as f:
    pins = {row['name']: row['sha256'] for row in tomllib.load(f)['deploy_binary']}
for name, var in [('zcash-sign', 'KONCLAVE_ZCASH_SIGN'), ('zcash-devtool', 'KONCLAVE_DEVTOOL')]:
    with open(os.environ[var], 'rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    if digest != pins[name]:
        raise SystemExit('Engine checksum mismatch for ' + name)
    print(name, digest)
PY
```

### Pinned-source builds

Use Git, GNU patch and rustup. On Ubuntu 24.04 the build environment includes `build-essential`, `cmake`, `pkg-config`, `libssl-dev`, `libudev-dev` and `protobuf-compiler`. Allow space for two separate release builds.

The drill builder reads `[source.frost-tools]` for `zcash-sign` and checks its committed `Cargo.lock`. For `zcash-devtool` it resolves `[source.zcash-devtool-stable]`, verifies the recorded patch and replacement lockfile by SHA-256, applies the patch with `-p1` and zero fuzz, and installs that lockfile. Both builds use the resolved commits and `cargo build --release --locked`. Rust 1.99.0 is the compiler recorded for the stable devtool build.

```sh
rustup toolchain install 1.99.0 --profile minimal
builds=$(mktemp -d "$HOME/konclave-engine-builds.XXXXXXXX")
python3 ui/drill/build-engine.py zcash-sign "$builds/sign"
python3 ui/drill/build-engine.py zcash-devtool "$builds/devtool"
(cd "$builds/sign" && sha256sum -c SHA256SUMS)
(cd "$builds/devtool" && sha256sum -c SHA256SUMS)
export KONCLAVE_ZCASH_SIGN="$builds/sign/target/release/zcash-sign"
export KONCLAVE_DEVTOOL="$builds/devtool/target/release/zcash-devtool"
```

Keep each build’s `provenance.json` and `SHA256SUMS` with its verification evidence. They identify the full source commit, effective Cargo lockfile, any patch, compiler, target, command and actual executable digest. Build paths can affect the bytes. Record these as local source builds. The deployment records in `engine/versions.lock` identify the separately built artifacts.

## Generate the complete exports

```sh
# Choose a private parent on persistent storage outside the repository.
drill=$(mktemp -d "$HOME/konclave-export-drill.XXXXXXXX")
node ui/drill/export.mjs generate "$drill/exports"
```

Enter and confirm a separate passphrase for each seat at its hidden terminal prompt. `generate` launches its own helper with `KONCLAVE_NETWORK=test`, `KONCLAVE_LIGHTWALLETD=testnet.zec.rocks:443` and a new private vaults directory. It waits for that process to bind before checking the helper’s creation protocol. Registration uses `POST /api/vault` with the public package and real seat certificates. The helper receives no share.

The setup reads the UFVK and birthday from that new vault’s `registration.json`. The helper’s public response must match the package digest, group, quorum and both addresses. The registration has no network field. The native checker decodes the actual UFVK for testnet with `konclave_seal::receivers::vault_receivers`, checks its Orchard group key and both derived addresses, and compares the scan floor with the wallet’s `keys.toml`. A refused check stops generation before any export is retained.

The writer receives the validated UFVK and birthday. In memory, the harness compares each opened export to its seat’s original key package, public package, read secret and setup metadata. It runs a fresh reader on each file before writing the three encrypted files. The helper stops and its temporary registration and wallet directory are removed. After a hard kill or power loss, a `.konclave-setup-*` directory inside this newly created drill parent may need private removal after its helper has stopped.

## Retain and verify

Retain `seat-1.konclave.json`, `seat-2.konclave.json` and `seat-3.konclave.json` privately for the later drill. Give each member their own file and keep the passphrases separately. Run the reader with each member’s file, including after the helper has stopped.

```sh
node ui/drill/export.mjs verify "$drill/exports/seat-1.konclave.json"
node ui/drill/export.mjs verify "$drill/exports/seat-2.konclave.json"
node ui/drill/export.mjs verify "$drill/exports/seat-3.konclave.json"
```

The fresh reader accepts the encrypted file and a terminal-entered passphrase. Its Node file permissions cover only the opener, reader code and WASM. It checks v2, the seat and quorum, public-package identity and required private-wallet fields. The independent testnet key and receiver check runs during setup. Publish only verdicts, the source commit and binary checksums. Keep exports, keys, registration contents, passphrases and wallet files private.

# konclave-wasm: browser-signer core (WS1)

The three de-risked probes assembled into **one wasm-bindgen module** the browser calls:

1. **FROST-redpallas signing round** (`wasm-signer-spike`)
2. **Orchard action verification** surface (`wasm-orchard-probe`)
3. **ZIP-244 sig_digest** via blake2b (`wasm-sighash-probe`)

**Milestone (2026-07-11): assembled, compiles, and RUNS in a real browser.**
- The three deps (`reddsa`/frost + `orchard` + `blake2b_simd`) compile **together** natively
  and to `wasm32-unknown-unknown`, with **zero `secp256k1`** in the tree (`cargo tree` empty).
- `wasm-pack build --target web` (today: `node scripts/build-wasm.mjs`, below) → a ~750 KB `.wasm` (2026-07; ~1.4 MB now); `selftest()` runs a full 2-of-3
  rerandomized redpallas ceremony and **VERIFIES inside headless Chromium**.

The split ceremony (`ceremony` module) drives a full 2-of-3 rerandomized redpallas signature
**through serialized wire bytes**: the share (KeyPackage) and nonces stay local; only public
material (commitments, signing package, randomizer seed, shares, signature) crosses, exactly
what the blind relay carries. This is the "round1/round2/aggregate over the relay" step of the
konclave.xyz plan (temp/21, WS1). The **wasm-bindgen JS API** (`TestVault`, `participantRound1`,
`Coordinator`, `participantRound2`) lets **JavaScript drive the full multi-device ceremony**,
verified in headless Chromium (`js-test/ceremony.html` → `JS-CEREMONY-OK sig=64B`), exactly the
surface the React app calls. Next: implement the byte-exact
Orchard-only `sig_digest` (vs `konclave-signer` on a real PCZT), and generate the TS API
(temp/24) for the React app.

## Reproduce
```sh
cargo test                                              # native: assembled core signs+verifies+hashes
cargo tree --target wasm32-unknown-unknown | grep -c secp256k1   # 0
node ../scripts/build-wasm.mjs --out pkg                # the pinned recipe; ~1.4 MB .wasm
# serve pkg/ over http and call selftest() → "OK: 2-of-3 … VERIFIED"
```

The package the app ships (`ui/src/wasm-pkg`) is regenerated only with `node scripts/build-wasm.mjs`
from the repository root: it builds with the compiler pinned in `rust-toolchain.toml`, the wasm-pack
version recorded in `engine/versions.lock` and fixed source paths, so the same source gives the same
bytes on any machine, and it records the result in `engine/versions.lock`. CI rebuilds the module the
same way and fails if the committed package or its record differs (#1065).

What that guards against is a package in the repository that is stale, mixed or replaced by mistake.
It is not a defence against a hostile web host, which serves the module and could serve any bytes
(#605 is the outside check), and wasm-pack downloads the wasm-bindgen CLI and binaryen pinned by
version, not by checksum.

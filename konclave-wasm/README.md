# konclave-wasm — browser-signer core (WS1)

The three de-risked probes assembled into **one wasm-bindgen module** the browser calls:

1. **FROST-redpallas signing round** (`wasm-signer-spike`)
2. **Orchard action verification** surface (`wasm-orchard-probe`)
3. **ZIP-244 sig_digest** via blake2b (`wasm-sighash-probe`)

**Milestone (2026-07-11): assembled, compiles, and RUNS in a real browser.**
- The three deps (`reddsa`/frost + `orchard` + `blake2b_simd`) compile **together** natively
  and to `wasm32-unknown-unknown` — **zero `secp256k1`** in the tree (`cargo tree` empty).
- `wasm-pack build --target web` → a ~750 KB `.wasm`; `selftest()` runs a full 2-of-3
  rerandomized redpallas ceremony and **VERIFIES inside headless Chromium**.

The split ceremony (`ceremony` module) drives a full 2-of-3 rerandomized redpallas signature
**through serialized wire bytes** — the share (KeyPackage) and nonces stay local; only public
material (commitments, signing package, randomizer seed, shares, signature) crosses, exactly
what the blind relay carries. This is the "round1/round2/aggregate over the relay" step of the
konclave.app plan (temp/21, WS1). The **wasm-bindgen JS API** (`TestVault`, `participantRound1`,
`Coordinator`, `participantRound2`) lets **JavaScript drive the full multi-device ceremony** —
verified in headless Chromium (`js-test/ceremony.html` → `JS-CEREMONY-OK sig=64B`), exactly the
surface the React app calls. Next: implement the byte-exact
Orchard-only `sig_digest` (vs `konclave-signer` on a real PCZT), and generate the TS API
(temp/24) for the React app.

## Reproduce
```sh
cargo test                                              # native: assembled core signs+verifies+hashes
cargo tree --target wasm32-unknown-unknown | grep -c secp256k1   # 0
wasm-pack build --target web --out-dir pkg              # ~750 KB .wasm
# serve pkg/ over http and call selftest() → "OK: 2-of-3 … VERIFIED"
```

# Konclave: system diagrams

Complete system flow of Konclave, from the current MVP through the delivered roadmap. All
diagrams are Mermaid and render on GitHub. Two vocabularies appear throughout: **public
material** (commitments, signing packages, signatures) crosses the wire freely, while a
**share** (the secret piece of the key) never leaves its device.

## 1. System overview (three layers)

```mermaid
flowchart TB
  A["Member devices: Alice, Bob, Carol. The share never leaves the device"]
  UI["Layer 3, UI (Vite + React): Dashboard, Payment, Payroll, Proposal, Ledger, /net, /signer"]
  Orch["Layer 2, Orchestrator (Rust): state machine, validation, store (SQLCipher), sealed custody, FROST-to-PCZT bridge"]
  Eng["Layer 1, Engine (Zcash Foundation): frostd, frost-client, zcash-sign, zcash-devtool, librustzcash"]
  Relay["Blind relay (loopback and hosted)"]
  Chain["Zcash mainnet (Orchard, shielded)"]

  A --> UI
  UI -->|"JSON, loopback only"| Orch
  Orch --> Eng
  Eng -->|"broadcast"| Chain
  UI -.->|"public or encrypted bytes"| Relay
  A -.-> Relay
```

## 2. Create a vault by Distributed Key Generation

The key is generated distributed and is never reconstituted. Only public round-1 packages and
sealed round-2 packages cross the relay.

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice device
  participant B as Bob device
  participant R as Blind relay
  participant Z as zcash-sign

  Note over A,B: each device generates its own identity and enc key
  A->>R: hello (enc pubkey)
  B->>R: hello (enc pubkey)
  A->>R: round-1 package (public, broadcast)
  B->>R: round-1 package (public, broadcast)
  Note over A,B: part2 makes one secret round-2 package per recipient
  A->>R: round-2 package for Bob (sealed to Bob)
  B->>R: round-2 package for Alice (sealed to Alice)
  Note over A,B: part3 combines everything locally
  A->>Z: group verifying key
  Z->>A: Orchard address and UFVK
  Note over A,B: same group key on both, the whole key never existed
```

## 3. Quorum payment (propose, approve, sign, broadcast)

```mermaid
sequenceDiagram
  autonumber
  participant U as Proposer
  participant O as Orchestrator
  participant M as Other members
  participant E as Engine (devtool, signer, frostd)
  participant C as Zcash mainnet

  U->>O: propose payment (to, amount, memo)
  Note over O: validate address, amount, balance
  O->>U: Awaiting (proposer is first approval)
  M->>O: approve
  Note over O: quorum reached, state becomes Ready
  U->>O: send (explicit confirmation)
  Note over O: vault-binding guard, proposal vault must match the ceremony
  O->>E: PCZT create and prove
  Note over E: FROST ceremony over frostd, shares of who approved
  E->>C: inject signature, finalize, broadcast (Orchard)
  C->>O: txid
  O->>U: Sent, txid recorded in the ledger
```

## 4. Private payroll (N outputs, one approval)

```mermaid
flowchart LR
  CSV["CSV: label, address, amount, memo"] --> Parse["Parse and validate each line"]
  Parse --> Plan["Payroll plan, N outputs"]
  Plan --> Prop["One proposal, approved once"]
  Prop --> Quorum{"Quorum reached?"}
  Quorum -->|no| Wait["Awaiting"]
  Quorum -->|yes| Build["Multi-output Orchard builder (zcash_client_backend)"]
  Build --> Sign["FROST ceremony, one signature per real spend"]
  Sign --> Tx["One shielded transaction, N encrypted memos"]
  Tx --> Ledger["Itemized ledger, N line-items, CSV export"]
```

## 5. Multi-device FROST in the browser (the /net flow, live over the internet)

```mermaid
sequenceDiagram
  autonumber
  participant TA as Tab A (creator)
  participant TB as Tab B (guest)
  participant HR as Hosted blind relay (Railway)

  TA->>HR: create room, config (n, t), hello
  Note over TA: show the invite code
  TB->>HR: join with code, hello
  Note over TA,TB: seating is deterministic (sorted tags)
  TA->>HR: DKG round 1 (public)
  TB->>HR: DKG round 1 (public)
  TA->>HR: DKG round 2 (sealed to recipient)
  TB->>HR: DKG round 2 (sealed to recipient)
  Note over TA,TB: both derive the same group key, each keeps only its share
  TA->>HR: sign request (test digest)
  TA->>HR: commitment (round 1)
  TB->>HR: commitment (round 1)
  TA->>HR: signing package and seed
  TA->>HR: signature share (round 2)
  TB->>HR: signature share (round 2)
  Note over TA,TB: aggregate, each device verifies the group signature itself
```

## 6. Social recovery (Repairable Threshold Scheme)

A member loses a device. A quorum of helpers rebuilds that member's share. The group key is
untouched, no share is revealed, and the repaired share is byte-identical to the lost one.

```mermaid
sequenceDiagram
  autonumber
  participant H1 as Helper 1
  participant H2 as Helper 2
  participant R as Blind relay
  participant M as Recovering member

  Note over H1,H2: each helper computes one delta per helper (part 1)
  H1->>R: delta for H2 (sealed)
  H2->>R: delta for H1 (sealed)
  Note over H1,H2: each helper sums received deltas into a sigma (part 2)
  H1->>R: sigma (sealed to the member)
  H2->>R: sigma (sealed to the member)
  R->>M: sigmas
  Note over M: combine into the repaired KeyPackage (part 3), validate vs the group share
  Note over M: the repaired share signs a verifying quorum again
```

## 7. Proposal state machine

```mermaid
stateDiagram-v2
  [*] --> Awaiting: propose (proposer is first approval)
  Awaiting --> Ready: approve (quorum reached)
  Awaiting --> Refused: refusal makes quorum unreachable
  Awaiting --> Expired: past the expiry window
  Ready --> Sent: sign (FROST) and broadcast
  Ready --> Refused: refusal before send
  Refused --> [*]
  Expired --> [*]
  Sent --> [*]
```

## 8. Inheritance, the dead-man's-switch

```mermaid
stateDiagram-v2
  [*] --> Active: policy armed (lapse window, grace, heir)
  Active --> Pending: silence past the lapse window
  Pending --> Active: heartbeat within the grace period
  Pending --> Released: silence past lapse plus grace
  Released --> [*]: quorum releases to the heir (an ordinary quorum-signed payment)
```

## 9. Deployment topology

```mermaid
flowchart LR
  Dev["Developer: git push to main"] --> GH["GitHub: deegalabs/konclave"]
  GH --> CI["CI: fmt, clippy, tests (4 Rust crates), wasm build, UI"]
  GH -->|"auto-deploy"| Vercel["Vercel: UI demo (konclave-demo.vercel.app)"]
  GH -.->|"native connect, see DEPLOY.md"| Railway["Railway: blind relay (relay-server)"]
  Vercel -->|"/net posts opaque bytes"| Railway
  Bridge["Local: konclave serve (loopback bridge)"] --> EngineBins["Engine binaries (engine/versions.lock)"]
  EngineBins --> Mainnet["Zcash mainnet (the real path)"]
```

## 10. The trust boundary, at a glance

```mermaid
flowchart LR
  Dev["The device: FROST share and signing nonces, never leave"] -->|"produces"| Pub["Public FROST material"]
  Pub -->|"broadcast"| Tx["Mainnet sees one ordinary single-signer shielded tx"]
  Dev -.->|"sealed round-2 and deltas"| Relay["Blind relay sees only ciphertext and metadata"]
  Tx --> Key["The whole key is never reconstituted"]
```

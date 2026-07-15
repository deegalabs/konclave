# Konclave: system diagrams

Complete system flow of Konclave, from the current MVP through the delivered roadmap. All
diagrams are Mermaid and render on GitHub. Two vocabularies appear throughout: **public
material** (commitments, signing packages, signatures) crosses the wire freely, while a
**share** (the secret piece of the key) never leaves its device.

## 1. System overview (three layers)

```mermaid
flowchart TB
  subgraph Devices["Member devices, the share never leaves"]
    A["Alice, share 1"]
    B["Bob, share 2"]
    C["Carol, share 3"]
  end

  subgraph L3["Layer 3, UI (Vite + React)"]
    Dash["Dashboard"]
    Pay["Payment and Payroll"]
    Prop["Proposal and Ledger"]
    Net["/net, multi-device vault"]
    Signer["/signer, browser FROST"]
  end

  subgraph L2["Layer 2, Orchestrator (Rust)"]
    SM["Proposal state machine"]
    Val["Validation, ZIP-317 and address"]
    Store["Store, SQLite with SQLCipher"]
    Sec["Sealed key custody"]
    Bridge["FROST to PCZT bridge"]
  end

  subgraph L1["Layer 1, Engine (Zcash Foundation)"]
    Frostd["frostd"]
    FClient["frost-client"]
    Sign["zcash-sign"]
    Devtool["zcash-devtool, PCZT"]
    Lib["librustzcash"]
  end

  Relay["Blind relay, loopback and hosted"]
  Chain["Zcash mainnet, Orchard shielded"]

  Devices --> L3
  L3 -->|"structured JSON, loopback only"| L2
  L2 --> L1
  L1 -->|"broadcast"| Chain
  Net <-.->|"public or encrypted bytes only"| Relay
  Relay <-.-> Devices
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
  Note over A,B: part2 produces one secret round-2 package per recipient
  A->>R: round-2 package for Bob (sealed to Bob)
  B->>R: round-2 package for Alice (sealed to Alice)
  Note over A,B: part3 combines everything locally
  A-->>A: KeyPackage (share A) + group key
  B-->>B: KeyPackage (share B) + group key
  A->>Z: group verifying key
  Z-->>A: Orchard address + UFVK
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
  O->>O: validate address (zcash_address), amount, balance
  O-->>U: Awaiting (proposer counts as first approval)
  M->>O: approve
  O->>O: quorum reached -> Ready
  U->>O: send (explicit confirmation)
  O->>O: vault-binding guard (proposal vault == ceremony vault)
  O->>E: PCZT create, prove
  E->>E: FROST ceremony over frostd (shares of who approved)
  E->>E: inject signature into PCZT, finalize
  E->>C: broadcast (Orchard shielded)
  C-->>O: txid
  O-->>U: Sent, txid recorded in the ledger
```

## 4. Private payroll (N outputs, one approval)

```mermaid
flowchart LR
  CSV["CSV, label, address, amount, memo"] --> Parse["Parse and validate each line"]
  Parse --> Plan["Payroll plan, N outputs"]
  Plan --> Prop["One proposal, approved once"]
  Prop --> Quorum{"Quorum reached?"}
  Quorum -->|no| Wait["Awaiting"]
  Quorum -->|yes| Build["Multi-output Orchard builder, zcash_client_backend"]
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
  TA-->>TA: show invite code
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
  TA->>HR: signing package + seed
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
  H1->>R: sigma (sealed to member)
  H2->>R: sigma (sealed to member)
  M->>M: combine sigmas into the repaired KeyPackage (part 3)
  M->>M: validate against the group public share, reject if mismatch
  Note over M: the repaired share signs a verifying quorum again
```

## 7. Proposal state machine

```mermaid
stateDiagram-v2
  [*] --> Awaiting: propose (proposer is first approval)
  Awaiting --> Awaiting: approve (below quorum)
  Awaiting --> Ready: approve (quorum reached)
  Awaiting --> Refused: refusal makes quorum unreachable
  Awaiting --> Expired: past the expiry window
  Ready --> Sent: sign (FROST) and broadcast
  Ready --> Refused: refusal (still possible before send)
  Refused --> [*]
  Expired --> [*]
  Sent --> [*]
```

## 8. Inheritance, the dead-man's-switch

```mermaid
stateDiagram-v2
  [*] --> Active: policy armed (lapse window, grace, heir)
  Active --> Active: proof-of-life heartbeat (resets the clock)
  Active --> Pending: silence past the lapse window
  Pending --> Active: heartbeat within the grace period
  Pending --> Released: silence past lapse plus grace
  Released --> [*]: quorum may release to the heir
  note right of Released
    release is an ordinary quorum-signed payment
  end note
```

## 9. Deployment topology

```mermaid
flowchart LR
  Dev["Developer, git push to main"] --> GH["GitHub, deegalabs/konclave"]
  GH --> CI["CI, fmt + clippy + tests, 4 Rust crates + wasm build + UI"]
  GH -->|"auto-deploy"| Vercel["Vercel, UI demo (konclave-demo.vercel.app)"]
  GH -.->|"native connect, docs/DEPLOY.md"| Railway["Railway, blind relay (relay-server)"]
  Vercel -->|"/net posts opaque bytes"| Railway
  subgraph Local["Local, the real mainnet path"]
    Bridge["konclave serve, loopback bridge"]
    EngineBins["Engine binaries, per engine/versions.lock"]
  end
  Bridge --> EngineBins --> Mainnet["Zcash mainnet"]
```

## 10. The trust boundary, at a glance

```mermaid
flowchart TB
  subgraph Secret["Never leaves the device"]
    Share["FROST share"]
    Nonce["Signing nonces"]
  end
  subgraph Relay["The relay sees (blind)"]
    Pub["Public FROST material"]
    Ct["Ciphertext, sealed round-2 and deltas"]
    Meta["Metadata, room id, timing, sizes"]
  end
  subgraph Chain["Zcash mainnet sees"]
    OneTx["One ordinary single-signer shielded tx"]
  end
  Share -.->|"produces, never transmitted"| Pub
  Nonce -.->|"local only"| Pub
  Pub --> OneTx
  Ct --> Relay
  Note1["The whole key is never reconstituted"]
```

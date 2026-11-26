# What you can check, what is open, and what we do not claim

> For a treasurer deciding whether to use Konclave. One page, three lists. It repeats the
> [README](../README.md), [SECURITY.md](../SECURITY.md#known-limitations), [PROOF.md](PROOF.md) and
> [CLAIMS.md](CLAIMS.md); where they say more, they win.

## What you can check today

- **The mainnet transactions are real.** [PROOF.md](PROOF.md) lists Konclave's Zcash mainnet
  transactions, each the first time Konclave proved one capability on the live network. Run
  `node scripts/verify-proof.mjs` (Node 18 or newer, no install): it asks public block explorers
  whether each one exists and is mined, and exits `0` only if every one is
  ([PROOF.md, How to run](PROOF.md#how-to-run)).
- **What the chain cannot show.** A FROST signature is indistinguishable on chain from one person's
  signature, so the chain cannot prove that a quorum signed. What attests it instead is written
  down in [PROOF.md](PROOF.md#what-on-chain-verification-cannot-prove-alone).
- **The web app the site serves.** Since 0.22.0 each release publishes a `web-manifest.json`, so
  anyone with Node 22 or later can check from outside the app that the web app the site serves is
  that release, file by file: `node scripts/verify-web.mjs`
  ([VERIFY-WEB.md](VERIFY-WEB.md)). That is detection, for whoever runs it, at that moment: it does
  not stop a compromised host ([SECURITY.md](../SECURITY.md#known-limitations)).
- **The tools we build on.** Konclave does not reimplement cryptography. It stands on the Zcash
  Foundation's [frost-tools](https://github.com/ZcashFoundation/frost-tools) (`frostd`,
  `frost-client`, `zcash-sign`) and the reference [`frost`](https://github.com/ZcashFoundation/frost)
  crate, and on [zcash-devtool](https://github.com/zcash/zcash-devtool) and
  [librustzcash](https://github.com/zcash/librustzcash)
  ([README](../README.md#built-on-the-zcash-foundations-tools)).
- **What a member's device checks before it signs.** A device signs only the message it derives
  from its own copy of the transaction, in both signing rounds, so another member cannot swap the
  transaction under it. It reads the payment from the transaction, checks it against the approved
  payment, memos included, and refuses a fee that is not exactly ZIP 317's fee for its actions at a
  rate the device accepts. The coordinator still chooses which notes a payment spends and how its
  change is split, so it can make a payment pay more fee than it needs, within that rule; the extra
  goes to the network ([SECURITY.md](../SECURITY.md#known-limitations), "Changing what a
  payment pays"). That guards against a member, not against the coordinator, which builds the
  transaction to begin with: until
  [#567](https://github.com/deegalabs/konclave/issues/567) is fixed a payment the quorum signs is
  only as safe as our hosted coordinator.

## Open and tracked

The README says it in these words: "Konclave has not been independently audited, and until #567 is
fixed a payment the quorum signs is only as safe as our hosted coordinator. Do not keep significant
funds in it yet."

- **No independent audit.** Konclave has not been independently audited. The Zcash Foundation's
  partial audit of FROST excludes rerandomized FROST, the variant Zcash uses
  ([SECURITY.md](../SECURITY.md#known-limitations)).
- **An approval is not yet tied to the exact content it approves
  ([#567](https://github.com/deegalabs/konclave/issues/567)).** Until #567 is fixed a payment the
  quorum signs is only as safe as our hosted coordinator. What is open: "an approval is not yet tied
  to the exact content of the proposal, and the approved payment a device compares with is fetched
  from the coordinator when it signs" ([SECURITY.md](../SECURITY.md#known-limitations)).
  The plan, in the issue's title: "Bind each approval to the content it approves, and have the
  device check it before signing". Its scope, since the 2026-10-16 comment: every vote signs the proposal's content, and the device
  checks that content before it signs.
- **Our hosted coordinator reads the vault's books: amounts, recipients and memos
  ([#516](https://github.com/deegalabs/konclave/issues/516)).** "The coordinator holds each vault's
  viewing key and reads its books" ([SECURITY.md](../SECURITY.md#known-limitations)). The plan, in
  the issue's title: "Prove on the device: remove the viewing key from the server, and measure what
  it costs". Its status, in the issue's words: open, "with the cheap half now measured rather than
  estimated".
- **Our web host could serve a modified app.** "Every member using the web app loads it from our
  web host, so a compromised host could serve all of them a modified app at once, and the
  threshold would not stop that." The check above detects it for whoever runs it; an installed
  app does not yet refuse an update that is not a release
  ([#605](https://github.com/deegalabs/konclave/issues/605)), and the desktop installers are not
  code-signed ([#606](https://github.com/deegalabs/konclave/issues/606))
  ([SECURITY.md](../SECURITY.md#known-limitations)).
- **Everything else.** [SECURITY.md, Known limitations](../SECURITY.md#known-limitations) lists the
  other open items by kind of attack, each with its issue.

## What we do not claim

- **An independent audit.** None has been done.
- **That Konclave is ready for significant funds.** The README says: "Do not keep significant funds
  in it yet."
- **Any feature that is not shipped.** A roadmap item, a planned feature or an open issue is not a
  claim. [CLAIMS.md](CLAIMS.md#status-labels-use-them-everywhere) has the labels every stated capability
  carries: `proven on-chain`, `dry-run`, `by test` or `roadmap`.

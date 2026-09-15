#!/usr/bin/env node
import { readFileSync } from "node:fs";
// verify-proof.mjs - independent, judge-runnable proof that Konclave's claimed
// mainnet transactions are real, mined Zcash transactions.
//
// This script talks ONLY to public block explorers. It has no dependencies and
// no knowledge of Konclave's internals. It confirms, for each txid, that the
// transaction EXISTS and is MINED on the Zcash MAINNET, and reports the block
// height, confirmations, and whatever shielded/output metadata the explorer
// exposes.
//
// HONEST SCOPE (read this before drawing conclusions):
//   On-chain data proves a transaction exists, is mined, and (being shielded)
//   reveals nothing about amounts or parties. It does NOT, by itself, prove the
//   threshold/FROST nature of the signature. A FROST-aggregated Orchard
//   signature is designed to be indistinguishable on-chain from an ordinary
//   single-signer Orchard signature - that indistinguishability is precisely the
//   privacy property. The threshold nature is attested by the build and the
//   ceremony logs, not by the chain. This script deliberately does not overclaim.
//
// Requirements: Node 18+ (uses global fetch). No npm install needed.
// Usage: node scripts/verify-proof.mjs
//
// EXIT CODES, because the three answers are not the same answer:
//   0  every txid verified on mainnet
//   1  at least one txid was NOT found or not mined - a statement about the chain
//   2  inconclusive: nothing refuted, but an explorer could not be reached for at least one txid
//   3  docs/PROOF.md could not be parsed (usage/format problem, not a result)
// 1 and 2 shared an exit code until 2026-09-15, so "the wifi dropped" and "this transaction does
// not exist" were indistinguishable to anything calling this - including a person reading the tail
// of the output.

// The list is READ FROM docs/PROOF.md, not duplicated here. It used to be a hard-coded array, and
// it drifted: the document said eleven transactions while the script checked eight - so the very
// command offered as "don't trust us, check" disagreed with the claim it was meant to verify.
// One source, one answer.
const PROOF = new URL("../docs/PROOF.md", import.meta.url);
const TXIDS = readFileSync(PROOF, "utf8")
  .split("\n")
  .map((line) => /^\|\s*(.+?)\s*\|\s*`([0-9a-f]{64})`\s*\|/.exec(line))
  .filter(Boolean)
  .map((m) => ({ txid: m[2], label: m[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim() }));

if (TXIDS.length === 0) {
  console.error("No transactions found in docs/PROOF.md - has the table format changed?");
  process.exit(3); // a usage/parse problem, distinct from both a failed proof (1) and a flaky network (2)
}


const TIMEOUT_MS = 15000;
/** How many times to re-ask the whole explorer set for one txid before calling it unreachable. */
const RETRIES = 4;
/** Linear backoff between those attempts (attempt N waits N * this). Linear, not exponential: the
 *  failure being waited out is a per-minute rate window, not a struggling server. */
const BACKOFF_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "konclave-verify-proof/1.0" },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: err && err.name === "AbortError" ? "request timed out" : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// --- Explorer adapters -------------------------------------------------------
// Each adapter returns a normalized record:
//   { found, mined, blockHeight|null, confirmations|null, shielded|null,
//     shieldedNote, source }
// or { error } if the explorer could not be reached / did not answer usefully.

// Primary: Blockchair.
async function viaBlockchair(txid) {
  const url = `https://api.blockchair.com/zcash/dashboards/transaction/${txid}`;
  const r = await fetchJson(url);
  if (!r.ok) return { error: `Blockchair: ${r.error}` };
  const data = r.json && r.json.data && r.json.data[txid];
  if (!data || !data.transaction) {
    return { found: false, mined: false, blockHeight: null, confirmations: null, shielded: null, shieldedNote: "not indexed by Blockchair", source: "blockchair" };
  }
  const tx = data.transaction;
  const ctx = r.json.context || {};
  const blockId = typeof tx.block_id === "number" ? tx.block_id : null;
  const mined = blockId !== null && blockId > 0;
  let confirmations = null;
  if (mined && typeof ctx.state === "number" && ctx.state > 0) {
    confirmations = ctx.state - blockId + 1;
  }
  // Blockchair exposes shielded value flows for Zcash when present.
  let shielded = null;
  let shieldedNote = "shielded flag not exposed by this endpoint";
  const shieldedFields = [
    "shielded_value_delta",
    "value_sapling_pool_delta",
    "value_orchard_pool_delta",
  ];
  const present = shieldedFields.filter((f) => tx[f] !== undefined && tx[f] !== null);
  if (present.length) {
    const anyNonZero = present.some((f) => Number(tx[f]) !== 0);
    // A fully-shielded Orchard tx typically shows no transparent inputs/outputs.
    const noTransparent = (tx.input_count === 0 || tx.input_count === undefined) &&
      (tx.output_count === 0 || tx.output_count === undefined);
    shielded = anyNonZero || noTransparent;
    shieldedNote = `derived from ${present.join(", ")}` + (noTransparent ? " + no transparent I/O" : "");
  } else if (tx.input_count === 0 && tx.output_count === 0) {
    shielded = true;
    shieldedNote = "no transparent inputs/outputs (consistent with a fully shielded tx)";
  }
  return { found: true, mined, blockHeight: blockId, confirmations, shielded, shieldedNote, source: "blockchair" };
}

// Fallback: zcashexplorer.app (public JSON API).
async function viaZcashExplorer(txid) {
  const url = `https://mainnet.zcashexplorer.app/api/v1/transactions/${txid}`;
  const r = await fetchJson(url);
  if (!r.ok) return { error: `zcashexplorer: ${r.error}` };
  const tx = r.json && (r.json.tx || r.json.transaction || r.json);
  if (!tx || (tx.hash === undefined && tx.txid === undefined && tx.height === undefined)) {
    return { found: false, mined: false, blockHeight: null, confirmations: null, shielded: null, shieldedNote: "not indexed by zcashexplorer", source: "zcashexplorer" };
  }
  const blockHeight = tx.height ?? tx.block_height ?? null;
  const mined = blockHeight !== null && Number(blockHeight) > 0;
  const confirmations = tx.confirmations ?? null;
  // Shielded heuristic: presence of Orchard/Sapling actions, or absence of
  // transparent vin/vout. Report honestly if we cannot tell.
  let shielded = null;
  let shieldedNote = "shielded flag not exposed by this endpoint";
  const orchard = tx.orchard_actions ?? tx.num_orchard_actions ?? (Array.isArray(tx.orchard) ? tx.orchard.length : undefined);
  const sapling = tx.sapling_spends ?? tx.num_sapling ?? undefined;
  const vinLen = Array.isArray(tx.vin) ? tx.vin.length : (tx.transparent_inputs ?? undefined);
  const voutLen = Array.isArray(tx.vout) ? tx.vout.length : (tx.transparent_outputs ?? undefined);
  if (orchard !== undefined || sapling !== undefined) {
    shielded = Number(orchard || 0) > 0 || Number(sapling || 0) > 0;
    shieldedNote = `orchard_actions=${orchard ?? 0}, sapling=${sapling ?? 0}`;
  } else if (vinLen !== undefined && voutLen !== undefined) {
    shielded = Number(vinLen) === 0 && Number(voutLen) === 0;
    shieldedNote = `no transparent I/O (vin=${vinLen}, vout=${voutLen})`;
  }
  return { found: true, mined, blockHeight: Number(blockHeight), confirmations: confirmations !== null ? Number(confirmations) : null, shielded, shieldedNote, source: "zcashexplorer" };
}

async function verifyOne(entry) {
  const { txid, label } = entry;
  console.log(`\n── ${txid}`);
  console.log(`   ${label}`);

  // Both explorers are public and rate-limited, and a long run WILL hit that: they answer the first
  // dozen txids and start refusing. Before this, the first refusal made the whole run inconclusive -
  // so the command offered as "don't trust us, check" reported nothing about the chain, and did it
  // in a way that looked like a failure. A rate limit is a reason to WAIT, not a verdict.
  const adapters = [viaBlockchair, viaZcashExplorer];
  let result = null;
  const errors = [];
  for (let attempt = 0; attempt < RETRIES && !result; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_MS * attempt;
      console.log(`   … every explorer refused; waiting ${wait}ms before retry ${attempt}/${RETRIES - 1}`);
      await sleep(wait);
    }
    for (const adapter of adapters) {
      const r = await adapter(txid);
      if (r.error) {
        errors.push(r.error);
        if (attempt === 0) console.log(`   … ${r.error} (trying next explorer)`);
        continue;
      }
      result = r;
      break;
    }
  }

  if (!result) {
    console.log(`   RESULT: could not reach any explorer.`);
    for (const e of errors) console.log(`           - ${e}`);
    return { ok: false, networkFailure: true };
  }

  console.log(`   source: ${result.source}`);
  console.log(`   found: ${result.found ? "yes" : "NO"}`);
  console.log(`   mined: ${result.mined ? "yes" : "NO"}`);
  console.log(`   block height: ${result.blockHeight ?? "n/a"}`);
  console.log(`   confirmations: ${result.confirmations ?? "n/a (not reported by this explorer)"}`);
  if (result.shielded === null) {
    console.log(`   shielded: unknown (${result.shieldedNote})`);
  } else {
    console.log(`   shielded: ${result.shielded ? "yes" : "no"} (${result.shieldedNote})`);
  }

  const confirmed = result.found && result.mined;
  if (confirmed) {
    const c = result.confirmations !== null ? `${result.confirmations} confirmations` : "confirmations not reported";
    console.log(`   VERIFIED: ${txid} is a real, mined Zcash mainnet transaction at block ${result.blockHeight} (${c}).`);
  } else {
    console.log(`   NOT VERIFIED: ${txid} was not confirmed as found+mined by ${result.source}.`);
  }
  return { ok: confirmed, networkFailure: false };
}

async function main() {
  console.log("Konclave - independent on-chain proof of mainnet transactions");
  console.log("Explorers: Blockchair (primary), zcashexplorer.app (fallback)");
  console.log("Node:", process.version);

  if (typeof fetch !== "function") {
    console.error("\nERROR: global fetch is not available. This script needs Node 18+.");
    process.exit(1);
  }

  const results = [];
  for (const entry of TXIDS) {
    // Sequential to be polite to public rate-limited APIs.
    // eslint-disable-next-line no-await-in-loop
    results.push(await verifyOne(entry));
  }

  console.log("\n───────────────────────────────────────────────");
  const verified = results.filter((r) => r.ok).length;
  const unreachable = results.filter((r) => r.networkFailure).length;
  const refuted = results.length - verified - unreachable;

  // THE COUNT IS PRINTED, because it is the thing people quote. Every public number about this
  // project's proof - the README, CLAUDE.md, a forum post - is supposed to come from this command,
  // and until now the command did not state one: you had to grep its log, which is how the README
  // ended up saying "eight" while the document it checks listed seventeen.
  console.log(`CHECKED: ${results.length} txids from docs/PROOF.md`);
  console.log(`  verified on mainnet: ${verified}`);
  if (refuted > 0) console.log(`  NOT found or not mined: ${refuted}`);
  if (unreachable > 0) console.log(`  no explorer could be reached for: ${unreachable}`);
  console.log("");

  // Three different answers, three different exit codes. They used to share exit 1, so a caller
  // could not tell "the chain says this transaction does not exist" from "the wifi dropped" - and
  // those two deserve opposite reactions. A flaky explorer must never read as a failed proof.
  if (refuted > 0) {
    console.log("VERDICT: FAILED - at least one txid was not confirmed as found+mined.");
    console.log("This IS a statement about the transactions. Investigate before publishing anything.");
    process.exit(1);
  }

  if (unreachable > 0) {
    console.log("VERDICT: INCONCLUSIVE - a public explorer could not be reached for every txid.");
    console.log(`Nothing was refuted: ${verified} of ${results.length} verified, ${unreachable} unreachable.`);
    console.log("Public explorers rate-limit long runs. Re-run later; this is a statement about");
    console.log("connectivity, not about the transactions.");
    process.exit(2);
  }

  // DOES THE REST OF THE REPO AGREE WITH THIS NUMBER?
  //
  // The script's own header records this drifting once already: "the document said eleven
  // transactions while the script checked eight - so the very command offered as 'don't trust us,
  // check' disagreed with the claim it was meant to verify." Fixing the list did not stop it
  // happening again: on 2026-09-15 the README said EIGHT while this table held seventeen.
  //
  // Checked here rather than in a test because this is the command someone runs immediately before
  // quoting the number - in a forum post, a README, a grant application. A warning at that moment is
  // read; a failing test in a suite nobody runs before writing prose is not.
  const claims = [];
  for (const doc of ["../README.md", "../CLAUDE.md", "../docs/ARCHITECTURE.md"]) {
    let text;
    try {
      text = readFileSync(new URL(doc, import.meta.url), "utf8");
    } catch {
      continue; // a missing doc is not this script's problem to report
    }
    for (const m of text.matchAll(/\b(\d+)\s+(?:independently\s+)?verifiable\s+mainnet\s+(?:txids|transactions)|\b(\d+)\s+(?:independently\s+)?verifiable\s+txids/g)) {
      const n = Number(m[1] ?? m[2]);
      if (Number.isFinite(n) && n !== results.length) {
        claims.push(`${doc.replace("../", "")} says ${n}`);
      }
    }
  }
  if (claims.length > 0) {
    console.log(`WARNING: ${results.length} txids are listed here, but ${claims.join("; ")}.`);
    console.log("Whichever is wrong, do not publish a number until they agree.");
    console.log("");
  }

  console.log("VERDICT: VERIFIED - the txids are real, mined Zcash mainnet transactions.");

  console.log("\nHonest scope: this proves existence + mined state on mainnet. Being");
  console.log("shielded, these transactions reveal nothing on-chain about amounts or");
  console.log("parties. On-chain data does NOT by itself prove the FROST threshold nature:");
  console.log("a FROST-aggregated Orchard signature is indistinguishable from a normal");
  console.log("single-signer one - that indistinguishability is the privacy property.");
  console.log("The threshold nature is attested by the build and ceremony, not the chain.");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nUnexpected error:", err && err.message ? err.message : err);
  console.error("The script did not complete. Exit 1.");
  process.exit(1);
});

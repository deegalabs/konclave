#!/usr/bin/env node
// verify-proof.mjs — independent, judge-runnable proof that Konclave's claimed
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
//   2-of-3 threshold/FROST nature of the signature. A FROST-aggregated Orchard
//   signature is designed to be indistinguishable on-chain from an ordinary
//   single-signer Orchard signature — that indistinguishability is precisely the
//   privacy property. The threshold nature is attested by the build and the
//   ceremony logs, not by the chain. This script deliberately does not overclaim.
//
// Requirements: Node 18+ (uses global fetch). No npm install needed.
// Usage: node scripts/verify-proof.mjs

const TXIDS = [
  {
    txid: "43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572",
    label: "application-driven 2-of-3 quorum payment (FROST-signed, broadcast)",
  },
  {
    txid: "f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360",
    label: "Gate-1 CLI-driven vertical-slice payment",
  },
];

const TIMEOUT_MS = 15000;

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

  const adapters = [viaBlockchair, viaZcashExplorer];
  let result = null;
  const errors = [];
  for (const adapter of adapters) {
    const r = await adapter(txid);
    if (r.error) {
      errors.push(r.error);
      console.log(`   … ${r.error} (trying next explorer)`);
      continue;
    }
    result = r;
    break;
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
  console.log("Konclave — independent on-chain proof of mainnet transactions");
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
  const anyNetworkFailure = results.some((r) => r.networkFailure);
  const allConfirmed = results.every((r) => r.ok);

  if (anyNetworkFailure) {
    console.log("VERDICT: INCONCLUSIVE — a public explorer could not be reached.");
    console.log("The network appears unavailable. Re-run when online; this is not a");
    console.log("statement about the transactions, only about connectivity.");
    process.exit(1);
  }

  if (allConfirmed) {
    console.log("VERDICT: VERIFIED — both txids are real, mined Zcash mainnet transactions.");
  } else {
    console.log("VERDICT: FAILED — at least one txid was not confirmed as found+mined.");
  }

  console.log("\nHonest scope: this proves existence + mined state on mainnet. Being");
  console.log("shielded, these transactions reveal nothing on-chain about amounts or");
  console.log("parties. On-chain data does NOT by itself prove the 2-of-3 FROST nature:");
  console.log("a FROST-aggregated Orchard signature is indistinguishable from a normal");
  console.log("single-signer one — that indistinguishability is the privacy property.");
  console.log("The threshold nature is attested by the build and ceremony, not the chain.");

  process.exit(allConfirmed ? 0 : 1);
}

main().catch((err) => {
  console.error("\nUnexpected error:", err && err.message ? err.message : err);
  console.error("The script did not complete. Exit 1.");
  process.exit(1);
});

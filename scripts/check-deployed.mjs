#!/usr/bin/env node
// check-deployed.mjs - what is RUNNING, not what is merged.
//
// The helper and relay are deployed by hand (`railway up`), so a fix can merge green and never
// reach production. That is not hypothetical: on 2026-09-06 the whole #288 write-authentication
// chain was on `main` and the running helper still answered 404 to the route that proves it, which
// means the vaults were unprotected while the repo said otherwise. The browser had its own version
// of this - `ui/src/wasm-pkg` is committed by hand, and #430 shipped to the repo and not to the app.
//
// So this asks production directly. It probes ROUTES that only exist after a given change, which is
// a proxy and an honest one: a 404 is proof the deploy predates the change, while a 401 or 200 only
// says the route is there. It cannot tell you the deploy is CURRENT, only that a named feature is
// or is not present.
//
// Usage:  node scripts/check-deployed.mjs
// No dependencies. Read-only. Talks to the public endpoints anyone can reach.

const HELPER = process.env.KONCLAVE_HELPER ?? "https://konclave-helper-production.up.railway.app";
const RELAY = process.env.KONCLAVE_RELAY ?? "https://konclave-relay-production.up.railway.app";

// A vault id is needed to reach the gated routes. With a REAL one the answer is unambiguous: 401
// means the route is there and gating, 404 means the deploy predates it. Without one the probe
// still runs, but a 404 could also just be "unknown vault", so the report says so rather than
// claiming more than it knows.
//
// No id is hardcoded here on purpose. A vault id is the group key, and this file is public.
const VAULT = process.argv.find((a) => a.startsWith("--vault="))?.slice(8) ?? process.env.KONCLAVE_VAULT;
const REAL_VAULT = /^[0-9a-f]{64}$/.test(VAULT ?? "");
const PROBE_VAULT = REAL_VAULT ? VAULT : "0".repeat(64);

const CHECKS = [
  {
    name: "helper is up",
    url: `${HELPER}/api/health`,
    live: (s) => s === 200,
    since: "always",
  },
  {
    name: "UFVK route (#447) - the export can rebuild a vault",
    url: `${HELPER}/api/vault/ufvk?vault=${PROBE_VAULT}`,
    // 404 here is ambiguous only if the vault is unknown, which is why the message says so.
    live: (s) => s === 401,
    since: "2026-09-05",
    note: REAL_VAULT
      ? "404 with a real vault id means the deploy predates this route"
      : "404 is AMBIGUOUS without a real vault id: pass --vault=<64 hex> to be sure",
  },
  { name: "relay is up", url: `${RELAY}/health`, live: (s) => s === 200, since: "always" },
];

async function status(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return r.status;
  } catch (e) {
    return `unreachable (${e instanceof Error ? e.message : e})`;
  }
}

const rows = [];
for (const c of CHECKS) rows.push([c, await status(c.url)]);

let missing = 0;
console.log(`\nwhat production is running   ${new Date().toISOString().slice(0, 10)}\n`);
for (const [c, s] of rows) {
  const ok = typeof s === "number" && c.live(s);
  if (!ok) missing++;
  console.log(`  ${ok ? "live " : "NOT  "} ${String(s).padEnd(12)} ${c.name}`);
  if (!ok && c.note) console.log(`        ${c.note}`);
}

console.log(
  missing === 0
    ? "\nEverything probed is present.\n"
    : `\n${missing} probe(s) say production is behind. Deploy: rebuild the binary, refresh ` +
        `deploy/helper/bin/, then \`railway up\`. NOTE: \`railway redeploy\` re-runs the OLD image.\n`,
);
process.exit(missing === 0 ? 0 : 1);

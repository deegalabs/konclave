// against-lock.mjs - gathers git and the public hosts' answers for `check-deployed.mjs
// --against-lock`; every rule is in what-is-running.mjs (tested). Read-only.

import { execFileSync } from "node:child_process";
import {
  compareRunning, exitCodeOf, lockDeployCommit, minCreationIn, uiCustomHeaders,
} from "./what-is-running.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();

const COORDINATORS = ["https://helper.konclave.xyz", "https://konclave-helper-production.up.railway.app"];
const RELAYS = ["https://relay.konclave.xyz", "https://konclave-relay-production.up.railway.app"];
const WEBS = ["https://www.konclave.xyz", "https://konclave-demo.vercel.app"];
const STAGING_COORDINATOR = "https://konclave-helper-staging.up.railway.app";
const WEB_ORIGIN = "https://www.konclave.xyz";
// What makes up the coordinator's build: its crates, the lock pinning the tools, the image recipe.
const SERVICE_PATHS = ["helper-server", "orchestrator", "konclave-seal", "konclave-http", "konclave-signer",
  "Cargo.toml", "Cargo.lock", "engine/versions.lock", "deploy/helper"];
// The app's relay client: the headers it names are the ones a relay preflight must allow.
const RELAY_CLIENT = "ui/src/net.ts";

async function json(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.error(`${url}: HTTP ${r.status}`); return null; }
    try { return await r.json(); } catch { console.error(`${url}: not JSON`); return null; }
  } catch (e) {
    console.error(`${url}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function allowHeaders(url, headers) {
  try {
    const r = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": headers.map((h) => h.toLowerCase()).join(","),
      },
      signal: AbortSignal.timeout(15000),
    });
    return r.headers.get("access-control-allow-headers");
  } catch (e) {
    console.error(`${url} (preflight): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function againstLock(argv) {
  const relayDigest = argv.find((a) => a.startsWith("--relay-digest="))?.slice(15) ?? process.env.KONCLAVE_RELAY_DIGEST;
  if (!/^[0-9a-f]{16}$/.test(relayDigest ?? "")) {
    console.error("--relay-digest=<16 hex> is required: the output of `relay-server --digest` at the recorded deploy commit.");
    return 2;
  }
  const deploy = lockDeployCommit(git("show", "origin/staging:engine/versions.lock"));
  const creation = minCreationIn(git("show", `${deploy}:helper-server/src/main.rs`));
  const mainTip = git("rev-parse", "origin/main");
  const webVersion = JSON.parse(git("show", "origin/main:ui/package.json")).version;
  const grepHeaders = (spec) => {
    try { return git("grep", "-h", "-o", "-E", "['\"]X-Konclave-[A-Za-z-]+['\"]", "origin/main", "--", ...spec); }
    catch { return ""; }
  };
  const appHeaders = uiCustomHeaders(grepHeaders(["ui/src", ":!*.test.*"]));
  const relayHeaders = uiCustomHeaders(grepHeaders([RELAY_CLIENT]));
  const expected = {
    coordinator: { commit: deploy, creation },
    relayDigest,
    web: { version: webVersion, commit: mainTip },
  };

  const stagingHealth = await json(`${STAGING_COORDINATOR}/api/health`);
  let staging = { commit: null, serviceCodeEqual: false };
  if (stagingHealth?.helper_commit) {
    const c = String(stagingHealth.helper_commit).replace(/-dirty$/, "");
    let equal = false;
    try { equal = git("diff", "--stat", c, "origin/staging", "--", ...SERVICE_PATHS) === ""; } catch { equal = false; }
    staging = { commit: stagingHealth.helper_commit, serviceCodeEqual: equal && !String(stagingHealth.helper_commit).endsWith("-dirty") };
  }
  const host = (u) => new URL(u).host;
  const observed = {
    coordinators: await Promise.all(COORDINATORS.map(async (u) => ({ name: host(u), health: await json(`${u}/api/health`) }))),
    relays: await Promise.all(RELAYS.map(async (u) => ({ name: host(u), health: await json(`${u}/health`) }))),
    webs: await Promise.all(WEBS.map(async (u) => ({ name: host(u), version: await json(`${u}/version.json`) }))),
    preflights: [
      ...(await Promise.all(COORDINATORS.map(async (u) => ({
        name: host(u), headers: appHeaders, allow: await allowHeaders(`${u}/api/vault`, appHeaders) })))),
      ...(await Promise.all(RELAYS.map(async (u) => ({
        name: host(u), headers: relayHeaders, allow: await allowHeaders(`${u}/api/relay/probe`, relayHeaders) })))),
    ],
    staging,
  };

  const rows = compareRunning(expected, observed);
  console.log(`\nwhat is running, against the recorded deploy   ${new Date().toISOString().slice(0, 16)}Z`);
  console.log(`recorded: coordinator ${deploy.slice(0, 8)} (creation ${creation}), relay ${relayDigest}, ` +
    `web ${webVersion} at main ${mainTip.slice(0, 7)}\n`);
  for (const r of rows) console.log(`  ${r.level === "ok" ? "ok  " : r.level === "warn" ? "WARN" : "RED "}  ${r.name}: ${r.detail}`);
  const code = exitCodeOf(rows);
  console.log(code === 0
    ? "\nProduction runs the recorded deploy.\n"
    : "\nProduction differs from the recorded deploy (rows marked RED). Right after a deploy, this stays red " +
      "until the lock PR that records it is merged into staging.\n");
  return code;
}

#!/usr/bin/env node
// Check what a vault id alone buys from the coordinator (#388 / #476).
//
//   node scripts/probe-opacity.mjs <vault-id> [--times 3] [--gap 5]
//
// The claim this checks is narrow and worth stating exactly: a 256-bit vault id is a bearer
// credential for a vault's SHAPE - quorum, member count, receive address, change receiver - and for
// nothing else. Balance, history, ledger, member names and the viewing key all require `readKey`,
// which only a seated member's device can derive.
//
// It is written as a CHECK rather than a transcript because a transcript proves what happened once
// on someone else's machine. This runs against YOUR vault, from a plain terminal, with nothing but
// the id - which is the same position an attacker who found a forwarded link is in.
//
// WHAT IT CANNOT SHOW. That a vault mid-payment is indistinguishable from an idle one needs a
// payment happening while it runs. Run it during one to see that half; run it any time to see that
// the gate holds. It reports which of the two you got rather than implying the stronger claim.
//
// It is READ-ONLY and unauthenticated by construction: it holds no key, sends no header, and could
// not write anything if it tried.

const BASE = process.env.KONCLAVE_HELPER ?? 'https://konclave-helper-production.up.railway.app'

/** The reads the coordinator gates on `readKey` (#402). Kept as a list here so a gate that quietly
 *  loses an endpoint shows up as a 200 where a 401 belongs. */
const GATED = [
  '/api/vault/balance',
  '/api/vault/transactions',
  '/api/vault/ceremonies',
  '/api/vault/proposals',
  '/api/vault/ledger',
  '/api/vault/ledger.csv',
  '/api/vault/members',
]

/** Deliberately OPEN, and the coordinator says so at the route. Listed so the report states what an
 *  id DOES buy rather than leaving the reader to assume it buys nothing. */
const OPEN = '/api/vault'

const args = process.argv.slice(2)
const vault = args.find((a) => !a.startsWith('--'))
const numAfter = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i === -1 ? dflt : Number(args[i + 1]) || dflt
}
const times = numAfter('--times', 3)
const gapSec = numAfter('--gap', 5)

if (!vault || !/^[0-9a-f]{64}$/i.test(vault)) {
  console.error('usage: node scripts/probe-opacity.mjs <vault-id> [--times N] [--gap SECONDS]')
  console.error('       the id is 64 hex characters - the same string a shared link carries')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(path) {
  const url = `${BASE}${path}?vault=${vault}`
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    const body = await r.arrayBuffer()
    return { status: r.status, bytes: body.byteLength }
  } catch (e) {
    return { status: 0, bytes: 0, error: String(e) }
  }
}

console.log(`Probing ${BASE} with a vault id and NOTHING else.`)
console.log(`${times} pass(es), ${gapSec}s apart. Nothing here is authenticated.\n`)

let gateHeld = true
const openSizes = []

for (let pass = 1; pass <= times; pass++) {
  const open = await probe(OPEN)
  openSizes.push(`${open.status}/${open.bytes}`)
  const rows = []
  for (const p of GATED) {
    const r = await probe(p)
    // 401 is the gate. A 404 means the vault has no such record yet, which is not the gate holding
    // and must not be reported as if it were.
    if (r.status !== 401) gateHeld = false
    rows.push(`  ${r.status}  ${String(r.bytes).padStart(6)}b  ${p}`)
  }
  console.log(`pass ${pass}`)
  console.log(`  ${open.status}  ${String(open.bytes).padStart(6)}b  ${OPEN}   <- open by design`)
  console.log(rows.join('\n'))
  if (pass < times) await sleep(gapSec * 1000)
}

const identical = new Set(openSizes).size === 1
console.log('')
console.log(`The open route answered: ${openSizes.join('  ')}`)
console.log(identical
  ? '  byte-identical across every pass.'
  : '  IT CHANGED between passes - the shape below is not what this claims.')

if (!gateHeld) {
  console.error('\nFAIL: a gated read did not answer 401. This vault is not protected, or the gate has a hole.')
  console.error('An open/legacy vault created before #388 answers 200 here - that is expected for those,')
  console.error('and is exactly why they are listed as a known limit rather than called protected.')
  process.exit(1)
}

console.log('\nVERIFIED: every private read refused; the id bought metadata only.')
console.log('\nHonest scope: this shows the gate holds. That a vault MID-PAYMENT is indistinguishable')
console.log('from an idle one is the same check run while a payment happens - the byte count above is')
console.log('what you compare. Run it during a ceremony to see that half.')

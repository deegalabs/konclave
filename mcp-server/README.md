# Konclave MCP - the single-agent-proof treasurer's assistant

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant help run a
**Konclave** vault - read its state and **draft** a payment proposal - while being
**structurally incapable of moving the money**.

## The thesis

Konclave is a collective [FROST](https://frost.zfnd.org/) vault on Zcash where **no single
party can move funds**: every spend requires a **quorum of humans** to approve, each signing
with their own key share, and the group key is never reconstituted. It is *single-person-proof*
by design.

This MCP server extends that guarantee to AI. It gives an assistant the tools to **READ** the
vault (balance, on-chain transactions, proposals, ledger) and to **DRAFT** a payment or payroll
**proposal** - and **nothing else**. There is deliberately **no tool to approve, sign, or
broadcast**. The AI can propose and inform; only the human quorum, inside the Konclave app, can
approve a draft and broadcast it. A drafted proposal is created in the *awaiting approval* state
and moves zero funds until humans act on it.

So even an AI that is fully trusted with these tools - even a compromised or misled one -
**literally cannot move the money alone**. The absence of a sign/send tool is not an oversight;
it is the feature. Konclave is single-person-proof, and with this server it is **single-agent-proof**
too: a capability no competitor's treasury tooling offers.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `list_vaults` | read | Every vault on this device (id, name, quorum, members). Discover ids for the `vault_id` argument. |
| `get_vault` | read | Vault metadata: name, FROST threshold/total, members, Orchard address. |
| `get_balance` | read | Spendable / total / pending balance in ZEC. |
| `get_transactions` | read | On-chain transaction history (newest first) for reconciliation. |
| `list_proposals` | read | Open proposals with state and approval counts. |
| `get_ledger` | read | Full history, including terminal states (sent/refused/expired). |
| `propose_payment` | **draft only** | Creates an *awaiting-approval* proposal `{ to_address, value_zec, memo? }`. Moves no funds. Humans must approve it in the app. |
| `propose_payroll` | **draft only** | Creates an *awaiting-approval* payroll proposal `{ description?, lines: [{ label?, address, value_zec, memo? }] }` (one approval, N outputs). Moves no funds. |

**Deliberately absent:** there is no `approve_proposal`, no `sign`, no `send`, no `broadcast`.
No tool in this server can move funds. That is the whole point.

### Multi-vault

Every vault-scoped tool (`get_vault`, `list_proposals`, `get_ledger`, `propose_payment`,
`propose_payroll`) takes an optional `vault_id`. Call `list_vaults` to discover the ids; omit
`vault_id` to use this device's default (first) vault. An unknown id is rejected with a 404 rather
than silently falling back. (`get_balance` and `get_transactions` reflect the live wallet the
bridge was started with, which is per-run rather than per-vault.)

## How it works

The server is a thin, safe wrapper over Konclave's loopback HTTP bridge (`konclave serve`,
default `http://127.0.0.1:4762`). It speaks MCP over **stdio**. Reads hit the `/api/*` GET
endpoints; `propose_payment` POSTs to `/api/proposals` and `propose_payroll` to `/api/payroll`.

### The session token (automatic)

Konclave's bridge requires an `X-Konclave-Session` header (a CSRF/DNS-rebinding defence) on every
state-changing POST. That token is generated **fresh per `konclave serve` run** and **rotates on
every restart**, so a hardcoded value is fragile. This server therefore **fetches it
automatically** from the loopback `GET /api/session` endpoint at startup and caches it (and
re-fetches once on a 403, to survive a restart). You do not need to set anything.

That endpoint is safe by construction: it is reachable only over loopback (the same `Host` gate
that defeats DNS-rebinding runs first), and the bridge never emits CORS headers, so a cross-origin
web page cannot read the response. A local non-browser process already has full loopback access
and could POST regardless; the endpoint only spares it from scraping the token out of the served
HTML (`window.__KONCLAVE_SESSION__`). If you run an older bridge that predates `GET /api/session`,
set `KONCLAVE_SESSION` manually as a fallback.

### Configuration (environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `KONCLAVE_API` | no | `http://127.0.0.1:4762` | Base URL of the Konclave HTTP bridge. |
| `KONCLAVE_SESSION` | no | *(unset)* | Manual CSRF session-token override. Normally unnecessary - the server fetches the token from `GET /api/session`. Set it only for an older bridge without that route. Reads never need it. |

## Build & run

This package is part of the Konclave pnpm workspace. From the repo root:

```bash
pnpm --filter konclave-mcp install   # or `pnpm install` for the whole workspace
pnpm --filter konclave-mcp build     # compiles src/ -> dist/
pnpm --filter konclave-mcp test      # tool-surface smoke test (no live backend needed)
pnpm --filter konclave-mcp start     # runs the stdio server (usually launched by the MCP client)
```

Requires Node 18+ (uses the built-in `fetch`). Make sure the Konclave backend is up first:

```bash
konclave serve     # binds 127.0.0.1:4762
```

### Test interactively

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Register with Claude Desktop

Add to your `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`; Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "konclave": {
      "command": "node",
      "args": ["/absolute/path/to/konclave/mcp-server/dist/index.js"],
      "env": {
        "KONCLAVE_API": "http://127.0.0.1:4762"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear; ask it to check the balance or draft a payment - then
watch it stop at the wall: it can hand a proposal to the humans, but it cannot cross the quorum.

## License

Dual-licensed under Apache-2.0 OR MIT, matching the Konclave repository.

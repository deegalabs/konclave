# Konclave MCP — the single-agent-proof treasurer's assistant

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant help run a
**Konclave** vault — read its state and **draft** a payment proposal — while being
**structurally incapable of moving the money**.

## The thesis

Konclave is a collective [FROST](https://frost.zfnd.org/) vault on Zcash where **no single
party can move funds**: every spend requires a **quorum of humans** to approve, each signing
with their own key share, and the group key is never reconstituted. It is *single-person-proof*
by design.

This MCP server extends that guarantee to AI. It gives an assistant the tools to **READ** the
vault (balance, proposals, ledger) and to **DRAFT** a payment **proposal** — and **nothing
else**. There is deliberately **no tool to approve, sign, or broadcast**. The AI can propose and
inform; only the human quorum, inside the Konclave app, can approve a draft and broadcast it. A
drafted proposal is created in the *awaiting approval* state and moves zero funds until humans
act on it.

So even an AI that is fully trusted with these tools — even a compromised or misled one —
**literally cannot move the money alone**. The absence of a sign/send tool is not an oversight;
it is the feature. Konclave is single-person-proof, and with this server it is **single-agent-proof**
too: a capability no competitor's treasury tooling offers.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `get_vault` | read | Vault metadata: name, FROST threshold/total, members, Orchard address. |
| `get_balance` | read | Spendable / total / pending balance in ZEC. |
| `list_proposals` | read | Open proposals with state and approval counts. |
| `get_ledger` | read | Full history, including terminal states (sent/refused/expired). |
| `propose_payment` | **draft only** | Creates an *awaiting-approval* proposal `{ to_address, value_zec, memo? }`. Moves no funds. Humans must approve it in the app. |

**Deliberately absent:** there is no `approve_proposal`, no `sign`, no `send`, no `broadcast`.
No tool in this server can move funds. That is the whole point.

## How it works

The server is a thin, safe wrapper over Konclave's loopback HTTP bridge (`konclave serve`,
default `http://127.0.0.1:4762`). It speaks MCP over **stdio**. Reads hit the `/api/*` GET
endpoints; `propose_payment` POSTs to `/api/proposals`.

### Configuration (environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `KONCLAVE_API` | no | `http://127.0.0.1:4762` | Base URL of the Konclave HTTP bridge. |
| `KONCLAVE_SESSION` | no | *(unset)* | CSRF session token. The app requires an `X-Konclave-Session` header on POSTs; if set, it is forwarded with `propose_payment`. Without it, drafting may return a clear 403 you can relay to the human. Reads never need it. |

## Build & run

```bash
cd mcp-server
npm install
npm run build      # compiles src/ -> dist/
npm start          # runs the stdio server (usually launched by the MCP client, not by hand)
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
        "KONCLAVE_API": "http://127.0.0.1:4762",
        "KONCLAVE_SESSION": ""
      }
    }
  }
}
```

Restart Claude Desktop. The five tools appear; ask it to check the balance or draft a payment —
then watch it stop at the wall: it can hand a proposal to the humans, but it cannot cross the
quorum.

## License

Dual-licensed under Apache-2.0 OR MIT, matching the Konclave repository.

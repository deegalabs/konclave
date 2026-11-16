- **The local MCP server runs on a patched MCP SDK.** `mcp-server` now requires
  `@modelcontextprotocol/sdk` 1.32.2, and the packages it pulls in (hono, `@hono/node-server`,
  express's body-parser, proxy-addr and qs, ip-address, fast-uri) move to their patched releases.
  The advisories concern HTTP server transports and the frameworks behind them, OAuth clients,
  proxy and IP-range checks, URI parsing and hono's HTML helpers. This server speaks only stdio to
  the assistant that starts it: the HTTP stack never loads, and fast-uri is loaded only by the SDK's
  schema validator, over the server's own tool schemas. Nothing here reaches the coordinator, the
  relay, the signer or the web app: the web build is byte-identical before and after (same commit id
  embedded).

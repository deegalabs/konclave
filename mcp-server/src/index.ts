#!/usr/bin/env node
/**
 * Konclave MCP server
 * =====================
 *
 * Konclave is a collective FROST vault on Zcash: no single party can move funds -
 * a quorum of humans must approve every spend. This MCP server lets an AI assistant
 * act as a "treasurer's assistant" over that vault.
 *
 * The design is deliberate and load-bearing:
 *   - The AI can READ everything (vault metadata, balance, transactions, proposals, ledger).
 *   - The AI can DRAFT a payment or payroll PROPOSAL.
 *   - The AI has NO tool to sign, approve, or broadcast. None exists in this server.
 *
 * So even an AI literally cannot move the money alone. Only the human quorum,
 * inside the Konclave app, can approve a draft proposal and broadcast it. This is
 * the "single-person-proof" guarantee extended to "single-agent-proof".
 *
 * The server is a thin, safe wrapper over Konclave's loopback HTTP bridge
 * (`konclave serve`, default http://127.0.0.1:4762). It speaks MCP over stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration (from environment)
// ---------------------------------------------------------------------------

/** Base URL of the Konclave loopback HTTP bridge. */
const API_BASE = (process.env.KONCLAVE_API ?? "http://127.0.0.1:4762").replace(
  /\/+$/,
  "",
);

/**
 * Optional CSRF session token override. Konclave's bridge requires an
 * `X-Konclave-Session` header on POSTs. The token is generated fresh per
 * `konclave serve` run and rotates on every restart, so a hardcoded env value
 * is fragile - by default we FETCH it automatically from the loopback
 * `GET /api/session` endpoint (safe: loopback-only, no CORS, same-origin
 * protects the browser). If the user still exports KONCLAVE_SESSION we honor it
 * (useful for older bridges without the /api/session route).
 */
const SESSION_ENV = process.env.KONCLAVE_SESSION;

const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// HTTP client helpers
// ---------------------------------------------------------------------------

class KonclaveApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KonclaveApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Optional `?vault=<id>` selector, forwarded to any vault-scoped route. */
  vault?: string;
}

/**
 * Cache for the session token once resolved. `undefined` means "not fetched yet".
 * A resolved value is either the token string or `null` (fetch attempted and failed;
 * we do not retry on every call, but a fresh fetch is forced after a 403).
 */
let sessionCache: string | null | undefined = undefined;

/** Build a path with an optional `?vault=<id>` query appended. */
function withVault(path: string, vault?: string): string {
  if (!vault) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}vault=${encodeURIComponent(vault)}`;
}

/** Low-level GET/POST against the bridge, without the session-token dance. */
async function rawRequest<T = unknown>(
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; token?: string } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = `${API_BASE}${path}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (method === "POST" && opts.token) {
    headers["X-Konclave-Session"] = opts.token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "AbortError") {
      throw new KonclaveApiError(
        `Timed out after ${REQUEST_TIMEOUT_MS}ms contacting the Konclave backend at ${url}.`,
      );
    }
    throw new KonclaveApiError(
      `Could not reach the Konclave backend at ${url}. Is it running? ` +
        `Start it with \`konclave serve\` (it binds 127.0.0.1:4762 by default), ` +
        `or set KONCLAVE_API to the correct address. Underlying error: ${cause}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    // Try to surface a human-readable error message from the body.
    let detail = "";
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      detail =
        (typeof obj.error === "string" && obj.error) ||
        (typeof obj.message === "string" && obj.message) ||
        JSON.stringify(parsed);
    } else if (typeof parsed === "string") {
      detail = parsed;
    }

    if (res.status === 403) {
      detail += detail && !detail.endsWith(".") ? ". " : " ";
      detail +=
        "This POST was rejected (a missing/invalid CSRF session, or a non-loopback host). " +
        "The MCP normally fetches the token automatically from GET /api/session; if your " +
        "Konclave bridge predates that route, export KONCLAVE_SESSION with the app's token. " +
        "Note: even with a valid session, this only creates a proposal that a human quorum " +
        "must still approve in the app.";
    }

    throw new KonclaveApiError(
      `Konclave API ${method} ${path} failed with HTTP ${res.status}. ${detail}`.trim(),
      res.status,
    );
  }

  return parsed as T;
}

/**
 * Resolve the session token: the KONCLAVE_SESSION override if set, otherwise
 * fetched once from the loopback `GET /api/session` and cached. Returns undefined
 * if it cannot be obtained (the caller's POST then surfaces a clear 403).
 */
async function getSession(force = false): Promise<string | undefined> {
  if (SESSION_ENV) return SESSION_ENV;
  if (!force && sessionCache !== undefined) return sessionCache ?? undefined;
  try {
    const data = await rawRequest<{ session?: string }>("/api/session");
    const token =
      data && typeof data === "object" && typeof data.session === "string"
        ? data.session
        : null;
    sessionCache = token;
    return token ?? undefined;
  } catch {
    // Older bridge without /api/session, or unreachable. Cache the miss so we do
    // not hammer it; a POST will still be attempted (and 403 with guidance).
    sessionCache = null;
    return undefined;
  }
}

/** GET/POST against the bridge, transparently attaching the session token on POST. */
async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const fullPath = withVault(path, opts.vault);
  if (method !== "POST") {
    return rawRequest<T>(fullPath, { method, body: opts.body });
  }
  let token = await getSession();
  try {
    return await rawRequest<T>(fullPath, { method, body: opts.body, token });
  } catch (err) {
    // A 403 may mean the token rotated (a `konclave serve` restart). Re-fetch once.
    if (
      err instanceof KonclaveApiError &&
      err.status === 403 &&
      !SESSION_ENV
    ) {
      token = await getSession(true);
      if (token) {
        return rawRequest<T>(fullPath, { method, body: opts.body, token });
      }
    }
    throw err;
  }
}

/** Render a value as a pretty JSON code block for the AI/human to read. */
function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Standard success result: a readable text payload + structured content. */
function ok(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** Standard error result: an isError tool response with a clear message. */
function fail(err: unknown) {
  const message =
    err instanceof KonclaveApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

// A shared, optional `vault_id` argument for every vault-scoped tool.
const vaultIdArg = {
  vault_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional vault id to target (from list_vaults). Omit to use this device's " +
        "default (first) vault. An unknown id is rejected with a 404 rather than " +
        "silently falling back.",
    ),
};

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

export const server = new McpServer({
  name: "konclave-mcp",
  version: "0.1.0",
});

// --- list_vaults -----------------------------------------------------------
server.registerTool(
  "list_vaults",
  {
    title: "List vaults on this device",
    description:
      "List every Konclave vault known to this device: id, name, quorum, and members. " +
      "Read-only. Use this first to discover vault ids, then pass a vault_id to the " +
      "other tools to target a specific vault (they default to the first vault otherwise).",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const data = await apiRequest<{ vaults?: unknown[] }>("/api/vaults");
      const vaults = (data as { vaults?: unknown[] }).vaults ?? data;
      const count = Array.isArray(vaults) ? vaults.length : undefined;
      return ok(jsonBlock(vaults), {
        vaults,
        ...(count !== undefined ? { count } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- get_vault -------------------------------------------------------------
server.registerTool(
  "get_vault",
  {
    title: "Get vault metadata",
    description:
      "Read metadata about a Konclave vault: its name, the FROST quorum " +
      "(threshold-of-total signers), the member list, and the shielded Orchard " +
      "receiving address. Read-only. Use this to understand who must approve " +
      "spends and where the vault receives funds.",
    inputSchema: { ...vaultIdArg },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ vault_id }) => {
    try {
      const data = await apiRequest<{ vault?: unknown }>("/api/vault", {
        vault: vault_id,
      });
      const vault = (data as { vault?: unknown }).vault ?? data;
      return ok(jsonBlock(vault), { vault });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- get_balance -----------------------------------------------------------
server.registerTool(
  "get_balance",
  {
    title: "Get vault balance",
    description:
      "Read the vault's on-chain balance in ZEC: spendable, total, and pending. " +
      "Read-only. Use this before drafting a payment to check the vault can " +
      "actually cover the amount (though the app enforces this authoritatively too). " +
      "Note: the bridge's live wallet is per-run, so the balance reflects the wallet " +
      "the app was started with, not a per-vault selector.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const data = await apiRequest<Record<string, unknown>>("/api/balance");
      return ok(jsonBlock(data), data);
    } catch (err) {
      return fail(err);
    }
  },
);

// --- get_transactions ------------------------------------------------------
server.registerTool(
  "get_transactions",
  {
    title: "Get on-chain transactions",
    description:
      "Read the vault wallet's on-chain transaction history (newest first). " +
      "Read-only. Use this to reconcile the ledger against what actually confirmed " +
      "on-chain, or to answer questions about past on-chain activity. Returns an " +
      "empty list (not an error) when no live wallet is configured on the bridge.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const data = await apiRequest<{ transactions?: unknown[] }>(
        "/api/transactions",
      );
      const transactions =
        (data as { transactions?: unknown[] }).transactions ?? data;
      const count = Array.isArray(transactions) ? transactions.length : undefined;
      return ok(jsonBlock(transactions), {
        transactions,
        ...(count !== undefined ? { count } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- list_proposals --------------------------------------------------------
server.registerTool(
  "list_proposals",
  {
    title: "List open proposals",
    description:
      "List the vault's current payment/payroll proposals with their state " +
      "(e.g. awaiting approval) and how many quorum members have approved so far. " +
      "Read-only. Use this to report what is pending human approval.",
    inputSchema: { ...vaultIdArg },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ vault_id }) => {
    try {
      const data = await apiRequest<{ proposals?: unknown[] }>(
        "/api/proposals",
        { vault: vault_id },
      );
      const proposals = (data as { proposals?: unknown[] }).proposals ?? data;
      const count = Array.isArray(proposals) ? proposals.length : undefined;
      return ok(jsonBlock(proposals), {
        proposals,
        ...(count !== undefined ? { count } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- get_ledger ------------------------------------------------------------
server.registerTool(
  "get_ledger",
  {
    title: "Get full ledger",
    description:
      "Read the full accounting history of the vault: all proposals including " +
      "terminal states (sent, refused, expired). Read-only. Use this for " +
      "reporting, reconciliation, and answering questions about past spending.",
    inputSchema: { ...vaultIdArg },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ vault_id }) => {
    try {
      const data = await apiRequest<{ ledger?: unknown[] }>("/api/ledger", {
        vault: vault_id,
      });
      const ledger = (data as { ledger?: unknown[] }).ledger ?? data;
      const count = Array.isArray(ledger) ? ledger.length : undefined;
      return ok(jsonBlock(ledger), {
        ledger,
        ...(count !== undefined ? { count } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- propose_payment -------------------------------------------------------
server.registerTool(
  "propose_payment",
  {
    title: "Draft a payment proposal (humans must approve)",
    description:
      "DRAFT a single payment proposal in the vault. It is intentionally not a spend: " +
      "it creates a proposal in the 'awaiting approval' state - nothing moves. The AI " +
      "CANNOT approve, sign, or broadcast it: there is no such tool in this server, by " +
      "design. A human quorum must open the Konclave app and approve the proposal before " +
      "any funds move; every member signs with their own FROST key share. Prefer a " +
      "shielded Orchard destination address. Returns the created proposal (with its id " +
      "and state) so you can report it to the humans who must act on it.",
    inputSchema: {
      ...vaultIdArg,
      to_address: z
        .string()
        .min(1)
        .describe(
          "Destination Zcash address. Should be a shielded Orchard address; " +
            "the Konclave app validates the address authoritatively and will " +
            "reject an unsupported/wrong-network address.",
        ),
      value_zec: z
        .union([z.number().positive(), z.string().min(1)])
        .describe(
          "Amount to pay, in ZEC (e.g. 0.01). Accepts a number or a decimal " +
            "string. Must be positive and within the vault's spendable balance.",
        ),
      memo: z
        .string()
        .optional()
        .describe(
          "Optional shielded memo attached to the payment (visible only to the " +
            "recipient). Do not put secrets here that the recipient should not see.",
        ),
    },
    annotations: {
      readOnlyHint: false,
      // Not destructive: it only drafts a proposal awaiting human approval; it
      // moves no funds and can be refused/expired by humans in the app.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ vault_id, to_address, value_zec, memo }) => {
    try {
      const body: Record<string, unknown> = {
        // The bridge expects a proposer; the AI acts as an assistant, so we
        // label the origin clearly and honestly for the human audit trail.
        proposer: "ai-assistant (Konclave MCP)",
        to_address,
        // The bridge parses the amount as a decimal string (no floating point).
        value_zec: String(value_zec),
      };
      if (memo !== undefined && memo !== "") {
        body.memo = memo;
      }

      const proposal = await apiRequest<Record<string, unknown>>(
        "/api/proposals",
        { method: "POST", body, vault: vault_id },
      );

      const id =
        (proposal && typeof proposal === "object"
          ? ((proposal as Record<string, unknown>).id ??
            (proposal as Record<string, unknown>).proposal_id)
          : undefined) ?? "(unknown id)";

      const note =
        `Drafted a payment proposal (id: ${id}) for ${value_zec} ZEC to ${to_address}. ` +
        `It is now AWAITING human approval and has moved NO funds. ` +
        `The AI cannot approve or send it - a quorum of members must approve it in the ` +
        `Konclave app, where each signs with their own FROST key share.\n\n` +
        jsonBlock(proposal);

      return ok(note, { proposal });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- propose_payroll -------------------------------------------------------
server.registerTool(
  "propose_payroll",
  {
    title: "Draft a payroll proposal (one approval, N outputs; humans must approve)",
    description:
      "DRAFT a payroll proposal: a single Orchard transaction paying many recipients " +
      "at once, approved by the quorum ONE time. Like propose_payment, it is not a spend: " +
      "it creates a proposal in the 'awaiting approval' state and moves NO funds. The AI " +
      "CANNOT approve, sign, or broadcast it - the human quorum does that in the app, each " +
      "signing with their own FROST key share. Every line's address should be a shielded " +
      "Orchard address; per-line memos are encrypted to that recipient only. Returns the " +
      "created proposal plus a line/summary breakdown.",
    inputSchema: {
      ...vaultIdArg,
      description: z
        .string()
        .optional()
        .describe(
          "Optional accounting label for the run, e.g. 'Payroll April 2026'. " +
            "Defaults to a generated label if omitted.",
        ),
      lines: z
        .array(
          z.object({
            label: z
              .string()
              .optional()
              .describe("Optional human label for this recipient (e.g. a name)."),
            address: z
              .string()
              .min(1)
              .describe(
                "Recipient Zcash address; prefer a shielded Orchard address.",
              ),
            value_zec: z
              .union([z.number().positive(), z.string().min(1)])
              .describe("Amount for this line, in ZEC. A number or decimal string."),
            memo: z
              .string()
              .optional()
              .describe(
                "Optional shielded memo for this recipient (encrypted to them only).",
              ),
          }),
        )
        .min(1)
        .describe("The payroll lines: one entry per recipient."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ vault_id, description, lines }) => {
    try {
      const body: Record<string, unknown> = {
        proposer: "ai-assistant (Konclave MCP)",
        lines: lines.map((l) => {
          const line: Record<string, unknown> = {
            address: l.address,
            value_zec: String(l.value_zec),
          };
          if (l.label !== undefined && l.label !== "") line.label = l.label;
          if (l.memo !== undefined && l.memo !== "") line.memo = l.memo;
          return line;
        }),
      };
      if (description !== undefined && description !== "") {
        body.description = description;
      }

      const result = await apiRequest<Record<string, unknown>>("/api/payroll", {
        method: "POST",
        body,
        vault: vault_id,
      });

      const proposal =
        result && typeof result === "object"
          ? (result as Record<string, unknown>).proposal
          : undefined;
      const id =
        (proposal && typeof proposal === "object"
          ? ((proposal as Record<string, unknown>).id ??
            (proposal as Record<string, unknown>).proposal_id)
          : undefined) ?? "(unknown id)";

      const note =
        `Drafted a payroll proposal (id: ${id}) with ${lines.length} line(s). ` +
        `It is now AWAITING human approval and has moved NO funds. ` +
        `The AI cannot approve or send it - a quorum of members must approve it in the ` +
        `Konclave app, where each signs with their own FROST key share.\n\n` +
        jsonBlock(result);

      return ok(note, { result });
    } catch (err) {
      return fail(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Warm the session token so the first POST does not pay the extra round-trip
  // (and so a misconfigured bridge is visible in the startup log, on stderr).
  if (!SESSION_ENV) {
    const token = await getSession();
    if (!token) {
      console.error(
        "konclave-mcp: could not fetch a session token from GET /api/session. " +
          "Read tools still work; drafting proposals may 403 until the bridge is reachable " +
          "or KONCLAVE_SESSION is set.",
      );
    }
  }
  // Stderr is safe for logs (stdout is the MCP transport).
  console.error(
    `konclave-mcp ready. Backend: ${API_BASE}. ` +
      `Tools: list_vaults, get_vault, get_balance, get_transactions, list_proposals, ` +
      `get_ledger, propose_payment, propose_payroll ` +
      `(read + draft only - no sign/send by design).`,
  );
}

// Only auto-start when run as the entrypoint (so tests can import the module).
const isEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntry) {
  main().catch((err) => {
    console.error("Fatal error starting konclave-mcp:", err);
    process.exit(1);
  });
}

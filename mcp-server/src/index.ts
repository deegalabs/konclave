#!/usr/bin/env node
/**
 * Konclave MCP server
 * =====================
 *
 * Konclave is a collective FROST vault on Zcash: no single party can move funds —
 * a quorum of humans must approve every spend. This MCP server lets an AI assistant
 * act as a "treasurer's assistant" over that vault.
 *
 * The design is deliberate and load-bearing:
 *   - The AI can READ everything (vault metadata, balance, proposals, ledger).
 *   - The AI can DRAFT a payment PROPOSAL.
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
 * Optional CSRF session token. The real Konclave app requires an
 * `X-Konclave-Session` header on POSTs. If the user exports KONCLAVE_SESSION we
 * forward it; otherwise we omit it (read-only calls do not need it, and a
 * missing token simply produces a clear 403 the AI can relay to the human).
 */
const SESSION = process.env.KONCLAVE_SESSION;

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
}

async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = `${API_BASE}${path}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (method === "POST" && SESSION) {
    headers["X-Konclave-Session"] = SESSION;
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
      detail +=
        detail && !detail.endsWith(".") ? ". " : " ";
      detail +=
        "This POST was rejected (likely a missing/invalid CSRF session). " +
        "Set the KONCLAVE_SESSION environment variable to the app's session token, " +
        "then restart this MCP server. Note: even with a valid session, this only " +
        "creates a proposal that a human quorum must still approve in the app.";
    }

    throw new KonclaveApiError(
      `Konclave API ${method} ${path} failed with HTTP ${res.status}. ${detail}`.trim(),
      res.status,
    );
  }

  return parsed as T;
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

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "konclave-mcp",
  version: "0.1.0",
});

// --- get_vault -------------------------------------------------------------
server.registerTool(
  "get_vault",
  {
    title: "Get vault metadata",
    description:
      "Read metadata about the Konclave vault: its name, the FROST quorum " +
      "(threshold-of-total signers), the member list, and the shielded Orchard " +
      "receiving address. Read-only. Use this to understand who must approve " +
      "spends and where the vault receives funds.",
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
      const data = await apiRequest<{ vault?: unknown }>("/api/vault");
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
      "actually cover the amount (though the app enforces this authoritatively too).",
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

// --- list_proposals --------------------------------------------------------
server.registerTool(
  "list_proposals",
  {
    title: "List open proposals",
    description:
      "List the vault's current payment/payroll proposals with their state " +
      "(e.g. awaiting approval) and how many quorum members have approved so far. " +
      "Read-only. Use this to report what is pending human approval.",
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
      const data = await apiRequest<{ proposals?: unknown[] }>(
        "/api/proposals",
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
      const data = await apiRequest<{ ledger?: unknown[] }>("/api/ledger");
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
      "DRAFT a payment proposal in the vault. This is the ONLY write this server " +
      "can perform, and it is intentionally not a spend. It creates a proposal in " +
      "the 'awaiting approval' state — nothing moves. The AI CANNOT approve, sign, " +
      "or broadcast it: there is no such tool in this server, by design. A human " +
      "quorum must open the Konclave app and approve the proposal before any funds " +
      "move; every member signs with their own FROST key share. Prefer a shielded " +
      "Orchard destination address. Returns the created proposal (with its id and " +
      "state) so you can report it to the humans who must act on it.",
    inputSchema: {
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
  async ({ to_address, value_zec, memo }) => {
    try {
      const body: Record<string, unknown> = {
        // The bridge expects a proposer; the AI acts as an assistant, so we
        // label the origin clearly and honestly for the human audit trail.
        proposer: "ai-assistant (Konclave MCP)",
        to_address,
        value_zec,
      };
      if (memo !== undefined && memo !== "") {
        body.memo = memo;
      }

      const proposal = await apiRequest<Record<string, unknown>>(
        "/api/proposals",
        { method: "POST", body },
      );

      const id =
        (proposal && typeof proposal === "object"
          ? ((proposal as Record<string, unknown>).id ??
            (proposal as Record<string, unknown>).proposal_id)
          : undefined) ?? "(unknown id)";

      const note =
        `Drafted a payment proposal (id: ${id}) for ${value_zec} ZEC to ${to_address}. ` +
        `It is now AWAITING human approval and has moved NO funds. ` +
        `The AI cannot approve or send it — a quorum of members must approve it in the ` +
        `Konclave app, where each signs with their own FROST key share.\n\n` +
        jsonBlock(proposal);

      return ok(note, { proposal });
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
  // Stderr is safe for logs (stdout is the MCP transport).
  console.error(
    `konclave-mcp ready. Backend: ${API_BASE}. ` +
      `Tools: get_vault, get_balance, list_proposals, get_ledger, propose_payment ` +
      `(read + draft only — no sign/send by design).`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting konclave-mcp:", err);
  process.exit(1);
});

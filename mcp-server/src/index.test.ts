import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "./index.js";

// Light smoke test: wire the server to an in-memory client and inspect its tool list +
// schemas. It never touches a live Konclave bridge (no tool is invoked), so it validates the
// server's shape without a running backend.

let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  tools = (await client.listTools()).tools;
});

describe("konclave-mcp tool surface", () => {
  it("exposes exactly the read + draft tools (no sign/send)", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_balance",
        "get_ledger",
        "get_transactions",
        "get_vault",
        "list_proposals",
        "list_vaults",
        "propose_payment",
        "propose_payroll",
      ].sort(),
    );
    // By design there is no tool that can sign, approve, or broadcast.
    for (const forbidden of ["approve", "sign", "send", "broadcast", "vote"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("every tool advertises an input schema", () => {
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("propose_payment requires a destination and amount", () => {
    const t = tools.find((x) => x.name === "propose_payment");
    expect(t).toBeDefined();
    const props = (t!.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(props).toHaveProperty("to_address");
    expect(props).toHaveProperty("value_zec");
    expect(props).toHaveProperty("vault_id"); // optional selector
    const required = (t!.inputSchema.required ?? []) as string[];
    expect(required).toContain("to_address");
    expect(required).toContain("value_zec");
    expect(required).not.toContain("vault_id");
  });

  it("propose_payroll takes an array of lines", () => {
    const t = tools.find((x) => x.name === "propose_payroll");
    expect(t).toBeDefined();
    const props = (t!.inputSchema.properties ?? {}) as Record<string, any>;
    expect(props).toHaveProperty("lines");
    expect(props.lines.type).toBe("array");
    const required = (t!.inputSchema.required ?? []) as string[];
    expect(required).toContain("lines");
  });

  it("read tools accept an optional vault_id", () => {
    for (const name of ["get_vault", "list_proposals", "get_ledger"]) {
      const t = tools.find((x) => x.name === name);
      const props = (t!.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(props).toHaveProperty("vault_id");
      const required = (t!.inputSchema.required ?? []) as string[];
      expect(required).not.toContain("vault_id");
    }
  });
});

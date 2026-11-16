import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// #973. The amount rule lives once, in the bridge (`Zatoshis::from_zec_str`,
// orchestrator/src/money.rs). The tool only guarantees it hands the bridge the decimal
// the assistant meant, and that the bridge's refusal reaches the assistant with its reason.
// The stub below answers with canned bodies in the bridge's real shape
// (`{"error", "detail"}`, orchestrator/src/server.rs `bad()`); it never judges an amount,
// so these tests prove the relay and the representation guard, not the amount rule
// (money.rs's own tests prove that).

type Canned = { status: number; body: unknown };
let posts: Array<{ path: string; body: Record<string, any> }> = [];
let nextPost: Canned = { status: 201, body: { id: "p-1" } };

function respond({ status, body }: Canned): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/session") return respond({ status: 200, body: { session: "t" } });
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return respond(nextPost);
    }
    return respond({ status: 404, body: { error: "not stubbed" } });
  }),
);

let client: Client;

beforeAll(async () => {
  const { server } = await import("./index.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "amount-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

beforeEach(() => {
  posts = [];
  nextPost = { status: 201, body: { id: "p-1" } };
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const pay = (value_zec: unknown) =>
  call("propose_payment", { to_address: "u1dest", value_zec });
const payroll = (values: unknown[]) =>
  call("propose_payroll", {
    lines: values.map((value_zec, i) => ({ address: `u1line${i + 1}`, value_zec })),
  });

describe("propose_payment amount (#973)", () => {
  it("refuses a non-finite number before reaching the bridge", async () => {
    // InMemoryTransport hands the server the JS value itself; over stdio a JSON client
    // could not even encode it. This is what the server sees, not a wire format.
    const r = await pay(1e400);
    expect(r.isError).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("refuses a number String() writes with an exponent, and says to send a decimal string", async () => {
    const r = await pay(1e-7);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/decimal string/);
    expect(posts).toHaveLength(0);
  });

  it("sends a plain number and a decimal string exactly", async () => {
    expect((await pay(0.01)).isError).toBeFalsy();
    expect((await pay("0.01")).isError).toBeFalsy();
    expect(posts.map((p) => p.body.value_zec)).toEqual(["0.01", "0.01"]);
  });

  // Bodies copied from orchestrator/src/server.rs create_proposal (parse error, then zero).
  it.each([
    ["abc", "could not parse zatoshi amount"],
    ["-1", "could not parse zatoshi amount"],
    ["0.123456789", "could not parse zatoshi amount"],
    ["0", "the value must be greater than zero"],
  ])("lets the bridge judge the string %s and relays its reason", async (v, why) => {
    nextPost = { status: 400, body: { error: "invalid amount", detail: why } };
    const r = await pay(v);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.value_zec).toBe(v);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`invalid amount: ${why}`);
  });

  it("offers an example only when it is the same amount", async () => {
    expect(text(await pay(1e-7))).toContain('"0.0000001"');
    const rounded = text(await pay(1.23e-9));
    expect(rounded).toMatch(/decimal string\.$/);
    expect(posts).toHaveLength(0);
  });

  it("does not relay the detail of a non-400 answer (tool stderr stays out)", async () => {
    nextPost = { status: 502, body: { error: "wallet", detail: "zcash-devtool: /path stderr" } };
    const r = await pay("0.01");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("wallet");
    expect(text(r)).not.toContain("stderr");
  });
});

describe("propose_payroll amount (#973)", () => {
  it("names the line whose number cannot be sent exactly, before reaching the bridge", async () => {
    const r = await payroll(["0.01", 1e-7]);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/line 2/);
    expect(text(r)).toMatch(/decimal string/);
    expect(posts).toHaveLength(0);
  });

  it("relays the bridge's line and reason for a string it refuses", async () => {
    nextPost = {
      status: 400,
      body: { error: "invalid line", detail: "line 2: could not parse zatoshi amount" },
    };
    const r = await payroll(["0.01", "abc"]);
    expect(posts).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("line 2: could not parse zatoshi amount");
  });

  it("sends every line's amount exactly", async () => {
    nextPost = { status: 201, body: { id: "pr-1" } };
    expect((await payroll([0.5, "0.00000001"])).isError).toBeFalsy();
    expect(posts[0]!.body.lines.map((l: any) => l.value_zec)).toEqual(["0.5", "0.00000001"]);
  });
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBetaDocsTools } from "../src/runtime/docs.js";

const clients: Client[] = [];
const servers: McpServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function connect() {
  const server = new McpServer({ name: "test", version: "1" });
  registerBetaDocsTools(server, new CfWorkerJsonSchemaValidator());
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  servers.push(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function upstream(result: Record<string, unknown>, sse = false) {
  const calls: Record<string, unknown>[] = [];
  const requests: Request[] = [];
  const send = vi.fn(
    async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }
      const message = (await request.json()) as {
        id?: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      let payload = result;
      if (message.method === "initialize") {
        payload = {
          capabilities: { tools: {} },
          protocolVersion: "2025-03-26",
          serverInfo: { name: "Photon", version: "1" },
        };
      } else {
        calls.push(message.params);
      }
      const body = { id: message.id, jsonrpc: "2.0", result: payload };
      return sse
        ? new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(body);
    }
  );
  vi.stubGlobal("fetch", send);
  return { calls, requests, send };
}

describe("Beta documentation tools", () => {
  it("lists only the two read-only tools without connecting to Mintlify", async () => {
    const { send } = upstream({});
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_docs",
      "read_docs",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        destructiveHint: false,
        readOnlyHint: true,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("version");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("forces Beta, drops Stable hits and returns public URLs (SSE: %s)", async (sse) => {
    const { calls, requests } = upstream(
      {
        content: [
          {
            text: "Title: MCP\nLink: https://docs.photon.codes/docs/beta/ai-tools/mcp\nPage: beta/ai-tools/mcp\nContent: Beta guide",
            type: "text",
          },
          {
            text: "Title: Stable\nLink: https://photon.codes/docs/cli\nPage: cli\nContent: Stable guide",
            type: "text",
          },
        ],
      },
      sse
    );
    const client = await connect();
    const result = await client.callTool({
      arguments: { query: "MCP" },
      name: "search_docs",
    });
    expect(calls).toEqual([
      { arguments: { query: "MCP", version: "Beta" }, name: "search_photon" },
    ]);
    expect(result).toMatchObject({
      content: [
        {
          text: "Title: MCP\nLink: https://photon.codes/docs/beta/ai-tools/mcp\nPage: beta/ai-tools/mcp\nContent: Beta guide",
          type: "text",
        },
      ],
    });
    for (const request of requests) {
      expect(request.url).toBe("https://photon.codes/docs/mcp");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.credentials).toBe("omit");
      expect(request.redirect).toBe("error");
    }
  });

  it.each([
    "/beta/ai-tools/mcp",
    "/beta/ai-tools/mcp.mdx",
  ])("reads only the selected Beta page: %s", async (path) => {
    const { calls } = upstream({
      content: [{ text: "# Beta MCP", type: "text" }],
    });
    const client = await connect();
    const result = await client.callTool({
      arguments: { path },
      name: "read_docs",
    });
    expect(calls).toEqual([
      {
        arguments: { command: "cat /beta/ai-tools/mcp.mdx" },
        name: "query_docs_filesystem_photon",
      },
    ]);
    expect(result).toMatchObject({
      content: [{ text: "# Beta MCP", type: "text" }],
    });
  });

  it.each([
    ["search_docs", { query: "MCP", version: "Stable" }],
    ["search_docs", { query: "" }],
    ["search_docs", { query: "x".repeat(2001) }],
    ["read_docs", { path: "/cli" }],
    ["read_docs", { path: "/beta/../cli" }],
    ["read_docs", { path: "/beta/%2e%2e/cli" }],
    ["read_docs", { path: "/beta//cli" }],
    ["read_docs", { path: "/beta/foo; cat /cli.mdx" }],
    ["read_docs", { path: "/beta/foo\ncat /cli.mdx" }],
    ["read_docs", { path: "/beta/foo\n" }],
    ["read_docs", { path: "/beta/*" }],
    ["read_docs", { path: "https://photon.codes/docs/beta/ai-tools/mcp" }],
    ["read_docs", { command: "cat /cli.mdx", path: "/beta/foo" }],
  ])("rejects invalid %s arguments before any upstream request: %j", async (name, args) => {
    const { send } = upstream({});
    const client = await connect();
    const result = await client.callTool({ arguments: args, name });
    expect(result).toMatchObject({ isError: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns an empty Beta search without falling back to Stable", async () => {
    const { calls } = upstream({
      content: [{ text: "Page: cli\nContent: Stable guide", type: "text" }],
    });
    const client = await connect();
    const result = await client.callTool({
      arguments: { query: "missing" },
      name: "search_docs",
    });
    expect(result).toMatchObject({
      content: [
        { text: "No matching Beta documentation found.", type: "text" },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("does not return upstream tool errors or private error details", async () => {
    upstream({
      content: [{ text: "private error details", type: "text" }],
      isError: true,
    });
    const client = await connect();
    const result = await client.callTool({
      arguments: { path: "/beta/missing" },
      name: "read_docs",
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "docs_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("private error details");
  });

  it("isolates network failure to the docs call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private network detail"))
    );
    const client = await connect();
    const result = await client.callTool({
      arguments: { query: "MCP" },
      name: "search_docs",
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "docs_unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain("private network detail");
    expect((await client.listTools()).tools).toHaveLength(2);
  });

  it("bounds a stalled upstream connection", async () => {
    const client = await connect();
    vi.useFakeTimers();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      (input: Request | string | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          );
        });
      }
    );
    const pending = client.callTool({
      arguments: { query: "MCP" },
      name: "search_docs",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toMatchObject({
      isError: true,
      structuredContent: { code: "docs_unavailable" },
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
  });

  it("cancels upstream requests when the caller cancels", async () => {
    const client = await connect();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      (input: Request | string | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          );
        });
      }
    );
    const controller = new AbortController();
    const pending = client.callTool(
      { arguments: { path: "/beta/ai-tools/mcp" }, name: "read_docs" },
      { signal: controller.signal }
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    controller.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(requests.every((request) => request.signal.aborted)).toBe(true)
    );
  });
});

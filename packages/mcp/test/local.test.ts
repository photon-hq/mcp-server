import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  type McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { compileRelease } from "@photon-ai/mcp-core/compiler/compile";
import { writeRuntimeModule } from "@photon-ai/mcp-core/compiler/release-artifacts/index";
import { activateRuntimeRelease } from "@photon-ai/mcp-core/runtime/runtime-release";
import { describe, expect, it } from "vitest";
import { createLocalServerFactory } from "../src/local.js";

const project = {
  additionalProperties: false,
  properties: { id: { type: "string" }, name: { type: "string" } },
  required: ["id", "name"],
  type: "object",
};

async function fixtureRelease() {
  const compiled = compileRelease({
    aggregate: {
      info: { title: "Local fixture", version: "1" },
      openapi: "3.1.0",
      paths: {
        "/v1/projects/{id}": {
          get: {
            operationId: "getProject",
            parameters: [
              {
                in: "path",
                name: "id",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": { content: { "application/json": { schema: project } } },
            },
            "x-required-permissions": ["project:read"],
          },
        },
      },
    },
    aggregateEtag: "local-fixture",
    compilerPolicy: { operationPollLimit: 3 },
    environment: "production",
  });
  const directory = await mkdtemp(join(tmpdir(), "photon-mcp-local-"));
  const file = join(directory, "runtime-release.ts");
  try {
    const identity = await writeRuntimeModule(compiled, file);
    const emitted = (await import(
      `${pathToFileURL(file).href}?checksum=${identity.checksum}`
    )) as { readonly default: unknown };
    return await activateRuntimeRelease(emitted.default, identity.checksum);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function call(
  factory: () => McpServer,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(factory);
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: { name: "local-test", version: "1" },
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          },
        },
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": "2026-07-28",
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      },
      method: "POST",
    })
  );
  const result = (await response.json()) as Record<string, unknown>;
  await handler.close();
  return result;
}

describe("createLocalServerFactory", () => {
  it("calls the configured API origin with the user's key", async () => {
    const requests: Request[] = [];
    const factory = await createLocalServerFactory({
      config: {
        apiKey: "pho_ask_key_secret",
        apiUrl: "https://api.photon.codes",
      },
      fetch: (sent) => {
        requests.push(sent);
        return Promise.resolve(
          Response.json({ id: "project-1", name: "Demo" }, { status: 200 })
        );
      },
      release: await fixtureRelease(),
      version: "0.0.0-test",
    });

    const listed = await call(factory, "tools/list");
    expect(
      (listed.result as { tools: { name: string }[] }).tools.map(
        (tool) => tool.name
      )
    ).toEqual(["getProject"]);

    const called = await call(factory, "tools/call", {
      arguments: { path: { id: "project-1" } },
      name: "getProject",
    });
    expect(called.result).toMatchObject({
      structuredContent: {
        data: { id: "project-1", name: "Demo" },
        status: 200,
      },
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.photon.codes/v1/projects/project-1");
    expect(request?.headers.get("authorization")).toBe(
      "Bearer pho_ask_key_secret"
    );
    expect(request?.headers.get("user-agent")).toBe("photon-mcp/0.0.0-test");
  });

  it("returns an upstream denial as a tool error without the body", async () => {
    const factory = await createLocalServerFactory({
      config: {
        apiKey: "pho_ask_key_secret",
        apiUrl: "https://api.photon.codes",
      },
      fetch: () =>
        Promise.resolve(
          Response.json(
            { detail: "private denial detail" },
            {
              headers: { "content-type": "application/problem+json" },
              status: 403,
            }
          )
        ),
      release: await fixtureRelease(),
      version: "0.0.0-test",
    });
    const called = await call(factory, "tools/call", {
      arguments: { path: { id: "project-1" } },
      name: "getProject",
    });
    expect(called.result).toMatchObject({ isError: true });
    expect(JSON.stringify(called.result)).not.toContain(
      "private denial detail"
    );
  });
});

import { describe, expect, it } from "vitest";
import { compileRelease } from "../src/compiler/compile.js";
import {
  canonicalJson,
  parseSemanticReleaseSnapshot,
  type SemanticReleaseSnapshot,
  semanticReleaseIdentity,
} from "../src/compiler/release-snapshot.js";
import { makeCompileInput } from "./fixtures.js";

const checksumPattern = /^[a-f0-9]{64}$/u;

function semanticSnapshot(release: ReturnType<typeof compileRelease>) {
  const {
    changeReport: _changeReport,
    previousReleaseIdentity: _previousReleaseIdentity,
    ...snapshot
  } = release;
  return snapshot;
}

describe("release snapshot", () => {
  it("round-trips canonical semantic facts with a stable identity", () => {
    const snapshot = semanticSnapshot(compileRelease(makeCompileInput()));
    const parsed = parseSemanticReleaseSnapshot(
      JSON.parse(canonicalJson(snapshot))
    );
    const unordered = Object.fromEntries([
      ["z", 1],
      [
        "a",
        Object.fromEntries([
          ["y", 2],
          ["x", 3],
        ]),
      ],
    ]);

    expect(canonicalJson(parsed)).toBe(canonicalJson(snapshot));
    expect(canonicalJson(unordered)).toBe(
      '{\n  "a": {\n    "x": 3,\n    "y": 2\n  },\n  "z": 1\n}\n'
    );
    expect(semanticReleaseIdentity(parsed)).toBe(
      semanticReleaseIdentity(snapshot)
    );
  });

  it.each([
    ["audit", "audit"],
    ["exclusions", "exclusions"],
    ["blacklist", "blacklist"],
    ["baseline hash", "baselineOpenApiHash"],
    ["gateway routes", "gatewayRoutes"],
  ])("rejects removed %s compile input and previous snapshot fields", (_name, field) => {
    expect(() =>
      compileRelease({ ...makeCompileInput(), [field]: [] })
    ).toThrowError("invalid_compile_input");

    const input = makeCompileInput() as Record<string, unknown>;
    input.previousRelease = {
      ...semanticSnapshot(compileRelease(makeCompileInput())),
      [field]: [],
    };
    expect(() => compileRelease(input)).toThrowError(
      "invalid_previous_release"
    );
  });

  it("parses a trusted previous semantic snapshot for compilation", () => {
    const previous = semanticSnapshot(compileRelease(makeCompileInput()));
    const input = makeCompileInput();
    const pathItem = (
      input.aggregate.paths as Partial<
        Record<string, Partial<Record<string, Record<string, unknown>>>>
      >
    )["/projects/{projectId}"];
    if (!pathItem) {
      throw new Error("missing fixture path");
    }
    const operation = pathItem.get;
    if (!operation) {
      throw new Error("missing fixture operation");
    }
    operation.description = "Returns one project.";
    (input as { previousRelease?: unknown }).previousRelease = previous;

    const candidate = compileRelease(input);

    expect(parseSemanticReleaseSnapshot(previous)).toEqual(previous);
    expect(candidate.changeReport).toMatchObject({
      changes: [
        expect.objectContaining({
          decision: "automatic",
          kind: "description_changed",
          operationId: "getProject",
        }),
      ],
      decision: "automatic",
    });
    expect(candidate).not.toHaveProperty("previousRelease");
    expect(candidate.previousReleaseIdentity).toMatch(checksumPattern);
  });

  it("returns a detached snapshot", () => {
    const snapshot = semanticSnapshot(compileRelease(makeCompileInput()));
    const source = JSON.parse(canonicalJson(snapshot)) as {
      openapi: { info: { title: string } };
      registry: { operationId: string }[];
      tools: { name: string }[];
    };
    const parsed = parseSemanticReleaseSnapshot(source);
    const [registry] = source.registry;
    const [tool] = source.tools;
    if (!(registry && tool)) {
      throw new Error("missing snapshot capability");
    }

    source.openapi.info.title = "Changed API";
    registry.operationId = "changedOperation";
    tool.name = "changedOperation";

    expect(parsed).toEqual(snapshot);
  });

  it("rejects the reserved release operation ID in previous snapshots", () => {
    const source = JSON.parse(
      canonicalJson(semanticSnapshot(compileRelease(makeCompileInput())))
    ) as { registry: { operationId: string }[] };
    const [capability] = source.registry;
    if (!capability) {
      throw new Error("missing snapshot capability");
    }
    capability.operationId = "release";

    expect(() => parseSemanticReleaseSnapshot(source)).toThrowError(
      "invalid_previous_release"
    );
  });

  it("rejects a reserved ID in a disabled unadvertised snapshot route", () => {
    const source = JSON.parse(
      canonicalJson(semanticSnapshot(compileRelease(makeCompileInput())))
    ) as {
      openapi: { paths: Record<string, unknown> };
    };
    source.openapi.paths["/disabled-release"] = {
      get: {
        operationId: "release",
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
        "x-photon-mcp": { enabled: false },
      },
    };

    expect(() => parseSemanticReleaseSnapshot(source)).toThrowError(
      "invalid_previous_release"
    );
  });

  it("rejects an enabled OpenAPI route omitted from registry and tools", () => {
    const source = JSON.parse(
      canonicalJson(semanticSnapshot(compileRelease(makeCompileInput())))
    ) as {
      registry: unknown[];
      tools: unknown[];
    };
    source.registry = [];
    source.tools = [];

    expect(() => parseSemanticReleaseSnapshot(source)).toThrowError(
      "invalid_previous_release"
    );
  });

  it("rejects duplicate admitted OpenAPI operation IDs", () => {
    const source = JSON.parse(
      canonicalJson(semanticSnapshot(compileRelease(makeCompileInput())))
    ) as {
      openapi: { paths: Record<string, unknown> };
    };
    source.openapi.paths = {
      "/duplicate": {
        get: {
          operationId: "getProject",
          responses: { "204": { description: "No content" } },
        },
      },
      ...source.openapi.paths,
    };

    expect(() => parseSemanticReleaseSnapshot(source)).toThrowError(
      "invalid_previous_release"
    );
  });

  it("rejects an admitted OpenAPI operation without an operation ID", () => {
    const source = JSON.parse(
      canonicalJson(semanticSnapshot(compileRelease(makeCompileInput())))
    ) as {
      openapi: {
        paths: Partial<
          Record<string, Partial<Record<string, Record<string, unknown>>>>
        >;
      };
      registry: unknown[];
      tools: unknown[];
    };
    const operation = source.openapi.paths["/projects/{projectId}"]?.get;
    if (!operation) {
      throw new Error("missing fixture operation");
    }
    const { operationId: _operationId, ...withoutOperationId } = operation;
    source.openapi.paths = {
      "/missing-operation-id": { get: withoutOperationId },
    };
    source.registry = [];
    source.tools = [];

    expect(() => parseSemanticReleaseSnapshot(source)).toThrowError(
      "invalid_previous_release"
    );
  });

  it("accepts a referenced private GET getter and ignores an unreferenced disabled route", () => {
    const input = makeCompileInput({
      method: "post",
      operation: {
        operationId: "startOperation",
        responses: {
          "202": {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    operationId: { type: "string" },
                    projectId: { type: "string" },
                    state: { type: "string" },
                  },
                  required: ["projectId", "operationId", "state"],
                  type: "object",
                },
              },
            },
            links: {
              operation: {
                operationId: "readOperation",
                parameters: {
                  operationId: "$response.body#/operationId",
                  projectId: "$response.body#/projectId",
                },
              },
            },
          },
        },
      },
    });
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    paths["/projects/{projectId}/operations/{operationId}"] = {
      get: {
        operationId: "readOperation",
        responses: {
          "200": {
            content: {
              "application/json": { schema: { type: "object" } },
            },
          },
        },
        "x-photon-mcp": { enabled: false },
      },
    };
    paths["/disabled-unreferenced"] = {
      get: {
        operationId: "disabledUnreferenced",
        responses: { "204": { description: "No content" } },
        "x-photon-mcp": { enabled: false },
      },
    };
    const snapshot = semanticSnapshot(compileRelease(input));

    expect(
      snapshot.privateCapabilities.map((item) => item.operationId)
    ).toEqual(["readOperation"]);
    expect(parseSemanticReleaseSnapshot(snapshot)).toEqual(snapshot);
  });

  it("wraps valid-shape relationship failures with their cause", () => {
    const snapshot = semanticSnapshot(compileRelease(makeCompileInput()));
    const source = JSON.parse(canonicalJson(snapshot)) as {
      tools: { name: string }[];
    };
    const [tool] = source.tools;
    if (!tool) {
      throw new Error("missing snapshot tool");
    }
    tool.name = "otherOperation";

    let thrown: unknown;
    try {
      parseSemanticReleaseSnapshot(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      cause: expect.objectContaining({ message: "invalid_snapshot_relations" }),
      message: "invalid_previous_release",
    });
  });

  it.each([
    [
      "unknown field",
      (snapshot: SemanticReleaseSnapshot) => ({ ...snapshot, audit: [] }),
    ],
    [
      "malformed tools",
      (snapshot: SemanticReleaseSnapshot) => ({ ...snapshot, tools: [{}] }),
    ],
  ])("wraps %s as an invalid previous release", (_name, change) => {
    const snapshot = semanticSnapshot(compileRelease(makeCompileInput()));

    expect(() => parseSemanticReleaseSnapshot(change(snapshot))).toThrowError(
      "invalid_previous_release"
    );
  });

  it("ignores compilation metadata when deriving an identity directly", () => {
    const release = compileRelease(makeCompileInput());
    const withDifferentMetadata = {
      ...release,
      changeReport: {
        changes: [{ kind: "changed" }],
        decision: "review" as const,
        schemaVersion: 1 as const,
      },
      previousReleaseIdentity: "different",
    };

    expect(semanticReleaseIdentity(release)).toBe(
      semanticReleaseIdentity(withDifferentMetadata)
    );
  });

  it.each([
    ["admission model", { admissionModel: "other" }],
    ["aggregate ETag", { aggregateEtag: '"other"' }],
    ["OpenAPI document", { openapi: { changed: true } }],
    ["authorization permissions", { authPermissions: ["other:read"] }],
    ["compiler version", { compilerVersion: "0.2.0" }],
    ["environment", { environment: "production" }],
    [
      "private capabilities",
      { privateCapabilities: [{ operationId: "other" }] },
    ],
    ["protocol version", { protocolVersion: "other" }],
    ["registry", { registry: [] }],
    ["schema version", { schemaVersion: 2 }],
    ["tools", { tools: [] }],
  ])("changes identity when %s changes", (_name, change) => {
    const snapshot = semanticSnapshot(compileRelease(makeCompileInput()));

    expect(
      semanticReleaseIdentity({
        ...snapshot,
        ...change,
      } as SemanticReleaseSnapshot)
    ).not.toBe(semanticReleaseIdentity(snapshot));
  });
});

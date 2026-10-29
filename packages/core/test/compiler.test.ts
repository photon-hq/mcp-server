import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { describe, expect, it } from "vitest";
import { compileRelease } from "../src/compiler/compile.js";
import { parseMcpExtension } from "../src/compiler/extension.js";
import { semanticReleaseIdentity } from "../src/compiler/release-snapshot.js";
import { closeSchema } from "../src/schema.js";
import { makeCompileInput } from "./fixtures.js";

const idempotencyPattern = /idempotency/iu;
const releaseIdentityPattern = /^[a-f0-9]{64}$/u;
const advertisedSuccessDefinition = /^#\/\$defs\/success_200_/u;

function capability(
  result: ReturnType<typeof compileRelease>,
  operationId = "getProject"
) {
  const found = result.registry.find(
    (item) => item.operationId === operationId
  );

  if (!found) {
    throw new Error(`missing capability: ${operationId}`);
  }

  return found;
}

interface InputPartition {
  readonly additionalProperties?: boolean;
  readonly properties: Record<string, unknown>;
}

function requiredPartition(
  properties: Partial<Record<string, InputPartition>>,
  name: string
): InputPartition {
  const partition = properties[name];
  if (!partition) {
    throw new Error(`missing input partition: ${name}`);
  }
  return partition;
}

describe("compileRelease", () => {
  it.each([
    "oneOf",
    "anyOf",
  ])("closes object %s around branch properties", (keyword) => {
    const schema = closeSchema(
      {
        properties: { shared: { type: "string" } },
        required: ["shared"],
        type: "object",
        [keyword]: [
          { properties: { a: { type: "string" } }, required: ["a"] },
          { properties: { b: { type: "integer" } }, required: ["b"] },
        ],
      },
      undefined
    );
    for (const validator of [
      new AjvJsonSchemaValidator(),
      new CfWorkerJsonSchemaValidator({ draft: "2020-12" }),
    ]) {
      const validate = validator.getValidator(schema);
      expect(validate({ a: "a", shared: "s" }).valid).toBe(true);
      expect(validate({ b: 1, shared: "s" }).valid).toBe(true);
      expect(validate({ a: "a", extra: true, shared: "s" }).valid).toBe(false);
      expect(validate({ a: "a", b: 1, shared: "s" }).valid).toBe(
        keyword === "anyOf"
      );
    }
  });

  it("preserves parameter descriptions with schema annotations taking precedence", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          parameters: [
            {
              description: "Parameter guidance",
              in: "query",
              name: "fallback",
              schema: { type: "string" },
            },
            {
              description: "Parameter guidance",
              in: "query",
              name: "specific",
              schema: { description: "Schema guidance", type: "string" },
            },
          ],
        },
      })
    );
    const input = capability(result).inputSchema as {
      properties: Record<string, InputPartition>;
    };
    expect(
      requiredPartition(input.properties, "query").properties
    ).toMatchObject({
      fallback: { description: "Parameter guidance" },
      specific: { description: "Schema guidance" },
    });
  });

  it("allows complete operation lists exceeding 200 entries", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          operationId: "listOperations",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      operations: {
                        items: { additionalProperties: true, type: "object" },
                        type: "array",
                      },
                    },
                    required: ["operations"],
                    type: "object",
                  },
                },
              },
            },
          },
        },
      })
    );
    const validate = new AjvJsonSchemaValidator().getValidator(
      capability(result, "listOperations").outputSchema
    );
    const item = { operationId: "op", projectId: "project", state: "running" };
    expect(validate({ data: { operations: [item] }, status: 200 }).valid).toBe(
      true
    );
    expect(
      validate({
        data: { operations: Array.from({ length: 201 }, () => item) },
        status: 200,
      }).valid
    ).toBe(true);
  });

  it("preserves the declared operation-list continuation token contract", () => {
    const input = makeCompileInput({
      operation: {
        operationId: "listOperations",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OperationPage" },
              },
            },
          },
        },
      },
    });
    Object.assign(input.aggregate.components.schemas, {
      OperationPage: {
        additionalProperties: false,
        properties: {
          nextPageToken: {
            description: "Opaque continuation token",
            minLength: 3,
            type: "string",
          },
          operations: { items: { type: "object" }, type: "array" },
        },
        required: ["operations"],
        type: "object",
      },
    });
    const schema = capability(
      compileRelease(input),
      "listOperations"
    ).outputSchema;
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    expect(
      validate({
        data: { nextPageToken: "opaque", operations: [] },
        status: 200,
      }).valid
    ).toBe(true);
    expect(validate({ data: { operations: [] }, status: 200 }).valid).toBe(
      true
    );
    expect(
      validate({ data: { nextPageToken: "x", operations: [] }, status: 200 })
        .valid
    ).toBe(false);
    expect(
      validate({ data: { extra: true, operations: [] }, status: 200 }).valid
    ).toBe(true);
  });

  it("reads success responses openly while request bodies stay closed", () => {
    const input = makeCompileInput({
      method: "post",
      operation: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Resource" },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Resource" },
              },
            },
          },
        },
      },
    });
    Object.assign(input.aggregate.components.schemas, {
      Owner: {
        oneOf: [
          {
            additionalProperties: false,
            properties: { id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
          {
            additionalProperties: false,
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
            type: "object",
          },
        ],
      },
      Resource: {
        additionalProperties: false,
        properties: {
          failure: { not: {} },
          id: { type: "string" },
          kind: { const: "number", type: "string" },
          owner: { $ref: "#/components/schemas/Owner" },
          state: {
            description: "Lifecycle state.",
            enum: ["unallocated", "active", "retired"],
            type: "string",
          },
        },
        required: ["id", "kind", "state"],
        type: "object",
      },
    });
    const compiled = capability(compileRelease(input));
    const [representation] = compiled.successRepresentations;
    if (!(representation && "schema" in representation)) {
      throw new Error("missing success representation");
    }
    // Both owner branches match once objects are open, which oneOf rejects.
    const resource = {
      id: "resource-1",
      kind: "number",
      owner: { id: "owner-1", name: "Owner" },
      state: "active",
    };
    for (const validator of [
      new AjvJsonSchemaValidator(),
      new CfWorkerJsonSchemaValidator({ draft: "2020-12" }),
    ]) {
      // The released schemas are frozen; cfworker annotates what it validates.
      const output = validator.getValidator(
        structuredClone(compiled.outputSchema)
      );
      const response = validator.getValidator(
        structuredClone(representation.schema)
      );
      const read = (data: unknown) => [
        output({ data, status: 200 }).valid,
        response(data).valid,
      ];
      expect(read(resource)).toEqual([true, true]);
      expect(read({ ...resource, added: true, state: "provisioning" })).toEqual(
        [true, true]
      );
      expect(read({ ...resource, failure: "x" })).toEqual([false, false]);
      expect(read({ ...resource, kind: "other" })).toEqual([false, false]);
      expect(read({ ...resource, state: 1 })).toEqual([false, false]);
      const { state: _state, ...withoutState } = resource;
      expect(read(withoutState)).toEqual([false, false]);

      const request = validator.getValidator(
        structuredClone(compiled.inputSchema)
      );
      const call = (body: unknown) =>
        request({ body, path: { projectId: "project-1" } }).valid;
      expect(call(resource)).toBe(true);
      expect(call({ ...resource, state: "provisioning" })).toBe(false);
      expect(call({ ...resource, added: true })).toBe(false);
    }
    expect(JSON.stringify(compiled.outputSchema)).toContain(
      'Lifecycle state.\\n\\nKnown values: [\\"unallocated\\",\\"active\\",\\"retired\\"]. Others may be added.'
    );
  });
  it("rejects the reserved release operation ID at compile admission", () => {
    expect(() =>
      compileRelease(
        makeCompileInput({ operation: { operationId: "release" } })
      )
    ).toThrowError("reserved_operation_id");
  });

  it("rejects a reserved ID on an otherwise disabled operation", () => {
    const input = makeCompileInput();
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    const source = (
      paths["/projects/{projectId}"] as Record<string, unknown> | undefined
    )?.get;
    if (!source) {
      throw new Error("missing fixture operation");
    }
    paths["/disabled-release"] = {
      get: {
        ...(source as Record<string, unknown>),
        operationId: "release",
        "x-photon-mcp": { enabled: false },
      },
    };

    expect(() => compileRelease(input)).toThrowError("reserved_operation_id");
  });

  it("derives route facts without serializing a route collection", () => {
    const compiled = compileRelease(makeCompileInput());

    expect(Object.hasOwn(compiled, "gatewayRoutes")).toBe(false);
    expect(semanticReleaseIdentity(compiled)).toMatch(releaseIdentityPattern);
  });

  it("rejects unknown compiler policy fields", () => {
    const input = makeCompileInput() as unknown as Record<string, unknown>;
    input.compilerPolicy = { operationPollLimit: 3, unknown: true };

    expect(() => compileRelease(input)).toThrowError("invalid_compiler_policy");
  });

  const reorderedEnumObject = Object.fromEntries([
    ["b", 2],
    ["a", 1],
  ]);

  it.each([
    ["omitted metadata", undefined, true],
    ["empty metadata", {}, true],
    ["explicit enabled", { enabled: true }, true],
    ["producer disabled", { enabled: false }, false],
  ])("handles %s", (_name, extension, included) => {
    const result = compileRelease(makeCompileInput({ extension }));
    expect(
      result.registry.some((item) => item.operationId === "getProject")
    ).toBe(included);
  });

  it.each([
    false,
    { unknown: true },
    { enabled: "yes" },
  ])("rejects malformed extension %#", (extension) => {
    expect(() => compileRelease(makeCompileInput({ extension }))).toThrowError(
      "invalid_mcp_extension"
    );
  });

  it("normalizes disabled metadata to enabled only", () => {
    expect(parseMcpExtension({ enabled: false, readOnly: true })).toEqual({
      enabled: false,
    });
  });

  it("partitions colliding inputs and preserves validation facts", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          parameters: [
            {
              in: "path",
              name: "value",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "query",
              name: "value",
              schema: {
                default: 2,
                enum: [1, 2],
                maximum: 5,
                minimum: 1,
                type: "integer",
              },
            },
            {
              in: "header",
              name: "value",
              schema: { format: "uuid", type: "string" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    value: { maxLength: 8, minLength: 2, type: "string" },
                  },
                  required: ["value"],
                  type: "object",
                },
              },
            },
            required: true,
          },
        },
      })
    );
    const schema = capability(result).inputSchema as {
      properties: Partial<Record<string, InputPartition>>;
      required: string[];
    };
    const path = requiredPartition(schema.properties, "path");
    const query = requiredPartition(schema.properties, "query");
    const headers = requiredPartition(schema.properties, "headers");
    const body = requiredPartition(schema.properties, "body");

    expect(schema.required).toEqual(["path", "body"]);
    expect(path.properties.value).toEqual({
      type: "string",
    });
    expect(query.properties.value).toEqual({
      default: 2,
      enum: [1, 2],
      maximum: 5,
      minimum: 1,
      type: "integer",
    });
    expect(headers.properties.value).toEqual({
      format: "uuid",
      type: "string",
    });
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.value).toEqual({
      maxLength: 8,
      minLength: 2,
      type: "string",
    });
  });

  it.each([
    ["authorization", "Authorization"],
    ["cookie", "Cookie"],
    ["workload", "X-Workload-Identity"],
    ["trace", "Traceparent"],
  ])("rejects a required forbidden %s header", (_name, name) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [
              {
                in: "header",
                name,
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        })
      )
    ).toThrow();
  });

  it("compiles the exact Idempotency-Key declaration into runtime policy without exposing it as tool input", () => {
    const result = compileRelease(
      makeCompileInput({
        method: "post",
        operation: {
          parameters: [
            {
              explode: false,
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { maxLength: 255, minLength: 1, type: "string" },
              style: "simple",
            },
          ],
        },
      })
    );
    const item = capability(result);

    expect(item.idempotency).toBe("header");
    expect(item.idempotencyKeySchema).toEqual({
      maxLength: 255,
      minLength: 1,
      type: "string",
    });
    expect(JSON.stringify(item.inputSchema)).not.toMatch(idempotencyPattern);
  });

  it.each([
    ["optional", { required: false }],
    ["unspecified", {}],
  ])("compiles an %s Idempotency-Key like a required one, because the runtime always sends a key", (_name, requiredness) => {
    const item = capability(
      compileRelease(
        makeCompileInput({
          method: "post",
          operation: {
            parameters: [
              {
                in: "header",
                name: "Idempotency-Key",
                ...requiredness,
                schema: { maxLength: 255, minLength: 1, type: "string" },
              },
            ],
          },
        })
      )
    );

    expect(item.idempotency).toBe("header");
    expect(JSON.stringify(item.inputSchema)).not.toMatch(idempotencyPattern);
  });

  it.each([
    ["wrong location", { in: "query" }],
    ["wrong schema", { schema: { type: "integer" } }],
    ["wrong style", { style: "form" }],
    ["wrong explode", { explode: true }],
    ["reserved values", { allowReserved: true }],
    ["empty values", { allowEmptyValue: true }],
    [
      "content form",
      {
        content: {
          "application/json": { schema: { type: "string" } },
        },
      },
    ],
  ])("rejects an unsupported Idempotency-Key %s variant", (_name, update) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          method: "post",
          operation: {
            parameters: [
              {
                explode: false,
                in: "header",
                name: "Idempotency-Key",
                required: true,
                schema: { maxLength: 255, minLength: 1, type: "string" },
                style: "simple",
                ...update,
              },
            ],
          },
        })
      )
    ).toThrowError("unsupported_idempotency_parameter");
  });

  it.each([
    { maxLength: 128, minLength: 8, pattern: "^[!-~]{8,128}$", type: "string" },
    { pattern: "^[\\x21-\\x7e]{1,255}$", type: "string" },
  ])("preserves the internal idempotency contract %j", (schema) => {
    const result = capability(
      compileRelease(
        makeCompileInput({
          method: "post",
          operation: {
            parameters: [
              { in: "header", name: "Idempotency-Key", required: true, schema },
            ],
          },
        })
      )
    );
    expect(result.idempotencyKeySchema).toEqual(schema);
    expect(JSON.stringify(result.inputSchema)).not.toMatch(idempotencyPattern);
  });

  it("rejects duplicate Idempotency-Key declarations", () => {
    const parameter = {
      in: "header",
      name: "Idempotency-Key",
      required: true,
      schema: { maxLength: 255, minLength: 1, type: "string" },
    };
    expect(() =>
      compileRelease(
        makeCompileInput({
          method: "post",
          operation: { parameters: [parameter, { ...parameter }] },
        })
      )
    ).toThrowError("unsupported_idempotency_parameter");
  });

  it.each([
    ["path style", "path", { style: "form" }],
    ["path explode", "path", { explode: true }],
    ["query style", "query", { style: "simple" }],
    ["query explode", "query", { explode: false }],
    ["header style", "header", { style: "form" }],
    ["header explode", "header", { explode: true }],
    ["reserved value", "query", { allowReserved: true }],
    ["empty value", "query", { allowEmptyValue: true }],
  ] as const)("rejects unsupported %s serialization", (_name, location, update) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [
              {
                in: location,
                name: "value",
                ...(location === "path" ? { required: true } : {}),
                schema: { type: "string" },
                ...update,
              },
            ],
          },
        })
      )
    ).toThrowError("unsupported_parameter_serialization");
  });

  it.each([
    ["null", { type: "null" }],
    ["array of objects", { items: { type: "object" }, type: "array" }],
    [
      "open object",
      { properties: { value: { type: "string" } }, type: "object" },
    ],
    [
      "nested object",
      {
        additionalProperties: false,
        properties: { value: { type: "object" } },
        type: "object",
      },
    ],
  ])("rejects an unsupported %s parameter schema", (_name, schema) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [{ in: "query", name: "value", schema }],
          },
        })
      )
    ).toThrowError("unsupported_parameter_schema");
  });

  it("accepts contains as a compiler-level JSON Schema keyword", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  contains: { const: "needle" },
                  items: { type: "string" },
                  minContains: 1,
                  type: "array",
                },
              },
            },
            required: true,
          },
        },
      })
    );

    expect(JSON.stringify(capability(result).inputSchema)).toContain(
      '"contains":{"const":"needle"}'
    );
  });

  it("advertises OpenAPI example annotations as JSON Schema examples", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    name: { example: "Acme", type: "string" },
                    slug: {
                      example: "acme",
                      examples: ["acme"],
                      type: "string",
                    },
                    tier: {
                      example: "pro",
                      examples: ["free"],
                      type: "string",
                    },
                  },
                  type: "object",
                },
              },
            },
          },
        },
      })
    );

    const { body } = (
      capability(result).inputSchema as {
        properties: { body: { properties: Record<string, unknown> } };
      }
    ).properties;
    expect(body.properties).toEqual({
      name: { examples: ["Acme"], type: "string" },
      slug: { examples: ["acme"], type: "string" },
      tier: { examples: ["free", "pro"], type: "string" },
    });
  });

  it("checks referenced parameter schemas and keeps the reference", () => {
    const input = makeCompileInput({
      operation: {
        parameters: [
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { type: "string" },
          },
          {
            description: "Sort order.",
            in: "query",
            name: "order",
            schema: { $ref: "#/components/schemas/SortOrder" },
          },
          {
            in: "query",
            name: "platforms",
            schema: {
              items: { $ref: "#/components/schemas/SortOrder" },
              type: "array",
            },
          },
        ],
      },
    });
    const aggregate = input.aggregate as {
      components: { schemas: Record<string, unknown> };
    };
    aggregate.components.schemas.SortOrder = {
      enum: ["asc", "desc"],
      type: "string",
    };

    const schema = capability(compileRelease(input)).inputSchema as {
      $defs: Record<string, unknown>;
      properties: { query: { properties: Record<string, unknown> } };
    };

    expect(schema.properties.query.properties.order).toEqual({
      $ref: "#/$defs/SortOrder",
      description: "Sort order.",
    });
    expect(schema.$defs.SortOrder).toEqual({
      enum: ["asc", "desc"],
      type: "string",
    });
  });

  it.each([
    ["object", { properties: { value: { type: "string" } }, type: "object" }],
    ["self-referencing", { $ref: "#/components/schemas/Loop" }],
  ])("rejects a reference to an unsupported %s parameter schema", (_name, target) => {
    const input = makeCompileInput({
      operation: {
        parameters: [
          {
            in: "query",
            name: "value",
            schema: { $ref: "#/components/schemas/Loop" },
          },
        ],
      },
    });
    const aggregate = input.aggregate as {
      components: { schemas: Record<string, unknown> };
    };
    aggregate.components.schemas.Loop = target;

    expect(() => compileRelease(input)).toThrow("unsupported_parameter_schema");
  });

  it("closes local references and rejects unresolved or external references", () => {
    const compiled = compileRelease(makeCompileInput());
    expect(capability(compiled).successRepresentations).toMatchObject([
      {
        mediaType: "application/json",
        schema: {
          $defs: {
            Project: { properties: { id: { type: "string" } }, type: "object" },
          },
        },
        status: 200,
      },
    ]);

    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Missing" },
                  },
                },
              },
            },
          },
        })
      )
    ).toThrow();
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "https://example.test/schema" },
                  },
                },
              },
            },
          },
        })
      )
    ).toThrow();
  });

  it("rejects $defs declared below the schema root", () => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    $defs: { RootValue: { type: "string" } },
                    properties: {
                      child: {
                        $defs: { ChildValue: { type: "number" } },
                        properties: {
                          value: { $ref: "#/$defs/RootValue" },
                        },
                        type: "object",
                      },
                    },
                    type: "object",
                  },
                },
              },
            },
          },
        })
      )
    ).toThrow("nested_schema_definitions");
  });

  it("lifts generated request definitions to the final input schema root", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Project" },
              },
            },
          },
        },
      })
    );

    expect(capability(result).inputSchema).toMatchObject({
      $defs: { Project: { type: "object" } },
      properties: { body: { $ref: "#/$defs/Project" } },
    });
  });

  it("keeps async request definitions at the final input root despite component name collisions", () => {
    const input = makeCompileInput({
      method: "post",
      operation: {
        operationId: "startOperation",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $defs: { Value: { type: "string" } },
                $ref: "#/$defs/Value",
              },
            },
          },
        },
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
                  required: ["operationId", "projectId", "state"],
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
    const aggregate = input.aggregate as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, unknown>>;
    };
    aggregate.components.schemas.Value = { type: "number" };
    aggregate.paths["/projects/{projectId}/operations/{operationId}"] = {
      get: {
        operationId: "readOperation",
        responses: { "204": { description: "No content" } },
        "x-photon-mcp": { enabled: false },
      },
    };

    const schema = capability(compileRelease(input), "startOperation")
      .inputSchema as {
      $defs: Record<string, unknown>;
      oneOf: Array<{ properties: { body: unknown } }>;
    };

    const initialBranch = schema.oneOf.at(0);
    if (initialBranch === undefined) {
      throw new Error("missing initial async input branch");
    }

    expect(schema.$defs.Value).toEqual({ type: "string" });
    expect(initialBranch.properties.body).toEqual({ $ref: "#/$defs/Value" });
  });

  it("lifts success definitions to the advertised output schema root", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    $defs: { Payload: { type: "string" } },
                    $ref: "#/$defs/Payload",
                  },
                },
              },
            },
          },
        },
      })
    );

    const item = capability(result);
    const output = item.outputSchema as {
      $defs: Record<string, unknown>;
      oneOf: Array<{ properties: { data: { $ref: string } } }>;
    };
    const branch = output.oneOf.at(0);
    if (branch === undefined) {
      throw new Error("missing advertised success branch");
    }
    const reference = branch.properties.data.$ref;

    expect(reference).toMatch(advertisedSuccessDefinition);
    expect(output.$defs[reference.slice("#/$defs/".length)]).toEqual({
      type: "string",
    });
    expect(item.successRepresentations).toMatchObject([
      {
        schema: {
          $defs: { Payload: { type: "string" } },
          $ref: "#/$defs/Payload",
        },
      },
    ]);
  });

  it("namespaces independent success definition roots in the advertised schema", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    $defs: { Value: { type: "string" } },
                    $ref: "#/$defs/Value",
                  },
                },
                "application/vnd.photon+json": {
                  schema: {
                    $defs: { Value: { type: "number" } },
                    $ref: "#/$defs/Value",
                  },
                },
              },
            },
            "202": {
              content: {
                "application/json": {
                  schema: {
                    $defs: { Value: { type: "boolean" } },
                    $ref: "#/$defs/Value",
                  },
                },
              },
            },
          },
        },
      })
    );
    const output = capability(result).outputSchema as {
      $defs: Record<string, unknown>;
      oneOf: Array<{
        properties: {
          data: { $ref?: string; anyOf?: Array<{ $ref: string }> };
        };
      }>;
    };
    const data = output.oneOf.flatMap(
      (branch) =>
        branch.properties.data.anyOf ?? [
          branch.properties.data as { $ref: string },
        ]
    );
    const names = data.map((schema) => schema.$ref?.slice("#/$defs/".length));

    expect(new Set(names).size).toBe(3);
    expect(names).toHaveLength(3);
    expect(names.map((name) => output.$defs[name ?? ""])).toEqual([
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
    ]);
  });

  it("keeps local definitions distinct from colliding component definitions", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    $defs: { Project: { type: "string" } },
                    allOf: [
                      { $ref: "#/$defs/Project" },
                      { $ref: "#/components/schemas/Project" },
                    ],
                  },
                },
              },
            },
          },
        },
      })
    );
    const [representation] = capability(result).successRepresentations;

    expect(representation).toMatchObject({
      schema: {
        $defs: {
          component_Project: { type: "object" },
          Project: { type: "string" },
        },
        allOf: [
          { $ref: "#/$defs/Project" },
          { $ref: "#/$defs/component_Project" },
        ],
      },
    });
  });

  it.each([
    [
      "request",
      {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/$defs/Project" },
            },
          },
        },
      },
    ],
    [
      "success",
      {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/$defs/Project" },
              },
            },
          },
        },
      },
    ],
  ])("rejects a dangling local definition despite a same-named component in %s", (_name, operation) => {
    expect(() => compileRelease(makeCompileInput({ operation }))).toThrow(
      "dangling_local_reference"
    );
  });

  it("rejects resource-scoped request schemas at compilation", () => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $id: "urn:example:resource", type: "object" },
                },
              },
            },
          },
        })
      )
    ).toThrow("unsupported_schema_keyword");
  });

  it("closes escaped local and component definition pointers", () => {
    const input = makeCompileInput({
      operation: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  $defs: { "A/B": { type: "string" } },
                  allOf: [
                    { $ref: "#/$defs/A~1B" },
                    { $ref: "#/components/schemas/A~1B" },
                  ],
                },
              },
            },
          },
        },
      },
    });
    const aggregate = input.aggregate as {
      components: { schemas: Record<string, unknown> };
    };
    aggregate.components.schemas["A/B"] = { type: "number" };

    expect(
      capability(compileRelease(input)).successRepresentations
    ).toMatchObject([
      {
        schema: {
          $defs: {
            "A/B": { type: "string" },
            component_A_B: { type: "number" },
          },
          allOf: [{ $ref: "#/$defs/A~1B" }, { $ref: "#/$defs/component_A_B" }],
        },
      },
    ]);
  });

  it.each([
    ["leading zero", "0200"],
    ["exponent", "2e2"],
    ["leading space", " 200"],
    ["trailing space", "200 "],
    ["trailing LF", "200\n"],
    ["trailing CR", "200\r"],
    ["trailing line separator", "200\u2028"],
    ["trailing paragraph separator", "200\u2029"],
  ])("rejects non-canonical success status key with %s", (_name, status) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            responses: {
              [status]: {
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        })
      )
    ).toThrow("invalid_success_status");
  });

  it("does not rewrite reference-shaped JSON literals while aliasing advertised schemas", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    $defs: { Value: { type: "string" } },
                    const: { $ref: "#/$defs/Value" },
                    default: { $ref: "#/$defs/Value" },
                    enum: [{ $ref: "#/$defs/Value" }],
                    examples: [{ $ref: "#/$defs/Value" }],
                    properties: { value: { $ref: "#/$defs/Value" } },
                    type: "object",
                  },
                },
              },
            },
          },
        },
      })
    );
    const output = capability(result).outputSchema as {
      oneOf: Array<{
        properties: {
          data: {
            const: unknown;
            default: unknown;
            enum: unknown;
            examples: unknown;
          };
        };
      }>;
    };
    const branch = output.oneOf.at(0);
    if (branch === undefined) {
      throw new Error("missing advertised literal branch");
    }

    expect(branch.properties.data).toMatchObject({
      const: { $ref: "#/$defs/Value" },
      default: { $ref: "#/$defs/Value" },
      enum: [{ $ref: "#/$defs/Value" }],
      examples: [{ $ref: "#/$defs/Value" }],
    });
  });

  it("rejects a required reserved OpenAPI header parameter", () => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [
              {
                in: "header",
                name: "Content-Type",
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        })
      )
    ).toThrow("forbidden_header_parameter");
  });

  it.each([
    "Content-Type",
    "X-Photon-Version",
    "Proxy-Authorization",
    "X-Api-Key",
  ])("leaves the optional reserved header %s out of the tool", (name) => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          parameters: [{ in: "header", name, schema: { type: "string" } }],
        },
      })
    );
    expect(JSON.stringify(capability(result).inputSchema)).not.toContain(name);
  });

  it("ignores non-JSON request alternatives when JSON is available", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          requestBody: {
            content: {
              "application/json": { schema: { type: "object" } },
              "application/x-protobuf": {
                schema: { format: "binary", type: "string" },
              },
            },
          },
        },
      })
    );
    expect(capability(result)).toMatchObject({
      requestMediaType: "application/json",
    });
  });

  it("rejects unsupported request media at compilation", () => {
    const mediaType = "application/*+json";
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            requestBody: {
              content: { [mediaType]: { schema: { type: "object" } } },
            },
          },
        })
      )
    ).toThrow("unsupported_request_media_type");
  });

  it("ignores non-JSON success alternatives when JSON is available", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": { schema: { type: "object" } },
                "application/x-protobuf": {
                  schema: { format: "binary", type: "string" },
                },
              },
            },
          },
        },
      })
    );
    expect(capability(result).successRepresentations).toEqual([
      expect.objectContaining({ mediaType: "application/json", status: 200 }),
    ]);
  });

  it("rejects unsupported success media at compilation", () => {
    const mediaType = "application/*+json";
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            responses: {
              "200": {
                content: { [mediaType]: { schema: { type: "object" } } },
              },
            },
          },
        })
      )
    ).toThrow("unsupported_response_media_type");
  });

  it("normalizes ASCII-uppercase JSON media types", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          requestBody: {
            content: {
              "Application/VND.Photon+JSON": { schema: { type: "object" } },
            },
          },
          responses: {
            "200": {
              content: {
                "Application/VND.Photon+JSON": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      })
    );

    expect(capability(result)).toMatchObject({
      requestMediaType: "application/vnd.photon+json",
      successRepresentations: [
        { mediaType: "application/vnd.photon+json", status: 200 },
      ],
    });
  });

  it("builds a status-discriminated JSON success schema", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: { "application/json": { schema: { type: "string" } } },
            },
            "202": {
              content: { "application/json": { schema: { type: "number" } } },
            },
            "204": { description: "No content" },
          },
        },
      })
    );

    expect(capability(result).outputSchema).toMatchObject({
      oneOf: [
        {
          properties: { data: { type: "string" }, status: { const: 200 } },
          required: ["status", "data"],
        },
        {
          properties: { data: { type: "number" }, status: { const: 202 } },
          required: ["status", "data"],
        },
        { properties: { status: { const: 204 } }, required: ["status"] },
      ],
      type: "object",
    });
  });

  it("uses anyOf for multiple JSON representations of one status", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": { schema: { type: "string" } },
                "application/vnd.photon+json": { schema: { type: "string" } },
              },
            },
          },
        },
      })
    );
    const output = capability(result).outputSchema as {
      oneOf: Array<{ properties: { data: unknown } }>;
    };

    expect(output.oneOf.at(0)?.properties.data).toEqual({
      anyOf: [{ type: "string" }, { type: "string" }],
    });
    expect(capability(result).successRepresentations).toEqual([
      {
        mediaType: "application/json",
        schema: { type: "string" },
        status: 200,
      },
      {
        mediaType: "application/vnd.photon+json",
        schema: { type: "string" },
        status: 200,
      },
    ]);
  });

  it("selects the UTF-8-lowest normalized request media type for identical schemas", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          requestBody: {
            content: {
              "Application/Z+JSON": {
                schema: {
                  properties: { name: { type: "string" } },
                  type: "object",
                },
              },
              "application/a+json": {
                schema: {
                  properties: { name: { type: "string" } },
                  type: "object",
                },
              },
            },
          },
        },
      })
    );

    expect(capability(result)).toMatchObject({
      requestMediaType: "application/a+json",
    });
  });

  it("rejects inconsistent request media schemas", () => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            requestBody: {
              content: {
                "application/json": { schema: { type: "string" } },
                "application/vnd.photon+json": { schema: { type: "number" } },
              },
            },
          },
        })
      )
    ).toThrow("inconsistent_request_media_schemas");
  });

  it("preserves every ordered success representation", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          responses: {
            "200": {
              content: {
                "application/json": { schema: { type: "number" } },
                "application/vnd.photon+json": { schema: { type: "string" } },
              },
            },
            "202": {
              content: { "application/json": { schema: { type: "boolean" } } },
            },
            "204": { description: "No content" },
          },
        },
      })
    );
    const item = capability(result) as typeof capability extends (
      ...args: never
    ) => infer Item
      ? Item & { successRepresentations: unknown }
      : never;

    expect(item.successRepresentations).toEqual([
      {
        mediaType: "application/json",
        schema: { type: "number" },
        status: 200,
      },
      {
        mediaType: "application/vnd.photon+json",
        schema: { type: "string" },
        status: 200,
      },
      {
        mediaType: "application/json",
        schema: { type: "boolean" },
        status: 202,
      },
      { status: 204 },
    ]);
    expect(item.outputSchema).toMatchObject({
      oneOf: [
        {
          properties: {
            data: { anyOf: [{ type: "number" }, { type: "string" }] },
            status: { const: 200 },
          },
        },
        {
          properties: {
            data: { type: "boolean" },
            status: { const: 202 },
          },
        },
        { properties: { status: { const: 204 } } },
      ],
    });
  });

  it("rejects conflicting normalized success representations", () => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            responses: {
              "200": {
                content: {
                  "application/json": { schema: { type: "string" } },
                  "application/json; charset=utf-8": {
                    schema: { type: "number" },
                  },
                },
              },
            },
          },
        })
      )
    ).toThrow("conflicting_success_representation");
  });

  it.each([
    [
      "multipart",
      {
        requestBody: {
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
      },
    ],
    [
      "binary",
      {
        responses: {
          "200": {
            content: {
              "application/octet-stream": {
                schema: { format: "binary", type: "string" },
              },
            },
          },
        },
      },
    ],
    [
      "stream",
      {
        responses: {
          "200": {
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    ],
  ])("rejects admitted %s transport", (_name, operation) => {
    expect(() => compileRelease(makeCompileInput({ operation }))).toThrow();
  });

  it("derives annotations, permissions, and stable descriptions", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          description: "Returns a project by identifier.",
          summary: "Get project",
          "x-photon-mcp": {
            destructive: false,
            idempotent: true,
            readOnly: true,
          },
          "x-required-permissions": ["projects:read", "projects:write"],
        },
      })
    );
    const item = capability(result);

    expect(item.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(item.requiredPermissions).toEqual([
      "projects:read",
      "projects:write",
    ]);
    expect(item).not.toHaveProperty("confirmation");
    expect(result.tools).toEqual([
      {
        description: "Get project\n\nReturns a project by identifier.",
        name: "getProject",
        title: "Get project",
      },
    ]);
  });

  it("titles a tool by its operation ID when it has no summary", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          description: "Returns a project by identifier.",
          summary: "",
        },
      })
    );
    expect(result.tools).toEqual([
      {
        description: "Returns a project by identifier.",
        name: "getProject",
        title: "getProject",
      },
    ]);
  });

  it.each([
    "options",
    "trace",
    "connect",
  ])("fails admitted unsupported %s methods", (method) => {
    const input = makeCompileInput();
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    paths["/projects/{projectId}"] = {
      [method]: {
        operationId: "unsupportedMethod",
        responses: {
          "204": { description: "No content" },
        },
      },
    };

    expect(() => compileRelease(input)).toThrowError("unsupported_http_method");
  });

  it("skips producer-disabled unsupported methods and transports", () => {
    const input = makeCompileInput();
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    paths["/projects/{projectId}"] = {
      options: {
        operationId: "disabledOptions",
        responses: {
          "204": { description: "No content" },
        },
        "x-photon-mcp": { enabled: false },
      },
      post: {
        operationId: "disabledMultipart",
        requestBody: {
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: {
          "204": { description: "No content" },
        },
        "x-photon-mcp": { enabled: false },
      },
    };

    expect(compileRelease(input).registry).toEqual([]);
  });

  it.each([
    [
      "binary-only success",
      {
        "200": {
          content: {
            "application/octet-stream": {
              schema: { format: "binary", type: "string" },
            },
          },
        },
      },
    ],
    [
      "problem-only success",
      {
        "200": {
          content: {
            "application/problem+json": { schema: { type: "object" } },
          },
        },
      },
    ],
  ])("rejects %s response declarations", (_name, responses) => {
    expect(() =>
      compileRelease(makeCompileInput({ operation: { responses } }))
    ).toThrow();
  });

  it.each([
    [
      "input",
      {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: { accessToken: { type: "string" } },
                type: "object",
              },
            },
          },
        },
      },
    ],
    [
      "output",
      {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  properties: { signingSecret: { type: "string" } },
                  type: "object",
                },
              },
            },
          },
        },
      },
    ],
  ])("preserves producer-admitted %s fields without name-based screening", (name, operation) => {
    const compiled = capability(
      compileRelease(makeCompileInput({ operation }))
    );
    if (name === "input") {
      expect(compiled.inputSchema).toMatchObject({
        properties: {
          body: { properties: { accessToken: { type: "string" } } },
        },
      });
    } else {
      expect(compiled.successRepresentations).toMatchObject([
        { schema: { properties: { signingSecret: { type: "string" } } } },
      ]);
    }
  });

  it("preserves pagination and identifier parameters unless the producer disables the operation", () => {
    const input = makeCompileInput({
      operation: {
        parameters: [
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { type: "string" },
          },
          { in: "query", name: "pageToken", schema: { type: "string" } },
          { in: "query", name: "apiKeyId", schema: { type: "string" } },
        ],
      },
    });
    expect(capability(compileRelease(input)).inputSchema).toMatchObject({
      properties: {
        query: {
          properties: {
            apiKeyId: { type: "string" },
            pageToken: { type: "string" },
          },
        },
      },
    });
    const operation = input.aggregate.paths["/projects/{projectId}"].get;
    if (!operation) {
      throw new Error("missing fixture operation");
    }
    operation["x-photon-mcp"] = {
      enabled: false,
    };
    expect(compileRelease(input).registry).toEqual([]);
  });

  it("requires query and header partitions with required parameters", () => {
    const result = compileRelease(
      makeCompileInput({
        operation: {
          parameters: [
            {
              in: "path",
              name: "projectId",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "query",
              name: "cursor",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "header",
              name: "If-Match",
              required: true,
              schema: { type: "string" },
            },
          ],
        },
      })
    );
    const schema = capability(result).inputSchema as { required: string[] };

    expect(schema.required).toEqual(["path", "query", "headers"]);
  });

  it("adds continuation and polling facts for an Operation response Link", () => {
    const input = makeCompileInput({ method: "post" });
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    paths["/projects/{projectId}"] = {
      post: {
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
    };
    paths["/projects/{projectId}/operations/{operationId}"] = {
      get: {
        operationId: "readOperation",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  properties: { state: { type: "string" } },
                  type: "object",
                },
              },
            },
          },
        },
        "x-photon-mcp": { enabled: false },
      },
    };

    const item = capability(compileRelease(input), "startOperation") as {
      readonly inputSchema: Readonly<Record<string, unknown>>;
      readonly operationGetter?: string;
      readonly operationPollLimit?: number;
    };
    const inputSchema = item.inputSchema as {
      oneOf: readonly Readonly<Record<string, unknown>>[];
    };

    expect(item.operationGetter).toBe("readOperation");
    expect(item.operationPollLimit).toBe(3);
    expect(inputSchema.oneOf).toContainEqual({
      additionalProperties: false,
      properties: { continuation: { minLength: 1, type: "string" } },
      required: ["continuation"],
      type: "object",
    });
    expect(
      compileRelease(input).registry.map((entry) => entry.operationId)
    ).toEqual(["startOperation"]);
    expect(
      compileRelease(input).privateCapabilities.map(
        (entry) => entry.operationId
      )
    ).toEqual(["readOperation"]);
    expect(compileRelease(input).tools.map((entry) => entry.name)).toEqual([
      "startOperation",
    ]);
    paths["/projects/{projectId}/second"] = {
      post: {
        ...(paths["/projects/{projectId}"].post as Record<string, unknown>),
        operationId: "startSecondOperation",
      },
    };
    const shared = compileRelease(input);
    expect(
      shared.privateCapabilities.map((entry) => entry.operationId)
    ).toEqual(["readOperation"]);

    const getter = paths["/projects/{projectId}/operations/{operationId}"]
      .get as Record<string, unknown>;
    getter["x-photon-mcp"] = { enabled: true };
    const withPublicGetter = compileRelease(input);
    expect(withPublicGetter.registry.map((entry) => entry.operationId)).toEqual(
      ["readOperation", "startOperation", "startSecondOperation"]
    );
    expect(withPublicGetter.privateCapabilities).toEqual([]);
  });

  it("builds the immutable auth vocabulary from admitted and disabled producer declarations", () => {
    const input = makeCompileInput({
      operation: { "x-required-permissions": ["projects:read"] },
    });
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    paths["/disabled"] = {
      get: {
        operationId: "disabledScopeSource",
        responses: {
          "200": {
            content: {
              "application/json": { schema: { type: "object" } },
            },
          },
        },
        "x-photon-mcp": { enabled: false },
        "x-required-permissions": ["accounts:registered"],
      },
    };

    expect(compileRelease(input).authPermissions).toEqual([
      "accounts:registered",
      "projects:read",
    ]);
  });

  it("rejects enabled and disabled source operations sharing an operationId", () => {
    const input = makeCompileInput();
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    const projectPath = paths["/projects/{projectId}"] as Record<
      string,
      unknown
    >;
    const operation = projectPath.get as Record<string, unknown>;
    paths["/duplicate"] = {
      post: { ...operation, "x-photon-mcp": { enabled: false } },
    };

    expect(() => compileRelease(input)).toThrowError("duplicate_operation_id");
  });

  it("rejects two disabled source operations sharing an operationId", () => {
    const input = makeCompileInput();
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    const projectPath = paths["/projects/{projectId}"] as Record<
      string,
      unknown
    >;
    const operation = projectPath.get as Record<string, unknown>;
    operation["x-photon-mcp"] = { enabled: false };
    paths["/duplicate"] = {
      post: { ...operation },
    };

    expect(() => compileRelease(input)).toThrowError("duplicate_operation_id");
  });

  it("rejects a public and private gateway route sharing an operationId", () => {
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
    const response = {
      "200": {
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
    };
    paths["/projects/{projectId}/operations/{operationId}"] = {
      get: {
        operationId: "readOperation",
        responses: response,
        "x-photon-mcp": { enabled: false },
      },
    };
    paths["/public-operation"] = {
      get: { operationId: "readOperation", responses: response },
    };

    expect(() => compileRelease(input)).toThrowError("duplicate_operation_id");
  });

  it.each([
    [
      "range only",
      {
        "2XX": {
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
    ],
    [
      "range and concrete",
      {
        "2XX": {
          content: { "application/json": { schema: { type: "object" } } },
        },
        "200": {
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
    ],
  ])("rejects %s success response ranges", (_name, responses) => {
    expect(() =>
      compileRelease(makeCompileInput({ operation: { responses } }))
    ).toThrowError("unsupported_success_status_range");
  });

  it.each([
    ["required", "not-an-array"],
    ["enum", "not-an-array"],
    ["format", 42],
    ["minimum", "zero"],
    ["default", () => "not-json"],
  ])("rejects malformed %s schema values", (key, value) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    properties: { value: { [key]: value, type: "string" } },
                    type: "object",
                  },
                },
              },
            },
          },
        })
      )
    ).toThrow();
  });

  it.each([
    ["duplicate enum", { enum: ["one", "one"], type: "string" }],
    [
      "duplicate enum object with reordered keys",
      {
        enum: [{ a: 1, b: 2 }, reorderedEnumObject],
        type: "object",
      },
    ],
    ["duplicate type", { type: ["string", "string"] }],
    [
      "duplicate dependent required",
      { dependentRequired: { account: ["id", "id"] }, type: "object" },
    ],
    ["non-finite default", { default: Number.NaN, type: "number" }],
    ["non-finite const", { const: Number.POSITIVE_INFINITY, type: "number" }],
  ])("rejects %s schema values", (_name, schema) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            requestBody: {
              content: { "application/json": { schema } },
            },
          },
        })
      )
    ).toThrow();
  });

  it("sorts multiple operation names by UTF-8 bytes and leaves missing permissions empty", () => {
    const input = makeCompileInput();
    const paths = input.aggregate.paths as Record<
      string,
      Record<string, unknown>
    >;
    paths["/a"] = {
      get: {
        operationId: "éclair",
        responses: { "204": { description: "No content" } },
      },
    };
    paths["/b"] = {
      get: {
        operationId: "zebra",
        responses: { "204": { description: "No content" } },
      },
    };

    const result = compileRelease(input);
    expect(result.registry.map((item) => item.operationId)).toEqual([
      "getProject",
      "zebra",
      "éclair",
    ]);
    expect(capability(result, "zebra").requiredPermissions).toEqual([]);
  });
});

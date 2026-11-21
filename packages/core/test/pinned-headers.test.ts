import { describe, expect, it } from "vitest";
import { compileRelease } from "../src/compiler/compile.js";
import { makeCompileInput } from "./fixtures.js";

describe("pinned headers", () => {
  const contractHeader = {
    in: "header",
    name: "X-Contract",
    required: true,
    schema: { $ref: "#/components/schemas/Contract" },
  };

  function pinnedInput(
    pinnedHeaders: Record<string, string>,
    parameters: readonly unknown[],
    pathParameters?: readonly unknown[]
  ) {
    const input = makeCompileInput({ operation: { parameters } });
    const key = "/projects/{projectId}";
    return {
      ...input,
      aggregate: {
        ...input.aggregate,
        components: {
          schemas: {
            ...input.aggregate.components.schemas,
            Contract: { enum: ["v1"], type: "string" },
          },
        },
        paths: {
          [key]: {
            ...input.aggregate.paths[key],
            ...(pathParameters === undefined
              ? {}
              : { parameters: pathParameters }),
          },
        } as Record<string, Record<string, unknown>>,
      },
      compilerPolicy: { ...input.compilerPolicy, pinnedHeaders },
    };
  }

  it.each([
    ["an operation", [contractHeader], undefined],
    ["a path item", [], [contractHeader]],
  ])("takes a required header declared by %s out of tool input", (_level, parameters, pathParameters) => {
    const result = compileRelease(
      pinnedInput({ "X-Contract": "v1" }, parameters, pathParameters)
    );

    expect(result.pinnedHeaders).toEqual({ "x-contract": "v1" });
    // Without the pin, the required header makes `headers` required.
    expect(result.registry[0]?.inputSchema).not.toHaveProperty(
      "properties.headers"
    );
    expect(result.registry[0]?.inputSchema).not.toHaveProperty("required");
  });

  it("ignores declarations on operations it does not compile", () => {
    const input = pinnedInput({ "x-contract": "v1" }, [contractHeader]);
    input.aggregate.paths["/disabled"] = {
      post: {
        operationId: "disabledWrite",
        parameters: [{ ...contractHeader, schema: { const: "v2" } }],
        responses: { "204": { description: "No content" } },
        "x-photon-mcp": { enabled: false },
      },
    };

    expect(
      compileRelease(input).registry.map(({ operationId }) => operationId)
    ).toEqual(["getProject"]);
  });

  it.each([
    ["2", { type: "integer" }],
    ["true", { type: "boolean" }],
  ])("accepts pin %s when the scalar it serializes satisfies %j", (value, schema) => {
    const input = pinnedInput({ "x-contract": value }, [
      { ...contractHeader, schema },
    ]);

    expect(compileRelease(input).pinnedHeaders).toEqual({
      "x-contract": value,
    });
  });

  it.each([
    ["v2", { $ref: "#/components/schemas/Contract" }],
    ["02", { type: "integer" }],
  ])("rejects pin %s that %j does not allow", (value, schema) => {
    const input = pinnedInput({ "x-contract": value }, [
      { ...contractHeader, schema },
    ]);

    expect(() => compileRelease(input)).toThrow(
      `pinned_header_rejected_by_operation: getProject: X-Contract="${value}"`
    );
  });

  it.each([
    { Authorization: "v1" },
    { connection: "close" },
    { "X-Bad Name": "v1" },
    { "X-Contract": "v1", "x-contract": "v1" },
    { "x-contract": "v1\r\nv2" },
    { "x-contract": "" },
  ])("rejects the pin map %j", (pins) => {
    expect(() => compileRelease(pinnedInput(pins, [contractHeader]))).toThrow(
      "invalid_pinned_header"
    );
  });

  it.each([
    [
      "declared twice",
      pinnedInput(
        { "x-contract": "v1" },
        [{ ...contractHeader, name: "x-contract" }],
        [contractHeader]
      ),
      "duplicate_parameter",
    ],
    [
      "declared without a schema",
      pinnedInput({ "x-contract": "v1" }, [
        { in: "header", name: "X-Contract" },
      ]),
      "missing_parameter_schema",
    ],
    [
      "never declared",
      pinnedInput({ "x-contract": "v1", "x-other": "v1" }, [contractHeader]),
      "pinned_header_not_declared: x-other",
    ],
  ])("rejects a pinned header %s", (_case, input, error) => {
    expect(() => compileRelease(input)).toThrow(error);
  });
});

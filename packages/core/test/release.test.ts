import { describe, expect, it } from "vitest";
import { normalizeJsonMediaType, parseRelease } from "../src/release.js";
import { assertClosedSchema, closeSchema } from "../src/schema.js";
import { makeReleaseFixture } from "./fixtures.js";

const invalidJsonMediaTypes = [
  ["suffix wildcard", "application/*+json"],
  ["trailing wildcard", "application/json*"],
  ["Unicode lookalike", "application/K+json"],
  ["trailing LF", "application/json\n"],
  ["trailing CR", "application/json\r"],
  ["trailing line separator", "application/json\u2028"],
  ["trailing paragraph separator", "application/json\u2029"],
  ["parameter trailing LF", "application/json; charset=utf-8\n"],
  ["parameter trailing CR", "application/json; charset=utf-8\r"],
  [
    "parameter trailing line separator",
    "application/json; charset=utf-8\u2028",
  ],
  [
    "parameter trailing paragraph separator",
    "application/json; charset=utf-8\u2029",
  ],
] as const;

describe("normalizeJsonMediaType", () => {
  it.each(invalidJsonMediaTypes)("rejects %s", (_name, mediaType) => {
    expect(normalizeJsonMediaType(mediaType)).toBeUndefined();
  });

  it("preserves commas in media type parameters", () => {
    expect(normalizeJsonMediaType('application/json; profile="a,b"')).toBe(
      "application/json"
    );
  });
});

function arrayWithExtraProperty<T>(values: T[]): T[] {
  Object.defineProperty(values, "extra", { enumerable: true, value: true });
  return values;
}

function arrayWithForeignPrototype<T>(values: T[]): T[] {
  Object.setPrototypeOf(values, null);
  return values;
}

function sparseArray(): unknown[] {
  const values: unknown[] = [];
  values.length = 1;
  return values;
}

describe("parseRelease", () => {
  it("returns a complete release document", () => {
    const release = makeReleaseFixture();

    expect(parseRelease(release)).toEqual(release);
  });

  const valid = makeReleaseFixture();
  const [capability] = valid.registry;

  if (!capability) {
    throw new Error("release fixture must include a capability");
  }

  const invalidCases = [
    ["wrong schema", { ...valid, schemaVersion: 2 }],
    ["wrong admission", { ...valid, admissionModel: "blacklist" }],
    [
      "lowercase method",
      { ...valid, registry: [{ ...capability, method: "get" }] },
    ],
    ["duplicate operation", { ...valid, registry: [capability, capability] }],
    [
      "getter without polling limit",
      {
        ...valid,
        registry: [{ ...capability, operationGetter: "readOperation" }],
      },
    ],
    [
      "polling limit without getter",
      { ...valid, registry: [{ ...capability, operationPollLimit: 3 }] },
    ],
  ] as const;

  it.each(invalidCases)("rejects %s", (_name, value) => {
    expect(() => parseRelease(value)).toThrow();
  });

  it("rejects unknown document fields", () => {
    expect(() => parseRelease({ ...valid, extra: true })).toThrow();
  });

  it.each([
    "input",
    "output",
    "success",
  ])("rejects an own __proto__ keyword in a raw %s schema", (location) => {
    const rawRelease = JSON.parse(JSON.stringify(valid)) as {
      registry: Record<string, unknown>[];
    };
    const [rawCapability] = rawRelease.registry;
    const invalidSchema = JSON.parse('{"__proto__":true}') as Record<
      string,
      unknown
    >;

    if (!rawCapability) {
      throw new Error("release fixture must include a capability");
    }

    if (location === "input") {
      rawCapability.inputSchema = invalidSchema;
    } else if (location === "output") {
      rawCapability.outputSchema = invalidSchema;
    } else {
      rawCapability.successRepresentations = [
        {
          mediaType: "application/json",
          schema: invalidSchema,
          status: 200,
        },
      ];
    }

    expect(() => parseRelease(rawRelease)).toThrow(
      "unsupported_schema_keyword"
    );
  });

  it("preserves legal own __proto__ property and definition names from raw JSON", () => {
    const rawRelease = JSON.parse(JSON.stringify(valid)) as {
      registry: Record<string, unknown>[];
    };
    const [rawCapability] = rawRelease.registry;

    if (!rawCapability) {
      throw new Error("release fixture must include a capability");
    }

    rawCapability.inputSchema = JSON.parse(
      '{"additionalProperties":false,"properties":{"__proto__":{"type":"string"}},"type":"object"}'
    );
    rawCapability.outputSchema = JSON.parse(
      '{"$defs":{"__proto__":{"type":"string"}},"$ref":"#/$defs/__proto__"}'
    );

    const release = parseRelease(rawRelease);
    const [parsedCapability] = release.registry;
    const properties = parsedCapability?.inputSchema.properties as Record<
      string,
      unknown
    >;
    const definitions = parsedCapability?.outputSchema.$defs as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(Object.hasOwn(definitions, "__proto__")).toBe(true);
  });

  it.each([
    [
      "request media without a body",
      { ...capability, requestMediaType: "application/json" },
    ],
    [
      "body without request media",
      {
        ...capability,
        inputSchema: {
          additionalProperties: false,
          properties: {
            body: { additionalProperties: false, type: "object" },
          },
          type: "object",
        },
      },
    ],
    [
      "2xx status range",
      {
        ...capability,
        successRepresentations: [
          {
            mediaType: "application/json",
            schema: { additionalProperties: false, type: "object" },
            status: "2XX",
          },
        ],
      },
    ],
    [
      "malformed status",
      {
        ...capability,
        successRepresentations: [
          {
            mediaType: "application/json",
            schema: { additionalProperties: false, type: "object" },
            status: 200.5,
          },
        ],
      },
    ],
    [
      "204 carrying fields",
      { ...capability, successRepresentations: [{ schema: {}, status: 204 }] },
    ],
    [
      "non-204 missing fields",
      { ...capability, successRepresentations: [{ status: 200 }] },
    ],
    [
      "duplicate representations",
      {
        ...capability,
        successRepresentations: [{ status: 204 }, { status: 204 }],
      },
    ],
    [
      "wrong representation order",
      {
        ...capability,
        successRepresentations: [
          { status: 204 },
          { mediaType: "application/json", schema: {}, status: 200 },
        ],
      },
    ],
  ])("rejects %s", (_name, invalidCapability) => {
    expect(() =>
      parseRelease({ ...valid, registry: [invalidCapability] })
    ).toThrow();
  });

  it("rejects unsupported request media in a release", () => {
    const mediaType = "application/*+json";
    const bodyCapability = {
      ...capability,
      inputSchema: {
        additionalProperties: false,
        properties: {
          body: { additionalProperties: false, type: "object" },
        },
        type: "object",
      },
      requestMediaType: mediaType,
    };

    expect(() =>
      parseRelease({ ...valid, registry: [bodyCapability] })
    ).toThrow();
  });

  it("rejects unsupported success media in a release", () => {
    const mediaType = "application/*+json";
    const bodyCapability = {
      ...capability,
      successRepresentations: [
        { mediaType, schema: { type: "string" }, status: 200 },
      ],
    };

    expect(() =>
      parseRelease({ ...valid, registry: [bodyCapability] })
    ).toThrow();
  });

  it("normalizes ASCII-uppercase request and success media", () => {
    const release = parseRelease({
      ...valid,
      registry: [
        {
          ...capability,
          inputSchema: {
            additionalProperties: false,
            properties: {
              body: { additionalProperties: false, type: "object" },
            },
            type: "object",
          },
          requestMediaType: "Application/VND.Photon+JSON",
          successRepresentations: [
            {
              mediaType: "Application/VND.Photon+JSON",
              schema: { additionalProperties: false, type: "object" },
              status: 200,
            },
          ],
        },
      ],
    });

    expect(release.registry[0]).toMatchObject({
      requestMediaType: "application/vnd.photon+json",
      successRepresentations: [
        { mediaType: "application/vnd.photon+json", status: 200 },
      ],
    });
  });

  it("rejects same-status success media in reverse normalized UTF-8 order", () => {
    expect(() =>
      parseRelease({
        ...valid,
        registry: [
          {
            ...capability,
            successRepresentations: [
              {
                mediaType: "application/z+json",
                schema: { type: "string" },
                status: 200,
              },
              {
                mediaType: "application/json",
                schema: { type: "string" },
                status: 200,
              },
            ],
          },
        ],
      })
    ).toThrow("unordered success representations");
  });

  it("rejects success media that collide after normalization", () => {
    expect(() =>
      parseRelease({
        ...valid,
        registry: [
          {
            ...capability,
            successRepresentations: [
              {
                mediaType: "Application/JSON",
                schema: { type: "string" },
                status: 200,
              },
              {
                mediaType: "application/json",
                schema: { type: "string" },
                status: 200,
              },
            ],
          },
        ],
      })
    ).toThrow("duplicate success representation");
  });

  it.each([
    "$anchor",
    "$dynamicAnchor",
    "$dynamicRef",
    "$id",
  ])("rejects resource scope keyword %s in release schemas", (keyword) => {
    expect(() =>
      parseRelease({
        ...valid,
        registry: [
          {
            ...capability,
            inputSchema: {
              [keyword]: "urn:example:resource",
              additionalProperties: false,
              type: "object",
            },
          },
        ],
      })
    ).toThrow();
  });

  it.each([
    ["implicit object shape", { type: "object" }],
    ["component reference", { $ref: "#/components/schemas/Project" }],
    ["external reference", { $ref: "https://example.test/schema" }],
  ])("rejects a schema that is not already closed: %s", (_name, inputSchema) => {
    expect(() =>
      parseRelease({ ...valid, registry: [{ ...capability, inputSchema }] })
    ).toThrow();
  });

  it.each([
    ["invalid type", { type: 42 }],
    [
      "invalid required",
      { additionalProperties: false, required: "id", type: "object" },
    ],
    ["invalid enum", { enum: [] }],
    ["invalid numeric keyword", { maxLength: -1, type: "string" }],
    ["non-JSON instance value", { const: new Date(0) }],
  ])("rejects a closed schema with %s", (_name, inputSchema) => {
    expect(() =>
      parseRelease({ ...valid, registry: [{ ...capability, inputSchema }] })
    ).toThrow();
  });

  it("closes and round-trips a nullable object schema", () => {
    const inputSchema = closeSchema({ type: ["object", "null"] }, undefined);

    expect(inputSchema).toMatchObject({ additionalProperties: false });
    expect(() => assertClosedSchema(inputSchema)).not.toThrow();
    expect(() =>
      parseRelease({ ...valid, registry: [{ ...capability, inputSchema }] })
    ).not.toThrow();
  });

  it.each([
    "oneOf",
    "anyOf",
  ])("preserves %s branches while converting discriminator hints", (union) => {
    const closed = closeSchema(
      {
        description: "Brand profile.",
        discriminator: {
          mapping: { organization: "#/components/schemas/Organization" },
          propertyName: "type",
        },
        [union]: [
          { $ref: "#/components/schemas/Organization" },
          { const: { type: "sole_proprietor" } },
        ],
      },
      { schemas: { Organization: { const: { type: "organization" } } } }
    );

    expect(closed).toMatchObject({
      $defs: { Organization: { const: { type: "organization" } } },
      [union]: [
        { $ref: "#/$defs/Organization" },
        { const: { type: "sole_proprietor" } },
      ],
    });
    expect(closed).not.toHaveProperty("discriminator");
    expect(closed.description).toContain("Brand profile.");
    expect(closed.description).toContain("type");
    expect(closed.description).toContain("organization");
    expect(() => assertClosedSchema(closed)).not.toThrow();
  });

  it("retains enum constraints and instance literals while converting nested enum descriptions", () => {
    const literal = {
      discriminator: { propertyName: "literal" },
      "x-enumDescriptions": { active: "Ordinary JSON data" },
    };
    const closed = closeSchema(
      {
        properties: {
          payload: {
            const: literal,
            default: literal,
            enum: [literal],
            examples: [literal],
          },
          status: {
            description: "Subscription status.",
            enum: ["active", "past_due"],
            type: "string",
            "x-enumDescriptions": {
              active: "Subscribed and in good standing.",
              past_due: "The payer has an overdue invoice.",
            },
          },
        },
        type: "object",
      },
      undefined
    );

    expect(closed).toMatchObject({
      additionalProperties: false,
      properties: {
        payload: {
          const: literal,
          default: literal,
          enum: [literal],
          examples: [literal],
        },
        status: { enum: ["active", "past_due"], type: "string" },
      },
    });
    const { status } = closed.properties as { status: Record<string, unknown> };
    expect(status).not.toHaveProperty("x-enumDescriptions");
    expect(status.description).toContain("Subscription status.");
    expect(status.description).toContain("active");
    expect(status.description).toContain("Subscribed and in good standing.");
    expect(status.description).toContain("The payer has an overdue invoice.");
    expect(() => assertClosedSchema(closed)).not.toThrow();
  });

  it("does not discard unknown validation keywords alongside OpenAPI annotations", () => {
    expect(() =>
      closeSchema(
        {
          enum: ["active"],
          unknownValidation: true,
          "x-enumDescriptions": { active: "Active subscription." },
        },
        undefined
      )
    ).toThrow("unsupported_schema_keyword");
  });

  it("ignores vendor schema metadata without interpreting references or removing instance fields", () => {
    const literal = { "x-photon-extension": { fallback: "ordinary data" } };
    const closed = closeSchema(
      { $ref: "#/components/schemas/Content", "x-display": "content" },
      {
        schemas: {
          Content: {
            properties: {
              payload: {
                const: literal,
                default: literal,
                examples: [literal],
              },
              type: { const: "text", "x-display": { $ref: "#/not-a-schema" } },
              "x-business-field": { type: "string" },
            },
            required: ["type", "x-business-field"],
            type: "object",
            "x-photon-extension": {
              discriminator: "type",
              fallback: "#/$defs/UnknownContent",
              reserved: ["text"],
            },
          },
        },
      }
    );

    expect(closed).toEqual({
      $defs: {
        Content: {
          additionalProperties: false,
          properties: {
            payload: { const: literal, default: literal, examples: [literal] },
            type: { const: "text" },
            "x-business-field": { type: "string" },
          },
          required: ["type", "x-business-field"],
          type: "object",
        },
      },
      $ref: "#/$defs/Content",
    });
  });

  it.each([
    ["patternProperties", { patternProperties: { "^x-": { type: "string" } } }],
    ["required", { required: ["id"] }],
    ["propertyNames", { propertyNames: { type: "string" } }],
    ["minProperties", { minProperties: 1 }],
    ["maxProperties", { maxProperties: 2 }],
    ["dependentRequired", { dependentRequired: { id: ["kind"] } }],
    [
      "dependentSchemas",
      {
        dependentSchemas: {
          kind: { additionalProperties: false, required: ["value"] },
        },
      },
    ],
  ])("closes an object-like schema declared by %s", (_name, schema) => {
    expect(() => assertClosedSchema(schema)).toThrow("schema_not_closed");

    const closed = closeSchema(schema, undefined);

    expect(closed).toEqual({ ...schema, additionalProperties: false });
    expect(() => assertClosedSchema(closed)).not.toThrow();
  });

  it.each([
    ["empty", "", "#/$defs/", "#/$defs/"],
    ["percent", "%", "#/$defs/%25", "#/$defs/%25"],
    ["hash", "#", "#/$defs/%23", "#/$defs/%23"],
    ["space", "A B", "#/$defs/A%20B", "#/$defs/A%20B"],
    ["Unicode", "雪", "#/$defs/%E9%9B%AA", "#/$defs/%E9%9B%AA"],
    ["slash", "A/B", "#/$defs/A~1B", "#/$defs/A~1B"],
    ["tilde", "A~B", "#/$defs/A~0B", "#/$defs/A~0B"],
    ["percent-encoded pointer slash", "/", "#/$defs/%7E1", "#/$defs/~1"],
    ["percent-encoded pointer tilde", "~", "#/$defs/%7E0", "#/$defs/~0"],
  ])("closes and asserts a %s definition URI-fragment token", (_name, definitionName, reference, expectedReference) => {
    const closed = closeSchema(
      {
        $defs: Object.fromEntries([[definitionName, { type: "string" }]]),
        $ref: reference,
      },
      undefined
    );

    expect(closed.$ref).toBe(expectedReference);
    expect(Object.hasOwn(closed.$defs as object, definitionName)).toBe(true);
    expect(() => assertClosedSchema(closed)).not.toThrow();
  });

  it.each([
    "#/$defs/%",
    "#/$defs/%2",
    "#/$defs/%GG",
    "#/$defs/~",
    "#/$defs/~2",
  ])("rejects invalid definition URI-fragment token %s", (reference) => {
    const schema = {
      $defs: { value: { type: "string" } },
      $ref: reference,
    };

    expect(() => closeSchema(schema, undefined)).toThrow(
      "unsupported_local_reference"
    );
    expect(() => assertClosedSchema(schema)).toThrow(
      "unsupported_local_reference"
    );
  });

  it.each([
    ["encoded pointer escape", "/", "#/$defs/%7E1"],
    ["raw Unicode", "雪", "#/$defs/雪"],
    ["lowercase percent hex", "雪", "#/$defs/%e9%9b%aa"],
    ["percent-encoded unreserved character", "A", "#/$defs/%41"],
  ])("rejects a noncanonical %s local reference", (_name, definitionName, reference) => {
    const schema = {
      $defs: Object.fromEntries([[definitionName, { type: "string" }]]),
      $ref: reference,
    };

    expect(() => assertClosedSchema(schema)).toThrow(
      "unsupported_local_reference"
    );
  });

  it.each([
    [
      "type",
      { type: arrayWithExtraProperty(["object"]) },
      "invalid_schema_type",
    ],
    [
      "required",
      {
        additionalProperties: false,
        required: arrayWithExtraProperty(["id"]),
        type: "object",
      },
      "invalid_schema_required",
    ],
    [
      "dependentRequired",
      {
        additionalProperties: false,
        dependentRequired: { id: arrayWithForeignPrototype(["kind"]) },
        type: "object",
      },
      "invalid_dependent_required",
    ],
    [
      "enum",
      { enum: arrayWithExtraProperty(["value"]) },
      "invalid_schema_enum",
    ],
    ["examples", { examples: sparseArray() }, "invalid_schema_examples"],
    [
      "schema array",
      { allOf: arrayWithExtraProperty([{ type: "string" }]) },
      "invalid_schema_array",
    ],
  ])("rejects a malformed %s array", (_name, schema, message) => {
    expect(() => closeSchema(schema, undefined)).toThrow(message);
    expect(() => assertClosedSchema(schema)).toThrow(message);
  });

  it("round-trips every admitted schema array shape", () => {
    const schema = {
      additionalProperties: false,
      dependentRequired: { id: ["kind"] },
      enum: [{ kind: ["example"] }],
      examples: [{ kind: ["sample"] }],
      prefixItems: [{ type: "string" }],
      properties: { id: { oneOf: [{ type: "string" }, { type: "null" }] } },
      required: ["id"],
      type: ["object", "null"],
    };

    const closed = closeSchema(schema, undefined);

    expect(closed).toEqual(schema);
    expect(() => assertClosedSchema(closed)).not.toThrow();
  });

  it("rejects nested $defs consistently when closing and asserting", () => {
    const schema = {
      additionalProperties: false,
      properties: {
        nested: {
          $defs: { value: { type: "string" } },
          type: "string",
        },
      },
      type: "object",
    };

    expect(() => closeSchema(schema, undefined)).toThrow(
      "nested_schema_definitions"
    );
    expect(() => assertClosedSchema(schema)).toThrow(
      "nested_schema_definitions"
    );
  });

  it.each([
    [
      "local",
      {
        $defs: Object.fromEntries([["__proto__", { type: "string" }]]),
        $ref: "#/$defs/__proto__",
      },
      undefined,
    ],
    [
      "component",
      { $ref: "#/components/schemas/__proto__" },
      {
        schemas: Object.fromEntries([["__proto__", { type: "string" }]]),
      },
    ],
  ])("closes a %s definition named __proto__", (_name, schema, components) => {
    const closed = closeSchema(schema, components);
    const definitions = closed.$defs as Readonly<Record<string, unknown>>;

    expect(Object.hasOwn(definitions, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(definitions, "__proto__")?.value
    ).toEqual({ type: "string" });
    expect(closed.$ref).toBe("#/$defs/__proto__");
    expect(() => assertClosedSchema(closed)).not.toThrow();
  });

  it.each([
    ["input", { $ref: "#/$defs/Missing" }],
    ["output", { $ref: "#/components/schemas/Project" }],
    ["success", { $ref: "https://example.test/schema" }],
  ])("rejects a non-closed %s schema", (location, schema) => {
    let invalidCapability: unknown;
    if (location === "input") {
      invalidCapability = { ...capability, inputSchema: schema };
    } else if (location === "output") {
      invalidCapability = { ...capability, outputSchema: schema };
    } else {
      invalidCapability = {
        ...capability,
        successRepresentations: [
          { mediaType: "application/json", schema, status: 200 },
        ],
      };
    }

    expect(() =>
      parseRelease({ ...valid, registry: [invalidCapability] })
    ).toThrow();
  });
});

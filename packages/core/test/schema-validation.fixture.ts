// Fixed compatibility cases shared by Node artifact tests and real workerd.
export const schemaValidationCases = [
  {
    invalid: ["owner"],
    name: "union constraints",
    schema: {
      anyOf: [
        { enum: ["admin", "member"], type: "string" },
        {
          items: { enum: ["admin", "member"], type: "string" },
          minItems: 1,
          type: "array",
        },
      ],
    },
    valid: ["admin"],
  },
  {
    invalid: { children: [{ value: "2" }], value: 1 },
    name: "recursive references",
    schema: {
      $defs: {
        Node: {
          additionalProperties: false,
          properties: {
            children: { items: { $ref: "#/$defs/Node" }, type: "array" },
            value: { type: "integer" },
          },
          required: ["value"],
          type: "object",
        },
      },
      $ref: "#/$defs/Node",
    },
    valid: { children: [{ value: 2 }], value: 1 },
  },
  {
    invalid: "2026-09-05T00:00:00Z",
    name: "date-time precision",
    schema: { format: "date-time", pattern: "\\.\\d{3}Z$", type: "string" },
    valid: "2026-09-05T00:00:00.000Z",
  },
] as const;

import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { reservedHeaderName } from "../headers.js";
import { pinnedHeaderValue } from "../pinned-headers.js";
import type { Capability, ReleaseDocuments } from "../release.js";
import { closeSchema, componentSchema } from "../schema.js";
import type { PathOperation } from "./schema.js";

type JsonObject = Record<string, unknown>;
type ParameterGroup = "headers" | "path" | "query";

// A declared parameter is either tool input or a header the release pins.
type Parameter =
  | Readonly<{
      group: ParameterGroup;
      kind: "input";
      name: string;
      required: boolean;
      schema: JsonObject;
    }>
  | Readonly<{
      group: "headers";
      kind: "pinned";
      name: string;
      schema: unknown;
      value: string;
    }>;

const validator = new CfWorkerJsonSchemaValidator({ draft: "2020-12" });

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, message: string): JsonObject {
  return isObject(value) ? value : fail(message);
}

/** @internal */
export function parameterArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : fail("invalid_openapi_parameters");
}

// Path-level parameters first, then the operation's own.
function operationParameters(pathOperation: PathOperation): readonly unknown[] {
  const { parameters } = pathOperation.operation;
  return [
    ...pathOperation.pathParameters,
    ...(parameters === undefined ? [] : parameterArray(parameters)),
  ];
}

/** @internal Lowercase names of the header parameters an operation declares. */
export function declaredHeaderNames(
  pathOperation: PathOperation
): readonly string[] {
  return operationParameters(pathOperation).flatMap((parameter) =>
    isObject(parameter) &&
    parameter.in === "header" &&
    typeof parameter.name === "string"
      ? [parameter.name.toLowerCase()]
      : []
  );
}

function readParameter(
  value: unknown,
  components: unknown,
  pinnedHeaders: ReleaseDocuments["pinnedHeaders"]
): Parameter | undefined {
  const parameter = object(value, "invalid_openapi_parameter");
  const { in: location, name } = parameter;
  if (location !== "path" && location !== "query" && location !== "header") {
    fail("unsupported_parameter_location");
  }
  if (typeof name !== "string" || !name) {
    fail("invalid_openapi_parameter");
  }
  if (parameter.schema === undefined) {
    fail("missing_parameter_schema");
  }
  const pinned =
    location === "header" ? pinnedHeaderValue(pinnedHeaders, name) : undefined;
  if (pinned !== undefined) {
    return {
      group: "headers",
      kind: "pinned",
      name,
      schema: parameter.schema,
      value: pinned,
    };
  }
  if (location === "path" && parameter.required !== true) {
    fail("path_parameter_not_required");
  }
  if (location === "header" && reservedHeaderName.test(name)) {
    // The runtime would reject it, so an optional one is left out of the tool.
    if (parameter.required === true) {
      fail("forbidden_header_parameter");
    }
    return;
  }
  assertParameterSerialization(parameter, location, components);
  return {
    group: location === "header" ? "headers" : location,
    kind: "input",
    name,
    required: parameter.required === true,
    schema: {
      ...(parameter.description === undefined
        ? {}
        : { description: parameter.description }),
      ...object(parameter.schema, "unsupported_parameter_schema"),
    },
  };
}

// A pin is wire text. Like tool input, it satisfies the declaration when a
// scalar the runtime would serialize to that text does.
function assertPinnedValue(
  operationId: string,
  {
    name,
    schema,
    value,
  }: Readonly<{ name: string; schema: unknown; value: string }>,
  components: unknown
): void {
  const number = Number(value);
  const candidates = [
    value,
    ...(Number.isFinite(number) && String(number) === value ? [number] : []),
    ...(value === "true" || value === "false" ? [value === "true"] : []),
  ];
  const validate = validator.getValidator(
    closeSchema(
      { properties: { header: schema }, required: ["header"], type: "object" },
      components
    )
  );
  if (!candidates.some((header) => validate({ header }).valid)) {
    fail(
      `pinned_header_rejected_by_operation: ${operationId}: ${name}=${JSON.stringify(value)}`
    );
  }
}

// Serialization only depends on the referenced shape; the reference itself is
// kept for the advertised schema.
function parameterNode(value: unknown, components: unknown): JsonObject {
  let { $ref, ...schema } = object(value, "unsupported_parameter_schema");
  // Outer siblings such as description override the referenced schema.
  const layers = [schema];
  const seen = new Set<string>();
  while ($ref !== undefined) {
    if (typeof $ref !== "string" || seen.has($ref)) {
      fail("unsupported_parameter_schema");
    }
    seen.add($ref);
    ({ $ref, ...schema } = componentSchema($ref, components));
    layers.unshift(schema);
  }
  return Object.assign({}, ...layers);
}

function parameterTypes(
  schemaValue: unknown,
  components: unknown
): readonly ("array" | "object" | "scalar")[] {
  const schema = parameterNode(schemaValue, components);
  const branches = [schema.anyOf, schema.oneOf].flatMap((value) => {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.length === 0) {
      fail("unsupported_parameter_schema");
    }
    return value.flatMap((branch) => parameterTypes(branch, components));
  });
  if (schema.type === undefined && branches.length > 0) {
    return branches;
  }
  if (
    schema.type === "string" ||
    schema.type === "number" ||
    schema.type === "integer" ||
    schema.type === "boolean"
  ) {
    return [...branches, "scalar"];
  }
  if (schema.type === "array") {
    const items = parameterNode(schema.items, components);
    if (
      !["string", "number", "integer", "boolean"].includes(items.type as string)
    ) {
      fail("unsupported_parameter_schema");
    }
    return [...branches, "array"];
  }
  if (schema.type === "object") {
    const properties = object(
      schema.properties,
      "unsupported_parameter_schema"
    );
    if (
      schema.additionalProperties !== false ||
      Object.values(properties).some((value) => {
        const property = parameterNode(value, components);
        return !["string", "number", "integer", "boolean"].includes(
          property.type as string
        );
      })
    ) {
      fail("unsupported_parameter_schema");
    }
    return [...branches, "object"];
  }
  return fail("unsupported_parameter_schema");
}

function assertParameterSerialization(
  parameter: JsonObject,
  location: "header" | "path" | "query",
  components: unknown
): void {
  const types = parameterTypes(parameter.schema, components);
  if (location === "path" && types.some((type) => type !== "scalar")) {
    fail("unsupported_parameter_schema");
  }
  const expectedStyle = location === "query" ? "form" : "simple";
  const expectedExplode = location === "query";
  if (
    (parameter.style !== undefined && parameter.style !== expectedStyle) ||
    (parameter.explode !== undefined &&
      parameter.explode !== expectedExplode) ||
    (parameter.allowReserved !== undefined &&
      parameter.allowReserved !== false) ||
    (parameter.allowEmptyValue !== undefined &&
      parameter.allowEmptyValue !== false) ||
    parameter.content !== undefined
  ) {
    fail("unsupported_parameter_serialization");
  }
}

function isIdempotencyParameter(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    value.name.toLowerCase() === "idempotency-key"
  );
}

/** @internal */
export function idempotencyContract(
  pathOperation: PathOperation,
  components: unknown
): Pick<Capability, "idempotency" | "idempotencyKeySchema"> {
  const parameters = operationParameters(pathOperation).filter(
    isIdempotencyParameter
  );
  if (parameters.length === 0) {
    return { idempotency: "none" };
  }
  if (parameters.length !== 1) {
    fail("unsupported_idempotency_parameter");
  }
  const parameter = object(parameters[0], "unsupported_idempotency_parameter");
  const schema = object(parameter.schema, "unsupported_idempotency_parameter");
  if (
    parameter.in !== "header" ||
    (parameter.style !== undefined && parameter.style !== "simple") ||
    (parameter.explode !== undefined && parameter.explode !== false) ||
    (parameter.allowReserved !== undefined &&
      parameter.allowReserved !== false) ||
    (parameter.allowEmptyValue !== undefined &&
      parameter.allowEmptyValue !== false) ||
    parameter.content !== undefined ||
    schema.type !== "string"
  ) {
    fail("unsupported_idempotency_parameter");
  }
  return {
    idempotency: "header",
    idempotencyKeySchema: closeSchema(schema, components),
  };
}

type ParameterGroups = Record<
  ParameterGroup,
  { properties: JsonObject; required: string[] }
>;

/**
 * @internal The tool input's `path`, `query` and `headers` properties. Pinned
 * headers are checked against their declaration and left out.
 */
export function parameterInput(
  pathOperation: PathOperation,
  operationId: string,
  components: unknown,
  pinnedHeaders: ReleaseDocuments["pinnedHeaders"]
): { readonly properties: JsonObject; readonly required: string[] } {
  const groups: ParameterGroups = {
    headers: { properties: {}, required: [] },
    path: { properties: {}, required: [] },
    query: { properties: {}, required: [] },
  };
  const seen = new Set<string>();
  for (const candidate of operationParameters(pathOperation)) {
    if (isIdempotencyParameter(candidate)) {
      continue;
    }
    const declared = readParameter(candidate, components, pinnedHeaders);
    if (declared === undefined) {
      continue;
    }
    const identity = `${declared.group}:${declared.name.toLowerCase()}`;
    if (seen.has(identity)) {
      fail("duplicate_parameter");
    }
    seen.add(identity);
    if (declared.kind === "pinned") {
      assertPinnedValue(operationId, declared, components);
      continue;
    }
    groups[declared.group].properties[declared.name] = declared.schema;
    if (declared.required) {
      groups[declared.group].required.push(declared.name);
    }
  }
  return parameterPartitions(groups);
}

function parameterPartitions(groups: ParameterGroups): {
  readonly properties: JsonObject;
  readonly required: string[];
} {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const group of ["path", "query", "headers"] as const) {
    const item = groups[group];
    if (Object.keys(item.properties).length === 0) {
      continue;
    }
    properties[group] = {
      additionalProperties: false,
      properties: item.properties,
      ...(item.required.length === 0 ? {} : { required: item.required }),
      type: "object",
    };
    if (group === "path" || item.required.length > 0) {
      required.push(group);
    }
  }
  return { properties, required };
}

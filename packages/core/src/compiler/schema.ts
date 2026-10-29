import { reservedHeaderName } from "../headers.js";
import type { Capability, SuccessRepresentation } from "../release.js";
import {
  compareUtf8,
  normalizeJsonMediaType,
  normalizeSuccessMediaType,
} from "../release.js";
import { closeSchema, componentSchema, openSchema } from "../schema.js";
import type { McpOptions } from "./extension.js";
import { canonicalJson } from "./release-snapshot.js";

type JsonObject = Record<string, unknown>;
type HttpMethod = Capability["method"];

export interface PathOperation {
  readonly method: string;
  readonly operation: Readonly<JsonObject>;
  readonly pathParameters: readonly unknown[];
  readonly pathTemplate: string;
}

const methods = new Map<string, HttpMethod>([
  ["delete", "DELETE"],
  ["get", "GET"],
  ["head", "HEAD"],
  ["patch", "PATCH"],
  ["post", "POST"],
  ["put", "PUT"],
]);
const pathItemFields = new Set([
  "$ref",
  "description",
  "parameters",
  "servers",
  "summary",
]);

const successStatusRange = /^2xx$/iu;
const successStatusPattern = /^2[0-9]{2}$/u;

function isObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, message: string): JsonObject {
  return isObject(value) ? value : fail(message);
}

function jsonClone(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonClone);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonClone(item)])
    );
  }
  return fail("invalid_openapi_value");
}

export function cloneOpenApi(
  value: Readonly<JsonObject>
): Readonly<JsonObject> {
  return object(jsonClone(value), "invalid_openapi_value");
}

export function assertOpenApi31(
  value: Readonly<JsonObject>
): Readonly<JsonObject> {
  if (typeof value.openapi !== "string" || !value.openapi.startsWith("3.1.")) {
    return fail("invalid_openapi_31");
  }
  object(value.paths, "invalid_openapi_paths");
  return value;
}

export function listPathOperations(
  document: Readonly<JsonObject>
): readonly PathOperation[] {
  const paths = object(document.paths, "invalid_openapi_paths");
  const operations: PathOperation[] = [];

  for (const [pathTemplate, pathItemValue] of Object.entries(paths)) {
    if (!pathTemplate.startsWith("/")) {
      fail("invalid_openapi_path");
    }
    const pathItem = object(pathItemValue, "invalid_openapi_path_item");
    const pathParameters =
      pathItem.parameters === undefined
        ? []
        : parameterArray(pathItem.parameters);

    for (const [key, operationValue] of Object.entries(pathItem)) {
      if (pathItemFields.has(key) || key.startsWith("x-")) {
        continue;
      }
      const method = methods.get(key) ?? key.toUpperCase();
      operations.push({
        method,
        operation: object(operationValue, "invalid_openapi_operation"),
        pathParameters,
        pathTemplate,
      });
    }
  }

  return operations;
}

/** @internal */
export function pathOperationRouteFact(pathOperation: PathOperation): Readonly<{
  method: Capability["method"];
  operationId: string;
  pathTemplate: string;
}> {
  return {
    method: supportedMethod(pathOperation.method),
    operationId: operationId(pathOperation.operation),
    pathTemplate: pathOperation.pathTemplate,
  };
}

function parameterArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : fail("invalid_openapi_parameters");
}

function isJsonMediaType(mediaType: string): boolean {
  return normalizeJsonMediaType(mediaType) !== undefined;
}

function isProblemMediaType(mediaType: string): boolean {
  return normalizeJsonMediaType(mediaType) === "application/problem+json";
}

function stringArray(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(message);
  }
  return value as string[];
}

function parameterSchema(
  parameterValue: unknown,
  components: unknown
):
  | {
      readonly group: "headers" | "path" | "query";
      readonly name: string;
      readonly required: boolean;
      readonly schema: unknown;
    }
  | undefined {
  const parameter = object(parameterValue, "invalid_openapi_parameter");
  const location = parameter.in;
  if (location !== "path" && location !== "query" && location !== "header") {
    fail("unsupported_parameter_location");
  }
  if (typeof parameter.name !== "string" || !parameter.name) {
    fail("invalid_openapi_parameter");
  }
  if (parameter.schema === undefined) {
    fail("missing_parameter_schema");
  }
  if (location === "path" && parameter.required !== true) {
    fail("path_parameter_not_required");
  }
  if (location === "header" && reservedHeaderName.test(parameter.name)) {
    // The runtime would reject it, so an optional one is left out of the tool.
    if (parameter.required === true) {
      fail("forbidden_header_parameter");
    }
    return;
  }
  assertParameterSerialization(parameter, location, components);
  return {
    group: location === "header" ? "headers" : location,
    name: parameter.name,
    required: parameter.required === true,
    schema: {
      ...(parameter.description === undefined
        ? {}
        : { description: parameter.description }),
      ...object(parameter.schema, "unsupported_parameter_schema"),
    },
  };
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

function idempotencyContract(
  pathOperation: PathOperation,
  components: unknown
): Pick<Capability, "idempotency" | "idempotencyKeySchema"> {
  const operationParameters =
    pathOperation.operation.parameters === undefined
      ? []
      : parameterArray(pathOperation.operation.parameters);
  const parameters = [
    ...pathOperation.pathParameters,
    ...operationParameters,
  ].filter(isIdempotencyParameter);
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

const definitionPrefix = "#/$defs/";

// The type a definition validates as: its own, its reference's, or "object"
// when every union branch is an object.
function definitionType(schema: unknown, definitions: JsonObject): unknown {
  const resolve = (node: unknown, followed: readonly string[]): unknown => {
    if (!isObject(node)) {
      return;
    }
    if (node.type !== undefined) {
      return node.type;
    }
    if (
      typeof node.$ref === "string" &&
      node.$ref.startsWith(definitionPrefix)
    ) {
      const name = node.$ref.slice(definitionPrefix.length);
      return followed.includes(name)
        ? undefined
        : resolve(definitions[name], [...followed, name]);
    }
    const branches = node.anyOf ?? node.oneOf;
    return Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every((branch) => resolve(branch, followed) === "object")
      ? "object"
      : undefined;
  };
  return resolve(schema, []);
}

const annotationKeywords = new Set([
  "$comment",
  "default",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

// Clients and directories read an argument's type from the argument itself, so
// a body that only references a definition takes that definition's place.
// References are followed through aliases, and only when their other keywords
// are annotations; the outermost annotations win. A body that would still be
// a reference, or that carries its own constraints, is left as written.
function typedBody(schema: JsonObject, definitions: unknown): JsonObject {
  if (schema.type !== undefined || !isObject(definitions)) {
    return schema;
  }
  let body = schema;
  const followed: string[] = [];
  for (;;) {
    const { $ref: reference, ...siblings } = body;
    if (
      typeof reference !== "string" ||
      !reference.startsWith(definitionPrefix) ||
      !Object.keys(siblings).every((key) => annotationKeywords.has(key))
    ) {
      break;
    }
    const name = reference.slice(definitionPrefix.length);
    const target = definitions[name];
    if (!isObject(target) || followed.includes(name)) {
      return schema;
    }
    followed.push(name);
    body = { ...target, ...siblings };
  }
  const type = definitionType(body, definitions);
  return body === schema || body.$ref !== undefined || type === undefined
    ? schema
    : { ...body, type };
}

function inputSchema(
  pathOperation: PathOperation,
  components: unknown,
  asyncOperation: AsyncOperation | undefined,
  body: CompiledRequestBody | undefined
): JsonObject {
  const { properties, required } = parameterPartitions(
    groupedParameters(pathOperation, components)
  );
  let definitions: unknown;
  if (body) {
    const { $defs, ...schema } = body.schema;
    definitions = $defs;
    properties.body = typedBody(schema, $defs);
    if (body.required) {
      required.push("body");
    }
  }
  const initial = {
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
    type: "object",
  };
  return closeSchema(
    asyncOperation === undefined
      ? {
          ...(definitions === undefined ? {} : { $defs: definitions }),
          ...initial,
        }
      : {
          ...(definitions === undefined ? {} : { $defs: definitions }),
          additionalProperties: true,
          oneOf: [
            initial,
            {
              additionalProperties: false,
              properties: {
                continuation: { minLength: 1, type: "string" },
              },
              required: ["continuation"],
              type: "object",
            },
          ],
          type: "object",
        },
    components
  );
}

export interface AsyncOperation {
  readonly operationGetter: string;
  readonly operationPollLimit: number;
}

/** @internal */
export function operationGetterLink(
  operation: Readonly<JsonObject>
): string | undefined {
  const getter = linkedOperationGetter(operation);
  if (!getter) {
    return;
  }
  if (!photonOperationShape(operation)) {
    fail("invalid_operation_contract");
  }
  return getter;
}

function linkedOperationGetter(
  operation: Readonly<JsonObject>
): string | undefined {
  const responses = object(operation.responses, "missing_openapi_responses");
  const getters = Object.entries(responses)
    .filter(([status]) => isSuccessStatus(status))
    .flatMap(([, response]) => {
      const { links } = object(response, "invalid_openapi_response");
      if (links === undefined) {
        return [];
      }
      return Object.values(object(links, "invalid_operation_links")).map(
        (link) => {
          const value = object(link, "invalid_operation_link");
          if (
            typeof value.operationId !== "string" ||
            !operationLinkParameters(value.parameters)
          ) {
            fail("invalid_operation_link");
          }
          return value.operationId;
        }
      );
    });
  if (getters.length === 0) {
    return;
  }
  if (getters.length !== 1) {
    fail("invalid_operation_link");
  }
  return getters[0];
}

function successStatus(status: string): number | undefined {
  return status.length === 3 && successStatusPattern.test(status)
    ? Number(status)
    : undefined;
}

function isSuccessStatus(status: string): boolean {
  return successStatus(status) !== undefined;
}

function operationLinkParameters(value: unknown): boolean {
  const parameters = object(value, "invalid_operation_link");
  return (
    parameters.projectId === "$response.body#/projectId" &&
    parameters.operationId === "$response.body#/operationId"
  );
}

function photonOperationShape(operation: Readonly<JsonObject>): boolean {
  const responses = object(operation.responses, "missing_openapi_responses");
  return Object.entries(responses)
    .filter(([status]) => isSuccessStatus(status))
    .some(([, response]) => {
      const { content } = object(response, "invalid_openapi_response");
      if (content === undefined) {
        return false;
      }
      const json = Object.entries(
        object(content, "invalid_response_content")
      ).find(([type]) => isJsonMediaType(type) && !isProblemMediaType(type));
      if (!json) {
        return false;
      }
      const schema = object(
        object(json[1], "invalid_response_media").schema,
        "missing_response_schema"
      );
      const properties = object(schema.properties, "invalid_operation_schema");
      const required = stringArray(schema.required, "invalid_operation_schema");
      return ["operationId", "projectId", "state"].every(
        (name) => properties[name] !== undefined && required.includes(name)
      );
    });
}

type ParameterGroups = Record<
  "headers" | "path" | "query",
  { properties: JsonObject; required: string[] }
>;

function groupedParameters(
  pathOperation: PathOperation,
  components: unknown
): ParameterGroups {
  const groups: ParameterGroups = {
    headers: { properties: {}, required: [] },
    path: { properties: {}, required: [] },
    query: { properties: {}, required: [] },
  };
  const seen = new Set<string>();
  const operationParameters =
    pathOperation.operation.parameters === undefined
      ? []
      : parameterArray(pathOperation.operation.parameters);

  for (const candidate of [
    ...pathOperation.pathParameters,
    ...operationParameters,
  ]) {
    if (isIdempotencyParameter(candidate)) {
      continue;
    }
    const parameter = parameterSchema(candidate, components);
    if (parameter === undefined) {
      continue;
    }
    const identity = `${parameter.group}:${parameter.name.toLowerCase()}`;
    if (seen.has(identity)) {
      fail("duplicate_parameter");
    }
    seen.add(identity);
    groups[parameter.group].properties[parameter.name] = parameter.schema;
    if (parameter.required) {
      groups[parameter.group].required.push(parameter.name);
    }
  }
  return groups;
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

interface CompiledRequestBody {
  readonly mediaType: string;
  readonly required: boolean;
  readonly schema: Readonly<Record<string, unknown>>;
}

interface CompiledSuccess {
  readonly advertisedOutputSchema: Readonly<Record<string, unknown>>;
  readonly representations: readonly SuccessRepresentation[];
}

interface CompiledResponseRepresentations {
  readonly advertisedDefinitions: readonly [string, unknown][];
  readonly advertisedSchemas: readonly unknown[];
  readonly representations: readonly SuccessRepresentation[];
}

function requestBodySchema(
  operation: Readonly<JsonObject>,
  components: unknown
): CompiledRequestBody | undefined {
  if (operation.requestBody === undefined) {
    return;
  }
  const requestBody = object(operation.requestBody, "invalid_request_body");
  const entries = Object.entries(
    object(requestBody.content, "missing_request_body_content")
  ).filter(([type]) => isJsonMediaType(type));
  if (entries.length === 0) {
    fail("unsupported_request_media_type");
  }
  const schemas = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [mediaType, value] of entries) {
    const normalized = normalizeJsonMediaType(mediaType);
    if (normalized === undefined) {
      fail("unsupported_request_media_type");
    }
    const media = object(value, "invalid_request_media");
    if (media.schema === undefined) {
      fail("missing_request_body_schema");
    }
    const schema = closeSchema(media.schema, components);
    const existing = schemas.get(normalized);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(schema)
    ) {
      fail("inconsistent_request_media_schemas");
    }
    schemas.set(normalized, existing ?? schema);
  }
  const representations = [...schemas.entries()].sort(([left], [right]) =>
    compareUtf8(left, right)
  );
  const [mediaType, schema] = representations[0] ?? [];
  if (mediaType === undefined || schema === undefined) {
    fail("missing_request_body_content");
  }
  if (
    representations.some(
      ([, candidate]) => canonicalJson(candidate) !== canonicalJson(schema)
    )
  ) {
    fail("inconsistent_request_media_schemas");
  }
  return { mediaType, required: requestBody.required === true, schema };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: representation collection must retain deterministic validation order.
function outputSchema(
  operation: Readonly<JsonObject>,
  components: unknown
): CompiledSuccess {
  const responses = object(operation.responses, "missing_openapi_responses");
  const representations: SuccessRepresentation[] = [];
  const cases: JsonObject[] = [];
  const advertisedDefinitions = new Map<string, unknown>();

  for (const [statusText, responseValue] of Object.entries(responses)) {
    if (successStatusRange.test(statusText)) {
      fail("unsupported_success_status_range");
    }
    const status = successStatus(statusText);
    if (status === undefined) {
      const numeric = Number(statusText);
      if (Number.isInteger(numeric) && numeric >= 200 && numeric < 300) {
        fail("invalid_success_status");
      }
      continue;
    }
    const response = object(responseValue, "invalid_openapi_response");
    if (status === 204) {
      if (
        response.content !== undefined &&
        Object.keys(object(response.content, "invalid_response_content"))
          .length > 0
      ) {
        fail("unexpected_no_content_response_body");
      }
      representations.push({ status: 204 });
      cases.push(envelope(status));
      continue;
    }
    const compiled = responseSchemas(status, response.content, components);
    representations.push(...compiled.representations);
    for (const [name, schema] of compiled.advertisedDefinitions) {
      const existing = advertisedDefinitions.get(name);
      if (
        existing !== undefined &&
        canonicalJson(existing) !== canonicalJson(schema)
      ) {
        fail("conflicting_local_definition");
      }
      advertisedDefinitions.set(name, existing ?? schema);
    }
    cases.push(
      envelope(
        status,
        compiled.advertisedSchemas.length === 1
          ? compiled.advertisedSchemas[0]
          : { anyOf: compiled.advertisedSchemas }
      )
    );
  }

  if (representations.length === 0) {
    fail("missing_json_success_response");
  }
  representations.sort(compareSuccessRepresentations);
  cases.sort((left, right) => statusOf(left) - statusOf(right));
  return {
    advertisedOutputSchema: closeSchema(
      {
        ...(advertisedDefinitions.size === 0
          ? {}
          : { $defs: Object.fromEntries(advertisedDefinitions) }),
        additionalProperties: true,
        oneOf: cases,
        type: "object",
      },
      components
    ),
    representations,
  };
}

function responseSchemas(
  status: number,
  contentValue: unknown,
  components: unknown
): CompiledResponseRepresentations {
  const entries = Object.entries(
    object(contentValue, "missing_response_content")
  ).sort(([left], [right]) => compareUtf8(left, right));
  if (entries.length === 0) {
    fail("missing_response_content");
  }
  const representations = new Map<string, Readonly<Record<string, unknown>>>();
  const advertisedDefinitions = new Map<string, unknown>();
  const advertisedSchemas = new Map<string, unknown>();
  for (const [mediaType, value] of entries) {
    const normalized = normalizeSuccessMediaType(mediaType);
    if (normalized === undefined) {
      continue;
    }
    const media = object(value, "invalid_response_media");
    if (media.schema === undefined) {
      fail("missing_response_schema");
    }
    // Producers add fields and enum values within an API version, and a
    // catalog compiled before such a change must still read the response.
    const schema = openSchema(closeSchema(media.schema, components));
    const existing = representations.get(normalized);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(schema)
    ) {
      fail("conflicting_success_representation");
    }
    representations.set(normalized, existing ?? schema);
    const advertised = advertisedSchema(schema, status, normalized);
    for (const [name, definition] of advertised.definitions) {
      advertisedDefinitions.set(name, definition);
    }
    advertisedSchemas.set(normalized, advertised.schema);
  }
  if (representations.size === 0) {
    fail("unsupported_response_media_type");
  }
  return {
    advertisedDefinitions: [...advertisedDefinitions.entries()].sort(
      ([left], [right]) => compareUtf8(left, right)
    ),
    advertisedSchemas: [...advertisedSchemas.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([, schema]) => schema),
    representations: [...representations.entries()].map(
      ([mediaType, schema]) => ({ mediaType, schema, status })
    ),
  };
}

function advertisedSchema(
  schema: Readonly<Record<string, unknown>>,
  status: number,
  mediaType: string
): {
  readonly definitions: readonly [string, unknown][];
  readonly schema: unknown;
} {
  const mediaBytes = new TextEncoder().encode(mediaType);
  const prefix = `success_${status}_${[...mediaBytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}_`;
  const { $defs, ...body } = closeSchema(schema, undefined, prefix);
  if ($defs === undefined) {
    return { definitions: [], schema: body };
  }
  return {
    definitions: Object.entries(
      object($defs, "invalid_schema_property_map")
    ).sort(([left], [right]) => compareUtf8(left, right)),
    schema: body,
  };
}

function envelope(status: number, data?: unknown): JsonObject {
  return {
    additionalProperties: false,
    properties: {
      ...(data === undefined ? {} : { data }),
      status: { const: status },
    },
    required: data === undefined ? ["status"] : ["status", "data"],
    type: "object",
  };
}

function statusOf(schema: JsonObject): number {
  const properties = object(schema.properties, "invalid_output_schema");
  const status = object(properties.status, "invalid_output_schema").const;
  return typeof status === "number" ? status : fail("invalid_output_schema");
}

function compareSuccessRepresentations(
  left: SuccessRepresentation,
  right: SuccessRepresentation
): number {
  if (left.status !== right.status) {
    return left.status - right.status;
  }
  if (!("mediaType" in left && "mediaType" in right)) {
    return 0;
  }
  return compareUtf8(left.mediaType, right.mediaType);
}

function operationId(operation: Readonly<JsonObject>): string {
  return typeof operation.operationId === "string" &&
    operation.operationId.length > 0
    ? operation.operationId
    : fail("missing_operation_id");
}

export function operationPermissions(
  operation: Readonly<JsonObject>
): readonly string[] {
  const value = operation["x-required-permissions"];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    fail("invalid_required_permissions");
  }
  const permissions = [...value] as string[];
  if (new Set(permissions).size !== permissions.length) {
    fail("invalid_required_permissions");
  }
  return permissions.sort(compareUtf8);
}

// Clients show the title in place of the tool name; the summary is the
// operation's short human-readable name.
export function operationTitle(
  operation: Readonly<JsonObject>,
  fallback: string
): string {
  const summary =
    typeof operation.summary === "string" ? operation.summary.trim() : "";
  return summary || fallback;
}

export function compileCapability(
  pathOperation: PathOperation,
  components: unknown,
  extension: McpOptions | undefined,
  asyncOperation: AsyncOperation | undefined
): Capability {
  const { operation } = pathOperation;
  const method = supportedMethod(pathOperation.method);
  const id = operationId(operation);
  const body = requestBodySchema(operation, components);
  const success = outputSchema(operation, components);
  return {
    annotations: {
      destructiveHint: extension?.destructive ?? method === "DELETE",
      idempotentHint:
        extension?.idempotent ??
        new Set<HttpMethod>(["DELETE", "GET", "HEAD", "PUT"]).has(method),
      openWorldHint: true,
      readOnlyHint:
        extension?.readOnly ?? (method === "GET" || method === "HEAD"),
      // Directories read the display name from the annotations.
      title: operationTitle(operation, id),
    },
    ...idempotencyContract(pathOperation, components),
    inputSchema: inputSchema(pathOperation, components, asyncOperation, body),
    method,
    operationId: id,
    ...(asyncOperation === undefined
      ? {}
      : {
          operationGetter: asyncOperation.operationGetter,
          operationPollLimit: asyncOperation.operationPollLimit,
        }),
    outputSchema: success.advertisedOutputSchema,
    pathTemplate: pathOperation.pathTemplate,
    ...(body === undefined ? {} : { requestMediaType: body.mediaType }),
    requiredPermissions: operationPermissions(operation),
    successRepresentations: success.representations,
  };
}

function supportedMethod(method: string): HttpMethod {
  return new Set<HttpMethod>([
    "DELETE",
    "GET",
    "HEAD",
    "PATCH",
    "POST",
    "PUT",
  ]).has(method as HttpMethod)
    ? (method as HttpMethod)
    : fail("unsupported_http_method");
}

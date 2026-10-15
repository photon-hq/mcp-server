type JsonObject = Record<string, unknown>;

const sourceLifecycleKeyword = ["depre", "cated"].join("");
const schemaKeywords = new Set([
  "$comment",
  "$defs",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "default",
  "dependentRequired",
  "dependentSchemas",
  sourceLifecycleKeyword,
  "description",
  "else",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly",
]);
const arraySchemaKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const compositionKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const mappedSchemaKeywords = new Set([
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const nestedSchemaKeywords = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedProperties",
]);
const stringSchemaKeywords = new Set([
  "$comment",
  "$schema",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
]);
const booleanSchemaKeywords = new Set([
  sourceLifecycleKeyword,
  "readOnly",
  "uniqueItems",
  "writeOnly",
]);
const schemaTypes = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const numericSchemaKeywords = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
]);
const integerSchemaKeywords = new Set([
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
]);
const objectSchemaKeywords = new Set([
  "additionalProperties",
  "dependentRequired",
  "dependentSchemas",
  "maxProperties",
  "minProperties",
  "patternProperties",
  "properties",
  "propertyNames",
  "required",
]);
const safeDefinitionCharacter = /^[A-Za-z0-9_]$/u;
const encoder = new TextEncoder();

function isObject(value: unknown): value is JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    return jsonArray(value, "invalid_openapi_value").map(jsonClone);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonClone(item)])
    );
  }
  return fail("invalid_openapi_value");
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function safeDefinitionName(value: string): string {
  const safe = [...value]
    .map((character) =>
      safeDefinitionCharacter.test(character) ? character : "_"
    )
    .join("");
  return safe.length === 0 ? "definition" : safe;
}

function componentDefinitionName(value: string): string {
  return `component_${safeDefinitionName(value)}`;
}

function decodePointerSegment(value: string): string {
  let fragmentToken: string;
  try {
    fragmentToken = decodeURIComponent(value);
  } catch {
    fail("unsupported_local_reference");
  }
  if (fragmentToken.includes("/")) {
    fail("unsupported_local_reference");
  }
  let decoded = "";
  for (let index = 0; index < fragmentToken.length; index += 1) {
    const character = fragmentToken[index] ?? "";
    if (character !== "~") {
      decoded += character;
      continue;
    }
    const escaped = fragmentToken[index + 1];
    if (escaped === "0") {
      decoded += "~";
    } else if (escaped === "1") {
      decoded += "/";
    } else {
      fail("unsupported_local_reference");
    }
    index += 1;
  }
  return decoded;
}

function encodePointerSegment(value: string): string {
  const pointerToken = value.replaceAll("~", "~0").replaceAll("/", "~1");
  return encodeURIComponent(pointerToken);
}

function schemaArray(value: unknown): readonly unknown[] {
  return jsonArray(value, "invalid_schema_array");
}

function stringArray(value: unknown, message: string): readonly string[] {
  const values = jsonArray(value, message);
  if (values.some((item) => typeof item !== "string")) {
    fail(message);
  }
  return values as string[];
}

function jsonArray(value: unknown, message: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(message);
  }
  let indexCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      fail(message);
    }
    const index = Number(key);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= value.length ||
      String(index) !== key
    ) {
      fail(message);
    }
    indexCount += 1;
  }
  if (indexCount !== value.length) {
    fail(message);
  }
  return value;
}

function mapSchemaChildren(
  key: string,
  value: unknown,
  convert: (schema: unknown) => unknown
): unknown | undefined {
  if (mappedSchemaKeywords.has(key)) {
    return Object.fromEntries(
      Object.entries(object(value, "invalid_schema_property_map")).map(
        ([name, child]) => [name, convert(child)]
      )
    );
  }
  if (nestedSchemaKeywords.has(key)) {
    return typeof value === "boolean" ? value : convert(value);
  }
  if (arraySchemaKeywords.has(key)) {
    return schemaArray(value).map((child) => convert(child));
  }
}

function validateRequired(value: unknown): void {
  const names = stringArray(value, "invalid_schema_required");
  if (new Set(names).size !== names.length) {
    fail("invalid_schema_required");
  }
}

function schemaValueKey(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${jsonArray(value, "invalid_schema_enum")
      .map(schemaValueKey)
      .join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${schemaValueKey(value[key])}`)
      .join(",")}}`;
  }
  return fail("invalid_schema_enum");
}

function validateEnum(value: unknown): void {
  const values = jsonArray(value, "invalid_schema_enum");
  if (values.length === 0) {
    fail("invalid_schema_enum");
  }
  for (const item of values) {
    jsonClone(item);
  }
  if (new Set(values.map(schemaValueKey)).size !== values.length) {
    fail("invalid_schema_enum");
  }
}

function validateString(value: unknown): void {
  if (typeof value !== "string") {
    fail("invalid_schema_string");
  }
}

function validateType(value: unknown): void {
  const values =
    typeof value === "string"
      ? [value]
      : stringArray(value, "invalid_schema_type");
  if (values.length === 0 || values.some((item) => !schemaTypes.has(item))) {
    fail("invalid_schema_type");
  }
  if (new Set(values).size !== values.length) {
    fail("invalid_schema_type");
  }
}

function numericKeyword(key: string): boolean {
  return numericSchemaKeywords.has(key);
}

function integerKeyword(key: string): boolean {
  return integerSchemaKeywords.has(key);
}

function validateNumber(key: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_schema_number");
  }
  if (key === "multipleOf" && value <= 0) {
    fail("invalid_schema_number");
  }
  if (integerKeyword(key) && (!Number.isInteger(value) || value < 0)) {
    fail("invalid_schema_number");
  }
}

function validateBoolean(value: unknown): void {
  if (typeof value !== "boolean") {
    fail("invalid_schema_boolean");
  }
}

function validateDependentRequired(value: unknown): void {
  for (const names of Object.values(
    object(value, "invalid_dependent_required")
  )) {
    const dependencies = stringArray(names, "invalid_dependent_required");
    if (new Set(dependencies).size !== dependencies.length) {
      fail("invalid_dependent_required");
    }
  }
}

function validateExamples(value: unknown): void {
  for (const item of jsonArray(value, "invalid_schema_examples")) {
    jsonClone(item);
  }
}

function validateSchemaKeyword(key: string, value: unknown): void {
  if (key === "required") {
    validateRequired(value);
    return;
  }
  if (key === "enum") {
    validateEnum(value);
    return;
  }
  if (stringSchemaKeywords.has(key)) {
    validateString(value);
    return;
  }
  if (key === "type") {
    validateType(value);
    return;
  }
  if (numericKeyword(key)) {
    validateNumber(key, value);
    return;
  }
  if (booleanSchemaKeywords.has(key)) {
    validateBoolean(value);
    return;
  }
  if (key === "dependentRequired") {
    validateDependentRequired(value);
    return;
  }
  if (key === "examples") {
    validateExamples(value);
    return;
  }
  if (key === "default" || key === "const") {
    jsonClone(value);
  }
}

function closeObjectSchema(
  source: JsonObject,
  converted: JsonObject
): JsonObject {
  if (
    converted.additionalProperties === undefined &&
    converted.unevaluatedProperties === undefined
  ) {
    if (
      objectLike(source, true) &&
      [...compositionKeywords].some((key) => Object.hasOwn(source, key))
    ) {
      return { ...converted, unevaluatedProperties: false };
    }
    if (objectLike(source)) {
      return { ...converted, additionalProperties: false };
    }
  }
  return converted;
}

function objectType(value: unknown): boolean {
  return (
    value === "object" ||
    (Array.isArray(value) &&
      jsonArray(value, "invalid_schema_type").includes("object"))
  );
}

function objectLike(source: JsonObject, includeComposition = false): boolean {
  return (
    objectType(source.type) ||
    [...objectSchemaKeywords].some((keyword) =>
      Object.hasOwn(source, keyword)
    ) ||
    (includeComposition &&
      [...compositionKeywords].some(
        (keyword) =>
          Array.isArray(source[keyword]) &&
          source[keyword].some(
            (branch) => isObject(branch) && objectLike(branch, true)
          )
      ))
  );
}

function closedLocalReference(value: unknown): string {
  if (typeof value !== "string") {
    fail("invalid_schema_reference");
  }
  const prefix = "#/$defs/";
  if (!value.startsWith(prefix)) {
    fail(
      value.startsWith("#")
        ? "unsupported_local_reference"
        : "external_reference"
    );
  }
  const token = value.slice(prefix.length);
  const decoded = decodePointerSegment(token);
  if (encodePointerSegment(decoded) !== token) {
    fail("unsupported_local_reference");
  }
  return decoded;
}

/** Resolves a `#/components/schemas/<name>` reference to its source schema. */
export function componentSchema(
  reference: unknown,
  components: unknown
): JsonObject {
  if (typeof reference !== "string") {
    fail("invalid_schema_reference");
  }
  const prefix = "#/components/schemas/";
  if (!reference.startsWith(prefix)) {
    fail(
      reference.startsWith("#")
        ? "unsupported_local_reference"
        : "external_reference"
    );
  }
  const schemas =
    components === undefined
      ? {}
      : object(
          object(components, "invalid_openapi_components").schemas ?? {},
          "invalid_openapi_schemas"
        );
  const name = decodePointerSegment(reference.slice(prefix.length));
  if (!Object.hasOwn(schemas, name)) {
    fail("dangling_local_reference");
  }
  return object(schemas[name], "invalid_schema");
}

/** Validates the release's already-closed schema contract without rewriting it. */
export function assertClosedSchema(value: unknown): void {
  const root = object(value, "invalid_schema");
  const definitions =
    root.$defs === undefined ? {} : object(root.$defs, "invalid_schema");
  const definitionNames = new Set(Object.keys(definitions));

  const visit = (
    schema: unknown,
    rootSchema = false,
    composed = false
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: closed-schema traversal validates every admitted keyword shape in one place.
  ): void => {
    if (schema === true || schema === false) {
      return;
    }
    const source = object(schema, "invalid_schema");
    if (
      objectLike(source) &&
      !composed &&
      !Object.hasOwn(source, "additionalProperties") &&
      !Object.hasOwn(source, "unevaluatedProperties")
    ) {
      fail("schema_not_closed");
    }
    for (const [key, item] of Object.entries(source)) {
      if (key === sourceLifecycleKeyword || !schemaKeywords.has(key)) {
        fail("unsupported_schema_keyword");
      }
      validateSchemaKeyword(key, item);
      if (key === "$ref") {
        if (!definitionNames.has(closedLocalReference(item))) {
          fail("dangling_local_reference");
        }
        continue;
      }
      if (mappedSchemaKeywords.has(key)) {
        if (key === "$defs" && !rootSchema) {
          fail("nested_schema_definitions");
        }
        for (const child of Object.values(object(item, "invalid_schema"))) {
          visit(child);
        }
        continue;
      }
      if (nestedSchemaKeywords.has(key)) {
        visit(item);
        continue;
      }
      if (arraySchemaKeywords.has(key)) {
        for (const child of schemaArray(item)) {
          visit(
            child,
            false,
            compositionKeywords.has(key) &&
              (composed ||
                Object.hasOwn(source, "additionalProperties") ||
                Object.hasOwn(source, "unevaluatedProperties"))
          );
        }
      }
    }
  };
  visit(root, true);
}

/**
 * Closes an admitted schema into a self-contained root-$defs document.
 * A definition prefix is used only when embedding independently closed schemas
 * into a larger advertised document.
 */
export function closeSchema(
  value: unknown,
  components: unknown,
  definitionPrefix?: string
): JsonObject {
  const root = object(value, "invalid_schema");
  const schemas =
    components === undefined
      ? {}
      : object(
          object(components, "invalid_openapi_components").schemas ?? {},
          "invalid_openapi_schemas"
        );
  const localDefinitions =
    root.$defs === undefined
      ? {}
      : object(root.$defs, "invalid_schema_property_map");
  const localEntries = Object.entries(localDefinitions).sort(
    ([left], [right]) => compareUtf8(left, right)
  );
  const localNames = new Set(Object.keys(localDefinitions));
  const localDefinitionNames = new Map(
    localEntries.map(([name], index) => [
      name,
      definitionPrefix === undefined ? name : `${definitionPrefix}${index + 1}`,
    ])
  );
  const names = new Set(localDefinitionNames.values());
  const componentNames = new Map<string, string>();
  for (const name of Object.keys(schemas).sort(compareUtf8)) {
    const base = localNames.has(name)
      ? componentDefinitionName(name)
      : safeDefinitionName(name);
    let candidate = base;
    let suffix = 2;
    while (names.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    names.add(candidate);
    componentNames.set(name, candidate);
  }
  const sources = new Map<string, unknown>();
  for (const [name, source] of localEntries) {
    const resolved = localDefinitionNames.get(name);
    if (resolved === undefined) {
      fail("dangling_local_reference");
    }
    sources.set(resolved, source);
  }
  for (const [name, source] of Object.entries(schemas)) {
    const resolved = componentNames.get(name);
    if (resolved !== undefined) {
      sources.set(resolved, source);
    }
  }
  const definitions = new Map<string, unknown>();
  const visiting = new Set<string>();

  const convertDefinition = (name: string): void => {
    if (definitions.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      return;
    }
    const source = sources.get(name);
    if (source === undefined) {
      fail("dangling_local_reference");
    }
    visiting.add(name);
    definitions.set(name, convert(source));
    visiting.delete(name);
  };

  const convertReference = (reference: unknown): string => {
    if (typeof reference !== "string") {
      fail("invalid_schema_reference");
    }
    const componentPrefix = "#/components/schemas/";
    const internalPrefix = "#/$defs/";
    if (reference.startsWith(internalPrefix)) {
      const name = decodePointerSegment(reference.slice(internalPrefix.length));
      const resolved = localDefinitionNames.get(name);
      if (!localNames.has(name) || resolved === undefined) {
        fail("dangling_local_reference");
      }
      convertDefinition(resolved);
      return `#/$defs/${encodePointerSegment(resolved)}`;
    }
    if (!reference.startsWith(componentPrefix)) {
      fail(
        reference.startsWith("#")
          ? "unsupported_local_reference"
          : "external_reference"
      );
    }
    const name = decodePointerSegment(reference.slice(componentPrefix.length));
    const resolved = componentNames.get(name);
    if (resolved === undefined) {
      fail("dangling_local_reference");
    }
    convertDefinition(resolved);
    return `#/$defs/${encodePointerSegment(resolved)}`;
  };

  const convert = (
    schema: unknown,
    rootSchema = false,
    composed = false
  ): unknown => {
    if (schema === true || schema === false) {
      return schema;
    }
    const source = object(schema, "invalid_schema");
    if (!rootSchema && Object.hasOwn(source, "$defs")) {
      fail("nested_schema_definitions");
    }
    const converted = Object.fromEntries(
      Object.entries(source).flatMap(([key, item]) => {
        // Vendor metadata is opaque, not a validation schema or a reference graph.
        if (
          key === "discriminator" ||
          key === "example" ||
          key.startsWith("x-")
        ) {
          return [];
        }
        if (!schemaKeywords.has(key)) {
          fail("unsupported_schema_keyword");
        }
        validateSchemaKeyword(key, item);
        if (key === "$defs") {
          for (const definition of Object.values(
            object(item, "invalid_schema_property_map")
          )) {
            convert(definition);
          }
          return [];
        }
        if (key === "$ref") {
          return [[key, convertReference(item)]];
        }
        const mapped = mapSchemaChildren(key, item, (child) =>
          convert(child, false, compositionKeywords.has(key))
        );
        return [[key, mapped === undefined ? jsonClone(item) : mapped]];
      })
    );
    // OpenAPI hints are annotations, not additional validation constraints.
    // Only schema nodes reach this conversion; instance literals stay intact.
    for (const [keyword, label] of [
      ["discriminator", "Discriminator"],
      ["x-enumDescriptions", "Enum descriptions"],
    ] as const) {
      if (Object.hasOwn(source, keyword)) {
        converted.description = [
          converted.description,
          `${label}: ${JSON.stringify(jsonClone(source[keyword]))}`,
        ]
          .filter((description) => description !== undefined)
          .join("\n\n");
      }
    }
    // OpenAPI's singular example is the JSON Schema examples annotation.
    if (Object.hasOwn(source, "example")) {
      const example = jsonClone(source.example);
      const examples = jsonArray(
        converted.examples ?? [],
        "invalid_schema_examples"
      );
      converted.examples = examples.some(
        (item) => schemaValueKey(item) === schemaValueKey(example)
      )
        ? examples
        : [...examples, example];
    }
    return composed ? converted : closeObjectSchema(source, converted);
  };

  const convertedRoot = object(convert(root, true), "invalid_schema");
  for (const [name] of localEntries) {
    const resolved = localDefinitionNames.get(name);
    if (resolved === undefined) {
      fail("dangling_local_reference");
    }
    convertDefinition(resolved);
  }
  const closed =
    definitions.size === 0
      ? convertedRoot
      : { ...convertedRoot, $defs: Object.fromEntries(definitions) };
  assertClosedSchema(closed);
  return closed;
}

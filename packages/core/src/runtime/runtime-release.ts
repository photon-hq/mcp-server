import type {
  JsonSchemaType,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import {
  type Capability,
  compareUtf8,
  parseRelease,
  type ReleaseDocuments,
} from "../release.js";

interface RuntimeReleaseIdentity {
  readonly admissionModel: "producer_metadata_only";
  readonly aggregateEtag: string;
  readonly aggregateSha256: string;
  readonly authPermissions: readonly string[];
  readonly compilerVersion: "0.1.0";
  readonly environment: "production" | "staging";
  readonly previousReleaseIdentity: string | null;
  readonly protocolVersion: "2026-07-28";
  readonly releaseIdentity: string;
  readonly schemaVersion: 1;
}

interface RuntimeTool {
  readonly description: string;
  readonly name: string;
}

interface RouteFact {
  readonly method: Capability["method"];
  readonly operationId: string;
  readonly pathTemplate: string;
}

interface RuntimeSchema {
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  readonly responses: readonly RuntimeResponseWitness[];
}

type RuntimeResponseWitness = Readonly<
  | { readonly status: 204 }
  | {
      readonly mediaType: string;
      readonly status: number;
    }
>;

type ActivatedExecution = Readonly<{
  readonly capability: Capability;
  readonly inputSchema: StandardSchemaWithJSON;
  readonly outputSchema: StandardSchemaWithJSON;
  readonly successRepresentations: readonly Readonly<
    | { readonly status: 204 }
    | {
        readonly mediaType: string;
        readonly status: number;
        readonly validate: (value: unknown) => boolean;
      }
  >[];
  readonly validateOutput: (value: unknown) => boolean;
  readonly validateIdempotencyKey?: (value: unknown) => boolean;
}>;

export interface ActivatedRuntimeRelease {
  readonly authPermissions: readonly string[];
  readonly environment: RuntimeReleaseIdentity["environment"];
  readonly registrationPlan: readonly Readonly<{
    readonly execution: ActivatedExecution;
    readonly name: string;
    readonly operationGetter?: ActivatedExecution;
    readonly options: Readonly<{
      annotations: ToolAnnotations;
      description: string;
      inputSchema: StandardSchemaWithJSON;
      outputSchema: StandardSchemaWithJSON;
    }>;
  }>[];
  readonly releaseIdentity: string;
  readonly validator: CfWorkerJsonSchemaValidator;
}

export class RuntimeReleaseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "RuntimeReleaseError";
  }
}

const runtimeKeys = new Set([
  "authPermissions",
  "privateCapabilities",
  "registry",
  "releaseIdentity",
  "schemas",
  "tools",
]);
const releaseIdentityKeys = new Set([
  "admissionModel",
  "aggregateEtag",
  "aggregateSha256",
  "authPermissions",
  "compilerVersion",
  "environment",
  "previousReleaseIdentity",
  "protocolVersion",
  "releaseIdentity",
  "schemaVersion",
]);
const schemaKeys = new Set(["input", "output", "responses"]);
const responseWitnessKeys = new Set(["mediaType", "status"]);
const bodylessResponseWitnessKeys = new Set(["status"]);
const toolKeys = new Set(["description", "name"]);
const checksumPattern = /^[a-f0-9]{64}$/u;
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const encoder = new TextEncoder();

function fail(code: string): never {
  throw new RuntimeReleaseError(code);
}

function record(
  value: unknown,
  code = "invalid_runtime_release"
): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : fail(code);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
  code = "invalid_runtime_release"
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    fail(code);
  }
}

function sortedJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortedJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [
          key,
          sortedJsonValue((value as Readonly<Record<string, unknown>>)[key]),
        ])
    );
  }
  return fail("invalid_runtime_release");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedJsonValue(value), null, 2)}\n`;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonicalJson(value))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function parseReleaseIdentity(value: unknown): RuntimeReleaseIdentity {
  const identity = record(value);
  exactKeys(identity, releaseIdentityKeys);
  if (
    identity.admissionModel !== "producer_metadata_only" ||
    typeof identity.aggregateEtag !== "string" ||
    identity.aggregateEtag.length === 0 ||
    typeof identity.aggregateSha256 !== "string" ||
    !checksumPattern.test(identity.aggregateSha256) ||
    !Array.isArray(identity.authPermissions) ||
    identity.authPermissions.some(
      (permission) => typeof permission !== "string"
    ) ||
    identity.compilerVersion !== "0.1.0" ||
    (identity.environment !== "production" &&
      identity.environment !== "staging") ||
    (identity.previousReleaseIdentity !== null &&
      (typeof identity.previousReleaseIdentity !== "string" ||
        !checksumPattern.test(identity.previousReleaseIdentity))) ||
    identity.protocolVersion !== "2026-07-28" ||
    typeof identity.releaseIdentity !== "string" ||
    !checksumPattern.test(identity.releaseIdentity) ||
    identity.schemaVersion !== 1
  ) {
    fail("invalid_runtime_release");
  }
  return identity as unknown as RuntimeReleaseIdentity;
}

function parseTools(value: unknown): readonly RuntimeTool[] {
  if (!Array.isArray(value)) {
    fail("invalid_runtime_release");
  }
  return value.map((item) => {
    const tool = record(item);
    exactKeys(tool, toolKeys);
    if (
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      typeof tool.description !== "string" ||
      tool.description.length === 0
    ) {
      fail("invalid_runtime_release");
    }
    return { description: tool.description, name: tool.name };
  });
}

function parseSchemas(value: unknown): Readonly<Record<string, RuntimeSchema>> {
  const document = record(value);
  return Object.fromEntries(
    Object.entries(document).map(([operationId, item]) => {
      const schema = record(item, "release_schema_mismatch");
      exactKeys(schema, schemaKeys, "release_schema_mismatch");
      const input = record(schema.input, "release_schema_mismatch");
      const output = record(schema.output, "release_schema_mismatch");
      if (!Array.isArray(schema.responses)) {
        fail("release_schema_mismatch");
      }
      const responses: RuntimeResponseWitness[] = schema.responses.map(
        (witnessValue) => {
          const response = record(witnessValue, "release_schema_mismatch");
          if (response.status === 204) {
            exactKeys(
              response,
              bodylessResponseWitnessKeys,
              "release_schema_mismatch"
            );
            return { status: 204 } as const;
          }
          exactKeys(response, responseWitnessKeys, "release_schema_mismatch");
          if (
            typeof response.status !== "number" ||
            !Number.isInteger(response.status) ||
            typeof response.mediaType !== "string"
          ) {
            fail("release_schema_mismatch");
          }
          return {
            mediaType: response.mediaType,
            status: response.status,
          };
        }
      );
      return [
        operationId,
        {
          input,
          output,
          responses,
        },
      ];
    })
  );
}

function parseCapabilities(
  identity: RuntimeReleaseIdentity,
  authPermissions: unknown,
  registry: unknown,
  privateCapabilities: unknown
): ReleaseDocuments {
  try {
    return parseRelease({
      admissionModel: identity.admissionModel,
      aggregateEtag: identity.aggregateEtag,
      authPermissions,
      privateCapabilities,
      protocolVersion: identity.protocolVersion,
      registry,
      schemaVersion: identity.schemaVersion,
    });
  } catch {
    return fail("invalid_runtime_release");
  }
}

function assertSortedUnique(values: readonly string[], code: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some(
      (value, index) =>
        index > 0 && compareUtf8(values[index - 1] ?? "", value) >= 0
    )
  ) {
    fail(code);
  }
}

function deriveRouteFacts(
  registry: readonly Capability[],
  privateCapabilities: readonly Capability[]
): readonly RouteFact[] {
  const routes = new Map<string, RouteFact>();
  const add = (capability: Capability): void => {
    const route: RouteFact = {
      method: capability.method,
      operationId: capability.operationId,
      pathTemplate: capability.pathTemplate,
    };
    const existing = routes.get(route.operationId);
    if (
      existing &&
      (existing.method !== route.method ||
        existing.pathTemplate !== route.pathTemplate)
    ) {
      fail("release_route_mismatch");
    }
    routes.set(route.operationId, existing ?? route);
  };
  for (const capability of registry) {
    add(capability);
    if (!capability.operationGetter) {
      continue;
    }
    const getter = [...registry, ...privateCapabilities].find(
      (candidate) => candidate.operationId === capability.operationGetter
    );
    if (getter?.method !== "GET") {
      fail("release_route_mismatch");
    }
    add(getter);
  }
  return [...routes.values()].sort((left, right) =>
    compareUtf8(left.operationId, right.operationId)
  );
}

function assertCrossReferences(
  registry: readonly Capability[],
  privateCapabilities: readonly Capability[],
  tools: readonly RuntimeTool[],
  schemas: Readonly<Record<string, RuntimeSchema>>
): void {
  const operationIds = registry.map((capability) => capability.operationId);
  if (
    operationIds.some((operationId) => !operationIdPattern.test(operationId))
  ) {
    fail("invalid_runtime_release");
  }
  assertSortedUnique(operationIds, "invalid_runtime_release");
  assertSortedUnique(
    tools.map((tool) => tool.name),
    "release_tool_mismatch"
  );
  const allCapabilities = [...registry, ...privateCapabilities];
  const schemaNames = Object.keys(schemas).sort(compareUtf8);
  if (
    canonicalJson(operationIds) !==
    canonicalJson(tools.map((tool) => tool.name))
  ) {
    fail("release_tool_mismatch");
  }
  if (
    canonicalJson(
      allCapabilities.map((item) => item.operationId).sort(compareUtf8)
    ) !== canonicalJson(schemaNames)
  ) {
    fail("release_schema_mismatch");
  }
  deriveRouteFacts(registry, privateCapabilities);
  for (const capability of [...registry, ...privateCapabilities]) {
    const schema = schemas[capability.operationId];
    if (
      !schema ||
      canonicalJson(schema.input) !== canonicalJson(capability.inputSchema) ||
      canonicalJson(schema.output) !== canonicalJson(capability.outputSchema)
    ) {
      fail("release_schema_mismatch");
    }
    if (
      schema.responses.length !== capability.successRepresentations.length ||
      schema.responses.some((witness, index) => {
        const representation = capability.successRepresentations[index];
        return (
          representation === undefined ||
          witness.status !== representation.status ||
          ("mediaType" in witness && "mediaType" in representation
            ? witness.mediaType !== representation.mediaType
            : "mediaType" in witness !== "mediaType" in representation)
        );
      })
    ) {
      fail("release_schema_mismatch");
    }
    if (capability.operationGetter) {
      const operationGetter = [...registry, ...privateCapabilities].find(
        (candidate) => candidate.operationId === capability.operationGetter
      );
      if (operationGetter?.method !== "GET") {
        fail("release_route_mismatch");
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function")
  ) {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function activateSchema(
  validator: CfWorkerJsonSchemaValidator,
  schema: Readonly<Record<string, unknown>>
): Readonly<{
  schema: StandardSchemaWithJSON;
  validate: (value: unknown) => boolean;
}> {
  try {
    const compiled = validator.getValidator(schema as JsonSchemaType);
    const validate = Object.freeze((value: unknown): boolean => {
      try {
        return compiled(value).valid === true;
      } catch {
        return false;
      }
    });
    const standard = deepFreeze({
      "~standard": Object.freeze({
        jsonSchema: Object.freeze({
          input: () => schema,
          output: () => schema,
        }),
        validate: (value: unknown) => {
          const result = compiled(value);
          return result.valid
            ? { value: result.data }
            : { issues: [{ message: result.errorMessage }] };
        },
        vendor: "mcp",
        version: 1 as const,
      }),
    }) as StandardSchemaWithJSON;
    return Object.freeze({ schema: standard, validate });
  } catch (error) {
    if (error instanceof RuntimeReleaseError) {
      throw error;
    }
    return fail("release_schema_compilation_failed");
  }
}

function activateExecution(
  capability: Capability,
  schema: RuntimeSchema,
  validator: CfWorkerJsonSchemaValidator
): ActivatedExecution {
  const input = activateSchema(validator, schema.input);
  const output = activateSchema(validator, schema.output);
  const successRepresentations = Object.freeze(
    capability.successRepresentations.map((representation, index) => {
      const witness = schema.responses[index];
      if (witness === undefined || witness.status !== representation.status) {
        return fail("release_schema_mismatch");
      }
      if (!("schema" in representation)) {
        return Object.freeze({ status: 204 } as const);
      }
      if (
        !("mediaType" in witness) ||
        witness.mediaType !== representation.mediaType
      ) {
        return fail("release_schema_mismatch");
      }
      const response = activateSchema(validator, representation.schema);
      return Object.freeze({
        mediaType: representation.mediaType,
        status: representation.status,
        validate: response.validate,
      });
    })
  );
  const keyValidator =
    capability.idempotencyKeySchema === undefined
      ? undefined
      : validator.getValidator(capability.idempotencyKeySchema);
  return Object.freeze({
    capability,
    ...(keyValidator === undefined
      ? {}
      : {
          validateIdempotencyKey: (value: unknown) => keyValidator(value).valid,
        }),
    inputSchema: input.schema,
    outputSchema: output.schema,
    successRepresentations,
    validateOutput: output.validate,
  });
}

export async function activateRuntimeRelease(
  value: unknown,
  expectedChecksum: string
): Promise<ActivatedRuntimeRelease> {
  const supplied = record(value);
  const checksum = await sha256(supplied);
  if (
    !checksumPattern.test(expectedChecksum) ||
    checksum !== expectedChecksum
  ) {
    fail("release_checksum_mismatch");
  }
  const runtime = record(JSON.parse(canonicalJson(supplied)));
  exactKeys(runtime, runtimeKeys);
  const identity = parseReleaseIdentity(runtime.releaseIdentity);
  const release = parseCapabilities(
    identity,
    runtime.authPermissions,
    runtime.registry,
    runtime.privateCapabilities
  );
  if (
    canonicalJson(identity.authPermissions) !==
    canonicalJson(release.authPermissions)
  ) {
    fail("invalid_runtime_release");
  }
  deepFreeze(identity);
  deepFreeze(release.authPermissions);
  const { registry } = release;
  const tools = parseTools(runtime.tools);
  const schemas = parseSchemas(runtime.schemas);
  assertCrossReferences(registry, release.privateCapabilities, tools, schemas);
  const semanticIdentity = await sha256({
    admissionModel: identity.admissionModel,
    aggregateEtag: identity.aggregateEtag,
    aggregateSha256: identity.aggregateSha256,
    authPermissions: release.authPermissions,
    compilerVersion: identity.compilerVersion,
    environment: identity.environment,
    privateCapabilities: release.privateCapabilities,
    protocolVersion: identity.protocolVersion,
    registry,
    routes: deriveRouteFacts(registry, release.privateCapabilities),
    schemaVersion: identity.schemaVersion,
    tools,
  });
  if (semanticIdentity !== identity.releaseIdentity) {
    fail("release_identity_mismatch");
  }
  const validator = new CfWorkerJsonSchemaValidator({ draft: "2020-12" });
  const executions = new Map<string, ActivatedExecution>();
  for (const capability of [...registry, ...release.privateCapabilities]) {
    const schema = schemas[capability.operationId];
    if (!schema) {
      fail("release_schema_mismatch");
    }
    executions.set(
      capability.operationId,
      activateExecution(capability, schema, validator)
    );
  }
  const registrationPlan = Object.freeze(
    registry.map((capability, index) => {
      const execution = executions.get(capability.operationId);
      const tool = tools[index];
      if (!(execution && tool) || tool.name !== capability.operationId) {
        return fail("release_schema_mismatch");
      }
      const options = Object.freeze({
        annotations: capability.annotations,
        description: tool.description,
        inputSchema: execution.inputSchema,
        outputSchema: execution.outputSchema,
      });
      const operationGetter = capability.operationGetter
        ? executions.get(capability.operationGetter)
        : undefined;
      if (capability.operationGetter && !operationGetter) {
        return fail("release_route_mismatch");
      }
      return Object.freeze({
        execution,
        name: capability.operationId,
        ...(operationGetter === undefined ? {} : { operationGetter }),
        options,
      });
    })
  );
  deepFreeze(registry);
  deepFreeze(release.privateCapabilities);
  deepFreeze(tools);
  deepFreeze(schemas);
  return Object.freeze({
    authPermissions: release.authPermissions,
    environment: identity.environment,
    registrationPlan,
    releaseIdentity: identity.releaseIdentity,
    validator,
  });
}

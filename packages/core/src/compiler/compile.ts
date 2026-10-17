import { type Capability, compareUtf8 } from "../release.js";
import { closeSchema } from "../schema.js";
import {
  admittedOperations,
  indexOperations,
  recognizedOperationGetter,
} from "./relations.js";
import { type ChangeReport, diffRelease } from "./release-change.js";
import {
  canonicalJson,
  parseSemanticReleaseSnapshot,
  type SemanticReleaseSnapshot,
  semanticReleaseIdentity,
} from "./release-snapshot.js";
import {
  assertOpenApi31,
  cloneOpenApi,
  compileCapability,
  listPathOperations,
  operationPermissions,
} from "./schema.js";

export interface CompileReleaseInput {
  readonly aggregate: Readonly<Record<string, unknown>>;
  readonly aggregateEtag: string;
  readonly compilerPolicy: Readonly<{ operationPollLimit: number }>;
  readonly environment: "production" | "staging";
  readonly previousRelease?: SemanticReleaseSnapshot;
}

export interface CompiledRelease extends SemanticReleaseSnapshot {
  readonly changeReport: ChangeReport;
  readonly previousReleaseIdentity: string | null;
}

const compileInputKeys = new Set([
  "aggregate",
  "aggregateEtag",
  "compilerPolicy",
  "environment",
  "previousRelease",
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function toolDescription(
  operation: Readonly<Record<string, unknown>>,
  operationId: string
): string {
  const summary =
    typeof operation.summary === "string" ? operation.summary.trim() : "";
  const description =
    typeof operation.description === "string"
      ? operation.description.trim()
      : "";
  if (summary && description && summary !== description) {
    return `${summary}\n\n${description}`;
  }
  return summary || description || operationId;
}

// Clients show the title in place of the tool name; the summary is the
// operation's short human-readable name.
function toolTitle(
  operation: Readonly<Record<string, unknown>>,
  operationId: string
): string {
  const summary =
    typeof operation.summary === "string" ? operation.summary.trim() : "";
  return summary || operationId;
}

function validateInput(input: CompileReleaseInput): void {
  if (Object.keys(input).some((key) => !compileInputKeys.has(key))) {
    throw new Error("invalid_compile_input");
  }
  if (
    typeof input.aggregateEtag !== "string" ||
    input.aggregateEtag.length === 0
  ) {
    throw new Error("invalid_aggregate_etag");
  }
  if (input.environment !== "staging" && input.environment !== "production") {
    throw new Error("invalid_environment");
  }
  if (
    !Number.isInteger(input.compilerPolicy.operationPollLimit) ||
    input.compilerPolicy.operationPollLimit < 1
  ) {
    throw new Error("invalid_compiler_policy");
  }
}

export function parseCompileReleaseInput(value: unknown): CompileReleaseInput {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("invalid_compile_input");
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (Object.keys(input).some((key) => !compileInputKeys.has(key))) {
    throw new Error("invalid_compile_input");
  }
  const { compilerPolicy } = input;
  if (
    compilerPolicy === null ||
    Array.isArray(compilerPolicy) ||
    typeof compilerPolicy !== "object" ||
    Object.keys(compilerPolicy).length !== 1 ||
    !("operationPollLimit" in compilerPolicy) ||
    !Number.isInteger(compilerPolicy.operationPollLimit) ||
    (compilerPolicy.operationPollLimit as number) < 1
  ) {
    throw new Error("invalid_compiler_policy");
  }
  const parsed = {
    aggregate: input.aggregate as Readonly<Record<string, unknown>>,
    aggregateEtag: input.aggregateEtag as string,
    compilerPolicy: {
      operationPollLimit: compilerPolicy.operationPollLimit as number,
    },
    environment: input.environment as "production" | "staging",
    ...(input.previousRelease === undefined
      ? {}
      : {
          previousRelease: parseSemanticReleaseSnapshot(input.previousRelease),
        }),
  };
  validateInput(parsed);
  return parsed;
}

export function compileRelease(value: unknown): CompiledRelease {
  const input = parseCompileReleaseInput(value);
  const aggregate = assertOpenApi31(input.aggregate);
  const operationIds = new Set<string>();
  const operations = listPathOperations(aggregate);
  const operationsById = indexOperations(operations, "compiler");
  const authPermissions = [
    ...new Set(
      operations.flatMap(({ operation }) => operationPermissions(operation))
    ),
  ].sort(compareUtf8);
  const analyzed = admittedOperations(operations).map((candidate) => ({
    ...candidate,
    operationGetter: recognizedOperationGetter(
      candidate.pathOperation,
      operationsById
    ),
  }));
  const compiled = analyzed
    .map(({ operationGetter, extension, pathOperation }) => {
      const capability = compileCapability(
        pathOperation,
        aggregate.components,
        extension,
        operationGetter === undefined
          ? undefined
          : {
              operationGetter,
              operationPollLimit: input.compilerPolicy.operationPollLimit,
            }
      );
      if (operationIds.has(capability.operationId)) {
        throw new Error("duplicate_operation_id");
      }
      operationIds.add(capability.operationId);
      return { capability, operation: pathOperation.operation };
    })
    .sort((left, right) =>
      compareUtf8(left.capability.operationId, right.capability.operationId)
    );
  const registry = compiled.map(({ capability }) => capability);
  const publicCapabilities = new Map(
    registry.map((capability) => [capability.operationId, capability])
  );
  const privateById = new Map<string, Capability>();
  for (const capability of registry) {
    if (
      !capability.operationGetter ||
      publicCapabilities.has(capability.operationGetter)
    ) {
      continue;
    }
    const getter = operationsById.get(capability.operationGetter);
    if (!getter) {
      throw new Error("invalid_operation_getter");
    }
    const candidate = compileCapability(
      getter,
      aggregate.components,
      undefined,
      undefined
    );
    const existing = privateById.get(candidate.operationId);
    if (existing && canonicalJson(existing) !== canonicalJson(candidate)) {
      throw new Error("conflicting_operation_getter");
    }
    privateById.set(candidate.operationId, existing ?? candidate);
  }
  const privateCapabilities = [...privateById.values()].sort((left, right) =>
    compareUtf8(left.operationId, right.operationId)
  );
  const advertisedRegistry = registry.map((capability) => {
    if (capability.operationGetter === undefined) {
      return capability;
    }
    const getter =
      publicCapabilities.get(capability.operationGetter) ??
      privateById.get(capability.operationGetter);
    if (getter === undefined) {
      throw new Error("invalid_operation_getter");
    }
    const { $defs: sourceDefinitions, ...source } = closeSchema(
      capability.outputSchema,
      undefined,
      "source_"
    );
    const { $defs: getterDefinitions, ...poll } = closeSchema(
      getter.outputSchema,
      undefined,
      "poll_"
    );
    return {
      ...capability,
      outputSchema: closeSchema(
        {
          $defs: {
            ...(sourceDefinitions as Record<string, unknown>),
            ...(getterDefinitions as Record<string, unknown>),
          },
          anyOf: [source, poll],
          type: "object",
        },
        undefined
      ),
    };
  });
  const tools = compiled.map(({ capability, operation }) => ({
    description: toolDescription(operation, capability.operationId),
    name: capability.operationId,
    title: toolTitle(operation, capability.operationId),
  }));

  const snapshot: SemanticReleaseSnapshot = {
    admissionModel: "producer_metadata_only",
    aggregateEtag: input.aggregateEtag,
    authPermissions,
    compilerVersion: "0.1.0",
    environment: input.environment,
    openapi: cloneOpenApi(aggregate),
    privateCapabilities,
    protocolVersion: "2026-07-28",
    registry: advertisedRegistry,
    schemaVersion: 1,
    tools,
  };
  return deepFreeze({
    ...snapshot,
    changeReport: input.previousRelease
      ? diffRelease(input.previousRelease, snapshot)
      : { changes: [], decision: "automatic", schemaVersion: 1 },
    previousReleaseIdentity: input.previousRelease
      ? semanticReleaseIdentity(input.previousRelease)
      : null,
  });
}

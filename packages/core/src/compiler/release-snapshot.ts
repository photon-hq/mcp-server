import { createHash } from "node:crypto";
import {
  type Capability,
  compareUtf8,
  parseRelease,
  type ReleaseDocuments,
} from "../release.js";
import {
  admittedOperations,
  indexOperations,
  recognizedOperationGetter,
} from "./relations.js";
import {
  assertOpenApi31,
  cloneOpenApi,
  listPathOperations,
  pathOperationRouteFact,
} from "./schema.js";

export interface SemanticReleaseSnapshot extends ReleaseDocuments {
  readonly compilerVersion: "0.1.0";
  readonly environment: "production" | "staging";
  readonly openapi: Readonly<Record<string, unknown>>;
  readonly tools: readonly Readonly<{
    description: string;
    name: string;
    title?: string;
  }>[];
}

interface RouteFact {
  readonly method: Capability["method"];
  readonly operationId: string;
  readonly pathTemplate: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("invalid_record");
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>
): void {
  if (
    Object.keys(value).length !== keys.size ||
    Object.keys(value).some((key) => !keys.has(key))
  ) {
    throw new Error("invalid_keys");
  }
}

const snapshotKeys = new Set([
  "admissionModel",
  "aggregateEtag",
  "authPermissions",
  "compilerVersion",
  "environment",
  "openapi",
  "privateCapabilities",
  "protocolVersion",
  "registry",
  "schemaVersion",
  "tools",
]);
const toolKeys = new Set(["description", "name"]);
// Releases compiled before tools carried a title omit it.
const titledToolKeys = new Set(["description", "name", "title"]);

/** @internal */
export function parseReleaseTools(
  value: unknown
): SemanticReleaseSnapshot["tools"] {
  if (!Array.isArray(value)) {
    throw new Error("invalid_tools");
  }
  return value.map((item) => {
    const tool = record(item);
    exactKeys(tool, "title" in tool ? titledToolKeys : toolKeys);
    if (
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !(tool.title === undefined || typeof tool.title === "string")
    ) {
      throw new Error("invalid_tools");
    }
    return {
      description: tool.description,
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
    };
  });
}

/** @internal */
export function deriveRouteFacts(
  registry: readonly Capability[],
  privateCapabilities: readonly Capability[]
): readonly RouteFact[] {
  const routes = new Map<string, RouteFact>();
  const add = (route: RouteFact): void => {
    const existing = routes.get(route.operationId);
    if (existing && canonicalJson(existing) !== canonicalJson(route)) {
      throw new Error("invalid_registry_route");
    }
    routes.set(route.operationId, existing ?? route);
  };
  for (const capability of registry) {
    add({
      method: capability.method,
      operationId: capability.operationId,
      pathTemplate: capability.pathTemplate,
    });
    if (!capability.operationGetter) {
      continue;
    }
    const getter = [...registry, ...privateCapabilities].find(
      (candidate) => candidate.operationId === capability.operationGetter
    );
    if (getter?.method !== "GET") {
      throw new Error("invalid_registry_route");
    }
    add({
      method: getter.method,
      operationId: getter.operationId,
      pathTemplate: getter.pathTemplate,
    });
  }
  return [...routes.values()].sort((left, right) =>
    compareUtf8(left.operationId, right.operationId)
  );
}

function expectedRouteFacts(
  openapi: Readonly<Record<string, unknown>>
): readonly RouteFact[] {
  const pathOperations = listPathOperations(openapi);
  const operationsById = indexOperations(pathOperations, "snapshot");
  const admitted = admittedOperations(pathOperations);
  const admittedIds = new Set(
    admitted.map(
      ({ pathOperation }) => pathOperationRouteFact(pathOperation).operationId
    )
  );
  const routes = new Map<string, RouteFact>();
  for (const { pathOperation } of admitted) {
    const route = pathOperationRouteFact(pathOperation);
    routes.set(route.operationId, route);
    const operationGetter = recognizedOperationGetter(
      pathOperation,
      operationsById
    );
    if (operationGetter === undefined || admittedIds.has(operationGetter)) {
      continue;
    }
    const getter = operationsById.get(operationGetter);
    if (!getter) {
      throw new Error("invalid_registry_route");
    }
    const getterRoute = pathOperationRouteFact(getter);
    if (getterRoute.method !== "GET") {
      throw new Error("invalid_registry_route");
    }
    routes.set(getterRoute.operationId, getterRoute);
  }
  return [...routes.values()].sort((left, right) =>
    compareUtf8(left.operationId, right.operationId)
  );
}

function hasReservedOperationId(
  openapi: Readonly<Record<string, unknown>>
): boolean {
  return listPathOperations(openapi).some(
    (item) => item.operation.operationId === "release"
  );
}

/** @internal */
export function assertSemanticReleaseRelations(
  snapshot: SemanticReleaseSnapshot
): void {
  const registryIds = snapshot.registry.map((item) => item.operationId);
  const toolIds = snapshot.tools.map((item) => item.name);
  if (
    hasReservedOperationId(snapshot.openapi) ||
    new Set(toolIds).size !== toolIds.length ||
    canonicalJson(registryIds) !== canonicalJson(toolIds) ||
    canonicalJson(expectedRouteFacts(snapshot.openapi)) !==
      canonicalJson(
        deriveRouteFacts(snapshot.registry, snapshot.privateCapabilities)
      )
  ) {
    throw new Error("invalid_snapshot_relations");
  }
}

function parseSemanticSnapshot(value: unknown): SemanticReleaseSnapshot {
  const source = record(value);
  exactKeys(source, snapshotKeys);
  if (
    source.compilerVersion !== "0.1.0" ||
    (source.environment !== "staging" && source.environment !== "production") ||
    typeof source.aggregateEtag !== "string" ||
    !source.aggregateEtag
  ) {
    throw new Error("invalid_snapshot_facts");
  }
  const release = parseRelease({
    admissionModel: source.admissionModel,
    aggregateEtag: source.aggregateEtag,
    authPermissions: source.authPermissions,
    privateCapabilities: source.privateCapabilities,
    protocolVersion: source.protocolVersion,
    registry: source.registry,
    schemaVersion: source.schemaVersion,
  });
  if (
    [...release.registry, ...release.privateCapabilities].some(
      (capability) => capability.operationId === "release"
    )
  ) {
    throw new Error("invalid_snapshot_facts");
  }
  const openapi = cloneOpenApi(assertOpenApi31(record(source.openapi)));
  if (hasReservedOperationId(openapi)) {
    throw new Error("invalid_snapshot_facts");
  }
  const snapshot: SemanticReleaseSnapshot = {
    ...release,
    compilerVersion: source.compilerVersion,
    environment: source.environment,
    openapi,
    tools: parseReleaseTools(source.tools),
  };
  assertSemanticReleaseRelations(snapshot);
  return snapshot;
}

export function parseSemanticReleaseSnapshot(
  value: unknown
): SemanticReleaseSnapshot {
  try {
    return parseSemanticSnapshot(value);
  } catch (error) {
    throw new Error("invalid_previous_release", { cause: error });
  }
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, item]) => [key, sortedValue(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function semanticReleaseIdentity(
  snapshot: SemanticReleaseSnapshot
): string {
  return sha256(
    canonicalJson({
      admissionModel: snapshot.admissionModel,
      aggregateEtag: snapshot.aggregateEtag,
      aggregateSha256: sha256(canonicalJson(snapshot.openapi)),
      authPermissions: snapshot.authPermissions,
      compilerVersion: snapshot.compilerVersion,
      environment: snapshot.environment,
      privateCapabilities: snapshot.privateCapabilities,
      protocolVersion: snapshot.protocolVersion,
      registry: snapshot.registry,
      routes: deriveRouteFacts(snapshot.registry, snapshot.privateCapabilities),
      schemaVersion: snapshot.schemaVersion,
      tools: snapshot.tools,
    })
  );
}

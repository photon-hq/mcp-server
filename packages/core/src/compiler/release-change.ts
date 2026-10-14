import {
  type Capability,
  compareUtf8,
  normalizeJsonMediaType,
  normalizeSuccessMediaType,
} from "../release.js";
import {
  canonicalJson,
  type SemanticReleaseSnapshot,
} from "./release-snapshot.js";
import { listPathOperations } from "./schema.js";

export interface ChangeReport {
  readonly changes: readonly SemanticChange[];
  readonly decision: "automatic" | "review";
  readonly schemaVersion: 1;
}

type ChangeDecision = "automatic" | "review";

export interface RepresentationKey {
  readonly mediaType: string | null;
  readonly status: number;
}

export type SemanticChange =
  | Readonly<{
      decision: "automatic";
      kind: "operation_added";
      operationId: string;
    }>
  | Readonly<{
      decision: "review";
      kind: "operation_removed";
      operationId: string;
    }>
  | Readonly<{
      candidateOperationId: string;
      decision: "review";
      kind: "operation_renamed";
      operationId: string;
    }>
  | Readonly<{
      candidateEnabled: boolean;
      decision: "review";
      kind: "enablement_changed";
      operationId: string;
      previousEnabled: boolean;
    }>
  | Readonly<{
      decision: "review";
      kind:
        | "method_changed"
        | "path_changed"
        | "permissions_changed"
        | "idempotency_changed"
        | "operationGetter_changed"
        | "operationPollLimit_changed"
        | "hints_changed";
      operationId: string;
    }>
  | Readonly<{
      decision: "automatic";
      kind: "input_schema_extended" | "description_changed";
      operationId: string;
    }>
  | Readonly<{
      decision: "review";
      kind: "input_schema_incompatible";
      operationId: string;
    }>
  | Readonly<{
      candidateMediaType: string | null;
      decision: "review";
      kind: "request_media_type_changed";
      operationId: string;
      previousMediaType: string | null;
    }>
  | Readonly<{
      decision: "automatic";
      kind: "success_responses_added" | "success_response_schemas_extended";
      operationId: string;
      representations: readonly RepresentationKey[];
    }>
  | Readonly<{
      decision: "review";
      kind:
        | "success_responses_removed"
        | "success_response_schemas_incompatible";
      operationId: string;
      representations: readonly RepresentationKey[];
    }>
  | Readonly<{
      decision: "review";
      kind: "authPermissions_changed";
      operationId: "release";
    }>;

const contracts = {
  authPermissions_changed: ["review", []],
  description_changed: ["automatic", []],
  enablement_changed: ["review", ["previousEnabled", "candidateEnabled"]],
  hints_changed: ["review", []],
  idempotency_changed: ["review", []],
  input_schema_extended: ["automatic", []],
  input_schema_incompatible: ["review", []],
  method_changed: ["review", []],
  operation_added: ["automatic", []],
  operation_removed: ["review", []],
  operation_renamed: ["review", ["candidateOperationId"]],
  operationGetter_changed: ["review", []],
  operationPollLimit_changed: ["review", []],
  path_changed: ["review", []],
  permissions_changed: ["review", []],
  request_media_type_changed: [
    "review",
    ["previousMediaType", "candidateMediaType"],
  ],
  success_response_schemas_extended: ["automatic", ["representations"]],
  success_response_schemas_incompatible: ["review", ["representations"]],
  success_responses_added: ["automatic", ["representations"]],
  success_responses_removed: ["review", ["representations"]],
} as const;

type ChangeKind = keyof typeof contracts;

interface OperationFacts {
  readonly enabled: boolean;
  readonly method: string;
  readonly operationId: string;
  readonly pathTemplate: string;
}

function operationFacts(
  release: SemanticReleaseSnapshot
): Map<string, OperationFacts> {
  const facts = new Map<string, OperationFacts>();
  for (const item of listPathOperations(release.openapi)) {
    const { operationId } = item.operation;
    if (typeof operationId !== "string") {
      continue;
    }
    const extension = item.operation["x-photon-mcp"];
    const enabled = !(
      extension !== null &&
      typeof extension === "object" &&
      !Array.isArray(extension) &&
      (extension as { enabled?: unknown }).enabled === false
    );
    facts.set(operationId, {
      enabled,
      method: item.method,
      operationId,
      pathTemplate: item.pathTemplate,
    });
  }
  return facts;
}

function byOperationId(
  registry: readonly Capability[]
): ReadonlyMap<string, Capability> {
  return new Map(registry.map((item) => [item.operationId, item]));
}

function byToolDescription(
  release: SemanticReleaseSnapshot
): ReadonlyMap<string, string> {
  return new Map(release.tools.map((tool) => [tool.name, tool.description]));
}

function lifecycleFacts(
  routeFacts: ReadonlyMap<string, OperationFacts>,
  publicCapabilities: ReadonlyMap<string, Capability>,
  privateGetterIds: ReadonlySet<string>
): Map<string, OperationFacts> {
  const facts = new Map(routeFacts);
  for (const operationId of privateGetterIds) {
    if (!publicCapabilities.has(operationId)) {
      facts.delete(operationId);
    }
  }
  return facts;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const extensibleSchemaMapKeys = new Set(["properties", "$defs"]);
type SchemaDirection = "input" | "output";

function compatibleSchemaMap(
  before: unknown,
  after: unknown,
  direction: SchemaDirection
): boolean {
  if (
    before === null ||
    after === null ||
    Array.isArray(before) ||
    Array.isArray(after) ||
    typeof before !== "object" ||
    typeof after !== "object"
  ) {
    return false;
  }
  const candidateMap = after as Record<string, unknown>;
  return Object.entries(before).every(
    ([name, schema]) =>
      Object.hasOwn(candidateMap, name) &&
      schemaCompatible(schema, candidateMap[name], direction)
  );
}

function compatibleSet(
  before: unknown,
  after: unknown,
  direction: SchemaDirection
): boolean {
  if (!(Array.isArray(before) && Array.isArray(after))) {
    return false;
  }
  const required = direction === "input" ? after : before;
  const available = direction === "input" ? before : after;
  return required.every((item) =>
    available.some((candidate) => same(item, candidate))
  );
}

function compatibleEnum(
  before: unknown,
  after: unknown,
  direction: SchemaDirection
): boolean {
  return compatibleSet(after, before, direction);
}

function compatibleSchemaObject(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  direction: SchemaDirection
): boolean {
  for (const [key, value] of Object.entries(before)) {
    if (!Object.hasOwn(after, key)) {
      return false;
    }
    if (key === "enum") {
      if (!compatibleEnum(value, after[key], direction)) {
        return false;
      }
    } else if (key === "required") {
      if (!compatibleSet(value, after[key], direction)) {
        return false;
      }
    } else if (extensibleSchemaMapKeys.has(key)) {
      if (!compatibleSchemaMap(value, after[key], direction)) {
        return false;
      }
    } else if (!schemaCompatible(value, after[key], direction)) {
      return false;
    }
  }
  return Object.keys(after).every(
    (key) => Object.hasOwn(before, key) || extensibleSchemaMapKeys.has(key)
  );
}

function schemaCompatible(
  before: unknown,
  after: unknown,
  direction: SchemaDirection
): boolean {
  if (same(before, after)) {
    return true;
  }
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return false;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return false;
  }
  return compatibleSchemaObject(
    before as Readonly<Record<string, unknown>>,
    after as Readonly<Record<string, unknown>>,
    direction
  );
}

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("invalid_record");
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !enumerableDataDescriptor(Object.getOwnPropertyDescriptor(value, key))
    )
  ) {
    throw new Error("invalid_keys");
  }
}

function enumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return (
    descriptor?.enumerable === true &&
    Object.hasOwn(descriptor, "value") &&
    !Object.hasOwn(descriptor, "get") &&
    !Object.hasOwn(descriptor, "set")
  );
}

function dataValue(
  value: Readonly<Record<string, unknown>>,
  key: string
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!enumerableDataDescriptor(descriptor)) {
    throw new Error("invalid_key");
  }
  return descriptor.value;
}

function compareRepresentation(
  left: RepresentationKey,
  right: RepresentationKey
): number {
  if (left.status !== right.status) {
    return left.status - right.status;
  }
  if (left.mediaType === null) {
    return right.mediaType === null ? 0 : -1;
  }
  return right.mediaType === null
    ? 1
    : compareUtf8(left.mediaType, right.mediaType);
}

function parseRepresentations(value: unknown): readonly RepresentationKey[] {
  if (!denseArray(value) || value.length === 0) {
    throw new Error("invalid_representations");
  }
  const representations = value.map((item) => {
    const representation = record(item);
    exactKeys(representation, ["mediaType", "status"]);
    const { status } = representation;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 299
    ) {
      throw new Error("invalid_representation");
    }
    if (status === 204) {
      if (representation.mediaType !== null) {
        throw new Error("invalid_representation");
      }
      return { mediaType: null, status };
    }
    if (
      typeof representation.mediaType !== "string" ||
      normalizeSuccessMediaType(representation.mediaType) !==
        representation.mediaType
    ) {
      throw new Error("invalid_representation");
    }
    return {
      mediaType: representation.mediaType,
      status,
    };
  });
  for (const [index, representation] of representations.entries()) {
    if (
      index > 0 &&
      compareRepresentation(
        representations[index - 1] ?? representation,
        representation
      ) >= 0
    ) {
      throw new Error("invalid_representations");
    }
  }
  return representations;
}

function denseArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (
      !enumerableDataDescriptor(
        Object.getOwnPropertyDescriptor(value, String(index))
      )
    ) {
      return false;
    }
  }
  return true;
}

function parseMediaType(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || normalizeJsonMediaType(value) !== value) {
    throw new Error("invalid_media_type");
  }
  return value;
}

function parseChange(value: unknown): SemanticChange {
  const change = record(value);
  const kindValue = dataValue(change, "kind");
  if (typeof kindValue !== "string" || !Object.hasOwn(contracts, kindValue)) {
    throw new Error("invalid_kind");
  }
  const kind = kindValue as ChangeKind;
  const [decision, detailKeys] = contracts[kind];
  exactKeys(change, ["decision", "kind", "operationId", ...detailKeys]);
  if (
    change.decision !== decision ||
    typeof change.operationId !== "string" ||
    !operationIdPattern.test(change.operationId)
  ) {
    throw new Error("invalid_change");
  }
  if (
    (change.operationId === "release") !==
    (kind === "authPermissions_changed")
  ) {
    throw new Error("invalid_change");
  }
  if (
    kind === "operation_renamed" &&
    (typeof change.candidateOperationId !== "string" ||
      !operationIdPattern.test(change.candidateOperationId) ||
      change.candidateOperationId === "release" ||
      change.candidateOperationId === change.operationId)
  ) {
    throw new Error("invalid_change");
  }
  if (
    kind === "enablement_changed" &&
    (typeof change.previousEnabled !== "boolean" ||
      typeof change.candidateEnabled !== "boolean" ||
      change.previousEnabled === change.candidateEnabled)
  ) {
    throw new Error("invalid_change");
  }
  if (
    kind === "request_media_type_changed" &&
    parseMediaType(change.previousMediaType) ===
      parseMediaType(change.candidateMediaType)
  ) {
    throw new Error("invalid_change");
  }
  const representations = Object.hasOwn(change, "representations")
    ? parseRepresentations(dataValue(change, "representations"))
    : undefined;
  return Object.freeze({
    ...change,
    ...(representations === undefined ? {} : { representations }),
  }) as SemanticChange;
}

export function parseChangeReport(value: unknown): ChangeReport {
  try {
    const report = record(value);
    exactKeys(report, ["changes", "decision", "schemaVersion"]);
    if (
      report.schemaVersion !== 1 ||
      !denseArray(report.changes) ||
      (report.decision !== "automatic" && report.decision !== "review")
    ) {
      throw new Error("invalid_report");
    }
    const changes = report.changes.map(parseChange);
    for (const [index, current] of changes.entries()) {
      const previous = changes[index - 1] ?? current;
      if (index === 0) {
        continue;
      }
      if (
        compareUtf8(previous.operationId, current.operationId) > 0 ||
        (previous.operationId === current.operationId &&
          compareUtf8(previous.kind, current.kind) >= 0)
      ) {
        throw new Error("invalid_order");
      }
    }
    const decision: ChangeDecision = changes.some(
      (change) => change.decision === "review"
    )
      ? "review"
      : "automatic";
    if (report.decision !== decision) {
      throw new Error("invalid_decision");
    }
    return { changes, decision, schemaVersion: 1 };
  } catch (error) {
    throw new Error("invalid_change_report", { cause: error });
  }
}

function addChange(
  changes: SemanticChange[],
  kind: string,
  operationId: string,
  decision: ChangeDecision,
  detail: Readonly<Record<string, unknown>> = {}
): void {
  if (
    !changes.some(
      (change) => change.operationId === operationId && change.kind === kind
    )
  ) {
    changes.push({ decision, kind, operationId, ...detail } as SemanticChange);
  }
}

interface RenameSets {
  readonly after: ReadonlySet<string>;
  readonly before: ReadonlySet<string>;
}

function collectRenames(
  changes: SemanticChange[],
  beforeFacts: ReadonlyMap<string, OperationFacts>,
  afterFacts: ReadonlyMap<string, OperationFacts>
): RenameSets {
  const before = new Set<string>();
  const after = new Set<string>();
  for (const [oldId, oldFacts] of beforeFacts) {
    if (afterFacts.has(oldId)) {
      continue;
    }
    const renamed = [...afterFacts.values()].find(
      (item) =>
        !beforeFacts.has(item.operationId) &&
        item.method === oldFacts.method &&
        item.pathTemplate === oldFacts.pathTemplate
    );
    if (renamed) {
      before.add(oldId);
      after.add(renamed.operationId);
      addChange(changes, "operation_renamed", oldId, "review", {
        candidateOperationId: renamed.operationId,
      });
    }
  }
  return { after, before };
}

function compareOperationFacts(
  changes: SemanticChange[],
  operationId: string,
  before: OperationFacts,
  after: OperationFacts
): void {
  if (before.enabled !== after.enabled) {
    addChange(changes, "enablement_changed", operationId, "review", {
      candidateEnabled: after.enabled,
      previousEnabled: before.enabled,
    });
  }
  if (before.method !== after.method) {
    addChange(changes, "method_changed", operationId, "review");
  }
  if (before.pathTemplate !== after.pathTemplate) {
    addChange(changes, "path_changed", operationId, "review");
  }
}

interface RepresentationFact {
  readonly key: RepresentationKey;
  readonly schema: unknown;
}

function representationFacts(
  capability: Capability
): ReadonlyMap<string, RepresentationFact> {
  return new Map(
    capability.successRepresentations.map((representation) => {
      const key: RepresentationKey =
        "mediaType" in representation
          ? {
              mediaType: representation.mediaType,
              status: representation.status,
            }
          : { mediaType: null, status: 204 };
      return [
        `${key.status}\u0000${key.mediaType ?? ""}`,
        {
          key,
          schema:
            "schema" in representation ? representation.schema : undefined,
        },
      ] as const;
    })
  );
}

function addRepresentationChange(
  changes: SemanticChange[],
  operationId: string,
  kind:
    | "success_responses_added"
    | "success_responses_removed"
    | "success_response_schemas_extended"
    | "success_response_schemas_incompatible",
  decision: ChangeDecision,
  representation: RepresentationKey
): void {
  const existing = changes.find(
    (change) => change.operationId === operationId && change.kind === kind
  );
  if (existing && "representations" in existing) {
    const representations = existing.representations as RepresentationKey[];
    if (
      !representations.some(
        (candidate) => compareRepresentation(candidate, representation) === 0
      )
    ) {
      representations.push(representation);
    }
  } else {
    addChange(changes, kind, operationId, decision, {
      representations: [representation],
    });
  }
}

function compareInputAndRequest(
  changes: SemanticChange[],
  operationId: string,
  before: Capability,
  after: Capability
): void {
  if (!same(before.inputSchema, after.inputSchema)) {
    const compatible = schemaCompatible(
      before.inputSchema,
      after.inputSchema,
      "input"
    );
    addChange(
      changes,
      compatible ? "input_schema_extended" : "input_schema_incompatible",
      operationId,
      compatible ? "automatic" : "review"
    );
  }
  if (!same(before.requestMediaType, after.requestMediaType)) {
    addChange(changes, "request_media_type_changed", operationId, "review", {
      candidateMediaType: after.requestMediaType ?? null,
      previousMediaType: before.requestMediaType ?? null,
    });
  }
}

function compareCapabilitySchemas(
  changes: SemanticChange[],
  operationId: string,
  before: Capability,
  after: Capability
): void {
  compareInputAndRequest(changes, operationId, before, after);
  const previous = representationFacts(before);
  const candidate = representationFacts(after);
  for (const [key, value] of previous) {
    const next = candidate.get(key);
    if (!next) {
      addRepresentationChange(
        changes,
        operationId,
        "success_responses_removed",
        "review",
        value.key
      );
    } else if (!same(value.schema, next.schema)) {
      addRepresentationChange(
        changes,
        operationId,
        schemaCompatible(value.schema, next.schema, "output")
          ? "success_response_schemas_extended"
          : "success_response_schemas_incompatible",
        schemaCompatible(value.schema, next.schema, "output")
          ? "automatic"
          : "review",
        value.key
      );
    }
  }
  for (const [key, value] of candidate) {
    if (!previous.has(key)) {
      addRepresentationChange(
        changes,
        operationId,
        "success_responses_added",
        "automatic",
        value.key
      );
    }
  }
}

function compareCapability(
  changes: SemanticChange[],
  operationId: string,
  before: Capability,
  after: Capability
): void {
  compareCapabilitySchemas(changes, operationId, before, after);
  if (!same(before.requiredPermissions, after.requiredPermissions)) {
    addChange(changes, "permissions_changed", operationId, "review");
  }
  if (
    !(
      same(before.idempotency, after.idempotency) &&
      same(before.idempotencyKeySchema, after.idempotencyKeySchema)
    )
  ) {
    addChange(changes, "idempotency_changed", operationId, "review");
  }
  for (const field of ["operationGetter", "operationPollLimit"] as const) {
    if (!same(before[field], after[field])) {
      addChange(changes, `${field}_changed`, operationId, "review");
    }
  }
  if (
    (before.annotations.readOnlyHint && !after.annotations.readOnlyHint) ||
    (before.annotations.idempotentHint && !after.annotations.idempotentHint) ||
    (!before.annotations.destructiveHint && after.annotations.destructiveHint)
  ) {
    addChange(changes, "hints_changed", operationId, "review");
  }
}

function compareDescription(
  changes: SemanticChange[],
  operationId: string,
  before: string,
  after: string
): void {
  if (before === after) {
    return;
  }
  addChange(changes, "description_changed", operationId, "automatic");
}

function comparePrivateGetterRouteFacts(
  changes: SemanticChange[],
  operationId: string,
  before: OperationFacts,
  after: OperationFacts
): void {
  if (before.pathTemplate !== after.pathTemplate) {
    addChange(changes, "path_changed", operationId, "review");
  }
}

function compareLinkedPrivateGetter(
  changes: SemanticChange[],
  operationId: string,
  before: Capability,
  after: Capability,
  previousCapabilities: ReadonlyMap<string, Capability>,
  candidateCapabilities: ReadonlyMap<string, Capability>,
  previousPrivateCapabilities: ReadonlyMap<string, Capability>,
  candidatePrivateCapabilities: ReadonlyMap<string, Capability>,
  previousRouteFacts: ReadonlyMap<string, OperationFacts>,
  candidateRouteFacts: ReadonlyMap<string, OperationFacts>
): void {
  if (before.operationGetter !== after.operationGetter) {
    return;
  }
  const getterId = before.operationGetter;
  if (!getterId) {
    return;
  }
  const oldGetter = previousPrivateCapabilities.get(getterId);
  const newGetter = candidatePrivateCapabilities.get(getterId);
  if (oldGetter && newGetter) {
    compareCapability(changes, operationId, oldGetter, newGetter);
    const oldRouteFact = previousRouteFacts.get(getterId);
    const newRouteFact = candidateRouteFacts.get(getterId);
    if (oldRouteFact && newRouteFact) {
      comparePrivateGetterRouteFacts(
        changes,
        operationId,
        oldRouteFact,
        newRouteFact
      );
    }
  } else if (
    (oldGetter || newGetter) &&
    !previousCapabilities.has(getterId) &&
    !candidateCapabilities.has(getterId)
  ) {
    addChange(changes, "operationGetter_changed", operationId, "review");
  }
}

function compareExistingOperation(
  changes: SemanticChange[],
  operationId: string,
  before: OperationFacts,
  after: OperationFacts,
  previousCapabilities: ReadonlyMap<string, Capability>,
  candidateCapabilities: ReadonlyMap<string, Capability>,
  previousPrivateCapabilities: ReadonlyMap<string, Capability>,
  candidatePrivateCapabilities: ReadonlyMap<string, Capability>,
  previousRouteFacts: ReadonlyMap<string, OperationFacts>,
  candidateRouteFacts: ReadonlyMap<string, OperationFacts>,
  previousDescriptions: ReadonlyMap<string, string>,
  candidateDescriptions: ReadonlyMap<string, string>
): void {
  compareOperationFacts(changes, operationId, before, after);
  const oldCapability = previousCapabilities.get(operationId);
  const newCapability = candidateCapabilities.get(operationId);
  if (!(oldCapability && newCapability)) {
    return;
  }
  compareCapability(changes, operationId, oldCapability, newCapability);
  compareLinkedPrivateGetter(
    changes,
    operationId,
    oldCapability,
    newCapability,
    previousCapabilities,
    candidateCapabilities,
    previousPrivateCapabilities,
    candidatePrivateCapabilities,
    previousRouteFacts,
    candidateRouteFacts
  );
  compareDescription(
    changes,
    operationId,
    previousDescriptions.get(operationId) ?? "",
    candidateDescriptions.get(operationId) ?? ""
  );
}

export function diffRelease(
  previous: SemanticReleaseSnapshot,
  candidate: SemanticReleaseSnapshot
): ChangeReport {
  const changes: SemanticChange[] = [];
  const previousRouteFacts = operationFacts(previous);
  const candidateRouteFacts = operationFacts(candidate);
  const previousCapabilities = byOperationId(previous.registry);
  const candidateCapabilities = byOperationId(candidate.registry);
  const previousPrivateCapabilities = byOperationId(
    previous.privateCapabilities
  );
  const candidatePrivateCapabilities = byOperationId(
    candidate.privateCapabilities
  );
  const privateGetterIds = new Set([
    ...previousPrivateCapabilities.keys(),
    ...candidatePrivateCapabilities.keys(),
  ]);
  const beforeFacts = lifecycleFacts(
    previousRouteFacts,
    previousCapabilities,
    privateGetterIds
  );
  const afterFacts = lifecycleFacts(
    candidateRouteFacts,
    candidateCapabilities,
    privateGetterIds
  );
  const previousDescriptions = byToolDescription(previous);
  const candidateDescriptions = byToolDescription(candidate);
  const renames = collectRenames(changes, beforeFacts, afterFacts);

  if (!same(previous.authPermissions, candidate.authPermissions)) {
    addChange(changes, "authPermissions_changed", "release", "review");
  }
  for (const [operationId, before] of beforeFacts) {
    const after = afterFacts.get(operationId);
    if (!after) {
      if (!renames.before.has(operationId)) {
        addChange(changes, "operation_removed", operationId, "review");
      }
      continue;
    }
    compareExistingOperation(
      changes,
      operationId,
      before,
      after,
      previousCapabilities,
      candidateCapabilities,
      previousPrivateCapabilities,
      candidatePrivateCapabilities,
      previousRouteFacts,
      candidateRouteFacts,
      previousDescriptions,
      candidateDescriptions
    );
  }

  for (const operationId of afterFacts.keys()) {
    if (!(beforeFacts.has(operationId) || renames.after.has(operationId))) {
      addChange(changes, "operation_added", operationId, "automatic");
    }
  }
  changes.sort((left, right) => {
    const operationOrder = compareUtf8(left.operationId, right.operationId);
    return operationOrder || compareUtf8(left.kind, right.kind);
  });
  for (const change of changes) {
    if ("representations" in change) {
      (change.representations as RepresentationKey[]).sort(
        compareRepresentation
      );
    }
  }
  return parseChangeReport({
    changes,
    decision: changes.some((change) => change.decision === "review")
      ? "review"
      : "automatic",
    schemaVersion: 1,
  });
}

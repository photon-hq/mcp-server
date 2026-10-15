import { isMcpOperationAdmitted, parseMcpExtension } from "./extension.js";
import { operationGetterLink, type PathOperation } from "./schema.js";

// Consumers deliberately schedule these phases separately: compilation checks
// permissions before admission; snapshots check all admitted routes before links.
export function indexOperations(
  operations: readonly PathOperation[],
  consumer: "compiler" | "snapshot"
): ReadonlyMap<string, PathOperation> {
  const operationsById = new Map<string, PathOperation>();
  for (const operation of operations) {
    const { operationId } = operation.operation;
    if (typeof operationId !== "string") {
      continue;
    }
    // Snapshots reject reserved IDs in their earlier snapshot-facts phase.
    if (consumer === "compiler" && operationId === "release") {
      throw new Error("reserved_operation_id");
    }
    if (operationsById.has(operationId)) {
      throw new Error(
        consumer === "compiler"
          ? "duplicate_operation_id"
          : "invalid_registry_route"
      );
    }
    operationsById.set(operationId, operation);
  }
  return operationsById;
}

export function admittedOperations(operations: readonly PathOperation[]) {
  // Parse every extension before filtering so malformed excluded metadata fails.
  return operations
    .map((pathOperation) => ({
      extension: parseMcpExtension(pathOperation.operation["x-photon-mcp"]),
      pathOperation,
    }))
    .filter(({ extension }) => isMcpOperationAdmitted(extension));
}

export function recognizedOperationGetter(
  pathOperation: PathOperation,
  operationsById: ReadonlyMap<string, PathOperation>
): string | undefined {
  const getter = operationGetterLink(pathOperation.operation);
  if (!getter) {
    return;
  }
  const target = operationsById.get(getter);
  if (
    !(
      target &&
      target.method === "GET" &&
      target.pathTemplate.includes("{projectId}") &&
      target.pathTemplate.includes("{operationId}")
    )
  ) {
    throw new Error("invalid_operation_getter");
  }
  return getter;
}

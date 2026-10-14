import {
  type InputRequiredResult,
  inputRequired,
} from "@modelcontextprotocol/server";
import {
  InvocationError,
  invokeRegistryTarget,
  isSafePathValue,
} from "../invoke.js";
import type {
  CapabilityExecutionRequest,
  RuntimeDependencies,
} from "./index.js";
import { errorResult, mapResponse, type Result } from "./response.js";

export type LifecycleDisposition = "cancelled" | "expired" | "rejected";

export type StateDisposition =
  | Readonly<{
      kind: "continue";
    }>
  | Readonly<{
      disposition?: LifecycleDisposition;
      kind: "outcome";
      outcome: Result;
    }>;

const stateHash = /^[a-f0-9]{64}$/u;

function emit(
  dependencies: RuntimeDependencies,
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  value?: number
): void {
  dependencies.event?.(name, attributes, value);
}

async function traced<T>(
  dependencies: RuntimeDependencies,
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  callback: () => T | Promise<T>
): Promise<T> {
  return dependencies.span
    ? dependencies.span(name, attributes, callback)
    : await callback();
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function canonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  throw new Error("invalid_input");
}

function stateExpired(
  state: Readonly<Record<string, unknown>>,
  now: number
): boolean {
  return typeof state.expiresAt === "number" && state.expiresAt <= now;
}

function idempotencyKey(dependencies: RuntimeDependencies): string {
  return Array.from(dependencies.randomBytes(16), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function continuationStateMatches(
  state: Readonly<Record<string, unknown>>,
  request: CapabilityExecutionRequest,
  now: number
): boolean {
  return (
    state.version === 1 &&
    state.class === "continuation" &&
    state.subject === request.auth.subject &&
    state.accountId === request.auth.accountId &&
    state.releaseIdentity === request.releaseIdentity &&
    typeof state.inputHash === "string" &&
    stateHash.test(state.inputHash) &&
    state.sourceOperationId === request.execution.capability.operationId &&
    state.getterOperationId ===
      request.operationGetter?.capability.operationId &&
    state.getterMethod === request.operationGetter?.capability.method &&
    state.getterPathTemplate ===
      request.operationGetter?.capability.pathTemplate &&
    isSafePathValue(state.operationId) &&
    isSafePathValue(state.projectId) &&
    (request.execution.capability.idempotency === "header"
      ? typeof state.idempotencyKey === "string"
      : state.idempotencyKey === undefined) &&
    typeof state.issuedAt === "number" &&
    state.issuedAt <= now &&
    typeof state.expiresAt === "number" &&
    state.expiresAt > now
  );
}

async function continuation(
  response: Response,
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies,
  hash: string,
  key?: string
): Promise<Result | undefined> {
  if (response.status !== 202) {
    return;
  }
  const getter = request.operationGetter;
  if (
    request.execution.capability.operationGetter === undefined ||
    getter === undefined
  ) {
    response.body?.cancel().catch(() => undefined);
    return errorResult("upstream_contract_violation");
  }
  const mapped = await mapResponse(response, request.execution);
  if (mapped.isError === true) {
    return mapped;
  }
  const output = object(mapped.structuredContent);
  const data = object(output.data);
  const operation = object(data.operation ?? data);
  if (
    !(
      isSafePathValue(operation.operationId) &&
      isSafePathValue(operation.projectId)
    )
  ) {
    return errorResult("upstream_contract_violation");
  }
  const now = dependencies.now();
  return pendingOperation(
    output,
    await dependencies.stateCodec.mint({
      accountId: request.auth.accountId,
      class: "continuation",
      expiresAt: now + dependencies.requestStateTtlMilliseconds,
      getterMethod: getter.capability.method,
      getterOperationId: getter.capability.operationId,
      getterPathTemplate: getter.capability.pathTemplate,
      idempotencyKey: key,
      inputHash: hash,
      issuedAt: now,
      operationId: operation.operationId,
      projectId: operation.projectId,
      releaseIdentity: request.releaseIdentity,
      sourceOperationId: request.execution.capability.operationId,
      subject: request.auth.subject,
      version: 1,
    })
  );
}

function pendingOperation(
  operation: Readonly<Record<string, unknown>>,
  requestState: string
): InputRequiredResult {
  return {
    ...inputRequired({ requestState }),
    content: [{ text: JSON.stringify(operation), type: "text" }],
    structuredContent: operation,
  } as InputRequiredResult;
}

function terminal(operation: Readonly<Record<string, unknown>>): boolean {
  return ["cancelled", "completed", "failed", "succeeded"].includes(
    operation.state as string
  );
}

async function notifyProgress(
  request: CapabilityExecutionRequest,
  attempt: number,
  limit: number,
  operation: Readonly<Record<string, unknown>>
): Promise<void> {
  if (!request.notifyProgress) {
    return;
  }
  if (request.signal.aborted) {
    throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const notification = Promise.resolve().then(() =>
    request.notifyProgress?.({
      message: [
        "pending",
        "queued",
        "running",
        "cancelled",
        "completed",
        "failed",
        "succeeded",
      ].includes(operation.state as string)
        ? String(operation.state)
        : "pending",
      progress: attempt + 1,
      total: limit,
    })
  );
  notification.catch(() => undefined);
  const aborted = Promise.withResolvers<void>();
  const abort = () =>
    aborted.reject(
      request.signal.reason ?? new DOMException("Aborted", "AbortError")
    );
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([notification, aborted.promise]);
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  } catch {
    if (request.signal.aborted) {
      // biome-ignore lint/style/useErrorCause: cancellation preserves the caller-visible abort reason.
      throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
}

async function pollOperation(
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies,
  state: Readonly<Record<string, unknown>>,
  limit: number,
  deadline: number,
  initialOutput?: Readonly<Record<string, unknown>>
): Promise<Result> {
  const getter = request.operationGetter;
  if (!getter) {
    return errorResult("invalid_request_state");
  }
  let latest: Readonly<Record<string, unknown>> = initialOutput ?? {
    operationId: state.operationId,
    projectId: state.projectId,
  };
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const attributes = {
      "http.request.method": getter.capability.method,
      "http.route": getter.capability.pathTemplate,
      "mcp.tool.name": request.execution.capability.operationId,
      "retry.attempt": attempt + 1,
    };
    emit(dependencies, "photon.mcp.operation.polls", attributes, 1);
    let mapped: Result;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: operation polls are intentionally sequential and bounded.
      const response = await traced(
        dependencies,
        "photon.operation.poll",
        attributes,
        () =>
          invokeRegistryTarget(
            {
              ...request,
              capability: getter.capability,
              deadline,
              input: {
                path: {
                  operationId: state.operationId,
                  projectId: state.projectId,
                },
              },
            },
            dependencies
          )
      );
      mapped = await mapResponse(response, getter);
    } catch (error) {
      if (request.signal.aborted) {
        emit(dependencies, "photon.mcp.operation.polls", {
          ...attributes,
          "mcp.result": "cancelled",
        });
        throw error;
      }
      if (
        error instanceof InvocationError &&
        error.code === "deadline_exceeded"
      ) {
        break;
      }
      throw error;
    }
    if (mapped.isError === true) {
      return mapped;
    }
    latest = object(mapped.structuredContent);
    const data = object(latest.data);
    const operation = object(data.operation ?? data);
    await notifyProgress(request, attempt, limit, operation);
    if (terminal(operation)) {
      emit(dependencies, "photon.mcp.operation.polls", {
        ...attributes,
        "mcp.result":
          operation.state === "cancelled" ? "cancelled" : "terminal",
      });
      return mapped;
    }
  }
  emit(dependencies, "photon.mcp.operation.polls", {
    "mcp.result": "pending",
    "mcp.tool.name": request.execution.capability.operationId,
  });
  return pendingOperation(
    latest,
    await dependencies.stateCodec.mint({
      ...state,
      expiresAt: dependencies.now() + dependencies.requestStateTtlMilliseconds,
    })
  );
}

type VerifiedStateResolution =
  | Readonly<{
      kind: "resolved";
      source?: "continuation" | "sdk";
      state?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      disposition: LifecycleDisposition;
      kind: "rejected";
      outcome: Result;
    }>;

async function resolveVerifiedState(
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies
): Promise<VerifiedStateResolution> {
  const { continuation: continuationToken, sdkRequestState } =
    request.protocolFacts;
  if (continuationToken === undefined) {
    return sdkRequestState === undefined
      ? { kind: "resolved" }
      : { kind: "resolved", source: "sdk", state: object(sdkRequestState) };
  }
  try {
    const continuationState =
      await dependencies.stateCodec.verify(continuationToken);
    if (
      sdkRequestState !== undefined &&
      JSON.stringify(canonical(continuationState)) !==
        JSON.stringify(canonical(sdkRequestState))
    ) {
      return {
        disposition: "rejected",
        kind: "rejected",
        outcome: errorResult("invalid_request_state"),
      };
    }
    return {
      kind: "resolved",
      source: "continuation",
      state: object(continuationState),
    };
  } catch {
    return {
      disposition: "rejected",
      kind: "rejected",
      outcome: errorResult("invalid_request_state"),
    };
  }
}

function exclusiveContinuationInput(input: unknown): boolean {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    return false;
  }
  const source = input as Record<string, unknown>;
  return (
    Object.keys(source).length === 1 &&
    typeof source.continuation === "string" &&
    source.continuation.length > 0
  );
}

export async function resolveStateDisposition(
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies,
  deadline: number
): Promise<StateDisposition> {
  const resolution = await resolveVerifiedState(request, dependencies);
  if (resolution.kind === "rejected") {
    return {
      disposition: resolution.disposition,
      kind: "outcome",
      outcome: resolution.outcome,
    };
  }
  const { source, state } = resolution;
  if (state === undefined) {
    return source === "continuation"
      ? {
          disposition: "rejected",
          kind: "outcome",
          outcome: errorResult("invalid_request_state"),
        }
      : { kind: "continue" };
  }
  if (state.class === "continuation") {
    const now = dependencies.now();
    if (
      (source === "continuation" &&
        !exclusiveContinuationInput(request.input)) ||
      !continuationStateMatches(state, request, now)
    ) {
      const lifecycleResult = stateExpired(state, now) ? "expired" : "rejected";
      return {
        disposition: lifecycleResult,
        kind: "outcome",
        outcome: errorResult("invalid_request_state"),
      };
    }
    return {
      kind: "outcome",
      outcome: await pollOperation(
        request,
        dependencies,
        state,
        request.execution.capability.operationPollLimit ?? 1,
        deadline
      ),
    };
  }
  return {
    disposition: "rejected",
    kind: "outcome",
    outcome: errorResult("invalid_request_state"),
  };
}

export async function invokeAndContinue(
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies,
  deadline: number,
  inputHash: string
): Promise<Result> {
  const key =
    request.execution.capability.idempotency === "header"
      ? idempotencyKey(dependencies)
      : undefined;
  if (key !== undefined && !request.execution.validateIdempotencyKey?.(key)) {
    return errorResult("invalid_idempotency_key");
  }
  const response = await invokeRegistryTarget(
    {
      ...request,
      capability: request.execution.capability,
      deadline,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    },
    dependencies
  );
  const pending =
    response.status === 202
      ? await continuation(response, request, dependencies, inputHash, key)
      : undefined;
  if (!pending) {
    return mapResponse(response, request.execution);
  }
  if (pending.resultType !== "input_required") {
    return pending;
  }
  if (typeof pending.requestState !== "string") {
    return errorResult("upstream_contract_violation");
  }
  const state = await dependencies.stateCodec.verify(pending.requestState);
  return pollOperation(
    request,
    dependencies,
    state,
    request.execution.capability.operationPollLimit ?? 1,
    deadline,
    object(pending.structuredContent)
  );
}

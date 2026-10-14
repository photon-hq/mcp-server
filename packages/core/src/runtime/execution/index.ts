import type {
  CallToolResult,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import { type InvocationDependencies, InvocationError } from "../invoke.js";
import type { ExecutionPrincipal } from "../principal.js";
import type { ActivatedRuntimeRelease } from "../runtime-release.js";
import type { Telemetry } from "../telemetry.js";
import {
  errorResult,
  type Result,
  upstreamContractViolation,
} from "./response.js";
import {
  canonical,
  invokeAndContinue,
  type LifecycleDisposition,
  resolveStateDisposition,
} from "./state.js";

export interface RuntimeDependencies extends InvocationDependencies {
  readonly event?: Telemetry["event"];
  readonly randomBytes: (length: number) => Uint8Array;
  readonly record: (
    event: Readonly<{ durationMs?: number; name: string; result: string }>
  ) => void;
  readonly requestStateTtlMilliseconds: number;
  readonly span?: Telemetry["span"];
  readonly stateCodec: Readonly<{
    mint: (value: Readonly<Record<string, unknown>>) => Promise<string>;
    verify: (value: string) => Promise<Readonly<Record<string, unknown>>>;
  }>;
}

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

export interface CapabilityProtocolFacts {
  readonly continuation?: string;
  readonly sdkRequestState?: unknown;
}

export interface CapabilityExecutionRequest {
  readonly auth: ExecutionPrincipal;
  readonly execution: ActivatedRuntimeRelease["registrationPlan"][number]["execution"];
  readonly input: unknown;
  readonly notifyProgress?: (
    update: Readonly<{
      readonly message: string;
      readonly progress: number;
      readonly total: number;
    }>
  ) => Promise<void>;
  readonly operationGetter?: ActivatedRuntimeRelease["registrationPlan"][number]["execution"];
  readonly protocolFacts: CapabilityProtocolFacts;
  readonly releaseIdentity: string;
  readonly signal: AbortSignal;
}

type PolicyExecution = Readonly<{
  disposition?: LifecycleDisposition;
  outcome: Result;
}>;

const encoder = new TextEncoder();
const totalExecutionMilliseconds = 30_000;

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function originalInput(input: unknown): unknown {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    return input;
  }
  const { continuation: _continuation, ...value } = input as Record<
    string,
    unknown
  >;
  return value;
}

async function inputHash(input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(canonical(input)))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function executeCapabilityInner(
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies
): Promise<PolicyExecution> {
  try {
    const deadline = dependencies.now() + totalExecutionMilliseconds;
    const hash = await inputHash(originalInput(request.input));
    const disposition = await resolveStateDisposition(
      request,
      dependencies,
      deadline
    );
    if (disposition.kind === "outcome") {
      return {
        ...(disposition.disposition === undefined
          ? {}
          : { disposition: disposition.disposition }),
        outcome: disposition.outcome,
      };
    }
    return {
      outcome: await invokeAndContinue(request, dependencies, deadline, hash),
    };
  } catch (error) {
    if (request.signal.aborted) {
      throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (error instanceof InvocationError) {
      if (error.code === "upstream_redirect_rejected" && error.upstream) {
        return {
          outcome: upstreamContractViolation(
            error.upstream.status,
            error.upstream.contentType,
            "redirect"
          ),
        };
      }
      return {
        outcome: errorResult(
          error.code === "invalid_path_parameter"
            ? error.code
            : "upstream_contract_violation"
        ),
      };
    }
    return { outcome: errorResult("internal_tool_error") };
  }
}

function toolOutcomeName(
  outcome: Result,
  disposition?: LifecycleDisposition
): string {
  if (disposition !== undefined) {
    return disposition;
  }
  if (outcome.resultType === "input_required") {
    return "pending";
  }
  const data = object(object(outcome.structuredContent).data);
  if (object(data.operation ?? data).state === "cancelled") {
    return "cancelled";
  }
  return outcome.isError === true ? "error" : "complete";
}

export async function executeCapability(
  request: CapabilityExecutionRequest,
  dependencies: RuntimeDependencies
): Promise<CallToolResult | InputRequiredResult> {
  const startedAt = dependencies.now();
  const attributes = {
    "http.request.method": request.execution.capability.method,
    "http.route": request.execution.capability.pathTemplate,
    "mcp.release.version": request.releaseIdentity,
    "mcp.tool.name": request.execution.capability.operationId,
  };
  let execution: PolicyExecution;
  try {
    execution = await traced(dependencies, "mcp.tool.call", attributes, () =>
      executeCapabilityInner(request, dependencies)
    );
    request.signal.throwIfAborted();
  } catch (error) {
    if (request.signal.aborted) {
      dependencies.record({
        durationMs: Math.max(0, dependencies.now() - startedAt),
        name: request.execution.capability.operationId,
        result: "cancelled",
      });
      dependencies.log?.("photon.mcp.tool.event", {
        "mcp.result": "cancelled",
        "mcp.tool.name": request.execution.capability.operationId,
      });
    }
    throw error;
  }
  const { outcome } = execution;
  const structured = object(outcome.structuredContent);
  const outcomeName = toolOutcomeName(outcome, execution.disposition);
  dependencies.record({
    durationMs: Math.max(0, dependencies.now() - startedAt),
    name: request.execution.capability.operationId,
    result: outcomeName,
  });
  const errorType =
    outcome.isError === true && typeof structured.code === "string"
      ? structured.code
      : undefined;
  dependencies.log?.("photon.mcp.tool.event", {
    ...(errorType === undefined ? {} : { "error.type": errorType }),
    "mcp.result": outcomeName,
    "mcp.tool.name": request.execution.capability.operationId,
  });
  if (structured.code === "upstream_contract_violation") {
    emit(
      dependencies,
      "photon.mcp.contract.violations",
      { "error.type": "upstream_contract_violation" },
      1
    );
    dependencies.log?.("photon.mcp.contract.event", {
      "error.type": "upstream_contract_violation",
      "mcp.result": "rejected",
    });
  }
  return outcome;
}

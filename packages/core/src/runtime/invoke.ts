import { reservedHeaderName } from "../headers.js";
import type { Capability } from "../release.js";
import type { ExecutionPrincipal } from "./principal.js";
import type { Telemetry } from "./telemetry.js";

// An origin with no path; every target must resolve back to it.
export type UpstreamUrl = string;
const pathParameter = /\{([^}]+)\}/gu;
const retryAfterDeltaSeconds = /^[0-9]+$/u;
const retryAfterHttpDate =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u;
const retryableStatus = new Set([429, 502, 503, 504]);
const unexpandedPathParameter = /\{[^}]+\}/u;

export class InvocationError extends Error {
  readonly code: string;
  readonly upstream?: Readonly<{ status: number; contentType: string | null }>;

  constructor(
    code: string,
    upstream?: Readonly<{ status: number; contentType: string | null }>
  ) {
    super(code);
    this.code = code;
    if (upstream) {
      this.upstream = upstream;
    }
  }
}

export interface InvocationRequest {
  readonly auth: ExecutionPrincipal;
  readonly capability: Capability;
  readonly deadline: number;
  readonly idempotencyKey?: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
}

export interface InvocationDependencies {
  readonly event?: Telemetry["event"];
  readonly fetchUpstream: (request: Request) => Promise<Response>;
  readonly log?: Telemetry["log"];
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly upstreamUrl: UpstreamUrl;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function isSafePathValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    wellFormedUtf16(value) &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("%") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return false;
    }
  }
  return true;
}

function scalar(value: unknown, code: string): string {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return String(value);
  }
  throw new InvocationError(code);
}

function safePathScalar(value: unknown): string {
  const serialized = scalar(value, "invalid_path_parameter");
  if (!isSafePathValue(serialized)) {
    throw new InvocationError("invalid_path_parameter");
  }
  try {
    return encodeURIComponent(serialized);
  } catch {
    // biome-ignore lint/style/useErrorCause: invalid caller path text must remain a stable public error.
    throw new InvocationError("invalid_path_parameter");
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function simple(value: unknown, path: boolean): string {
  const serialize = path
    ? safePathScalar
    : (item: unknown) => scalar(item, "invalid_header_parameter");
  if (Array.isArray(value)) {
    return value.map(serialize).join(",");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => compareStrings(left, right))
      .flatMap(([key, item]) => [serialize(key), serialize(item)])
      .join(",");
  }
  return serialize(value);
}

function targetUrl(
  capability: Capability,
  input: unknown,
  upstreamUrl: UpstreamUrl
): URL {
  const path = object(object(input).path);
  const pathname = capability.pathTemplate.replace(
    pathParameter,
    (_match, name: string) => safePathScalar(path[name])
  );
  if (unexpandedPathParameter.test(pathname)) {
    throw new InvocationError("invalid_path_parameter");
  }
  const url = new URL(pathname, upstreamUrl);
  if (url.origin !== upstreamUrl || url.pathname !== pathname) {
    throw new InvocationError("invalid_registry_target");
  }
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(object(object(input).query))) {
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(name, scalar(item, "invalid_query_parameter"));
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
        compareStrings(left, right)
      )) {
        search.append(key, scalar(item, "invalid_query_parameter"));
      }
    } else {
      search.append(name, scalar(value, "invalid_query_parameter"));
    }
  }
  url.search = search.toString();
  return url;
}

function requestHeaders(request: InvocationRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(
    object(object(request.input).headers)
  )) {
    if (reservedHeaderName.test(name)) {
      throw new InvocationError("forbidden_header");
    }
    headers.set(name, simple(value, false));
  }
  if (request.idempotencyKey) {
    headers.set("idempotency-key", request.idempotencyKey);
  }
  return headers;
}

function requestBody(
  capability: Capability,
  input: unknown,
  headers: Headers
): string | undefined {
  headers.delete("content-type");
  const { body } = object(input);
  if (body === undefined) {
    return;
  }
  if (capability.requestMediaType === undefined) {
    throw new InvocationError("missing_request_media_type");
  }
  headers.set("content-type", capability.requestMediaType);
  return JSON.stringify(body);
}

function canRetry(request: InvocationRequest): boolean {
  return (
    request.capability.method === "GET" ||
    request.capability.method === "HEAD" ||
    request.idempotencyKey !== undefined
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function retryAfterMilliseconds(
  response: Response,
  now: number
): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return;
  }
  if (retryAfterDeltaSeconds.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) &&
      seconds <= Number.MAX_SAFE_INTEGER / 1000
      ? seconds * 1000
      : undefined;
  }
  const date = retryAfterHttpDate.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(date) && new Date(date).toUTCString() === value
    ? Math.max(0, date - now)
    : undefined;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(
  response: Response | undefined,
  dependencies: InvocationDependencies,
  retryIndex: number
): number {
  const after =
    response === undefined
      ? undefined
      : retryAfterMilliseconds(response, dependencies.now());
  if (after !== undefined) {
    return after;
  }
  const base = 100 * 2 ** retryIndex;
  const bytes = dependencies.randomBytes(2);
  const jitter = ((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0)) % base;
  return base + jitter;
}

function cancelResponseBody(response: Response): void {
  try {
    Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup must not alter the selected retry or deadline outcome.
  }
}

function deadlineSignal(
  signal: AbortSignal,
  deadline: number,
  now: () => number
): Readonly<{ cleanup: () => void; signal: AbortSignal }> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const remaining = deadline - now();
  const timer = setTimeout(
    () => controller.abort(new InvocationError("deadline_exceeded")),
    Math.max(0, remaining)
  );
  return {
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retry classification stays centralized at the upstream trust boundary.
export async function invokeRegistryTarget(
  request: InvocationRequest,
  dependencies: InvocationDependencies
): Promise<Response> {
  const url = targetUrl(
    request.capability,
    request.input,
    dependencies.upstreamUrl
  );
  const headers = requestHeaders(request);
  const body = requestBody(request.capability, request.input, headers);
  const attempts = canRetry(request) ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(request.signal);
    if (dependencies.now() >= request.deadline) {
      throw new InvocationError("deadline_exceeded");
    }
    const bounded = deadlineSignal(
      request.signal,
      request.deadline,
      dependencies.now
    );
    let bodyOwnsCleanup = false;
    const telemetryAttributes = {
      "http.request.method": request.capability.method,
      "http.route": request.capability.pathTemplate,
      "mcp.tool.name": request.capability.operationId,
      "retry.attempt": attempt + 1,
    };
    dependencies.event?.(
      "photon.mcp.upstream.requests",
      telemetryAttributes,
      1
    );
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded retries must execute sequentially.
      const response = await dependencies.fetchUpstream(
        new Request(url, {
          ...(body === undefined ? {} : { body }),
          headers,
          method: request.capability.method,
          redirect: "manual",
          signal: bounded.signal,
        })
      );
      throwIfAborted(bounded.signal);
      if (response.status >= 300 && response.status < 400) {
        const upstream = {
          contentType: response.headers.get("content-type"),
          status: response.status,
        };
        cancelResponseBody(response);
        throw new InvocationError("upstream_redirect_rejected", upstream);
      }
      if (!retryableStatus.has(response.status) || attempt + 1 === attempts) {
        if (response.body === null) {
          return response;
        }
        if (response.status === 204 || response.status === 205) {
          cancelResponseBody(response);
          throw new InvocationError("upstream_contract_violation");
        }
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        const result = new Response(stream.readable, response);
        const piping = response.body.pipeTo(stream.writable, {
          signal: bounded.signal,
        });
        bodyOwnsCleanup = true;
        // The readable reports body failures; they must never replay the request.
        piping.then(bounded.cleanup, bounded.cleanup);
        return result;
      }
      dependencies.log?.("photon.mcp.retry.event", {
        ...telemetryAttributes,
        "mcp.result": "pending",
      });
      const retryAfter = retryDelay(response, dependencies, attempt);
      if (dependencies.now() + retryAfter >= request.deadline) {
        cancelResponseBody(response);
        throw new InvocationError("deadline_exceeded");
      }
      cancelResponseBody(response);
      await delay(retryAfter, bounded.signal);
    } catch (error) {
      if (bounded.signal.aborted) {
        throw (
          bounded.signal.reason ?? new DOMException("Aborted", "AbortError")
        );
      }
      if (
        error instanceof InvocationError &&
        error.code === "upstream_redirect_rejected"
      ) {
        throw error;
      }
      if (
        !(error instanceof TypeError) ||
        bounded.signal.aborted ||
        attempt + 1 === attempts
      ) {
        throw error;
      }
      dependencies.log?.("photon.mcp.retry.event", {
        ...telemetryAttributes,
        "mcp.result": "pending",
      });
      const retryAfter = retryDelay(undefined, dependencies, attempt);
      if (dependencies.now() + retryAfter >= request.deadline) {
        // biome-ignore lint/style/useErrorCause: the public deadline failure must not expose transport details.
        throw new InvocationError("deadline_exceeded");
      }
      await delay(retryAfter, bounded.signal);
    } finally {
      if (!bodyOwnsCleanup) {
        bounded.cleanup();
      }
    }
  }
  throw new InvocationError("upstream_retry_exhausted");
}

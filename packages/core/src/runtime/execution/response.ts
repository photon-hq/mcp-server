import type {
  CallToolResult,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import { normalizeJsonMediaType } from "../../release.js";
import { InvocationError } from "../invoke.js";
import type { ActivatedRuntimeRelease } from "../runtime-release.js";

export type Result = CallToolResult | InputRequiredResult;

type ExecutionPlan =
  ActivatedRuntimeRelease["registrationPlan"][number]["execution"];

const unsafeProblem =
  /(?:api[ _-]?key|authorization|bearer|client[ _-]?secret|credential|password|private[ _-]?key|signed|token|pin|pho_[a-z]+_)/iu;
const safeProblemIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const safeProblemUrn = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const privateHostnamePattern = /(?:^|[.-])(?:internal|private)(?:[.-]|$)/u;
const embeddedProblemUrl = /https?:\/\/[^\s<>"']+/giu;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const numericHostname = /^[0-9.]+$/u;
const specialHostnameSuffixes = [
  "corp",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localhost",
  "test",
] as const;

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

// Clients that read only text content still see the sanitized error fields, as
// the MCP spec recommends for structured results.
function errorContent(
  summary: string,
  structuredContent: Readonly<Record<string, unknown>>
): CallToolResult {
  return {
    content: [
      { text: `${summary} ${JSON.stringify(structuredContent)}`, type: "text" },
    ],
    isError: true,
    structuredContent: { ...structuredContent },
  };
}

export function errorResult(code: string): CallToolResult {
  return errorContent("Request could not be completed.", { code });
}

export function upstreamContractViolation(
  status: number,
  contentType: string | null,
  stage:
    | "redirect"
    | "error_response"
    | "success_status"
    | "response_type"
    | "response_body"
    | "response_schema"
    | "output_schema"
): CallToolResult {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  let responseType = contentType === null ? "missing" : "other";
  if (
    mediaType &&
    [
      "application/json",
      "application/problem+json",
      "text/html",
      "text/plain",
    ].includes(mediaType)
  ) {
    responseType = mediaType;
  }
  return errorContent("Request could not be completed.", {
    code: "upstream_contract_violation",
    responseType,
    stage,
    upstreamStatus: status,
  });
}

export function completedResult(
  value: Readonly<Record<string, unknown>>
): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value), type: "text" }],
    resultType: "complete",
    structuredContent: value,
  } as CallToolResult;
}

function publicProblemHostname(hostname: string): boolean {
  if (
    hostname.length > 253 ||
    hostname.startsWith("[") ||
    numericHostname.test(hostname) ||
    privateHostnamePattern.test(hostname)
  ) {
    return false;
  }
  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => dnsLabel.test(label)) &&
    !specialHostnameSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    )
  );
}

function safeProblemUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      publicProblemHostname(hostname)
    );
  } catch {
    return false;
  }
}

function safeProblemText(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    unsafeProblem.test(value) ||
    (value.match(embeddedProblemUrl) ?? []).some(
      (candidate) => !safeProblemUrl(candidate)
    )
  ) {
    return;
  }
  return value.slice(0, maximum);
}

function safeProblemId(value: unknown, maximum: number): string | undefined {
  const text = safeProblemText(value, maximum);
  return text !== undefined && safeProblemIdentifier.test(text)
    ? text
    : undefined;
}

function safeProblemType(value: unknown): string | undefined {
  const text = safeProblemText(value, 200);
  if (text === undefined) {
    return;
  }
  if (text.startsWith("urn:")) {
    return safeProblemUrn.test(text) ? text : undefined;
  }
  return safeProblemUrl(text) ? text : undefined;
}

function safeRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  const seconds = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 60
    ? seconds
    : undefined;
}

function validateSuccess(
  output: Readonly<Record<string, unknown>>,
  execution: ExecutionPlan,
  response: Response
): CallToolResult {
  const rejected = () =>
    upstreamContractViolation(
      response.status,
      response.headers.get("content-type"),
      "output_schema"
    );
  return execution.validateOutput(output)
    ? completedResult(output)
    : rejected();
}

const tokenPunctuation = "!#$%&'*+-.^_`|~";

function optionalWhitespace(value: string, index: number): number {
  let position = index;
  while (value[position] === " " || value[position] === "\t") {
    position += 1;
  }
  return position;
}

function tokenCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    tokenPunctuation.includes(value)
  );
}

function quotedCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return value === "\t" || (code >= 0x20 && code !== 0x7f);
}

function tokenEnd(value: string, index: number): number | undefined {
  let position = index;
  while (position < value.length && tokenCharacter(value.charAt(position))) {
    position += 1;
  }
  return position === index ? undefined : position;
}

function quotedValueEnd(value: string, index: number): number | undefined {
  let position = index + 1;
  while (position < value.length) {
    const character = value.charAt(position);
    if (character === '"') {
      return position + 1;
    }
    if (character === "\\") {
      const escaped = value[position + 1];
      if (escaped === undefined || !quotedCharacter(escaped)) {
        return;
      }
      position += 2;
    } else if (quotedCharacter(character)) {
      position += 1;
    } else {
      return;
    }
  }
}

function parameterValueEnd(value: string, index: number): number | undefined {
  return value[index] === '"'
    ? quotedValueEnd(value, index)
    : tokenEnd(value, index);
}

function validParameters(value: string): boolean {
  const firstParameter = value.indexOf(";");
  if (firstParameter === -1) {
    return true;
  }
  let index = firstParameter + 1;
  while (index < value.length) {
    index = optionalWhitespace(value, index);
    const nameEnd = tokenEnd(value, index);
    if (nameEnd === undefined) {
      return false;
    }
    index = optionalWhitespace(value, nameEnd);
    if (value[index] !== "=") {
      return false;
    }
    index = optionalWhitespace(value, index + 1);
    const valueEnd = parameterValueEnd(value, index);
    if (valueEnd === undefined) {
      return false;
    }
    index = optionalWhitespace(value, valueEnd);
    if (index === value.length) {
      return true;
    }
    if (value[index] !== ";") {
      return false;
    }
    index += 1;
  }
  return false;
}

function normalizeResponseMediaType(value: string): string | undefined {
  return value.includes(",") || !validParameters(value)
    ? undefined
    : normalizeJsonMediaType(value);
}

async function mapSuccessResponse(
  response: Response,
  execution: ExecutionPlan
): Promise<CallToolResult> {
  const candidates = execution.successRepresentations.filter(
    (candidate) => candidate.status === response.status
  );
  if (candidates.length === 0) {
    return upstreamContractViolation(
      response.status,
      response.headers.get("content-type"),
      "success_status"
    );
  }
  if (response.status === 204) {
    if (
      !candidates.some((candidate) => !("mediaType" in candidate)) ||
      new Uint8Array(await response.arrayBuffer()).byteLength !== 0
    ) {
      return upstreamContractViolation(
        response.status,
        response.headers.get("content-type"),
        "response_body"
      );
    }
    return validateSuccess({ status: response.status }, execution, response);
  }
  const contentType = response.headers.get("content-type");
  const mediaType =
    contentType === null ? undefined : normalizeResponseMediaType(contentType);
  const representation = candidates.find(
    (candidate) => "mediaType" in candidate && candidate.mediaType === mediaType
  );
  if (representation === undefined || !("mediaType" in representation)) {
    return upstreamContractViolation(
      response.status,
      response.headers.get("content-type"),
      "response_type"
    );
  }
  try {
    const data = await response.json();
    return representation.validate(data)
      ? validateSuccess({ data, status: response.status }, execution, response)
      : upstreamContractViolation(
          response.status,
          response.headers.get("content-type"),
          "response_schema"
        );
  } catch (error) {
    if (
      error instanceof InvocationError ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw error;
    }
    return upstreamContractViolation(
      response.status,
      response.headers.get("content-type"),
      "response_body"
    );
  }
}

function safeProblemStatus(
  value: unknown,
  responseStatus: number
): number | undefined {
  return value === responseStatus &&
    Number.isInteger(value) &&
    responseStatus >= 400 &&
    responseStatus <= 599
    ? responseStatus
    : undefined;
}

async function mapProblemResponse(response: Response): Promise<CallToolResult> {
  try {
    const problem = object(await response.json());
    const code = safeProblemId(problem.code, 96);
    const retryAfter = safeRetryAfter(response);
    const requestId = safeProblemId(problem.requestId, 128);
    const status = safeProblemStatus(problem.status, response.status);
    const title = safeProblemText(problem.title, 160);
    const type = safeProblemType(problem.type);
    return errorContent("The upstream service rejected the request.", {
      code: code ?? "upstream_problem",
      ...(status === undefined ? {} : { status }),
      ...(title === undefined ? {} : { title }),
      ...(type === undefined ? {} : { type }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(typeof problem.retryable === "boolean"
        ? { retryable: problem.retryable }
        : {}),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  } catch (error) {
    if (
      error instanceof InvocationError ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw error;
    }
    return upstreamContractViolation(
      response.status,
      response.headers.get("content-type"),
      "response_body"
    );
  }
}

export async function mapResponse(
  response: Response,
  execution: ExecutionPlan
): Promise<CallToolResult> {
  try {
    if (response.status >= 200 && response.status < 300) {
      return await mapSuccessResponse(response, execution);
    }
    const contentType = response.headers.get("content-type");
    return contentType !== null &&
      normalizeResponseMediaType(contentType) === "application/problem+json"
      ? await mapProblemResponse(response)
      : upstreamContractViolation(
          response.status,
          contentType,
          "error_response"
        );
  } finally {
    // Early contract rejection must release the unread body and its deadline.
    if (response.body && !response.body.locked) {
      response.body.cancel().catch(() => undefined);
    }
  }
}

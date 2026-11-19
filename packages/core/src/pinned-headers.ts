import { toolMayNotSetHeader } from "./headers.js";

const nonToken = /[^!#$%&'*+.^_`|~0-9A-Za-z-]/u;
const edgeWhitespace = /^[ \t]|[ \t]$/u;

function headerEntries(value: unknown): readonly [string, unknown][] {
  if (
    !(
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [null, Object.prototype].includes(Object.getPrototypeOf(value))
    )
  ) {
    throw new Error("invalid_pinned_header: expected a header map");
  }
  return Object.entries(value);
}

function validHeaderValue(value: unknown): value is string {
  if (typeof value !== "string" || !value || edgeWhitespace.test(value)) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code < 32 && char !== "\t") || code === 127 || code > 255) {
      return false;
    }
  }
  return true;
}

function normalizeHeaderEntries(
  entries: readonly [string, unknown][]
): Readonly<Record<string, string>> {
  const headers = new Map<string, string>();
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase();
    if (
      !name ||
      nonToken.test(name) ||
      toolMayNotSetHeader(name) ||
      headers.has(lower) ||
      !validHeaderValue(headerValue)
    ) {
      throw new Error(`invalid_pinned_header: ${JSON.stringify(name)}`);
    }
    headers.set(lower, headerValue);
  }
  return Object.freeze(Object.fromEntries(headers));
}

export function normalizePinnedHeaders(
  value: unknown
): Readonly<Record<string, string>> {
  return normalizeHeaderEntries(headerEntries(value));
}

export function parseStoredPinnedHeaders(
  value: unknown
): Readonly<Record<string, string>> {
  const entries = headerEntries(value);
  const headers = normalizeHeaderEntries(entries);
  for (const [name] of entries) {
    if (!Object.hasOwn(headers, name)) {
      throw new Error(`invalid_pinned_header: ${JSON.stringify(name)}`);
    }
  }
  return headers;
}

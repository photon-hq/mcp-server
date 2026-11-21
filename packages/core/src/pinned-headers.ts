import { reservedHeaderName } from "./headers.js";
import { compareUtf8 } from "./utf8.js";

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
      reservedHeaderName.test(name) ||
      headers.has(lower) ||
      !validHeaderValue(headerValue)
    ) {
      throw new Error(`invalid_pinned_header: ${JSON.stringify(name)}`);
    }
    headers.set(lower, headerValue);
  }
  const sorted = [...headers].sort(([left], [right]) =>
    compareUtf8(left, right)
  );
  return Object.freeze(Object.fromEntries(sorted));
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

// Header names are case-insensitive and a pin map stores them lowercase.
export function pinnedHeaderValue(
  pinnedHeaders: Readonly<Record<string, string>>,
  name: string
): string | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(pinnedHeaders, key) ? pinnedHeaders[key] : undefined;
}

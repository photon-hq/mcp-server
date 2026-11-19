// Headers a tool argument may never set: credentials, framing, request
// identity and trust-boundary headers. The runtime rejects them before fetch,
// and the compiler leaves optional ones out of tool schemas. `trace` and
// `workload` match anywhere in the name, so every tracing and workload-identity
// variant is covered.
export const reservedHeaderName =
  /^(?:authorization|proxy-authorization|cookie|content-type|content-length|forwarded|host|idempotency-key|baggage|via|x-api-key|x-http-method-override|x-method-override|x-forwarded-|x-original-|x-real-ip|x-pho-|x-photon-|x-(?:release|operation)(?:-|$)|cf-access-)|trace|workload/iu;

// The API date every upstream request is pinned to. Only `parseApiVersion`
// makes one, so a host cannot hand the runtime an unchecked string.
export type ApiVersion = string & { readonly __apiVersion: unique symbol };

export const apiVersionHeaderName = "photon-version";

// The runtime sets this header itself on every request. It is not reserved:
// the compiler leaves it out of tool schemas whether the operation marks it
// optional or required, and tool input may still never set it.
export const hostSuppliedHeaderName = /^photon-version$/iu;

const apiVersionFormat = /^\d{4}-\d{2}-\d{2}$/u;

export function parseApiVersion(value: string): ApiVersion {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !apiVersionFormat.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("invalid_api_version");
  }
  return value as ApiVersion;
}

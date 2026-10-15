// Headers a tool argument may never set: credentials, framing, request
// identity and trust-boundary headers. The runtime rejects them before fetch,
// and the compiler leaves optional ones out of tool schemas. `trace` and
// `workload` match anywhere in the name, so every tracing and workload-identity
// variant is covered.
export const reservedHeaderName =
  /^(?:authorization|proxy-authorization|cookie|content-type|content-length|forwarded|host|idempotency-key|baggage|via|x-api-key|x-http-method-override|x-method-override|x-forwarded-|x-original-|x-real-ip|x-pho-|x-photon-|x-(?:release|operation)(?:-|$)|cf-access-)|trace|workload/iu;

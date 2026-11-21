// Headers a tool argument may never set: credentials, framing, hop-by-hop,
// request identity and trust-boundary headers. The runtime rejects them before
// fetch, the compiler leaves optional ones out of tool schemas, and a release
// may not pin them. `trace` and `workload` match anywhere in the name, so every
// tracing and workload-identity variant is covered.
export const reservedHeaderName =
  /^(?:authorization|proxy-authorization|cookie|content-type|content-length|forwarded|host|idempotency-key|baggage|via|x-api-key|x-http-method-override|x-method-override|x-forwarded-|x-original-|x-real-ip|x-pho-|x-photon-|x-(?:release|operation)(?:-|$)|cf-access-)|^(?:connection|expect|keep-alive|te|trailer|transfer-encoding|upgrade)$|trace|workload/iu;

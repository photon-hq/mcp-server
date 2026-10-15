const methods = ["delete", "get", "head", "patch", "post", "put"] as const;

// Operations that return, set or rotate a secret or a verification code. They
// stay out of the local catalog even if the API later enables them for MCP.
const secretOperations = new Set([
  "configureVoiceProfileOutbound",
  "confirmAccountPhoneVerification",
  "createWebhookDestination",
  "getWhatsappBusinessVerificationCode",
  "rotateVoiceProfileOutboundCredential",
  "rotateWebhookSigningSecret",
  "startAccountPhoneVerification",
]);

export interface LocalAdmission {
  readonly aggregate: Readonly<Record<string, unknown>>;
  readonly excluded: readonly string[];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function grantable(
  operation: Readonly<Record<string, unknown>>,
  scopes: ReadonlySet<string>
): boolean {
  const permissions = operation["x-required-permissions"];
  return (
    Array.isArray(permissions) &&
    permissions.length > 0 &&
    permissions.every(
      (permission) => typeof permission === "string" && scopes.has(permission)
    )
  );
}

// An API key acts with the account's full first-party authority. Keep the local
// catalog to operations an OAuth client could be granted, as the hosted server
// does, minus the secret operations above.
export function restrictToOauthScopes(
  aggregate: Readonly<Record<string, unknown>>,
  scopes: readonly string[]
): LocalAdmission {
  const allowed = new Set(scopes);
  const excluded: string[] = [];
  const paths = Object.fromEntries(
    Object.entries(record(aggregate.paths)).map(([path, value]) => {
      const item = { ...record(value) };
      for (const method of methods) {
        const operation = record(item[method]);
        if (
          item[method] !== undefined &&
          (!grantable(operation, allowed) ||
            secretOperations.has(operation.operationId as string))
        ) {
          item[method] = { ...operation, "x-photon-mcp": { enabled: false } };
          excluded.push(`${method.toUpperCase()} ${path}`);
        }
      }
      return [path, item];
    })
  );
  return { aggregate: { ...aggregate, paths }, excluded };
}

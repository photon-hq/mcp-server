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

// Operations an API key needs that no OAuth client can be granted. An API key
// is bound to an account rather than an organization, so listing the account's
// organizations is how an agent finds the organizationId other tools take; the
// hosted server reads it from the grant with getCurrentOrganization instead.
const accountKeyOperations = new Set(["listOrganizations"]);

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

// An operation whose declared security excludes Account Service Keys can only
// be refused for one, such as getCurrentOrganization, which needs a credential
// bound to an organization. An empty or missing declaration is left to the
// other checks.
function acceptsAccountKey(
  operation: Readonly<Record<string, unknown>>
): boolean {
  const { security } = operation;
  return (
    !Array.isArray(security) ||
    security.length === 0 ||
    security.some((requirement) => "accountServiceKey" in record(requirement))
  );
}

// An API key acts with the account's full first-party authority. Keep the local
// catalog to operations an OAuth client could be granted, as the hosted server
// does, plus the account-key operations and minus the secret operations above,
// and drop operations that refuse an API key.
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
        if (item[method] === undefined) {
          continue;
        }
        const operation = record(item[method]);
        const operationId = operation.operationId as string;
        if (accountKeyOperations.has(operationId)) {
          item[method] = {
            ...operation,
            "x-photon-mcp": {
              ...record(operation["x-photon-mcp"]),
              enabled: true,
            },
          };
        } else if (
          !grantable(operation, allowed) ||
          secretOperations.has(operationId) ||
          !acceptsAccountKey(operation)
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

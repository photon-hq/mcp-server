export interface McpOptions {
  readonly destructive?: boolean;
  readonly enabled?: boolean;
  readonly idempotent?: boolean;
  readonly readOnly?: boolean;
}

/** @internal */
export function isMcpOperationAdmitted(
  options: McpOptions | undefined
): boolean {
  return options?.enabled !== false;
}

const optionKeys = new Set([
  "destructive",
  "enabled",
  "idempotent",
  "readOnly",
]);

function invalidExtension(): never {
  throw new Error("invalid_mcp_extension");
}

export function parseMcpExtension(value: unknown): McpOptions | undefined {
  if (value === undefined) {
    return;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return invalidExtension();
  }

  for (const [key, option] of Object.entries(value)) {
    if (!optionKeys.has(key) || typeof option !== "boolean") {
      return invalidExtension();
    }
  }

  const options = value as McpOptions;
  if (options.enabled === false) {
    return { enabled: false };
  }

  return options;
}

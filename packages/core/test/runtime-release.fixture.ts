interface RuntimeCapability {
  annotations: {
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: true;
    readOnlyHint: boolean;
  };

  idempotency: "none" | "header";
  idempotencyKeySchema?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  method: "GET" | "POST";
  operationGetter?: string;
  operationId: string;
  operationPollLimit?: number;
  outputSchema: Record<string, unknown>;
  pathTemplate: string;
  requestMediaType?: string;
  requiredPermissions: string[];
  successRepresentations: Array<
    | { status: 204 }
    | { mediaType: string; schema: Record<string, unknown>; status: number }
  >;
}

interface RuntimeReleaseFixtureValue {
  authPermissions: string[];
  privateCapabilities: RuntimeCapability[];
  registry: RuntimeCapability[];
  releaseIdentity: {
    admissionModel: string;
    aggregateEtag: string;
    aggregateSha256: string;
    authPermissions: string[];
    compilerVersion: string;
    environment: string;
    previousReleaseIdentity: null;
    protocolVersion: string;
    releaseIdentity: string;
    schemaVersion: number;
  };
  schemas: Record<
    string,
    {
      input: Record<string, unknown>;
      output: Record<string, unknown>;
      responses: Array<
        | { status: 204 }
        | {
            mediaType: string;
            status: number;
          }
      >;
    }
  >;
  tools: Array<{ description: string; name: string }>;
  [key: string]: unknown;
}

export interface RuntimeReleaseFixtureOptions {
  readonly mutate?: (value: RuntimeReleaseFixtureValue) => void;
  readonly withOperationGetter?: boolean;
}

export interface RuntimeReleaseFixture {
  readonly checksum: string;
  readonly value: RuntimeReleaseFixtureValue;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, item]) => [key, sortedValue(item)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const pathInputSchema = {
  additionalProperties: false,
  properties: {
    path: {
      additionalProperties: false,
      properties: { key: { minLength: 1, type: "string" } },
      required: ["key"],
      type: "object",
    },
  },
  required: ["path"],
  type: "object",
};
const mutationInputSchema = {
  oneOf: [
    pathInputSchema,
    {
      additionalProperties: false,
      properties: { continuation: { minLength: 1, type: "string" } },
      required: ["continuation"],
      type: "object",
    },
  ],
};
const responseDataSchema = {
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  type: "object",
};
const outputSchema = {
  additionalProperties: false,
  properties: {
    data: responseDataSchema,
    status: { const: 200 },
  },
  required: ["status", "data"],
  type: "object",
};

function makeCapabilities(withOperationGetter: boolean): {
  privateCapabilities: RuntimeCapability[];
  registry: RuntimeCapability[];
} {
  const getAlpha: RuntimeCapability = {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },

    idempotency: "none",
    inputSchema: pathInputSchema,
    method: "GET",
    operationId: "getAlpha",
    outputSchema,
    pathTemplate: "/alpha/{key}",
    requiredPermissions: ["project:read"],
    successRepresentations: [
      {
        mediaType: "application/json",
        schema: responseDataSchema,
        status: 200,
      },
    ],
  };
  const publicTool: RuntimeCapability = {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },

    idempotency: "none",
    inputSchema: pathInputSchema,
    method: "GET",
    operationId: "publicTool",
    outputSchema,
    pathTemplate: "/public/{key}",
    requiredPermissions: [],
    successRepresentations: [
      {
        mediaType: "application/json",
        schema: responseDataSchema,
        status: 200,
      },
    ],
  };
  const writeAlpha: RuntimeCapability = {
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },

    idempotency: "header",
    idempotencyKeySchema: { maxLength: 255, minLength: 1, type: "string" },
    inputSchema: mutationInputSchema,
    method: "POST",
    operationId: "writeAlpha",
    outputSchema,
    pathTemplate: "/alpha/{key}",
    requiredPermissions: ["platforms:write"],
    successRepresentations: [
      {
        mediaType: "application/json",
        schema: responseDataSchema,
        status: 200,
      },
    ],
  };
  if (!withOperationGetter) {
    return {
      privateCapabilities: [],
      registry: [getAlpha, publicTool, writeAlpha],
    };
  }
  getAlpha.operationGetter = "pollAlpha";
  getAlpha.operationPollLimit = 1;
  const pollAlpha: RuntimeCapability = {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },

    idempotency: "none",
    inputSchema: pathInputSchema,
    method: "GET",
    operationId: "pollAlpha",
    outputSchema,
    pathTemplate: "/alpha/{key}/operations",
    requiredPermissions: ["project:read"],
    successRepresentations: [
      {
        mediaType: "application/json",
        schema: responseDataSchema,
        status: 200,
      },
    ],
  };
  return {
    privateCapabilities: [pollAlpha],
    registry: [getAlpha, publicTool, writeAlpha],
  };
}

export async function makeRuntimeRelease(
  options: RuntimeReleaseFixtureOptions = {}
): Promise<RuntimeReleaseFixture> {
  const { privateCapabilities, registry } = makeCapabilities(
    options.withOperationGetter ?? false
  );
  const allCapabilities = [...registry, ...privateCapabilities];
  const tools = [
    { description: "Reads alpha.", name: "getAlpha" },
    { description: "Reads public data.", name: "publicTool" },
    { description: "Writes alpha.", name: "writeAlpha" },
  ];
  const releaseFacts = {
    admissionModel: "producer_metadata_only",
    aggregateEtag: '"runtime-1"',
    aggregateSha256:
      "1111111111111111111111111111111111111111111111111111111111111111",
    authPermissions: ["platforms:write", "project:read"],
    compilerVersion: "0.1.0",
    environment: "staging",
    privateCapabilities,
    protocolVersion: "2026-07-28",
    registry,
    routes: registry
      .flatMap((capability) => {
        const getter = capability.operationGetter
          ? allCapabilities.find(
              (candidate) =>
                candidate.operationId === capability.operationGetter
            )
          : undefined;
        return [capability, ...(getter ? [getter] : [])];
      })
      .map(({ method, operationId, pathTemplate }) => ({
        method,
        operationId,
        pathTemplate,
      }))
      .sort((left, right) =>
        compareStrings(left.operationId, right.operationId)
      ),
    schemaVersion: 1,
    tools,
  };
  const releaseIdentity = await sha256(releaseFacts);
  const value: RuntimeReleaseFixtureValue = {
    authPermissions: releaseFacts.authPermissions,
    privateCapabilities,
    registry,
    releaseIdentity: {
      admissionModel: releaseFacts.admissionModel,
      aggregateEtag: releaseFacts.aggregateEtag,
      aggregateSha256: releaseFacts.aggregateSha256,
      authPermissions: releaseFacts.authPermissions,
      compilerVersion: releaseFacts.compilerVersion,
      environment: releaseFacts.environment,
      previousReleaseIdentity: null,
      protocolVersion: releaseFacts.protocolVersion,
      releaseIdentity,
      schemaVersion: releaseFacts.schemaVersion,
    },
    schemas: Object.fromEntries(
      allCapabilities.map((capability) => [
        capability.operationId,
        {
          input: capability.inputSchema,
          output: capability.outputSchema,
          responses: capability.successRepresentations.map((representation) =>
            "schema" in representation
              ? {
                  mediaType: representation.mediaType,
                  status: representation.status,
                }
              : { status: 204 }
          ),
        },
      ])
    ),
    tools,
  };
  options.mutate?.(value);
  return { checksum: await sha256(value), value };
}

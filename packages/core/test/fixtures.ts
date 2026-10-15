import type { ReleaseDocuments } from "../src/release.js";

export interface CompileFixtureOptions {
  readonly extension?: unknown;
  readonly method?: "delete" | "get" | "head" | "patch" | "post" | "put";
  readonly operation?: Readonly<Record<string, unknown>>;
}

export function makeCompileInput(options: CompileFixtureOptions = {}) {
  const operation = {
    description: "Returns a project by identifier.",
    operationId: "getProject",
    parameters: [
      {
        description: "Project identifier.",
        in: "path",
        name: "projectId",
        required: true,
        schema: { type: "string" },
      },
      {
        description: "Requested projection.",
        in: "query",
        name: "view",
        schema: {
          default: "summary",
          enum: ["summary", "full"],
          type: "string",
        },
      },
      {
        in: "header",
        name: "If-Match",
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Project" },
          },
        },
        description: "Project found.",
      },
    },
    summary: "Get project",
    ...(options.extension === undefined
      ? {}
      : { "x-photon-mcp": options.extension }),
    ...options.operation,
  };

  return {
    aggregate: {
      components: {
        schemas: {
          Project: {
            additionalProperties: false,
            properties: {
              id: { description: "Project identifier.", type: "string" },
              name: { minLength: 1, type: "string" },
            },
            required: ["id", "name"],
            type: "object",
          },
        },
      },
      info: { title: "Photon API", version: "1.0.0" },
      openapi: "3.1.0",
      paths: {
        "/projects/{projectId}": { [options.method ?? "get"]: operation },
      },
    },
    aggregateEtag: '"aggregate-1"',
    compilerPolicy: { operationPollLimit: 3 },
    environment: "staging" as const,
  };
}

export function makeReleaseFixture(): ReleaseDocuments {
  return {
    admissionModel: "producer_metadata_only",
    aggregateEtag: '"release-1"',
    authPermissions: ["widgets:read"],
    privateCapabilities: [],
    protocolVersion: "2026-07-28",
    registry: [
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },

        idempotency: "none",
        inputSchema: {
          additionalProperties: false,
          type: "object",
        },
        method: "GET",
        operationId: "getWidget",
        outputSchema: {
          additionalProperties: false,
          type: "object",
        },
        pathTemplate: "/widgets/{widgetId}",
        requiredPermissions: ["widgets:read"],
        successRepresentations: [{ status: 204 }],
      },
    ],
    schemaVersion: 1,
  };
}

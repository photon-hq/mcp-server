import { z } from "zod";
import { assertClosedSchema } from "./schema.js";

const concreteJsonMediaType = /^application\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/u;
const asciiMediaType =
  /^[A-Za-z0-9!#$%&'+.^_`|~-]+\/[A-Za-z0-9!#$%&'+.^_`|~-]+$/u;
const asciiOptionalWhitespace = /^[\t ]+|[\t ]+$/gu;
const asciiUppercase = /[A-Z]/gu;
const lineTerminator = /[\n\r\u2028\u2029]/u;

function fullMatch(pattern: RegExp, value: string): boolean {
  return pattern.test(value) && value.replace(pattern, "") === "";
}

export type SuccessRepresentation =
  | Readonly<{ status: 204 }>
  | Readonly<{
      mediaType: string;
      schema: Readonly<Record<string, unknown>>;
      status: number;
    }>;

export interface Capability {
  readonly annotations: Readonly<{
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: true;
  }>;
  readonly idempotency: "none" | "header";
  readonly idempotencyKeySchema?: Readonly<Record<string, unknown>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly operationGetter?: string;
  readonly operationId: string;
  readonly operationPollLimit?: number;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly pathTemplate: string;
  readonly requestMediaType?: string;
  readonly requiredPermissions: readonly string[];
  readonly successRepresentations: readonly SuccessRepresentation[];
}

export interface ReleaseDocuments {
  readonly admissionModel: "producer_metadata_only";
  readonly aggregateEtag: string;
  readonly authPermissions: readonly string[];
  readonly privateCapabilities: readonly Capability[];
  readonly protocolVersion: "2026-07-28";
  readonly registry: readonly Capability[];
  readonly schemaVersion: 1;
}

const successRepresentationSchema = z.union([
  z.object({ status: z.literal(204) }).strict(),
  z
    .object({
      mediaType: z.string(),
      schema: z.record(z.string(), z.unknown()),
      status: z
        .number()
        .int()
        .min(200)
        .max(299)
        .refine((status) => status !== 204),
    })
    .strict(),
]);

const capabilitySchema = z
  .object({
    annotations: z
      .object({
        destructiveHint: z.boolean(),
        idempotentHint: z.boolean(),
        openWorldHint: z.literal(true),
        readOnlyHint: z.boolean(),
      })
      .strict(),
    idempotency: z.enum(["none", "header"]),
    idempotencyKeySchema: z.record(z.string(), z.unknown()).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    operationGetter: z.string().optional(),
    operationId: z.string(),
    operationPollLimit: z.number().int().positive().optional(),
    outputSchema: z.record(z.string(), z.unknown()),
    pathTemplate: z.string(),
    requestMediaType: z.string().optional(),
    requiredPermissions: z.array(z.string()),
    successRepresentations: z.array(successRepresentationSchema).min(1),
  })
  .strict()
  .superRefine((capability, context) => {
    if (
      (capability.idempotency === "header") !==
      (capability.idempotencyKeySchema !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "idempotency schema must match header policy",
        path: ["idempotencyKeySchema"],
      });
    }
    if (
      capability.idempotencyKeySchema &&
      capability.idempotencyKeySchema.type !== "string"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "idempotency schema must describe a string",
        path: ["idempotencyKeySchema"],
      });
    }
    if (capability.idempotencyKeySchema !== undefined) {
      try {
        assertClosedSchema(capability.idempotencyKeySchema);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "idempotency schema must be closed",
          path: ["idempotencyKeySchema"],
        });
      }
    }
  })
  .superRefine((capability, context) => {
    const schemas: Array<{
      readonly path: (string | number)[];
      readonly value: unknown;
    }> = [
      { path: ["inputSchema"], value: capability.inputSchema },
      { path: ["outputSchema"], value: capability.outputSchema },
      ...capability.successRepresentations.flatMap((representation, index) =>
        "schema" in representation
          ? [
              {
                path: ["successRepresentations", index, "schema"],
                value: representation.schema,
              },
            ]
          : []
      ),
    ];
    for (const schema of schemas) {
      try {
        assertClosedSchema(schema.value);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "schema must be closed",
          path: schema.path,
        });
      }
    }
    const body = inputBodySchema(capability.inputSchema);
    if ((body === undefined) !== (capability.requestMediaType === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "request media type must match input body",
        path: ["requestMediaType"],
      });
    }
    if (
      capability.requestMediaType !== undefined &&
      normalizeJsonMediaType(capability.requestMediaType) === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid request media type",
        path: ["requestMediaType"],
      });
    }

    let previous: SuccessRepresentation | undefined;
    const seen = new Set<string>();
    for (const [
      index,
      representation,
    ] of capability.successRepresentations.entries()) {
      if (
        "mediaType" in representation &&
        normalizeSuccessMediaType(representation.mediaType) === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid success media type",
          path: ["successRepresentations", index, "mediaType"],
        });
      }
      const key =
        "mediaType" in representation
          ? `${representation.status}:${normalizeSuccessMediaType(representation.mediaType)}`
          : "204";
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate success representation",
          path: ["successRepresentations", index],
        });
      }
      seen.add(key);
      const normalizedRepresentation =
        "mediaType" in representation
          ? {
              ...representation,
              mediaType:
                normalizeSuccessMediaType(representation.mediaType) ??
                representation.mediaType,
            }
          : representation;
      if (
        previous !== undefined &&
        compareRepresentation(previous, normalizedRepresentation) >= 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unordered success representations",
          path: ["successRepresentations", index],
        });
      }
      previous = normalizedRepresentation;
    }
  });

function inputBodySchema(
  inputSchema: Readonly<Record<string, unknown>>
): unknown {
  const direct = bodyFromProperties(inputSchema);
  if (direct !== undefined) {
    return direct;
  }
  if (!Array.isArray(inputSchema.oneOf)) {
    return;
  }
  for (const candidate of inputSchema.oneOf) {
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      const body = bodyFromProperties(
        candidate as Readonly<Record<string, unknown>>
      );
      if (body !== undefined) {
        return body;
      }
    }
  }
}

function bodyFromProperties(value: Readonly<Record<string, unknown>>): unknown {
  if (
    value.properties === null ||
    typeof value.properties !== "object" ||
    Array.isArray(value.properties)
  ) {
    return;
  }
  return (value.properties as Readonly<Record<string, unknown>>).body;
}

/** @internal */
export function normalizeJsonMediaType(value: string): string | undefined {
  if (lineTerminator.test(value)) {
    return;
  }
  const source = value.split(";", 1)[0]?.replace(asciiOptionalWhitespace, "");
  if (source === undefined || !fullMatch(asciiMediaType, source)) {
    return;
  }
  const normalized = source.replace(asciiUppercase, (letter) =>
    letter.toLowerCase()
  );
  if (
    normalized === "application/json" ||
    fullMatch(concreteJsonMediaType, normalized)
  ) {
    return normalized;
  }
}

/** @internal */
export function normalizeSuccessMediaType(value: string): string | undefined {
  const normalized = normalizeJsonMediaType(value);
  return normalized === "application/problem+json" ? undefined : normalized;
}

const encoder = new TextEncoder();

/** @internal */
export function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function compareRepresentation(
  left: SuccessRepresentation,
  right: SuccessRepresentation
): number {
  if (left.status !== right.status) {
    return left.status - right.status;
  }
  if (!("mediaType" in left && "mediaType" in right)) {
    return 0;
  }
  return compareUtf8(left.mediaType, right.mediaType);
}

const releaseSchema = z
  .object({
    admissionModel: z.literal("producer_metadata_only"),
    aggregateEtag: z.string(),
    authPermissions: z.array(z.string()),
    privateCapabilities: z.array(capabilitySchema).default([]),
    protocolVersion: z.literal("2026-07-28"),
    registry: z.array(capabilitySchema),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((release, context) => {
    const operationIds = new Set<string>();
    const privateOperationIds = new Set<string>();

    if (
      new Set(release.authPermissions).size !==
        release.authPermissions.length ||
      release.authPermissions.some(
        (permission, index) =>
          permission.length === 0 ||
          (index > 0 &&
            compareUtf8(release.authPermissions[index - 1] ?? "", permission) >=
              0)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid auth permission vocabulary",
        path: ["authPermissions"],
      });
    }

    for (const [index, capability] of release.registry.entries()) {
      if (operationIds.has(capability.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate operationId: ${capability.operationId}`,
          path: ["registry", index, "operationId"],
        });
      }

      operationIds.add(capability.operationId);

      if (
        capability.requiredPermissions.some(
          (permission) => !release.authPermissions.includes(permission)
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unknown required permission",
          path: ["registry", index, "requiredPermissions"],
        });
      }

      if (
        (capability.operationGetter === undefined) !==
        (capability.operationPollLimit === undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "operation getter and polling limit must be paired",
          path: ["registry", index],
        });
      }
    }
    for (const [index, capability] of release.privateCapabilities.entries()) {
      if (
        privateOperationIds.has(capability.operationId) ||
        operationIds.has(capability.operationId) ||
        capability.operationGetter !== undefined ||
        capability.operationPollLimit !== undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid private operationId: ${capability.operationId}`,
          path: ["privateCapabilities", index],
        });
      }
      privateOperationIds.add(capability.operationId);
    }
    for (const [index, capability] of release.registry.entries()) {
      if (
        capability.operationGetter !== undefined &&
        !privateOperationIds.has(capability.operationGetter) &&
        !operationIds.has(capability.operationGetter)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "missing private operation getter",
          path: ["registry", index, "operationGetter"],
        });
      }
    }
    const referencedPrivateOperationIds = new Set(
      release.registry.flatMap((capability) =>
        capability.operationGetter === undefined ||
        operationIds.has(capability.operationGetter)
          ? []
          : [capability.operationGetter]
      )
    );
    if (
      referencedPrivateOperationIds.size !== privateOperationIds.size ||
      [...privateOperationIds].some(
        (operationId) => !referencedPrivateOperationIds.has(operationId)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "orphan private operation getter",
        path: ["privateCapabilities"],
      });
    }
  });

export function parseRelease(value: unknown): ReleaseDocuments {
  assertRawReleaseSchemas(value);
  const release = releaseSchema.parse(value);

  return {
    ...release,
    privateCapabilities: release.privateCapabilities.map(normalizeCapability),
    registry: release.registry.map(normalizeCapability),
  };
}

function assertRawReleaseSchemas(source: unknown): void {
  const release = rawRecord(source);
  if (release === undefined) {
    return;
  }

  for (const collectionName of ["registry", "privateCapabilities"] as const) {
    for (const capability of rawArray(release[collectionName])) {
      assertRawCapabilitySchemas(capability);
    }
  }
}

function assertRawCapabilitySchemas(source: unknown): void {
  const capability = rawRecord(source);
  if (capability === undefined) {
    return;
  }
  for (const schemaName of ["inputSchema", "outputSchema"] as const) {
    if (Object.hasOwn(capability, schemaName)) {
      assertClosedSchema(capability[schemaName]);
    }
  }
  for (const representationSource of rawArray(
    capability.successRepresentations
  )) {
    const representation = rawRecord(representationSource);
    if (
      representation !== undefined &&
      Object.hasOwn(representation, "schema")
    ) {
      assertClosedSchema(representation.schema);
    }
  }
}

function rawArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function rawRecord(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizeCapability(
  capability: z.infer<typeof capabilitySchema>
): Capability {
  const {
    idempotencyKeySchema,
    operationGetter,
    operationPollLimit,
    requestMediaType,
    successRepresentations,
    ...requiredFields
  } = capability;

  return {
    ...requiredFields,
    ...(idempotencyKeySchema === undefined ? {} : { idempotencyKeySchema }),
    successRepresentations: successRepresentations.map((representation) =>
      "mediaType" in representation
        ? {
            ...representation,
            mediaType:
              normalizeSuccessMediaType(representation.mediaType) ??
              representation.mediaType,
          }
        : representation
    ),
    ...(operationGetter === undefined ? {} : { operationGetter }),
    ...(operationPollLimit === undefined ? {} : { operationPollLimit }),
    ...(requestMediaType === undefined
      ? {}
      : {
          requestMediaType:
            normalizeJsonMediaType(requestMediaType) ?? requestMediaType,
        }),
  };
}

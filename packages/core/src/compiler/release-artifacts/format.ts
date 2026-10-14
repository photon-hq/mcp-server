import { createHash } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { type Capability, compareUtf8 } from "../../release.js";
import type { CompiledRelease } from "../compile.js";
import type { ChangeReport } from "../release-change.js";
import { canonicalJson, semanticReleaseIdentity } from "../release-snapshot.js";
import type { BundleIdentity, RuntimeReleaseIdentity } from "./index.js";

export interface FormattedBundle {
  readonly identity: BundleIdentity;
  readonly manifest: string;
  readonly payloads: ReadonlyMap<string, string>;
}

export interface FormattedRuntimeModule {
  readonly identity: RuntimeReleaseIdentity;
  readonly source: string;
}

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** @internal */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** @internal */
export function normalizeOperationId(operationId: string): string {
  if (
    !operationIdPattern.test(operationId) ||
    operationId.includes("..") ||
    operationId.includes("/") ||
    operationId.includes("\\")
  ) {
    throw new Error("unsafe_operation_id");
  }
  return operationId;
}

function releaseDocument(compiled: CompiledRelease) {
  return {
    admissionModel: compiled.admissionModel,
    aggregateEtag: compiled.aggregateEtag,
    aggregateSha256: sha256(canonicalJson(compiled.openapi)),
    authPermissions: compiled.authPermissions,
    compilerVersion: compiled.compilerVersion,
    environment: compiled.environment,
    previousReleaseIdentity: compiled.previousReleaseIdentity,
    protocolVersion: compiled.protocolVersion,
    releaseIdentity: semanticReleaseIdentity(compiled),
    schemaVersion: compiled.schemaVersion,
  } as const;
}

function validateSchemas(compiled: CompiledRelease): void {
  const validator = new AjvJsonSchemaValidator();
  for (const capability of [
    ...compiled.registry,
    ...compiled.privateCapabilities,
  ]) {
    for (const schema of [
      capability.inputSchema,
      capability.outputSchema,
      ...capability.successRepresentations.flatMap((response) =>
        "schema" in response ? [response.schema] : []
      ),
      ...(capability.idempotencyKeySchema
        ? [capability.idempotencyKeySchema]
        : []),
    ]) {
      validator.getValidator(schema);
    }
  }
}

function schemas(compiled: CompiledRelease) {
  return Object.fromEntries(
    [...compiled.registry, ...compiled.privateCapabilities].map(
      (capability) => [
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
      ]
    )
  );
}

function runtimeRelease(compiled: CompiledRelease) {
  return {
    authPermissions: compiled.authPermissions,
    privateCapabilities: compiled.privateCapabilities,
    registry: compiled.registry,
    releaseIdentity: releaseDocument(compiled),
    schemas: schemas(compiled),
    tools: compiled.tools,
  } as const;
}

/** @internal */
export function markdownReport(report: ChangeReport): string {
  const lines = [
    "# Release change report",
    "",
    `Decision: ${report.decision}`,
    "",
  ];
  if (report.changes.length === 0) {
    lines.push("No semantic changes.");
  } else {
    for (const change of report.changes) {
      lines.push(`- ${JSON.stringify(JSON.parse(canonicalJson(change)))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function materializeBundleFiles(
  compiled: CompiledRelease
): ReadonlyMap<string, string> {
  const files = new Map<string, string>([
    ["change-report.json", canonicalJson(compiled.changeReport)],
    ["change-report.md", markdownReport(compiled.changeReport)],
    ["auth-permissions.json", canonicalJson(compiled.authPermissions)],
    ["openapi.json", canonicalJson(compiled.openapi)],
    ["private-capabilities.json", canonicalJson(compiled.privateCapabilities)],
    ["registry.json", canonicalJson(compiled.registry)],
    ["release.json", canonicalJson(releaseDocument(compiled))],
    ["tools.json", canonicalJson(compiled.tools)],
  ]);
  for (const capability of [
    ...compiled.registry,
    ...compiled.privateCapabilities,
  ]) {
    const operationId = normalizeOperationId(capability.operationId);
    files.set(
      `schemas/${operationId}.input.json`,
      canonicalJson(capability.inputSchema)
    );
    files.set(
      `schemas/${operationId}.output.json`,
      canonicalJson(capability.outputSchema)
    );
  }
  return files;
}

function manifestFor(files: ReadonlyMap<string, string>): string {
  return `${[...files]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([path, content]) => `${sha256(content)}  ${path}`)
    .join("\n")}\n`;
}

/** @internal */
export function expectedContractFiles(
  registry: readonly Capability[],
  privateCapabilities: readonly Capability[]
): readonly string[] {
  const operationIds = [...registry, ...privateCapabilities].map((item) =>
    normalizeOperationId(item.operationId)
  );
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error("invalid_bundle_registry");
  }
  return [
    "change-report.json",
    "change-report.md",
    "auth-permissions.json",
    "checksums.sha256",
    "openapi.json",
    "private-capabilities.json",
    "registry.json",
    "release.json",
    ...operationIds.flatMap((operationId) => [
      `schemas/${operationId}.input.json`,
      `schemas/${operationId}.output.json`,
    ]),
    "tools.json",
  ].sort(compareUtf8);
}

export function formatBundle(compiled: CompiledRelease): FormattedBundle {
  validateSchemas(compiled);
  const payloads = materializeBundleFiles(compiled);
  const manifest = manifestFor(payloads);
  return {
    identity: {
      checksum: sha256(manifest),
      files: [...payloads.keys(), "checksums.sha256"].sort(compareUtf8),
    },
    manifest,
    payloads,
  };
}

export function formatRuntimeModule(
  compiled: CompiledRelease
): FormattedRuntimeModule {
  validateSchemas(compiled);
  const runtime = runtimeRelease(compiled);
  const json = canonicalJson(runtime).trimEnd();
  const checksum = sha256(canonicalJson(runtime));
  const source = `// biome-ignore format: generated canonical release module\nconst runtimeRelease = JSON.parse(${JSON.stringify(json)});\n\n// biome-ignore format: generated runtime checksum\nexport const runtimeReleaseChecksum = "${checksum}";\n\nexport default runtimeRelease;\n`;
  return {
    identity: {
      checksum,
      releaseIdentity: runtime.releaseIdentity.releaseIdentity,
    },
    source,
  };
}

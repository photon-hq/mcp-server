import {
  compareUtf8,
  parseRelease,
  type ReleaseDocuments,
} from "../../release.js";
import { type ChangeReport, parseChangeReport } from "../release-change.js";
import {
  assertSemanticReleaseRelations,
  canonicalJson,
  parseReleaseTools,
  type SemanticReleaseSnapshot,
  semanticReleaseIdentity,
} from "../release-snapshot.js";
import { assertOpenApi31, cloneOpenApi } from "../schema.js";
import {
  expectedContractFiles,
  markdownReport,
  normalizeOperationId,
  sha256,
} from "./format.js";
import type { BundleIdentity } from "./index.js";

const manifestLinePattern = /^([a-f0-9]{64}) {2}([^\\]+)$/u;

export interface PreparedBundleVerification {
  readonly checksum: string;
  readonly entries: readonly Readonly<{
    checksum: string;
    path: string;
  }>[];
  readonly files: readonly string[];
  readonly paths: readonly string[];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("invalid_record");
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>
): void {
  if (
    Object.keys(value).length !== keys.size ||
    Object.keys(value).some((key) => !keys.has(key))
  ) {
    throw new Error("invalid_keys");
  }
}

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

function payloadText(
  payloads: ReadonlyMap<string, Uint8Array>,
  path: string
): string {
  const bytes = payloads.get(path);
  if (!bytes) {
    throw new Error("missing_bundle_payload");
  }
  return utf8Decoder.decode(bytes);
}

function readCanonicalJson(
  payloads: ReadonlyMap<string, Uint8Array>,
  path: string
): unknown {
  const source = payloadText(payloads, path);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("invalid_bundle_json", { cause: error });
  }
  if (canonicalJson(value) !== source) {
    throw new Error("non_canonical_bundle_json");
  }
  return value;
}

const releaseDocumentKeys = new Set([
  "admissionModel",
  "aggregateEtag",
  "aggregateSha256",
  "authPermissions",
  "compilerVersion",
  "environment",
  "previousReleaseIdentity",
  "protocolVersion",
  "releaseIdentity",
  "schemaVersion",
]);
function parseBundleRelease(
  releaseSource: Readonly<Record<string, unknown>>,
  registry: unknown,
  privateCapabilities: unknown
): ReleaseDocuments {
  try {
    return parseRelease({
      admissionModel: releaseSource.admissionModel,
      aggregateEtag: releaseSource.aggregateEtag,
      authPermissions: releaseSource.authPermissions,
      privateCapabilities,
      protocolVersion: releaseSource.protocolVersion,
      registry,
      schemaVersion: releaseSource.schemaVersion,
    });
  } catch (error) {
    throw new Error("invalid_bundle_registry", { cause: error });
  }
}

function validateBundlePayloads(
  files: readonly string[],
  values: ReadonlyMap<string, unknown>,
  payloads: ReadonlyMap<string, Uint8Array>
): void {
  const releaseSource = record(values.get("release.json"));
  exactKeys(releaseSource, releaseDocumentKeys);
  if (
    releaseSource.compilerVersion !== "0.1.0" ||
    (releaseSource.environment !== "staging" &&
      releaseSource.environment !== "production") ||
    typeof releaseSource.aggregateEtag !== "string" ||
    typeof releaseSource.aggregateSha256 !== "string" ||
    typeof releaseSource.releaseIdentity !== "string" ||
    !(
      releaseSource.previousReleaseIdentity === null ||
      typeof releaseSource.previousReleaseIdentity === "string"
    )
  ) {
    throw new Error("invalid_bundle_release");
  }
  const release = parseBundleRelease(
    releaseSource,
    values.get("registry.json"),
    values.get("private-capabilities.json")
  );
  if (
    canonicalJson(release.authPermissions) !==
    canonicalJson(values.get("auth-permissions.json"))
  ) {
    throw new Error("bundle_auth_permissions_mismatch");
  }
  if (
    JSON.stringify(
      expectedContractFiles(release.registry, release.privateCapabilities)
    ) !== JSON.stringify(files)
  ) {
    throw new Error("bundle_file_set_mismatch");
  }

  const tools = parseReleaseTools(values.get("tools.json"));
  if (
    canonicalJson(release.registry.map((item) => item.operationId)) !==
    canonicalJson(tools.map((item) => item.name))
  ) {
    throw new Error("bundle_tools_mismatch");
  }
  for (const capability of [
    ...release.registry,
    ...release.privateCapabilities,
  ]) {
    const operationId = normalizeOperationId(capability.operationId);
    if (
      canonicalJson(capability.inputSchema) !==
        canonicalJson(values.get(`schemas/${operationId}.input.json`)) ||
      canonicalJson(capability.outputSchema) !==
        canonicalJson(values.get(`schemas/${operationId}.output.json`))
    ) {
      throw new Error("bundle_schema_mismatch");
    }
  }
  const openapi = cloneOpenApi(
    assertOpenApi31(record(values.get("openapi.json")))
  );
  const snapshot: SemanticReleaseSnapshot = {
    ...release,
    compilerVersion: releaseSource.compilerVersion,
    environment: releaseSource.environment,
    openapi,
    tools,
  };
  try {
    assertSemanticReleaseRelations(snapshot);
  } catch (error) {
    throw new Error("bundle_routes_mismatch", { cause: error });
  }
  if (releaseSource.aggregateSha256 !== sha256(canonicalJson(openapi))) {
    throw new Error("bundle_aggregate_mismatch");
  }
  if (releaseSource.releaseIdentity !== semanticReleaseIdentity(snapshot)) {
    throw new Error("bundle_release_identity_mismatch");
  }
  let report: ChangeReport;
  try {
    report = parseChangeReport(values.get("change-report.json"));
  } catch (error) {
    throw new Error("invalid_bundle_change_report", { cause: error });
  }
  if (payloadText(payloads, "change-report.md") !== markdownReport(report)) {
    throw new Error("bundle_change_report_mismatch");
  }
}

export function verifyManifestIdentity(
  manifest: string,
  expectedChecksum: string
): string {
  const checksum = sha256(manifest);
  if (checksum !== expectedChecksum) {
    throw new Error("bundle_identity_mismatch");
  }
  return checksum;
}

export function prepareBundleVerification(
  manifest: string,
  files: readonly string[],
  checksum: string
): PreparedBundleVerification {
  if (!manifest.endsWith("\n") || manifest.endsWith("\n\n")) {
    throw new Error("invalid_checksum_manifest");
  }
  const entries = manifest
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = manifestLinePattern.exec(line);
      if (!(match?.[1] && match[2]) || match[2].startsWith("/")) {
        throw new Error("invalid_checksum_manifest");
      }
      return { checksum: match[1], path: match[2] };
    });
  const paths = entries.map((entry) => entry.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path) => path.includes("..")) ||
    JSON.stringify([...paths].sort(compareUtf8)) !== JSON.stringify(paths)
  ) {
    throw new Error("invalid_checksum_manifest");
  }
  const expectedFiles = [...paths, "checksums.sha256"].sort(compareUtf8);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(files)) {
    throw new Error("bundle_file_set_mismatch");
  }
  return { checksum, entries, files, paths };
}

export function verifyReleasePayloads(
  prepared: PreparedBundleVerification,
  payloads: ReadonlyMap<string, Uint8Array>
): BundleIdentity {
  for (const entry of prepared.entries) {
    const content = payloads.get(entry.path);
    if (!content || sha256(content) !== entry.checksum) {
      throw new Error("bundle_checksum_mismatch");
    }
  }

  const jsonPaths = prepared.files.filter((path) => path.endsWith(".json"));
  const values = new Map(
    jsonPaths.map((path) => [path, readCanonicalJson(payloads, path)] as const)
  );
  validateBundlePayloads(prepared.files, values, payloads);
  return { checksum: prepared.checksum, files: prepared.files };
}

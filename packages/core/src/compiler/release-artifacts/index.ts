import type { CompiledRelease } from "../compile.js";
import {
  assertBundleRoot,
  type BundlePayloadReader,
  claimBundleTarget,
  listBundleFiles,
  readBundleManifest,
  readBundlePayloads,
  removeClaimedTarget,
  writeBundlePayloads,
  writeRuntimeModuleFile,
} from "./filesystem.js";
import { formatBundle, formatRuntimeModule } from "./format.js";
import {
  prepareBundleVerification,
  verifyManifestIdentity,
  verifyReleasePayloads,
} from "./verify.js";

export interface BundleIdentity {
  readonly checksum: string;
  readonly files: readonly string[];
}

export interface RuntimeReleaseIdentity {
  readonly checksum: string;
  readonly releaseIdentity: string;
}

export async function writeBundle(
  compiled: CompiledRelease,
  directory: string
): Promise<BundleIdentity> {
  const target = await claimBundleTarget(directory);
  try {
    const formatted = formatBundle(compiled);
    await writeBundlePayloads(target, formatted.payloads, formatted.manifest);
    return formatted.identity;
  } catch (error) {
    await removeClaimedTarget(target);
    throw error;
  }
}

export async function writeRuntimeModule(
  compiled: CompiledRelease,
  file: string
): Promise<RuntimeReleaseIdentity> {
  const formatted = formatRuntimeModule(compiled);
  await writeRuntimeModuleFile(file, formatted.source);
  return formatted.identity;
}

export async function verifyBundleDirectory(
  directory: string,
  expectedChecksum: string,
  readPayload?: BundlePayloadReader
): Promise<BundleIdentity> {
  await assertBundleRoot(directory);
  const manifest = await readBundleManifest(directory);
  const checksum = verifyManifestIdentity(manifest, expectedChecksum);
  const files = await listBundleFiles(directory);
  const prepared = prepareBundleVerification(manifest, files, checksum);
  const payloads = await readBundlePayloads(
    directory,
    prepared.paths,
    readPayload
  );
  return verifyReleasePayloads(prepared, payloads);
}

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareUtf8 } from "../../release.js";

export type BundlePayloadReader = (absolutePath: string) => Promise<Uint8Array>;

async function writeRelative(
  directory: string,
  path: string,
  content: string
): Promise<void> {
  const root = resolve(directory);
  const target = resolve(directory, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("unsafe_bundle_path");
  }
  await writeFile(target, content, { encoding: "utf8", flag: "wx" });
}

export async function claimBundleTarget(directory: string): Promise<string> {
  const target = resolve(directory);
  try {
    await mkdir(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("bundle_target_exists", { cause: error });
    }
    throw error;
  }
  return target;
}

export async function writeBundlePayloads(
  target: string,
  payloads: ReadonlyMap<string, string>,
  manifest: string
): Promise<void> {
  await mkdir(join(target, "schemas"));
  const results = await Promise.allSettled(
    [...payloads]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([path, content]) => writeRelative(target, path, content))
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  await writeRelative(target, "checksums.sha256", manifest);
}

export async function removeClaimedTarget(target: string): Promise<void> {
  await rm(target, { force: true, recursive: true });
}

export async function assertBundleRoot(directory: string): Promise<void> {
  const root = await lstat(directory);
  if (root.isSymbolicLink()) {
    throw new Error("unsafe_bundle_root");
  }
  if (!root.isDirectory()) {
    throw new Error("invalid_bundle_directory");
  }
}

export async function listBundleFiles(
  directory: string
): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (current: string): Promise<void> => {
    await Promise.all(
      (await readdir(current, { withFileTypes: true })).map(async (entry) => {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error("unsafe_bundle_path");
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          paths.push(relative(directory, path).split(sep).join("/"));
        } else {
          throw new Error("unsafe_bundle_path");
        }
      })
    );
  };
  await visit(directory);
  return paths.sort(compareUtf8);
}

export async function readBundleManifest(directory: string): Promise<string> {
  return await readFile(join(directory, "checksums.sha256"), "utf8");
}

export async function readBundlePayloads(
  directory: string,
  paths: readonly string[],
  readPayload: BundlePayloadReader = async (path) => readFile(path)
): Promise<ReadonlyMap<string, Uint8Array>> {
  return new Map(
    await Promise.all(
      paths.map(
        async (path) =>
          [path, await readPayload(join(directory, path))] as const
      )
    )
  );
}

export async function writeRuntimeModuleFile(
  file: string,
  source: string
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

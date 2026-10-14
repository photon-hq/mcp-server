import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/bin/compile-release.js";
import {
  type CompiledRelease,
  compileRelease,
} from "../src/compiler/compile.js";
import { formatBundle } from "../src/compiler/release-artifacts/format.js";
import {
  verifyBundleDirectory,
  writeBundle,
  writeRuntimeModule,
} from "../src/compiler/release-artifacts/index.js";
import { prepareBundleVerification } from "../src/compiler/release-artifacts/verify.js";
import { canonicalJson } from "../src/compiler/release-snapshot.js";
import { compareUtf8 } from "../src/release.js";
import { activateRuntimeRelease } from "../src/runtime/runtime-release.js";
import { makeCompileInput } from "./fixtures.js";
import { schemaValidationCases } from "./schema-validation.fixture.js";

const checksumPattern = /^[a-f0-9]{64}$/u;
const manifestChecksumPrefixPattern = /^[a-f0-9]{64}/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rewritePayload(
  directory: string,
  path: string,
  content: string
): Promise<string> {
  await writeFile(join(directory, path), content, "utf8");
  const manifestPath = join(directory, "checksums.sha256");
  const manifest = (await readFile(manifestPath, "utf8"))
    .split("\n")
    .map((line) =>
      line.endsWith(`  ${path}`) ? `${sha256(content)}  ${path}` : line
    )
    .join("\n");
  await writeFile(manifestPath, manifest, "utf8");
  return sha256(manifest);
}

async function rewriteManifest(
  directory: string,
  update: (manifest: string) => string
): Promise<string> {
  const manifestPath = join(directory, "checksums.sha256");
  const manifest = update(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, manifest, "utf8");
  return sha256(manifest);
}

async function rewriteJsonPayload(
  directory: string,
  path: string,
  update: (value: unknown) => unknown
): Promise<string> {
  const value = JSON.parse(await readFile(join(directory, path), "utf8"));
  return await rewritePayload(directory, path, canonicalJson(update(value)));
}

function semanticSnapshot(release: CompiledRelease) {
  const {
    changeReport: _changeReport,
    previousReleaseIdentity: _previousReleaseIdentity,
    ...snapshot
  } = release;
  return snapshot;
}

function sourceOperation(input: ReturnType<typeof makeCompileInput>) {
  const pathItem = (
    input.aggregate.paths as Partial<
      Record<string, Partial<Record<string, Record<string, unknown>>>>
    >
  )["/projects/{projectId}"];
  const found = pathItem?.get;
  if (!found) {
    throw new Error("missing fixture operation");
  }
  return found;
}

async function expectBundleFailure(
  prefix: string,
  arrange: (
    directory: string,
    identity: Awaited<ReturnType<typeof writeBundle>>
  ) => Promise<string>,
  expectedError: string
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const directory = join(root, "bundle");
  try {
    const identity = await writeBundle(
      compileRelease(makeCompileInput()),
      directory
    );
    const checksum = await arrange(directory, identity);
    await expect(
      verifyBundleDirectory(directory, checksum)
    ).rejects.toThrowError(expectedError);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function readTree(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    await Promise.all(
      (await readdir(current, { withFileTypes: true })).map(async (entry) => {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else {
          files[relative(directory, path)] = await readFile(path, "utf8");
        }
      })
    );
  };
  await visit(directory);
  return files;
}

function releaseWithRequiredViewSchema(
  schema: Readonly<Record<string, unknown>>
): CompiledRelease {
  const release = compileRelease(makeCompileInput());
  const { $defs, ...viewSchema } = schema;
  return {
    ...release,
    registry: release.registry.map((capability) =>
      capability.operationId === "getProject"
        ? {
            ...capability,
            inputSchema: {
              ...capability.inputSchema,
              ...($defs ? { $defs } : {}),
              properties: {
                ...(capability.inputSchema.properties as Readonly<
                  Record<string, unknown>
                >),
                view: viewSchema,
              },
              required: [
                ...((capability.inputSchema.required as readonly string[]) ??
                  []),
                "view",
              ],
            },
          }
        : capability
    ),
  };
}

function asyncRelease(): CompiledRelease {
  const input = makeCompileInput({ method: "post" });
  const paths = input.aggregate.paths as Record<
    string,
    Record<string, unknown>
  >;
  paths["/projects/{projectId}"] = {
    post: {
      operationId: "startOperation",
      responses: {
        "202": {
          content: {
            "application/json": {
              schema: {
                properties: {
                  operationId: { type: "string" },
                  projectId: { type: "string" },
                  state: { type: "string" },
                },
                required: ["projectId", "operationId", "state"],
                type: "object",
              },
            },
          },
          links: {
            operation: {
              operationId: "readOperation",
              parameters: {
                operationId: "$response.body#/operationId",
                projectId: "$response.body#/projectId",
              },
            },
          },
        },
      },
    },
  };
  paths["/projects/{projectId}/operations/{operationId}"] = {
    get: {
      operationId: "readOperation",
      parameters: [
        {
          in: "path",
          name: "projectId",
          required: true,
          schema: { type: "string" },
        },
        {
          in: "path",
          name: "operationId",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          content: {
            "application/json": { schema: { type: "object" } },
          },
        },
      },
      "x-photon-mcp": { enabled: false },
    },
  };
  return compileRelease(input);
}

interface RuntimePayload {
  readonly privateCapabilities: readonly { readonly operationId: string }[];
  readonly schemas: Record<
    string,
    {
      readonly input: Record<string, unknown>;
      readonly output: Record<string, unknown>;
    }
  >;
  readonly tools: readonly { readonly name: string }[];
}

async function emitRuntimeRelease(release: CompiledRelease) {
  const root = await mkdtemp(join(tmpdir(), "runtime-release-"));
  const file = join(root, "runtime-release.ts");
  try {
    const identity = await writeRuntimeModule(release, file);
    const emitted = (await import(
      `${pathToFileURL(file).href}?checksum=${identity.checksum}`
    )) as {
      readonly default: RuntimePayload;
      readonly runtimeReleaseChecksum: string;
    };
    const checksum = emitted.runtimeReleaseChecksum;
    return {
      checksum,
      identity,
      payload: emitted.default,
    };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("release bundle", () => {
  it("rejects a reserved ID in a disabled unadvertised bundle route", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-reserved-route-"));
    const directory = join(root, "bundle");
    try {
      const compiled = compileRelease(makeCompileInput());
      const unsafe = {
        ...compiled,
        openapi: {
          ...compiled.openapi,
          paths: {
            ...(compiled.openapi.paths as Record<string, unknown>),
            "/disabled-release": {
              get: {
                operationId: "release",
                responses: {
                  "200": {
                    content: {
                      "application/json": { schema: { type: "object" } },
                    },
                  },
                },
                "x-photon-mcp": { enabled: false },
              },
            },
          },
        },
      } as CompiledRelease;
      const identity = await writeBundle(unsafe, directory);

      await expect(
        verifyBundleDirectory(directory, identity.checksum)
      ).rejects.toThrowError("bundle_routes_mismatch");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects files outside the release manifest", () => {
    const bundle = formatBundle(compileRelease(makeCompileInput()));

    const files = [...bundle.identity.files, "unexpected.json"].sort(
      compareUtf8
    );
    expect(() =>
      prepareBundleVerification(
        bundle.manifest,
        files,
        bundle.identity.checksum
      )
    ).toThrow("bundle_file_set_mismatch");
  });

  it("writes the exact deterministic tree and verifies every payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-bundle-"));
    const first = join(root, "first");
    const second = join(root, "second");
    try {
      const compiled = compileRelease(makeCompileInput());
      const firstIdentity = await writeBundle(compiled, first);
      const secondIdentity = await writeBundle(compiled, second);
      const firstTree = await readTree(first);
      const expectedPaths = [
        "auth-permissions.json",
        "change-report.json",
        "change-report.md",
        "checksums.sha256",
        "openapi.json",
        "private-capabilities.json",
        "registry.json",
        "release.json",
        "schemas/getProject.input.json",
        "schemas/getProject.output.json",
        "tools.json",
      ];

      expect(Object.keys(firstTree).sort()).toEqual(expectedPaths);
      expect(firstTree).toEqual(await readTree(second));
      expect(firstIdentity).toEqual(secondIdentity);
      expect(firstIdentity.files).toEqual(expectedPaths);
      await expect(
        verifyBundleDirectory(first, firstIdentity.checksum)
      ).resolves.toEqual(firstIdentity);
      expect(JSON.parse(firstTree["release.json"] ?? "null")).toMatchObject({
        aggregateEtag: '"aggregate-1"',
        compilerVersion: "0.1.0",
        environment: "staging",
        previousReleaseIdentity: null,
        protocolVersion: "2026-07-28",
      });
      expect(
        Object.values(firstTree).every(
          (content) => content.endsWith("\n") && !content.endsWith("\n\n")
        )
      ).toBe(true);
      const incomplete = join(root, "incomplete");
      await writeBundle(compiled, incomplete);
      const manifestPath = join(incomplete, "checksums.sha256");
      const manifest = await readFile(manifestPath, "utf8");
      await rm(join(incomplete, "tools.json"));
      await writeFile(
        manifestPath,
        manifest
          .split("\n")
          .filter((line) => !line.endsWith("  tools.json"))
          .join("\n"),
        "utf8"
      );
      await expect(
        verifyBundleDirectory(
          incomplete,
          sha256(await readFile(manifestPath, "utf8"))
        )
      ).rejects.toThrowError("bundle_file_set_mismatch");
      const [capability] = compiled.registry;
      if (!capability) {
        throw new Error("missing compiled capability");
      }
      const unsafe = {
        ...compiled,
        registry: [{ ...capability, operationId: "../escape" }],
      } as CompiledRelease;
      await expect(
        writeBundle(unsafe, join(root, "unsafe"))
      ).rejects.toThrowError("unsafe_operation_id");
      expect(
        (await readdir(root)).filter((name) => name.startsWith(".unsafe.tmp-"))
      ).toEqual([]);
      const trusted = firstIdentity.checksum;
      const forgedChecksum = await rewritePayload(
        first,
        "tools.json",
        '[\n  {\n    "description": "changed",\n    "name": "otherTool"\n  }\n]\n'
      );
      await expect(verifyBundleDirectory(first, trusted)).rejects.toThrowError(
        "bundle_identity_mismatch"
      );
      await expect(
        verifyBundleDirectory(first, forgedChecksum)
      ).rejects.toThrowError("bundle_tools_mismatch");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "malformed syntax",
      (manifest: string) =>
        manifest.replace(manifestChecksumPrefixPattern, "invalid"),
    ],
    [
      "out-of-order entries",
      (manifest: string) =>
        `${manifest.trimEnd().split("\n").reverse().join("\n")}\n`,
    ],
    [
      "an unsafe path",
      (manifest: string) =>
        manifest.replace("  auth-permissions.json", "  ../permissions.json"),
    ],
  ])("rejects checksum manifests with %s", async (_name, update) => {
    await expectBundleFailure(
      "bundle-manifest-",
      async (directory) => await rewriteManifest(directory, update),
      "invalid_checksum_manifest"
    );
  });

  it.each([
    [
      "a payload checksum mismatch",
      "changed\n",
      false,
      "bundle_checksum_mismatch",
    ],
    ["invalid JSON", "{\n", true, "invalid_bundle_json"],
    [
      "non-canonical JSON",
      '[{"description":"changed","name":"getProject"}]\n',
      true,
      "non_canonical_bundle_json",
    ],
  ])("rejects %s", async (_name, content, rehash, expectedError) => {
    await expectBundleFailure(
      "bundle-payload-",
      async (directory, identity) => {
        if (rehash) {
          return await rewritePayload(directory, "tools.json", content);
        }
        await writeFile(join(directory, "tools.json"), content, "utf8");
        return identity.checksum;
      },
      expectedError
    );
  });

  it.each([
    [
      "a capability schema",
      "schemas/getProject.input.json",
      (value: unknown) => ({
        ...(value as Readonly<Record<string, unknown>>),
        title: "changed",
      }),
      "bundle_schema_mismatch",
    ],
    [
      "the aggregate OpenAPI document",
      "openapi.json",
      (value: unknown) => {
        const document = value as Readonly<Record<string, unknown>>;
        return {
          ...document,
          info: {
            ...(document.info as Readonly<Record<string, unknown>>),
            title: "Changed API",
          },
        };
      },
      "bundle_aggregate_mismatch",
    ],
    [
      "the release identity",
      "release.json",
      (value: unknown) => ({
        ...(value as Readonly<Record<string, unknown>>),
        releaseIdentity: "0".repeat(64),
      }),
      "bundle_release_identity_mismatch",
    ],
    [
      "the change report",
      "change-report.json",
      (value: unknown) => ({
        ...(value as Readonly<Record<string, unknown>>),
        decision: "review",
      }),
      "invalid_bundle_change_report",
    ],
  ])("rejects semantic tampering of %s", async (_name, path, update, error) => {
    await expectBundleFailure(
      "bundle-semantic-",
      async (directory) => await rewriteJsonPayload(directory, path, update),
      error
    );
  });

  it("wraps the strict parser failure at the bundle boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-invalid-report-"));
    const directory = join(root, "bundle");
    try {
      const identity = await writeBundle(
        compileRelease(makeCompileInput()),
        directory
      );
      const checksum = await rewriteJsonPayload(
        directory,
        "change-report.json",
        (report) => ({ ...(report as Record<string, unknown>), extra: true })
      );

      await expect(
        verifyBundleDirectory(directory, checksum)
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "invalid_change_report" }),
        message: "invalid_bundle_change_report",
      });
      expect(identity.checksum).not.toBe(checksum);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an untrusted bundle checksum", async () => {
    await expectBundleFailure(
      "bundle-untrusted-",
      (_directory, identity) => {
        const replacement = identity.checksum.endsWith("0") ? "1" : "0";
        return Promise.resolve(identity.checksum.slice(0, -1) + replacement);
      },
      "bundle_identity_mismatch"
    );
  });

  it("writes and verifies a non-empty change report in both formats", async () => {
    const previous = compileRelease(makeCompileInput());
    const input = makeCompileInput();
    sourceOperation(input).description = "Returns one project.";
    (input as { previousRelease?: unknown }).previousRelease =
      semanticSnapshot(previous);
    const candidate = compileRelease(input);
    const root = await mkdtemp(join(tmpdir(), "change-report-"));
    const directory = join(root, "bundle");
    try {
      const identity = await writeBundle(candidate, directory);

      await expect(
        readFile(join(directory, "change-report.json"), "utf8")
      ).resolves.toContain('"description_changed"');
      await expect(
        readFile(join(directory, "change-report.md"), "utf8")
      ).resolves.toContain('"description_changed"');
      await expect(
        verifyBundleDirectory(directory, identity.checksum)
      ).resolves.toEqual(identity);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects root and nested symlinks and every pre-existing target", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-boundary-"));
    const real = join(root, "real");
    const link = join(root, "link");
    const emptyTarget = join(root, "empty-target");
    const occupiedTarget = join(root, "occupied-target");
    const fileTarget = join(root, "file-target");
    const writeLink = join(root, "write-link");
    try {
      const compiled = compileRelease(makeCompileInput());
      const identity = await writeBundle(compiled, real);
      await symlink(real, link);
      await expect(
        verifyBundleDirectory(link, identity.checksum)
      ).rejects.toThrowError("unsafe_bundle_root");

      const nestedLink = join(real, "schemas", "getProject.input.json");
      const nestedTarget = join(root, "nested-target.json");
      await writeFile(nestedTarget, "{}\n", "utf8");
      await rm(nestedLink);
      await symlink(nestedTarget, nestedLink);
      await expect(
        verifyBundleDirectory(real, identity.checksum)
      ).rejects.toThrowError("unsafe_bundle_path");

      await mkdir(emptyTarget);
      await expect(writeBundle(compiled, emptyTarget)).rejects.toThrowError(
        "bundle_target_exists"
      );
      await expect(readdir(emptyTarget)).resolves.toEqual([]);

      await mkdir(occupiedTarget);
      await writeFile(join(occupiedTarget, "keep.txt"), "keep\n", "utf8");
      await expect(writeBundle(compiled, occupiedTarget)).rejects.toThrowError(
        "bundle_target_exists"
      );
      await expect(
        readFile(join(occupiedTarget, "keep.txt"), "utf8")
      ).resolves.toBe("keep\n");

      await writeFile(fileTarget, "keep-file\n", "utf8");
      await expect(writeBundle(compiled, fileTarget)).rejects.toThrowError(
        "bundle_target_exists"
      );
      await expect(readFile(fileTarget, "utf8")).resolves.toBe("keep-file\n");

      await symlink(real, writeLink);
      await expect(writeBundle(compiled, writeLink)).rejects.toThrowError(
        "bundle_target_exists"
      );
      expect((await lstat(writeLink)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    "empty directory",
    "symlink",
  ])("claims the final target before a competing %s can appear", async (competitor) => {
    const root = await mkdtemp(join(tmpdir(), "bundle-claim-"));
    const target = join(root, "bundle");
    const sentinel = join(root, "sentinel");
    await mkdir(sentinel);
    let claimBlocked = false;
    let attempted = false;
    const compiled = compileRelease(makeCompileInput());
    const raced = {
      ...compiled,
      get changeReport() {
        if (!attempted) {
          attempted = true;
          try {
            if (competitor === "empty directory") {
              mkdirSync(target);
            } else {
              symlinkSync(sentinel, target);
            }
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            ) {
              claimBlocked = true;
            } else {
              throw error;
            }
          }
        }
        return compiled.changeReport;
      },
    } as CompiledRelease;
    try {
      const result = await writeBundle(raced, target).then(
        (identity) => ({ identity }),
        (error: unknown) => ({ error })
      );

      expect(claimBlocked).toBe(true);
      expect(result).toHaveProperty("identity");
      await expect(
        readFile(join(target, "checksums.sha256"), "utf8")
      ).resolves.toContain("  release.json\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes the manifest last and removes only its claimed target on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-completion-"));
    const target = join(root, "bundle");
    const compiled = compileRelease(makeCompileInput());
    let injected = false;
    const blocked = {
      ...compiled,
      get changeReport() {
        try {
          writeFileSync(join(target, "checksums.sha256"), "occupied\n");
          injected = true;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            throw error;
          }
        }
        return compiled.changeReport;
      },
    } as CompiledRelease;
    try {
      await expect(writeBundle(blocked, target)).rejects.toThrowError("EEXIST");
      expect(injected).toBe(true);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("validates semantic relationships from the one hashed payload read", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-single-read-"));
    const directory = join(root, "bundle");
    try {
      const identity = await writeBundle(
        compileRelease(makeCompileInput()),
        directory
      );
      const reads = new Map<string, number>();
      const verified = await verifyBundleDirectory(
        directory,
        identity.checksum,
        async (path) => {
          reads.set(path, (reads.get(path) ?? 0) + 1);
          const bytes = await readFile(path);
          if (path.endsWith("tools.json")) {
            await writeFile(
              path,
              '[\n  {\n    "description": "changed",\n    "name": "otherTool"\n  }\n]\n',
              "utf8"
            );
          }
          return bytes;
        }
      );

      expect(verified).toEqual(identity);
      expect(reads.size).toBe(identity.files.length - 1);
      expect([...reads.values()]).toEqual(
        Array.from({ length: identity.files.length - 1 }, () => 1)
      );
      await expect(
        readFile(join(directory, "tools.json"), "utf8")
      ).resolves.toContain("otherTool");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a bundle that omits registry and tools while retaining an enabled OpenAPI route", async () => {
    await expectBundleFailure(
      "bundle-openapi-route-",
      async (directory) => {
        await rewriteJsonPayload(directory, "registry.json", () => []);
        await rewriteJsonPayload(directory, "tools.json", () => []);
        await rm(join(directory, "schemas"), { force: true, recursive: true });
        return await rewriteManifest(directory, (manifest) =>
          manifest
            .split("\n")
            .filter((line) => !line.includes("  schemas/"))
            .join("\n")
        );
      },
      "bundle_routes_mismatch"
    );
  });

  it("rejects unknown CLI flags", () => {
    expect(() =>
      parseCommand([
        "compile",
        "--input",
        "input.json",
        "--out",
        "bundle",
        "--unknown",
        "value",
      ])
    ).toThrowError("unknown_command_argument");
  });

  it("requires a trusted checksum in the verify CLI", () => {
    expect(() =>
      parseCommand(["verify-bundle", "--bundle", "bundle"])
    ).toThrowError("missing_command_argument");
  });

  it.each(
    schemaValidationCases
  )("preserves $name through runtime artifacts", async ({
    schema,
    valid,
    invalid,
  }) => {
    const { payload, checksum } = await emitRuntimeRelease(
      releaseWithRequiredViewSchema(schema)
    );
    const emitted = payload.schemas.getProject;
    if (!emitted) {
      throw new Error("missing emitted schema");
    }
    const node = new AjvJsonSchemaValidator().getValidator(emitted.input);
    const release = await activateRuntimeRelease(payload, checksum);
    const worker =
      release.registrationPlan[0]?.options.inputSchema["~standard"];
    const good = { path: { projectId: "project-1" }, view: valid };
    const bad = { path: { projectId: "project-1" }, view: invalid };
    expect(node(good).valid).toBe(true);
    expect(node(bad).valid).toBe(false);
    expect(await worker?.validate(good)).toHaveProperty("value");
    expect(await worker?.validate(bad)).toHaveProperty("issues");
  });

  it("rejects an uncompileable schema before writing a bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "invalid-schema-bundle-"));
    const directory = join(root, "bundle");
    try {
      await expect(
        writeBundle(
          releaseWithRequiredViewSchema({ pattern: "[", type: "string" }),
          directory
        )
      ).rejects.toThrow();
      await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("publishes deep schemas without synthetic samples and still validates inputs", async () => {
    let schema: Record<string, unknown> = { const: "leaf", type: "string" };
    let valid: unknown = "leaf";
    for (let depth = 0; depth < 12; depth += 1) {
      schema = {
        additionalProperties: false,
        properties: { child: schema },
        required: ["child"],
        type: "object",
      };
      valid = { child: valid };
    }
    const { payload, checksum } = await emitRuntimeRelease(
      releaseWithRequiredViewSchema(schema)
    );
    const activated = await activateRuntimeRelease(payload, checksum);
    const input =
      activated.registrationPlan[0]?.options.inputSchema["~standard"];
    expect(
      await input?.validate({ path: { projectId: "project-1" }, view: valid })
    ).toHaveProperty("value");
    expect(
      await input?.validate({ path: { projectId: "project-1" }, view: {} })
    ).toHaveProperty("issues");
  });

  it("emits only immutable runtime facts and keeps the private getter route", async () => {
    const { checksum, identity, payload } = await emitRuntimeRelease(
      asyncRelease()
    );

    expect(identity.checksum).toMatch(checksumPattern);
    expect(checksum).toBe(identity.checksum);
    expect(identity.checksum).toBe(sha256(canonicalJson(payload)));
    expect(payload.privateCapabilities).toHaveLength(1);
    expect(payload.privateCapabilities[0]?.operationId).toBe("readOperation");
    expect(payload.tools.map((tool) => tool.name)).toEqual(["startOperation"]);
    const activated = await activateRuntimeRelease(payload, checksum);
    expect(activated.registrationPlan).toEqual([
      expect.objectContaining({
        name: "startOperation",
        operationGetter: expect.objectContaining({
          capability: expect.objectContaining({
            method: "GET",
            operationId: "readOperation",
          }),
        }),
      }),
    ]);
  });

  it("imports emitted JSON without changing an own __proto__ definition", async () => {
    const compiled = asyncRelease();
    const [capability, ...remainingCapabilities] = compiled.registry;
    if (!capability) {
      throw new Error("missing compiled capability");
    }
    const definitions = Object.fromEntries([["__proto__", { type: "string" }]]);
    const release: CompiledRelease = {
      ...compiled,
      registry: [
        {
          ...capability,
          inputSchema: { ...capability.inputSchema, $defs: definitions },
        },
        ...remainingCapabilities,
      ],
    };

    const { checksum, identity, payload } = await emitRuntimeRelease(release);
    const emittedDefinitions = payload.schemas[capability.operationId]?.input
      .$defs as Readonly<Record<string, unknown>>;

    expect(checksum).toBe(identity.checksum);
    expect(identity.checksum).toBe(sha256(canonicalJson(payload)));
    expect(Object.hasOwn(emittedDefinitions, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(emittedDefinitions, "__proto__")?.value
    ).toEqual({ type: "string" });
  });
});

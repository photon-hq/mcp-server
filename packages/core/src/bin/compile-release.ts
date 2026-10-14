#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  compileRelease,
  parseCompileReleaseInput,
} from "../compiler/compile.js";
import {
  verifyBundleDirectory,
  writeBundle,
  writeRuntimeModule,
} from "../compiler/release-artifacts/index.js";

type Command =
  | {
      readonly input: string;
      readonly name: "compile";
      readonly out: string;
      readonly runtimeModule?: string;
    }
  | {
      readonly bundle: string;
      readonly expectedChecksum: string;
      readonly name: "verify-bundle";
    };

function flags(args: readonly string[]): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!(key?.startsWith("--") && value && !value.startsWith("--"))) {
      throw new Error("invalid_command_arguments");
    }
    if (parsed.has(key)) {
      throw new Error("duplicate_command_argument");
    }
    parsed.set(key, value);
  }
  return parsed;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error("missing_command_argument");
  }
  return value;
}

function allowed(
  values: ReadonlyMap<string, string>,
  names: readonly string[]
): void {
  if ([...values.keys()].some((key) => !names.includes(key))) {
    throw new Error("unknown_command_argument");
  }
}

export function parseCommand(args: readonly string[]): Command {
  const [name, ...rest] = args;
  const values = flags(rest);
  if (name === "compile") {
    allowed(values, ["--input", "--out", "--runtime-module"]);
    const runtimeModule = values.get("--runtime-module");
    return {
      input: required(values, "--input"),
      name,
      out: required(values, "--out"),
      ...(runtimeModule ? { runtimeModule } : {}),
    };
  }
  if (name === "verify-bundle") {
    allowed(values, ["--bundle", "--expected-checksum"]);
    return {
      bundle: required(values, "--bundle"),
      expectedChecksum: required(values, "--expected-checksum"),
      name,
    };
  }
  throw new Error("unknown_command");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function run(args: readonly string[]): Promise<void> {
  const command = parseCommand(args);
  if (command.name === "compile") {
    const compiled = compileRelease(
      parseCompileReleaseInput(await readJson(command.input))
    );
    const identity = await writeBundle(compiled, command.out);
    if (command.runtimeModule) {
      await writeRuntimeModule(compiled, command.runtimeModule);
    }
    process.stdout.write(JSON.stringify(identity));
    process.stdout.write("\n");
    return;
  }
  const identity = await verifyBundleDirectory(
    command.bundle,
    command.expectedChecksum
  );
  process.stdout.write(JSON.stringify(identity));
  process.stdout.write("\n");
}

const [, entry] = process.argv;
// npm runs bins through a symlink, so compare the resolved path.
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : "error");
    process.stderr.write("\n");
    process.exitCode = 1;
  });
}

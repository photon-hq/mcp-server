#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { activateRuntimeRelease } from "@photon-ai/mcp-core/runtime/runtime-release";
import { loadLocalConfig } from "./config.js";
import runtimeRelease, {
  runtimeReleaseChecksum,
} from "./generated/runtime-release.js";
import { createLocalServerFactory } from "./local.js";

async function packageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  const { version } = manifest as { version?: unknown };
  return typeof version === "string" ? version : "unknown";
}

// stdout carries the MCP protocol; diagnostics go to stderr only.
async function main(): Promise<void> {
  const config = loadLocalConfig(process.env);
  if (config.apiUrl !== "https://api.photon.codes") {
    process.stderr.write(`photon-mcp: using API ${config.apiUrl}\n`);
  }
  const release = await activateRuntimeRelease(
    runtimeRelease,
    runtimeReleaseChecksum
  );
  const createServer = await createLocalServerFactory({
    config,
    release,
    version: await packageVersion(),
  });
  await createServer().connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `photon-mcp: ${error instanceof Error ? error.message : "startup failed"}\n`
  );
  process.exitCode = 1;
});

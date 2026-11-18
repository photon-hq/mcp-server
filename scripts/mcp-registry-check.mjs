#!/usr/bin/env node
// Official MCP Registry state for one release. A version is never overwritten:
// if the registry already has it, its server definition must match server.json
// and the publish step is skipped. `verify` polls until the registry serves the
// version. Usage:
//   node scripts/mcp-registry-check.mjs plan|verify SERVER_JSON_PATH
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function published(name, version) {
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "photon-mcp-release" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    return null;
  }
  assert.ok(response.ok, `MCP Registry returned HTTP ${response.status} for ${url}`);
  return response.json();
}

/** True when the MCP Registry still lacks the version; throws on mismatch. */
async function missing(expected) {
  const record = await published(expected.name, expected.version);
  if (!record) {
    return true;
  }
  const actual = record.server;
  assert.ok(actual, "MCP Registry response is missing server object");
  assert.equal(actual.name, expected.name, "MCP Registry server name mismatch");
  assert.equal(actual.version, expected.version, "MCP Registry server version mismatch");
  assert.deepEqual(actual.remotes, expected.remotes, "MCP Registry remotes mismatch");
  assert.deepEqual(actual.packages, expected.packages, "MCP Registry packages mismatch");
  return false;
}

const [mode, serverJsonPath] = process.argv.slice(2);
assert.ok(
  ["plan", "verify"].includes(mode) && serverJsonPath,
  "Usage: mcp-registry-check.mjs plan|verify SERVER_JSON_PATH"
);
const expected = JSON.parse(await readFile(serverJsonPath, "utf8"));
assert.ok(
  expected.name && /^\d+\.\d+\.\d+$/.test(expected.version ?? ""),
  `Invalid name or version in ${serverJsonPath}`
);

if (mode === "plan") {
  const publish = await missing(expected);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  }
  console.log(
    publish
      ? `Publishing ${expected.name} ${expected.version} to MCP Registry.`
      : `${expected.name} ${expected.version} is already on MCP Registry.`
  );
} else {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (await missing(expected)) {
    assert.ok(
      Date.now() < deadline,
      `${expected.name} ${expected.version} is not visible on MCP Registry yet; retry the release`
    );
    console.log(`Waiting for ${expected.name} ${expected.version} on MCP Registry...`);
    await sleep(10_000);
  }
  console.log(`${expected.name} ${expected.version} on MCP Registry matches ${serverJsonPath}.`);
}

#!/usr/bin/env node
// npm state for one release. A version is never overwritten: if npm already
// has it, its bytes must equal the built tarball and the publish step is
// skipped. `verify` polls until npm serves the tarball, since a new upload
// shows up seconds to minutes later. Usage:
//   node scripts/registry-check.mjs plan|verify NAME VERSION TARBALL_DIRECTORY
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function published(name, version) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "photon-mcp-release" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    return null;
  }
  assert.ok(response.ok, `npm returned HTTP ${response.status} for ${url}`);
  return response.json();
}

/** True when npm still lacks the version; throws if it has different bytes. */
async function missing(name, version, bytes) {
  const manifest = await published(name, version);
  if (!manifest) {
    return true;
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(
    manifest.dist.integrity,
    integrity,
    "npm already has this version with different bytes; release a new version instead"
  );
  return false;
}

const [mode, name, version, directory] = process.argv.slice(2);
assert.ok(
  ["plan", "verify"].includes(mode) &&
    name &&
    /^\d+\.\d+\.\d+$/.test(version ?? "") &&
    directory,
  "Usage: registry-check.mjs plan|verify NAME VERSION TARBALL_DIRECTORY"
);
const tarballs = (await readdir(directory)).filter((file) => file.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "Expected exactly one tarball");
const bytes = await readFile(join(directory, tarballs[0]));

if (mode === "plan") {
  const publish = await missing(name, version, bytes);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  }
  console.log(publish ? `Publishing ${name} ${version}.` : `${name} ${version} is already on npm with these bytes.`);
} else {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (await missing(name, version, bytes)) {
    assert.ok(Date.now() < deadline, `${name} ${version} is not visible on npm yet; retry the release`);
    console.log(`Waiting for ${name} ${version} on npm...`);
    await sleep(15_000);
  }
  console.log(`${name} ${version} on npm matches the built tarball.`);
}

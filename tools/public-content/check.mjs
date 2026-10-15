#!/usr/bin/env node
// Public content check. Every file in this repository and every commit message
// must be free of internal identifiers, local paths and credential-shaped
// values. Internal identifiers are listed only as SHA-256 hashes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const internalTermHashes = new Set([
  "6dfcd9a8e3a02a70bac21971c0b69561884359f850d7151d3451ed755f3f8099",
  "b44c7eaf88e2843fa6821c682d49ff33a473b248ef52b86ce70163b9fd0c8718",
  "56d5d419fab9f9c394847225d03291358160bf14f4abc8ff4ac13aea26cd2223",
  "65b0e2cea7cd42eb7815cfaacf2bc035e090cd1fea93319ef26e8457a2783903",
  "7df2ef96bcfe02fc865847731c9031584ab582563a84f2d923069b85c5e60190",
  "11810ec2a8369536786230b73126e43c173ada26da4ae75c957764d149e13f8f",
  "17c96ba030dbc76afbfe3ae5e5dcd1642beda1268de7e0a02b0470671eb00dfc",
  "212776f49d894288d048e4bb68f80b3524aad80487e506af7239231ef5d72efd",
  "f0fcf169a84eb47b6b94abdd6311644f4f25ddcf4d4cf220c599723c30cff551",
  "236c06d735c2d978446c40aff313c9a0530a712efd4186fee52da138c7d8095d",
  "0e10f3b8bb2a1ef311aba90fc1dd1e92b64513ea594607a17d1cd5f79c425792",
  "addc3bcdc97955777d35537fb66ee622dd02b72d3d14390596127d254eab56b2",
  "ee4290e15e9a2f894e730a406061e2ac1bb679e167c2c1712a834b90351b8ad8",
]);

const rules = [
  ["local-filesystem-path", /\/Users\/[A-Za-z0-9_.-]+\/|\/home\/(?:runner|[a-z][a-z0-9_-]*)\/|\/private\/tmp\/|[A-Z]:\\Users\\/],
  ["credential-shaped-value", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bpho_(?:ask|sk)_[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b|\bpypi-[A-Za-z0-9_-]{50,}\b/],
  // The @photon-hq/contracts namespace is public response metadata; depending
  // on or importing that package is not.
  ["internal-package-dependency", /(?:\b(?:from|import)\s*|\b(?:require(?:\.resolve)?|import)\s*\(\s*)["']@photon-hq\/contracts(?:\/[^"']*)?["']|["']@photon-hq\/contracts["']\s*:|(?:node_modules\/|registry\.npmjs\.org\/)@photon-hq\/contracts\b/i],
];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Lowercase tokens, their path segments and pairs, words and host suffixes. */
export function candidates(text) {
  const result = new Set();
  for (const [token] of text.matchAll(/[A-Za-z0-9@][A-Za-z0-9@._/-]*/g)) {
    const lower = token.toLowerCase().replace(/[._/-]+$/, "");
    result.add(lower);
    const segments = lower.split("/").filter(Boolean);
    segments.forEach((segment, index) => {
      result.add(segment);
      if (index + 1 < segments.length) {
        result.add(`${segment}/${segments[index + 1]}`);
        result.add(`${segment}/${segments[index + 1].split(".")[0]}`);
      }
      const labels = segment.split(".");
      for (let start = 1; start < labels.length - 1; start += 1) result.add(labels.slice(start).join("."));
    });
    for (const word of lower.split(/[^a-z0-9]+/)) if (word) result.add(word);
  }
  return result;
}

export function contentFindings(text, depth = 0) {
  assert.ok(depth < 100, "Content nesting exceeds inspection limit");
  const findings = new Set();
  const inspect = (value, level) => {
    assert.ok(level < 100, "Content nesting exceeds inspection limit");
    if (typeof value === "string") {
      for (const [name, rule] of rules) if (rule.test(value)) findings.add(name);
      for (const candidate of candidates(value)) {
        if (internalTermHashes.has(sha256(candidate))) { findings.add("internal-identifier"); break; }
      }
      // Inline source maps are otherwise invisible to plain-text scanning.
      for (const match of value.matchAll(/data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)/g)) {
        inspect(Buffer.from(match[1], "base64").toString("utf8"), level + 1);
      }
      // JSON escapes (for example \u0061) hide identifiers from plain text.
      if (value.includes("\\u")) {
        try { const decoded = JSON.parse(value); if (decoded !== value) inspect(decoded, level + 1); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
    } else if (Array.isArray(value)) for (const item of value) inspect(item, level + 1);
    else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) { inspect(key, level + 1); inspect(item, level + 1); }
  };
  inspect(text, depth);
  return [...findings].sort();
}

export function checkText(label, text) {
  const findings = contentFindings(text);
  assert.deepEqual(findings, [], `Blocked content in ${label}: ${findings.join(", ")}`);
}

async function walk(root, prefix = "") {
  const { readdir } = await import("node:fs/promises");
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Not a regular file: ${path}`);
  }
  return result;
}

async function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // --tree DIRECTORY checks every file below a directory (for example an
  // extracted package archive); otherwise the tracked files of this checkout.
  const tree = process.argv.indexOf("--tree");
  const root = tree === -1 ? process.cwd() : resolve(process.argv[tree + 1]);
  const paths = tree === -1 ? await trackedFiles(root) : await walk(root);
  assert.ok(paths.length, "No tracked files to check");
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path));
    assert.ok(!bytes.includes(0), `Binary content is not public source: ${path}`);
    checkText(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  if (process.argv.includes("--commit-message")) {
    checkText("the HEAD commit message", execFileSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf8" }));
  }
  console.log(`Public content check passed (${paths.length} files).`);
}

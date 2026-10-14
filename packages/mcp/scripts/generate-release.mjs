// Compiles the committed catalog source into the runtime module the CLI
// embeds, and writes a reviewable bundle to .release/production/.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { compileRelease } from "@photon-ai/mcp-core/compiler/compile";
import {
  writeBundle,
  writeRuntimeModule,
} from "@photon-ai/mcp-core/compiler/release-artifacts/index";
import { restrictToOauthScopes } from "../dist/admission.js";

const catalog = new URL("../catalog/", import.meta.url);
const output = new URL("../.release/production/", import.meta.url);

const bytes = await readFile(new URL("openapi.json", catalog));
const scopes = JSON.parse(
  await readFile(new URL("oauth-scopes.json", catalog), "utf8")
);
const { aggregate, excluded } = restrictToOauthScopes(
  JSON.parse(bytes.toString("utf8")),
  scopes
);
const compiled = compileRelease({
  aggregate,
  aggregateEtag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
  compilerPolicy: { operationPollLimit: 3 },
  environment: "production",
});

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await writeBundle(compiled, new URL("bundle", output).pathname);
await writeFile(
  new URL("excluded.json", output),
  `${JSON.stringify(excluded, null, 2)}\n`
);
await writeFile(
  new URL("tools.txt", output),
  `${compiled.tools
    .map((tool) => tool.name)
    .sort()
    .join("\n")}\n`
);
await writeRuntimeModule(
  compiled,
  new URL("../src/generated/runtime-release.ts", import.meta.url).pathname
);
console.log(
  `Compiled ${compiled.tools.length} tools; ${excluded.length} operations outside OAuth scopes excluded.`
);

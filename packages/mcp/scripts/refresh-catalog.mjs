// Replaces the committed catalog source with the production API's current
// OpenAPI document and the scopes OAuth clients can be granted.
import { mkdir, writeFile } from "node:fs/promises";

const origin = "https://api.photon.codes";
const catalog = new URL("../catalog/", import.meta.url);

async function fetchJson(path) {
  const response = await fetch(`${origin}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return response.json();
}

const [openapi, grantable] = await Promise.all([
  fetchJson("/openapi.json"),
  fetchJson("/v1/auth/oauth/scopes"),
]);
const { scopes } = grantable;
if (
  !Array.isArray(scopes) ||
  scopes.some((scope) => typeof scope !== "string")
) {
  throw new Error("GET /v1/auth/oauth/scopes returned no scope list.");
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
await mkdir(catalog, { recursive: true });
await writeFile(new URL("openapi.json", catalog), json(openapi));
await writeFile(
  new URL("oauth-scopes.json", catalog),
  json([...new Set(scopes)].sort())
);
console.log(
  `Catalog source refreshed: ${Object.keys(openapi.paths ?? {}).length} paths, ${scopes.length} OAuth scopes.`
);

import type { McpServer } from "@modelcontextprotocol/server";
import { createRequestStateCodec } from "@photon-ai/mcp-core/runtime/request-state";
import type { ActivatedRuntimeRelease } from "@photon-ai/mcp-core/runtime/runtime-release";
import { createServerFactory } from "@photon-ai/mcp-core/runtime/server";
import type { LocalConfig } from "./config.js";

export interface LocalServerInput {
  readonly config: LocalConfig;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly release: ActivatedRuntimeRelease;
  readonly version: string;
}

const requestStateTtlMilliseconds = 300_000;

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function keyFingerprint(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey)
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function authenticatedFetch(
  input: LocalServerInput
): (request: Request) => Promise<Response> {
  const send = input.fetch ?? ((request: Request) => fetch(request));
  return async (request) => {
    const url = new URL(request.url);
    if (
      url.origin !== input.config.apiUrl ||
      url.username ||
      url.password ||
      url.hash ||
      request.redirect !== "manual"
    ) {
      throw new Error("invalid_upstream_request");
    }
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${input.config.apiKey}`);
    headers.set("user-agent", `photon-mcp/${input.version}`);
    return await send(new Request(request, { headers, redirect: "manual" }));
  };
}

export async function createLocalServerFactory(
  input: LocalServerInput
): Promise<() => McpServer> {
  // State lives only as long as this process, so a fresh key per run is enough.
  const stateCodec = createRequestStateCodec({
    audience: `photon-mcp-local:${input.config.apiUrl}`,
    keys: [{ key: randomBytes(32), kid: "local" }],
  });
  const subject = await keyFingerprint(input.config.apiKey);
  const noop = () => undefined;
  return createServerFactory(input.release, {
    auth: { accountId: subject, subject },
    policy: {
      fetchUpstream: authenticatedFetch(input),
      now: () => Date.now(),
      randomBytes,
      record: noop,
      requestStateTtlMilliseconds,
      stateCodec,
      upstreamUrl: input.config.apiUrl,
    },
    serverInfo: { name: "photon-mcp", version: input.version },
    verifyRequestState: stateCodec.verify,
  });
}

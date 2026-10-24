import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type CallToolResult,
  fromJsonSchema,
  type jsonSchemaValidator,
  type McpServer,
} from "@modelcontextprotocol/server";
import { errorResult } from "./execution/response.js";

const docsEndpoint = "https://photon.codes/docs/mcp";
const betaPathPattern = "^/beta/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*(?:\\.mdx)?$";
const betaPath = new RegExp(betaPathPattern, "u");
const searchPage = /^Page: (beta\/[^\r\n]+)$/mu;
const searchLink = /^Link: .*$/mu;
const docsTimeoutMilliseconds = 15_000;
const annotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
};

async function callDocs(
  name: string,
  args: Record<string, string>,
  signal: AbortSignal
): Promise<CallToolResult> {
  const client = new Client({ name: "photon-beta-docs", version: "1.0.0" });
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(docsTimeoutMilliseconds),
  ]);
  const transport = new StreamableHTTPClientTransport(new URL(docsEndpoint), {
    // Public docs must never use the host's authenticated API fetch or follow redirects.
    requestInit: {
      credentials: "omit",
      redirect: "error",
      signal: boundedSignal,
    },
  });
  try {
    const options = { signal: boundedSignal, timeout: docsTimeoutMilliseconds };
    await client.connect(transport, options);
    const result = await client.callTool({ arguments: args, name }, options);
    if (result.resultType === "input_required" || result.isError) {
      return errorResult("docs_unavailable");
    }
    const content = result.content.filter((item) => item.type === "text");
    if (name !== "search_photon") {
      return { content };
    }
    // Also reject off-version hits if the upstream search ever ignores its filter.
    const betaContent = content.flatMap((item) => {
      const path = searchPage.exec(item.text)?.[1];
      return path && betaPath.test(`/${path}`)
        ? [
            {
              ...item,
              text: item.text.replace(
                searchLink,
                `Link: https://photon.codes/docs/${path}`
              ),
            },
          ]
        : [];
    });
    return {
      content:
        betaContent.length > 0
          ? betaContent
          : [{ text: "No matching Beta documentation found.", type: "text" }],
    };
  } catch {
    signal.throwIfAborted();
    return errorResult("docs_unavailable");
  } finally {
    await client.close();
  }
}

export function registerBetaDocsTools(
  server: McpServer,
  validator: jsonSchemaValidator
): void {
  server.registerTool(
    "search_docs",
    {
      annotations,
      description:
        "Search Photon Beta documentation for the current Photon API. Returns snippets and page paths for read_docs. Stable documentation is excluded.",
      inputSchema: fromJsonSchema<{ query: string }>(
        {
          additionalProperties: false,
          properties: {
            query: { maxLength: 2000, minLength: 1, type: "string" },
          },
          required: ["query"],
          type: "object",
        },
        validator
      ),
      title: "Search Photon Beta documentation",
    },
    ({ query }, context) =>
      callDocs(
        "search_photon",
        { query, version: "Beta" },
        context.mcpReq.signal
      )
  );
  server.registerTool(
    "read_docs",
    {
      annotations,
      description:
        "Read a Photon Beta documentation page discovered with search_docs. Pass its path under /beta/, for example /beta/ai-tools/mcp. Only individual Beta pages can be read; URLs, Stable paths and shell commands are rejected.",
      inputSchema: fromJsonSchema<{ path: string }>(
        {
          additionalProperties: false,
          properties: {
            path: { maxLength: 1000, pattern: betaPathPattern, type: "string" },
          },
          required: ["path"],
          type: "object",
        },
        validator
      ),
      title: "Read Photon Beta documentation",
    },
    ({ path }, context) =>
      callDocs(
        "query_docs_filesystem_photon",
        {
          command: `cat ${path.endsWith(".mdx") ? path : `${path}.mdx`}`,
        },
        context.mcpReq.signal
      )
  );
}

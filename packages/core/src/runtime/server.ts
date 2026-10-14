import {
  type Implementation,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  type CapabilityProtocolFacts,
  executeCapability,
  type RuntimeDependencies as PolicyDependencies,
} from "./execution/index.js";
import type { ExecutionPrincipal } from "./principal.js";
import type { ActivatedRuntimeRelease } from "./runtime-release.js";

export interface RuntimeDependencies {
  readonly auth: ExecutionPrincipal;
  readonly canonicalMcpUrl?: string;
  readonly policy: PolicyDependencies;
  readonly serverInfo: Implementation;
  readonly verifyRequestState: (
    state: string,
    context: ServerContext
  ) => unknown | Promise<unknown>;
}

type SessionDependencies = Pick<
  RuntimeDependencies,
  "serverInfo" | "verifyRequestState"
> & {
  readonly forRequest: (context: ServerContext) => RuntimeDependencies;
};

function stateRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function advertisedContinuation(args: unknown): string | undefined {
  if (!stateRecord(args)) {
    return;
  }
  const { continuation } = args;
  return typeof continuation === "string" && continuation.length > 0
    ? continuation
    : undefined;
}

function protocolFacts(
  args: unknown,
  context: ServerContext
): CapabilityProtocolFacts {
  const sdkRequestState = context.mcpReq.requestState<unknown>();
  const continuation = advertisedContinuation(args);
  return {
    ...(continuation === undefined ? {} : { continuation }),
    ...(sdkRequestState === undefined ? {} : { sdkRequestState }),
  };
}

function executeRegisteredTool(
  args: unknown,
  context: ServerContext,
  entry: ActivatedRuntimeRelease["registrationPlan"][number],
  release: ActivatedRuntimeRelease,
  dependencies: RuntimeDependencies
) {
  const progressToken = context.mcpReq._meta?.progressToken;
  const notifyProgress =
    typeof progressToken === "string" || typeof progressToken === "number"
      ? async (
          update: Readonly<{
            readonly message: string;
            readonly progress: number;
            readonly total: number;
          }>
        ) =>
          await context.mcpReq.notify({
            method: "notifications/progress",
            params: { ...update, progressToken },
          })
      : undefined;
  return executeCapability(
    {
      auth: dependencies.auth,
      execution: entry.execution,
      input: args,
      ...(notifyProgress === undefined ? {} : { notifyProgress }),
      ...(entry.operationGetter === undefined
        ? {}
        : { operationGetter: entry.operationGetter }),
      protocolFacts: protocolFacts(args, context),
      releaseIdentity: release.releaseIdentity,
      signal: context.mcpReq.signal,
    },
    dependencies.policy
  );
}

export function createServerFactory(
  release: ActivatedRuntimeRelease,
  dependencies: RuntimeDependencies | SessionDependencies
): () => McpServer {
  return () => {
    const verifyOfficialRequestState = async (
      state: string,
      context: ServerContext
    ): Promise<unknown> => {
      const current =
        "forRequest" in dependencies
          ? dependencies.forRequest(context)
          : dependencies;
      try {
        const verify = () => dependencies.verifyRequestState(state, context);
        return current.policy.span
          ? await current.policy.span("mcp.continuation.verify", {}, verify)
          : await verify();
      } catch {
        current.policy.event?.(
          "photon.mcp.tool.calls",
          { "mcp.result": "rejected" },
          1
        );
        current.policy.log?.("photon.mcp.tool.event", {
          "error.type": "invalid_request_state",
          "mcp.result": "rejected",
        });
        // biome-ignore lint/style/useErrorCause: retaining a verifier failure could retain signed-state details.
        throw new Error("invalid_request_state");
      }
    };
    const server = new McpServer(dependencies.serverInfo, {
      cacheHints: {
        "tools/list": { cacheScope: "public", ttlMs: 300_000 },
      },
      jsonSchemaValidator: release.validator,
      requestState: { verify: verifyOfficialRequestState },
    });
    for (const entry of release.registrationPlan) {
      server.registerTool(entry.name, entry.options, (args, context) =>
        executeRegisteredTool(
          args,
          context,
          entry,
          release,
          "forRequest" in dependencies
            ? dependencies.forRequest(context)
            : dependencies
        )
      );
    }
    return server;
  };
}

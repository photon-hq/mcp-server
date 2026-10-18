import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "../src/release.js";
import {
  type CapabilityExecutionRequest,
  executeCapability,
  type RuntimeDependencies,
} from "../src/runtime/execution/index.js";
import type { ExecutionPrincipal } from "../src/runtime/principal.js";
import { activateRuntimeRelease } from "../src/runtime/runtime-release.js";
import { makeRuntimeRelease } from "./runtime-release.fixture.js";

const auth: ExecutionPrincipal = {
  accountId: "account-1",
  subject: "subject-1",
};

const projectCapability = {
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },

  idempotency: "none",
  inputSchema: { type: "object" },
  method: "GET",
  operationId: "getItem",
  outputSchema: {
    additionalProperties: false,
    properties: { data: { type: "object" }, status: { const: 200 } },
    required: ["status", "data"],
    type: "object",
  },
  pathTemplate: "/projects/{projectId}",
  requiredPermissions: [],
  successRepresentations: [
    { mediaType: "application/json", schema: { type: "object" }, status: 200 },
  ],
} as const;

const operationOutputSchema = {
  additionalProperties: false,
  properties: {
    data: { type: "object" },
    status: { enum: [200, 202] },
  },
  required: ["status", "data"],
  type: "object",
};

const operationGetter = {
  ...projectCapability,
  operationId: "getOperation",
  outputSchema: operationOutputSchema,
  pathTemplate: "/projects/{projectId}/operations/{operationId}",
} as const;

const asyncCapability = {
  ...projectCapability,

  method: "POST",
  operationGetter: "getOperation",
  operationId: "startOperation",
  operationPollLimit: 1,
  outputSchema: operationOutputSchema,
  successRepresentations: [
    { mediaType: "application/json", schema: { type: "object" }, status: 202 },
  ],
} as const;

const idempotentAsyncCapability = {
  ...asyncCapability,

  idempotency: "header",
  idempotencyKeySchema: { maxLength: 255, minLength: 1, type: "string" },
} as const;

const executionValidator = new AjvJsonSchemaValidator();

function executionFor(
  capability: Capability
): CapabilityExecutionRequest["execution"] {
  const output = executionValidator.getValidator(capability.outputSchema);
  const key =
    capability.idempotencyKeySchema === undefined
      ? undefined
      : executionValidator.getValidator(capability.idempotencyKeySchema);
  const successRepresentations = capability.successRepresentations.map(
    (representation) =>
      "schema" in representation
        ? {
            mediaType: representation.mediaType,
            status: representation.status,
            validate: (() => {
              const validate = executionValidator.getValidator(
                representation.schema
              );
              return (value: unknown) => validate(value).valid;
            })(),
          }
        : { status: 204 as const }
  );
  return {
    capability,
    inputSchema:
      capability.inputSchema as unknown as CapabilityExecutionRequest["execution"]["inputSchema"],
    outputSchema:
      capability.outputSchema as unknown as CapabilityExecutionRequest["execution"]["outputSchema"],
    successRepresentations,
    ...(key === undefined
      ? {}
      : { validateIdempotencyKey: (value: unknown) => key(value).valid }),
    validateOutput: (value) => output(value).valid,
  };
}

function dependencies(
  response = new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
    status: 200,
  }),
  fetcher?: RuntimeDependencies["fetchUpstream"],
  overrides: Partial<RuntimeDependencies> = {}
) {
  const requests: Request[] = [];
  const dependency: RuntimeDependencies = {
    fetchUpstream:
      fetcher ??
      ((upstreamRequest) => {
        requests.push(upstreamRequest);
        return Promise.resolve(response);
      }),
    now: () => 1000,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    record: () => undefined,
    requestStateTtlMilliseconds: 300_000,
    stateCodec: { mint: async () => "state", verify: async () => ({}) },
    upstreamUrl: "https://api.photon.codes",
    ...overrides,
  };
  return { dependency, requests };
}

function request(value: unknown) {
  return {
    auth,
    execution: executionFor(projectCapability),
    input: { path: { projectId: value } },
    protocolFacts: {},
    releaseIdentity: "release-1",
    signal: new AbortController().signal,
  };
}

async function continuationFixture(
  overrides: Partial<RuntimeDependencies> = {}
) {
  const requests: Request[] = [];
  const states = new Map<string, Record<string, unknown>>();
  const dependency: RuntimeDependencies = {
    fetchUpstream: (upstreamRequest) => {
      requests.push(upstreamRequest);
      return Promise.resolve(
        requests.length === 1
          ? new Response(
              JSON.stringify({
                operationId: "operation-1",
                projectId: "project-1",
                state: "running",
              }),
              {
                headers: { "content-type": "application/json" },
                status: 202,
              }
            )
          : new Response(
              JSON.stringify({
                operationId: "operation-1",
                projectId: "project-1",
                state: "running",
              }),
              { headers: { "content-type": "application/json" }, status: 200 }
            )
      );
    },
    now: () => 1000,
    randomBytes: (length) => new Uint8Array(length),
    record: () => undefined,
    requestStateTtlMilliseconds: 300_000,
    stateCodec: {
      mint: (value) => {
        const token = `state-${states.size}`;
        states.set(token, { ...value });
        return Promise.resolve(token);
      },
      verify: (stateToken) => Promise.resolve(states.get(stateToken) ?? {}),
    },
    upstreamUrl: "https://api.photon.codes",
    ...overrides,
  };
  const first = await executeCapability(
    {
      ...request("project-1"),
      execution: executionFor(idempotentAsyncCapability),
      operationGetter: executionFor(operationGetter),
    },
    dependency
  );
  const token =
    "requestState" in first && typeof first.requestState === "string"
      ? first.requestState
      : "missing";
  const state = states.get(token);
  if (!state) {
    throw new Error("missing continuation state");
  }
  return { dependency, requests, state, token };
}

async function execute202(
  operation: Readonly<Record<string, unknown>>,
  options: Readonly<{
    operationGetter?: Capability;
    source?: Capability;
  }> = { operationGetter }
) {
  const requests: Request[] = [];
  const minted: Readonly<Record<string, unknown>>[] = [];
  const { dependency } = dependencies(
    undefined,
    (upstreamRequest) => {
      requests.push(upstreamRequest);
      return Promise.resolve(
        new Response(
          JSON.stringify({ ...operation, privateDetail: "must-not-escape" }),
          {
            headers: { "content-type": "application/json" },
            status: requests.length === 1 ? 202 : 200,
          }
        )
      );
    },
    {
      stateCodec: {
        mint: (value) => {
          minted.push(value);
          return Promise.resolve("continuation-state");
        },
        verify: () => Promise.resolve(minted[0] ?? {}),
      },
    }
  );
  const result = await executeCapability(
    {
      ...request("project-1"),
      execution: executionFor(options.source ?? asyncCapability),
      ...(options.operationGetter === undefined
        ? {}
        : { operationGetter: executionFor(options.operationGetter) }),
    },
    dependency
  );
  return { minted, requests, result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("capability execution lifecycle and responses", () => {
  it("keeps progress silent without a token and isolates notification failure", async () => {
    let calls = 0;
    let state: Readonly<Record<string, unknown>> = {};
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId: "operation-1",
              projectId: "project-1",
              state: "succeeded",
            },
            { status: calls === 1 ? 202 : 200 }
          )
        );
      },
      {
        stateCodec: {
          mint: (value) => {
            state = value;
            return Promise.resolve("continuation-state");
          },
          verify: async () => state,
        },
      }
    );

    const withoutToken = await executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(asyncCapability),
        operationGetter: executionFor(operationGetter),
      },
      dependency
    );
    expect(withoutToken).toMatchObject({
      resultType: "complete",
      structuredContent: { data: { state: "succeeded" }, status: 200 },
    });

    calls = 0;
    let notified = false;
    const withFailure = await executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(asyncCapability),
        notifyProgress: () => {
          notified = true;
          return Promise.reject(new Error("offline"));
        },
        operationGetter: executionFor(operationGetter),
      },
      dependency
    );
    expect(withFailure).toMatchObject({
      resultType: "complete",
      structuredContent: { data: { state: "succeeded" }, status: 200 },
    });
    expect(calls).toBe(2);
    expect(notified).toBe(true);
  });

  it("propagates the caller abort reason when progress notification fails", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled progress");
    let calls = 0;
    let state: Readonly<Record<string, unknown>> = {};
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId: "operation-1",
              projectId: "project-1",
              state: "running",
            },
            { status: calls === 1 ? 202 : 200 }
          )
        );
      },
      {
        stateCodec: {
          mint: (value) => {
            state = value;
            return Promise.resolve("continuation-state");
          },
          verify: () => Promise.resolve(state),
        },
      }
    );

    await expect(
      executeCapability(
        {
          ...request("project-1"),
          execution: executionFor(asyncCapability),
          notifyProgress: () => {
            controller.abort(reason);
            return Promise.reject(new Error("notification offline"));
          },
          operationGetter: executionFor(operationGetter),
          signal: controller.signal,
        },
        dependency
      )
    ).rejects.toBe(reason);
  });

  it("propagates the caller abort reason after progress notification resolves", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled after progress started");
    const notification = Promise.withResolvers<void>();
    const notified = Promise.withResolvers<void>();
    let calls = 0;
    let state: Readonly<Record<string, unknown>> = {};
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId: "operation-1",
              projectId: "project-1",
              state: "running",
            },
            { status: calls === 1 ? 202 : 200 }
          )
        );
      },
      {
        stateCodec: {
          mint: (value) => {
            state = value;
            return Promise.resolve("continuation-state");
          },
          verify: () => Promise.resolve(state),
        },
      }
    );
    const pending = executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(asyncCapability),
        notifyProgress: () => {
          notified.resolve();
          return notification.promise;
        },
        operationGetter: executionFor(operationGetter),
        signal: controller.signal,
      },
      dependency
    );

    await notified.promise;
    controller.abort(reason);
    notification.resolve();

    await expect(pending).rejects.toBe(reason);
  });

  it("propagates abort while progress notification never settles", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled pending progress");
    const notification = Promise.withResolvers<void>();
    const notified = Promise.withResolvers<void>();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener"
    );
    let calls = 0;
    let state: Readonly<Record<string, unknown>> = {};
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId: "operation-1",
              projectId: "project-1",
              state: "running",
            },
            { status: calls === 1 ? 202 : 200 }
          )
        );
      },
      {
        stateCodec: {
          mint: (value) => {
            state = value;
            return Promise.resolve("continuation-state");
          },
          verify: () => Promise.resolve(state),
        },
      }
    );
    const pending = executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(asyncCapability),
        notifyProgress: () => {
          notified.resolve();
          return notification.promise;
        },
        operationGetter: executionFor(operationGetter),
        signal: controller.signal,
      },
      dependency
    );

    await notified.promise;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    notification.reject(new Error("late notification rejection"));
    await Promise.resolve();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function)
    );
  });

  it("uses configured TTL for continuation and renewal", async () => {
    const minted: Readonly<Record<string, unknown>>[] = [];
    let calls = 0;
    let currentNow = 1000;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId: "operation-1",
              projectId: "project-1",
              state: "running",
            },
            { status: calls === 1 ? 202 : 200 }
          )
        );
      },
      {
        now: () => currentNow,
        requestStateTtlMilliseconds: 123_000,
        stateCodec: {
          mint: (value) => {
            minted.push(value);
            if (value.class === "continuation") {
              currentNow = 5000;
            }
            return Promise.resolve(`state-${minted.length}`);
          },
          verify: async (token) =>
            minted[Number(token.replace("state-", "")) - 1] ?? {},
        },
      }
    );
    await executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(idempotentAsyncCapability),
        operationGetter: executionFor(operationGetter),
      },
      dependency
    );
    expect(minted.map((state) => state.expiresAt)).toEqual([124_000, 128_000]);
  });

  it("matches success by exact status and normalized media before returning output", async () => {
    const fixture = await makeRuntimeRelease();
    const release = await activateRuntimeRelease(
      fixture.value,
      fixture.checksum
    );
    const execution = release.registrationPlan.find(
      (entry) => entry.name === "publicTool"
    )?.execution;
    if (!execution) {
      throw new Error("missing activated execution");
    }
    const bodylessExecution = executionFor({
      ...projectCapability,
      outputSchema: {
        additionalProperties: false,
        properties: { status: { const: 204 } },
        required: ["status"],
        type: "object",
      },
      pathTemplate: "/alpha/{key}",
      successRepresentations: [{ status: 204 }],
    });
    const markerExecution = executionFor({
      ...projectCapability,
      pathTemplate: "/alpha/{key}",
    });
    const diagnosticSentinel = "validator-detail";
    const diagnosticSchema = {
      additionalProperties: false,
      properties: {
        [diagnosticSentinel]: { type: "string" },
        ok: { type: "boolean" },
      },
      required: ["ok", diagnosticSentinel],
      type: "object",
    };
    const diagnosticInput = { ok: true };
    const diagnostic =
      executionValidator.getValidator(diagnosticSchema)(diagnosticInput);
    expect(diagnostic.valid).toBe(false);
    expect(diagnostic.errorMessage).toContain(diagnosticSentinel);
    const diagnosticExecution = executionFor({
      ...projectCapability,
      pathTemplate: "/alpha/{key}",
      successRepresentations: [
        {
          mediaType: "application/json",
          schema: diagnosticSchema,
          status: 200,
        },
      ],
    });
    const nonEmpty204 = new Response("body-secret validator-detail");
    Object.defineProperty(nonEmpty204, "status", { value: 204 });
    const cases: ReadonlyArray<{
      readonly execution?: CapabilityExecutionRequest["execution"];
      readonly name: string;
      readonly response: Response;
      readonly shouldError: boolean;
    }> = [
      {
        name: "redirect",
        response: Response.redirect("https://elsewhere.example", 302),
        shouldError: true,
      },
      {
        name: "undeclared status",
        response: new Response(
          JSON.stringify({ marker: "body-secret validator-detail" }),
          {
            headers: { "content-type": "application/json" },
            status: 201,
          }
        ),
        shouldError: true,
      },
      {
        name: "missing media",
        response: new Response(
          JSON.stringify({ marker: "body-secret validator-detail" }),
          { status: 200 }
        ),
        shouldError: true,
      },
      {
        name: "malformed media",
        response: new Response(
          JSON.stringify({ marker: "body-secret validator-detail" }),
          {
            headers: { "content-type": "application json" },
            status: 200,
          }
        ),
        shouldError: true,
      },
      {
        name: "unsupported media",
        response: new Response(
          JSON.stringify({ marker: "body-secret validator-detail" }),
          {
            headers: { "content-type": "text/plain" },
            status: 200,
          }
        ),
        shouldError: true,
      },
      {
        execution: markerExecution,
        name: "supported but undeclared media",
        response: new Response(
          JSON.stringify({ marker: "body-secret validator-detail" }),
          {
            headers: { "content-type": "application/vnd.photon+json" },
            status: 200,
          }
        ),
        shouldError: true,
      },
      {
        execution: markerExecution,
        name: "multiple media values",
        response: new Response(
          JSON.stringify({ marker: "body-secret validator-detail" }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8, text/plain",
            },
            status: 200,
          }
        ),
        shouldError: true,
      },
      {
        name: "invalid JSON",
        response: new Response("{body-secret validator-detail", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
        shouldError: true,
      },
      {
        execution: diagnosticExecution,
        name: "schema mismatch",
        response: new Response(JSON.stringify(diagnosticInput), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
        shouldError: true,
      },
      {
        name: "parameterized media",
        response: new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "Application/JSON; charset=utf-8" },
          status: 200,
        }),
        shouldError: false,
      },
      {
        name: "quoted comma parameter is ambiguous",
        response: new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": 'application/json; profile="a,b"',
          },
          status: 200,
        }),
        shouldError: true,
      },
      {
        name: "quoted parameter without comma",
        response: new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": 'application/json; profile="ab"',
          },
          status: 200,
        }),
        shouldError: false,
      },
      {
        name: "merged fields disguised by quotes",
        response: new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": 'application/json; charset=utf-8", text/plain"',
          },
          status: 200,
        }),
        shouldError: true,
      },
      {
        name: "unclosed quoted parameter",
        response: new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": 'application/json; profile="ab',
          },
          status: 200,
        }),
        shouldError: true,
      },
      {
        name: "illegal quoted escape",
        response: new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": 'application/json; profile="a\\\u0001"',
          },
          status: 200,
        }),
        shouldError: true,
      },
      {
        execution: bodylessExecution,
        name: "non-empty bodyless response",
        response: nonEmpty204,
        shouldError: true,
      },
    ] as const;
    for (const {
      execution: caseExecution = execution,
      name,
      response,
      shouldError,
    } of cases) {
      const observed: unknown[] = [];
      const { dependency } = dependencies(response, undefined, {
        log: (eventName, attributes) =>
          observed.push({ attributes, name: eventName }),
      });
      // biome-ignore lint/performance/noAwaitInLoops: each response owns a one-use body.
      const result = await executeCapability(
        {
          auth,
          execution: caseExecution,
          input: { path: { key: "alpha" } },
          protocolFacts: {},
          releaseIdentity: "release-1",
          signal: new AbortController().signal,
        } as CapabilityExecutionRequest,
        dependency
      );
      expect(result.isError === true, name).toBe(shouldError);
      if (shouldError) {
        expect(result).toMatchObject({
          structuredContent: { code: "upstream_contract_violation" },
        });
      }
      expect(JSON.stringify({ observed, result })).not.toContain("body-secret");
      expect(JSON.stringify({ observed, result })).not.toContain(
        "validator-detail"
      );
    }
  });

  it.each([
    200, 202,
  ])("cancels an unread upstream body when response %s is rejected", async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { dependency } = dependencies(
      new Response(body, {
        headers: { "content-type": "text/html" },
        status,
      })
    );
    const result = await executeCapability(request("project-1"), dependency);
    expect(result).toMatchObject({ isError: true });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("rejects undeclared empty success responses", async () => {
    const { dependency } = dependencies(new Response(null, { status: 204 }));
    const result = await executeCapability(request("project-1"), dependency);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "upstream_contract_violation" },
    });
  });

  it("bounds and sensitivity-checks every allowlisted Problem field", async () => {
    const { dependency } = dependencies(
      new Response(
        JSON.stringify({
          code: "not_found",
          detail: "credential=private",
          requestId: "request-1",
          status: 404,
          title: "Not found",
          type: "https://errors.example/not-found",
        }),
        {
          headers: { "content-type": "application/problem+json" },
          status: 404,
        }
      )
    );

    const result = await executeCapability(request("project-1"), dependency);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "not_found", status: 404, title: "Not found" },
    });
    const [text] = result.content as [{ text: string; type: "text" }];
    expect(text.text).toBe(
      `The upstream service rejected the request. ${JSON.stringify(result.structuredContent)}`
    );
    expect(JSON.stringify(result)).not.toContain("credential=private");
  });

  it.each([
    ["code", "code", { code: "token=private" }],
    ["internal type", "type", { type: "https://internal.example.com/private" }],
    ["single-label type", "type", { type: "https://backend/failure" }],
    ["private IPv4 type", "type", { type: "https://10.0.0.1/problem" }],
    ["local type", "type", { type: "https://service.local/problem" }],
    ["request ID", "requestId", { requestId: "credential=private" }],
    [
      "single-label request ID",
      "requestId",
      { requestId: "https://backend/failure" },
    ],
    ["title", "title", { title: "signed URL https://private.example" }],
    ["single-label title", "title", { title: "See https://backend/failure" }],
    ["bearer title", "title", { title: "Bearer abcdef" }],
    ["Photon key title", "title", { title: "Key pho_sk_abcdef revoked" }],
    ["detail", "detail", { detail: "password=private" }],
    ["API key detail", "detail", { detail: "api_key=private-value" }],
    [
      "single-label detail",
      "detail",
      { detail: "See https://backend/failure" },
    ],
    ["localhost detail", "detail", { detail: "See https://localhost/failure" }],
    ["numeric detail", "detail", { detail: "See https://2130706433/failure" }],
    [
      "internal-host detail",
      "detail",
      { detail: "See https://backend.internal/failure" },
    ],
    [
      "presigned-query detail",
      "detail",
      { detail: "See https://storage.example/object?X-Amz-Signature=abc" },
    ],
  ])("drops a sensitive Problem %s", async (_name, field, update) => {
    const { dependency } = dependencies(
      new Response(
        JSON.stringify({
          code: "safe_code",
          detail: "Safe detail",
          requestId: "request-1",
          status: 400,
          title: "Safe title",
          type: "urn:photon:problem:safe",
          ...update,
        }),
        {
          headers: { "content-type": "application/problem+json" },
          status: 400,
        }
      )
    );
    const result = await executeCapability(request("project-1"), dependency);

    expect((result.structuredContent as Record<string, unknown>)[field]).toBe(
      field === "code" ? "upstream_problem" : undefined
    );
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("retains only bounded public FQDN URLs in Problem fields", async () => {
    const { dependency } = dependencies(
      new Response(
        JSON.stringify({
          code: "safe_code",
          detail: `See https://status.example/failure ${"d".repeat(240)}`,
          requestId: `r${"1".repeat(160)}`,
          status: 400,
          title: `See https://errors.example/problem ${"t".repeat(160)}`,
          type: "https://errors.example/problem",
        }),
        {
          headers: { "content-type": "application/problem+json" },
          status: 400,
        }
      )
    );

    const projected = (
      await executeCapability(request("project-1"), dependency)
    ).structuredContent as Record<string, unknown>;

    expect(projected.type).toBe("https://errors.example/problem");
    expect(String(projected.title)).toHaveLength(160);
    expect(projected.detail).toBeUndefined();
    expect(String(projected.requestId)).toHaveLength(128);
  });

  it.each([
    ["an empty label", "a..b", false],
    ["an underscore", "_svc.example", false],
    ["a corp suffix", "backend.corp", false],
    ["an internal suffix", "backend.internal", false],
    ["a local suffix", "backend.local", false],
    ["a localhost suffix", "backend.localhost", false],
    ["a home suffix", "backend.home", false],
    ["a LAN suffix", "backend.lan", false],
    ["a test suffix", "backend.test", false],
    ["an invalid suffix", "backend.invalid", false],
    ["a leading hyphen", "-api.example", false],
    ["a trailing hyphen", "api-.example", false],
    ["an overlong label", `${"a".repeat(64)}.example`, false],
    ["an overlong name", `${`${"a".repeat(63)}.`.repeat(4)}example`, false],
    ["a valid public FQDN", "status.example", true],
  ] as const)("filters Problem URLs with %s", async (_name, hostname, retained) => {
    const type = `https://${hostname}/failure`;
    const { dependency } = dependencies(
      new Response(JSON.stringify({ status: 400, type }), {
        headers: { "content-type": "application/problem+json" },
        status: 400,
      })
    );

    const projected = (
      await executeCapability(request("project-1"), dependency)
    ).structuredContent as Record<string, unknown>;

    expect(projected.type).toBe(retained ? type : undefined);
  });

  it("omits untrusted Problem detail even without a URL or secret keyword", async () => {
    const detail = "connect ECONNREFUSED db01.prod.svc.cluster.local:5432";
    const { dependency } = dependencies(
      Response.json(
        { code: "UNAVAILABLE", detail, status: 400 },
        {
          headers: { "content-type": "application/problem+json" },
          status: 400,
        }
      )
    );
    const result = await executeCapability(request("project-1"), dependency);
    expect(result.structuredContent).toMatchObject({
      code: "UNAVAILABLE",
      status: 400,
    });
    expect(JSON.stringify(result)).not.toContain(detail);
    expect(result.structuredContent).not.toHaveProperty("detail");
  });

  it("preserves the upstream operations page and its continuation cursor", async () => {
    const operations = Array.from({ length: 201 }, (_, index) => ({
      detail: { private: "not-for-agent" },
      operationId: `operation-${index}`,
      projectId: "project-1",
      state: "running",
    }));
    const { dependency } = dependencies(
      Response.json({ nextPageToken: "next-page", operations })
    );
    const execution = executionFor({
      ...projectCapability,
      operationId: "listOperations",
      outputSchema: projectCapability.outputSchema,
    });
    const result = await executeCapability(
      { ...request("project-1"), execution },
      dependency
    );
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      status: number;
      data: Record<string, unknown>;
    };
    expect(output.status).toBe(200);
    expect(output.data.operations).toHaveLength(201);
    expect(output.data.nextPageToken).toBe("next-page");
    expect((output.data.operations as unknown[])[200]).toEqual({
      detail: { private: "not-for-agent" },
      operationId: "operation-200",
      projectId: "project-1",
      state: "running",
    });
  });

  it.each([
    ["mismatched status", { status: 401 }, {}, undefined],
    ["out-of-range status", { status: 700 }, {}, undefined],
    ["bounded retry", {}, { "retry-after": "60" }, 60],
    ["oversized retry", {}, { "retry-after": "61" }, undefined],
  ])("projects %s without trusting unbounded Problem facts", async (_name, update, headers, expected) => {
    const responseStatus = _name === "out-of-range status" ? 500 : 400;
    const { dependency } = dependencies(
      new Response(
        JSON.stringify({
          code: "safe_code",
          status: responseStatus,
          ...update,
        }),
        {
          headers: { "content-type": "application/problem+json", ...headers },
          status: responseStatus,
        }
      )
    );

    const result = await executeCapability(request("project-1"), dependency);
    const projected = result.structuredContent as Record<string, unknown>;
    if (_name.includes("status")) {
      expect(projected.status).toBe(expected);
    } else {
      expect(projected.retryAfter).toBe(expected);
    }
  });

  it("sanitizes an unexpected failure", async () => {
    const observed: unknown[] = [];
    const { dependency } = dependencies(
      undefined,
      () => Promise.reject(new Error("private upstream failure")),
      {
        event: (name, attributes) => observed.push({ attributes, name }),
        log: (name, attributes) => observed.push({ attributes, name }),
        record: (event) => observed.push(event),
      }
    );

    const result = await executeCapability(request("project-1"), dependency);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "internal_tool_error" },
    });
    expect(JSON.stringify(result)).not.toContain("private upstream failure");
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({
            "error.type": "internal_tool_error",
          }),
          name: "photon.mcp.tool.event",
        }),
      ])
    );
    expect(JSON.stringify(observed)).not.toContain("private upstream failure");
  });

  it("returns full asynchronous operation details through execution", async () => {
    const { result, minted } = await execute202(
      {
        error: { code: "PIN_INVALID", detail: "private error" },
        operationId: "operation-pin-token",
        pin: "123456",
        projectId: "project-secret-password",
        resource: { id: "resource-1", signedUrl: "private", type: "widget" },
        state: "running",
      },
      { operationGetter, source: asyncCapability }
    );
    expect(result).toMatchObject({ resultType: "input_required" });
    expect(result.structuredContent).toEqual({
      data: {
        error: { code: "PIN_INVALID", detail: "private error" },
        operationId: "operation-pin-token",
        pin: "123456",
        privateDetail: "must-not-escape",
        projectId: "project-secret-password",
        resource: { id: "resource-1", signedUrl: "private", type: "widget" },
        state: "running",
      },
      status: 200,
    });
    expect(JSON.stringify(result.content)).toContain("123456");
    expect(minted[0]).toMatchObject({
      operationId: "operation-pin-token",
      projectId: "project-secret-password",
    });
    expect(minted[0]).not.toHaveProperty("data");
    expect(minted[0]).not.toHaveProperty("error");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["slash", "a/b"],
    ["encoded slash", "a%2Fb"],
    ["backslash", "a\\b"],
    ["double slash", "//"],
    ["wrong type", 42],
  ])("fails a 202 closed for a %s projectId", async (_name, projectId) => {
    const { minted, requests, result } = await execute202({
      operationId: "operation-1",
      projectId,
      state: "running",
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "upstream_contract_violation" },
    });
    expect(
      requests.map((item) => item.headers.get("x-photon-mcp-operation"))
    ).toEqual([null]);
    expect(minted).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["slash", "a/b"],
    ["encoded slash", "a%2Fb"],
    ["backslash", "a\\b"],
    ["double slash", "//"],
    ["wrong type", 42],
  ])("fails a 202 closed for a %s operationId", async (_name, operationId) => {
    const { minted, requests, result } = await execute202({
      operationId,
      projectId: "project-1",
      state: "running",
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "upstream_contract_violation" },
    });
    expect(
      requests.map((item) => item.headers.get("x-photon-mcp-operation"))
    ).toEqual([null]);
    expect(minted).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("returns a 202 without polling when the source links no getter", async () => {
    const {
      operationGetter: _operationGetter,
      operationPollLimit: _limit,
      ...withoutGetter
    } = asyncCapability;
    const { minted, requests, result } = await execute202(
      {
        operationId: "operation-1",
        projectId: "project-1",
        state: "running",
      },
      { source: withoutGetter }
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: { operationId: "operation-1", state: "running" },
      status: 202,
    });
    expect(requests).toHaveLength(1);
    expect(minted).toHaveLength(0);
  });

  it("fails a 202 closed for an unresolved signed getter", async () => {
    const { requests, result } = await execute202(
      {
        operationId: "operation-1",
        projectId: "project-1",
        state: "running",
      },
      { source: asyncCapability }
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "upstream_contract_violation" },
    });
    expect(
      requests.map((item) => item.headers.get("x-photon-mcp-operation"))
    ).toEqual([null]);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("derives its deadline internally instead of trusting request input", async () => {
    const { dependency, requests } = dependencies();
    const forged = {
      ...request("project-1"),
      deadline: 0,
    } as CapabilityExecutionRequest;

    const result = await executeCapability(forged, dependency);

    expect(result).toMatchObject({ resultType: "complete" });
    expect(requests).toHaveLength(1);
  });

  it("records caller cancellation before rethrowing an invocation abort", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const observed: unknown[] = [];
    const spans: string[] = [];
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) =>
        new Promise((_resolve, reject) => {
          upstreamRequest.signal.addEventListener(
            "abort",
            () => reject(new TypeError("private fetch abort")),
            { once: true }
          );
          started.resolve();
        }),
      {
        event: (name, attributes) => observed.push({ attributes, name }),
        log: (name, attributes) => observed.push({ attributes, name }),
        record: (event) => observed.push(event),
        span: async (name, _attributes, callback) => {
          spans.push(name);
          return await callback();
        },
      }
    );
    const pending = executeCapability(
      { ...request("project-1"), signal: controller.signal },
      dependency
    );
    await started.promise;

    controller.abort(new Error("private caller reason"));

    await expect(pending).rejects.toThrow("private caller reason");
    expect(spans).toContain("mcp.tool.call");
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: "cancelled" }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "mcp.result": "cancelled" }),
          name: "photon.mcp.tool.event",
        }),
      ])
    );
    expect(JSON.stringify(observed)).not.toContain("private caller reason");
  });

  it("records caller cancellation while polling before rethrow", async () => {
    const controller = new AbortController();
    const polling = Promise.withResolvers<void>();
    const observed: unknown[] = [];
    const spans: string[] = [];
    let calls = 0;
    let state: Readonly<Record<string, unknown>> = {};
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            Response.json(
              {
                operationId: "operation-1",
                projectId: "project-1",
                state: "running",
              },
              { status: 202 }
            )
          );
        }
        return new Promise((_resolve, reject) => {
          upstreamRequest.signal.addEventListener(
            "abort",
            () => reject(new TypeError("private poll abort")),
            { once: true }
          );
          polling.resolve();
        });
      },
      {
        event: (name, attributes) => observed.push({ attributes, name }),
        log: (name, attributes) => observed.push({ attributes, name }),
        record: (event) => observed.push(event),
        span: async (name, _attributes, callback) => {
          spans.push(name);
          return await callback();
        },
        stateCodec: {
          mint: (value) => {
            state = value;
            return Promise.resolve("continuation-state");
          },
          verify: () => Promise.resolve(state),
        },
      }
    );
    const pending = executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(asyncCapability),
        operationGetter: executionFor(operationGetter),
        signal: controller.signal,
      },
      dependency
    );
    await polling.promise;

    controller.abort(new Error("private poll reason"));

    await expect(pending).rejects.toThrow("private poll reason");
    expect(spans).toEqual(
      expect.arrayContaining(["mcp.tool.call", "photon.operation.poll"])
    );
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: "cancelled" }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "mcp.result": "cancelled" }),
          name: "photon.mcp.operation.polls",
        }),
      ])
    );
    expect(JSON.stringify(observed)).not.toContain("private poll reason");
  });

  it("preserves an arbitrary caller abort reason during response body consumption", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped reading");
    const { dependency, requests } = dependencies(
      new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      })
    );
    const pending = executeCapability(
      { ...request("project-1"), signal: controller.signal },
      dependency
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it.each([
    "headers",
    "body",
  ] as const)("retains the latest output or resumed handle when the deadline expires during getter %s", async (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const controller = new AbortController();
    let calls = 0;
    let state: Readonly<Record<string, unknown>> = {};
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) => {
        calls += 1;
        if (calls === 1) {
          vi.setSystemTime(39_000);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                operationId: "operation-1",
                projectId: "project-1",
                state: "running",
              }),
              {
                headers: { "content-type": "application/json" },
                status: 202,
              }
            )
          );
        }
        if (phase === "body") {
          return Promise.resolve(
            new Response(new ReadableStream(), {
              headers: { "content-type": "application/json" },
            })
          );
        }
        return new Promise((_resolve, reject) => {
          upstreamRequest.signal.addEventListener(
            "abort",
            () => reject(new TypeError("fetch aborted")),
            { once: true }
          );
        });
      },
      {
        now: () => Date.now(),
        stateCodec: {
          mint: (value) => {
            state = value;
            return Promise.resolve("continuation-state");
          },
          verify: () => Promise.resolve(state),
        },
      }
    );
    let settled = false;
    let pending = executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(asyncCapability),
        operationGetter: executionFor(operationGetter),
        signal: controller.signal,
      },
      dependency
    ).then((value) => {
      settled = true;
      return value;
    });

    try {
      await vi.waitFor(() => expect(calls).toBe(2));
      await vi.advanceTimersByTimeAsync(40_000 - Date.now());
      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({
        requestState: "continuation-state",
        resultType: "input_required",
        structuredContent: {
          data: {
            operationId: "operation-1",
            projectId: "project-1",
            state: "running",
          },
          status: 202,
        },
      });
      expect(calls).toBe(2);
      settled = false;
      pending = executeCapability(
        {
          ...request("project-1"),
          execution: executionFor(asyncCapability),
          input: { continuation: "continuation-state" },
          operationGetter: executionFor(operationGetter),
          protocolFacts: { continuation: "continuation-state" },
          signal: controller.signal,
        },
        dependency
      ).then((value) => {
        settled = true;
        return value;
      });
      await vi.waitFor(() => expect(calls).toBe(3));
      await vi.advanceTimersByTimeAsync(70_000 - Date.now());
      const resumed = await pending;
      expect(resumed).toMatchObject({
        requestState: "continuation-state",
        resultType: "input_required",
      });
      expect(resumed.structuredContent).toEqual({
        operationId: "operation-1",
        projectId: "project-1",
      });
      expect(calls).toBe(3);
    } finally {
      if (!settled) {
        controller.abort(new Error("test cleanup"));
        await pending.catch(() => undefined);
      }
    }
  });

  it.each([
    ["class", "class", "mutation"],
    ["subject", "subject", "other-subject"],
    ["account", "accountId", "other-account"],
    ["release", "releaseIdentity", "other-release"],
    ["input", "inputHash", "other-input"],
    ["source operation", "sourceOperationId", "other-source"],
    ["getter operation", "getterOperationId", "other-getter"],
    ["getter method", "getterMethod", "POST"],
    ["getter route", "getterPathTemplate", "/other/{projectId}/{operationId}"],
    ["idempotency key", "idempotencyKey", undefined],
    ["issued time", "issuedAt", 1001],
    ["expiry", "expiresAt", 1000],
    ["version", "version", 2],
    ["operation path value", "operationId", "a/b"],
    ["project path value", "projectId", ".."],
    ["unpaired operation surrogate", "operationId", "\ud800"],
    ["unpaired project surrogate", "projectId", "\ud800"],
  ])("rejects a continuation with an invalid %s binding", async (_name, field, value) => {
    const { dependency, requests, state, token } = await continuationFixture();
    const before = requests.length;
    state[field] = value;

    const result = await executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(idempotentAsyncCapability),
        input: { continuation: token },
        operationGetter: executionFor(operationGetter),
        protocolFacts: { continuation: token },
      },
      dependency
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_request_state" },
    });
    expect(requests).toHaveLength(before);
  });

  it("records an expired continuation without polling", async () => {
    const observed: unknown[] = [];
    const { dependency, requests, state, token } = await continuationFixture({
      event: (name, attributes) => observed.push({ attributes, name }),
      log: (name, attributes) => observed.push({ attributes, name }),
      record: (event) => observed.push(event),
    });
    const before = requests.length;
    state.expiresAt = 1000;

    const result = await executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(idempotentAsyncCapability),
        input: { continuation: token },
        operationGetter: executionFor(operationGetter),
        protocolFacts: { continuation: token },
      },
      dependency
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_request_state" },
    });
    expect(requests).toHaveLength(before);
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: "expired" }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "mcp.result": "expired" }),
          name: "photon.mcp.tool.event",
        }),
      ])
    );
  });

  it("distinguishes a cancelled terminal operation in tool and poll telemetry", async () => {
    const observed: unknown[] = [];
    const { dependency, requests } = dependencies(
      undefined,
      (upstreamRequest) => {
        requests.push(upstreamRequest);
        return Promise.resolve(
          Response.json({
            operationId: "operation-1",
            projectId: "project-1",
            state: "cancelled",
          })
        );
      },
      {
        event: (name, attributes) => observed.push({ attributes, name }),
        log: (name, attributes) => observed.push({ attributes, name }),
        record: (event) => observed.push(event),
        stateCodec: {
          mint: async () => "unused",
          verify: async () => decodedState,
        },
      }
    );
    const decodedState = {
      accountId: "account-1",
      class: "continuation",
      expiresAt: 2000,
      getterMethod: "GET",
      getterOperationId: "getOperation",
      getterPathTemplate: "/projects/{projectId}/operations/{operationId}",
      idempotencyKey: "idempotency-1",
      inputHash: "a".repeat(64),
      issuedAt: 999,

      operationId: "operation-1",
      projectId: "project-1",
      releaseIdentity: "release-1",
      sourceOperationId: "startOperation",
      subject: "subject-1",
      version: 1,
    } as const;

    const result = await executeCapability(
      {
        ...request("project-1"),
        execution: executionFor(idempotentAsyncCapability),
        input: { continuation: "sealed-state" },
        operationGetter: executionFor(operationGetter),
        protocolFacts: { continuation: "sealed-state" },
      },
      dependency
    );

    expect(result).toMatchObject({
      resultType: "complete",
      structuredContent: { data: { state: "cancelled" }, status: 200 },
    });
    expect(requests).toHaveLength(1);
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: "cancelled" }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "mcp.result": "cancelled" }),
          name: "photon.mcp.operation.polls",
        }),
      ])
    );
  });
});

const policyAuth: ExecutionPrincipal = {
  accountId: "account-1",
  subject: "subject-1",
};

const policyReadCapability = {
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },

  idempotency: "none",
  inputSchema: { type: "object" },
  method: "GET",
  operationId: "getItem",
  outputSchema: {
    additionalProperties: false,
    properties: { data: { type: "object" }, status: { const: 200 } },
    required: ["status", "data"],
    type: "object",
  },
  pathTemplate: "/items/{itemId}",
  requiredPermissions: ["items:read"],
  successRepresentations: [
    { mediaType: "application/json", schema: { type: "object" }, status: 200 },
  ],
} as const;

const policyWriteCapability = {
  ...policyReadCapability,
  annotations: { ...policyReadCapability.annotations, readOnlyHint: false },

  idempotency: "header",
  idempotencyKeySchema: { maxLength: 255, minLength: 1, type: "string" },
  method: "POST",
  operationId: "updateItem",
  requiredPermissions: ["items:write"],
} as const;

const policyHighImpactCapability = {
  ...policyWriteCapability,

  method: "DELETE",
  operationId: "deleteItem",
} as const;

function policyDependencies(
  tampered = false,
  overrides: Partial<RuntimeDependencies> = {}
) {
  const requests: Request[] = [];
  const minted: Record<string, unknown>[] = [];
  const states = new Map<string, Readonly<Record<string, unknown>>>();
  const dependency: RuntimeDependencies = {
    fetchUpstream: (upstreamRequest) => {
      requests.push(upstreamRequest);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      );
    },
    now: () => 1000,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    record: () => undefined,
    requestStateTtlMilliseconds: 300_000,
    stateCodec: {
      mint: (value) => {
        const state = { ...value };
        const token = `sealed-state-${states.size}`;
        minted.push(state);
        states.set(token, state);
        return Promise.resolve(token);
      },
      verify: (token) => {
        if (tampered) {
          return Promise.reject(new Error("invalid"));
        }
        return Promise.resolve(states.get(token) ?? {});
      },
    },
    upstreamUrl: "https://api.photon.codes",
    ...overrides,
  };
  return { dependency, minted, requests, states };
}

function policyRequest(
  capability: Capability = policyReadCapability,
  overrides: Partial<CapabilityExecutionRequest> = {}
): CapabilityExecutionRequest {
  return {
    auth: policyAuth,
    execution: executionFor(capability),
    input: { path: { itemId: "item-1" } },
    protocolFacts: {},

    releaseIdentity: "release-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("mutation policy", () => {
  it.each([
    [
      "tampered state",
      policyRequest(policyWriteCapability, {
        protocolFacts: { continuation: "tampered" },
      }),
    ],
  ])("does not invoke for %s", async (_name, value) => {
    const { dependency, requests } = policyDependencies(
      value.protocolFacts.continuation === "tampered"
    );

    await executeCapability(value, dependency);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["read", policyRequest(policyReadCapability), "complete", 1],
    ["mutation", policyRequest(policyWriteCapability), "complete", 1],
    ["high impact", policyRequest(policyHighImpactCapability), "complete", 1],
  ])("executes %s without server confirmation", async (_name, value, expected, expectedRequests) => {
    const { dependency, requests } = policyDependencies();
    const result = await executeCapability(value, dependency);

    expect(result.resultType).toBe(expected);
    expect(requests).toHaveLength(expectedRequests);
  });

  it("rejects a generated key that violates the producer contract before upstream", async () => {
    const { dependency, requests, minted } = policyDependencies();
    const result = await executeCapability(
      policyRequest({
        ...policyWriteCapability,
        idempotencyKeySchema: { pattern: "^required-prefix-", type: "string" },
      }),
      dependency
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("invalid_idempotency_key");
    expect(requests).toHaveLength(0);
    expect(minted).toHaveLength(0);
  });
});

describe("capability execution protocol facts", () => {
  it.each([
    "mutation",
    "high-impact",
  ])("rejects retired %s request state without replaying a write", async (stateClass) => {
    const { dependency, requests } = policyDependencies();
    const result = await executeCapability(
      policyRequest(policyWriteCapability, {
        protocolFacts: { sdkRequestState: { class: stateClass } },
      }),
      dependency
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_request_state" },
    });
    expect(requests).toHaveLength(0);
  });

  it("rejects conflicting SDK and advertised continuation state", async () => {
    const { dependency, requests } = policyDependencies(false, {
      stateCodec: {
        mint: async () => "unused",
        verify: async () => ({ class: "continuation", subject: "other" }),
      },
    });
    const result = await executeCapability(
      policyRequest(idempotentAsyncCapability, {
        input: { continuation: "signed-continuation" },
        operationGetter: executionFor(operationGetter),
        protocolFacts: {
          continuation: "signed-continuation",
          sdkRequestState: { class: "continuation", subject: "subject-1" },
        },
      }),
      dependency
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "invalid_request_state" },
    });
    expect(requests).toHaveLength(0);
  });
});

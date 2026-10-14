import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileRelease } from "../src/compiler/compile.js";
import {
  type InvocationDependencies,
  type InvocationRequest,
  invokeRegistryTarget,
} from "../src/runtime/invoke.js";
import type { ExecutionPrincipal } from "../src/runtime/principal.js";
import { makeCompileInput } from "./fixtures.js";

const auth: ExecutionPrincipal = {
  accountId: "account-1",
  subject: "subject-1",
};

const capability = {
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

function dependencies(
  response = new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
    status: 200,
  }),
  fetcher?: InvocationDependencies["fetchUpstream"],
  overrides: Partial<InvocationDependencies> = {}
) {
  const requests: Request[] = [];
  const dependency: InvocationDependencies = {
    fetchUpstream:
      fetcher ??
      ((upstreamRequest) => {
        requests.push(upstreamRequest);
        return Promise.resolve(response);
      }),
    now: () => 1000,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    upstreamUrl: "https://api.photon.codes",
    ...overrides,
  };
  return { dependency, requests };
}

function invocationRequest(
  value: unknown,
  overrides: Partial<InvocationRequest> = {}
): InvocationRequest {
  return {
    auth,
    capability,
    deadline: 31_000,
    input: { path: { projectId: value } },
    signal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registry invocation", () => {
  it.each([
    "deadline",
    "caller",
  ] as const)("bounds a stalled response body through %s without replay", async (cause) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancelled = vi.fn();
    const { dependency, requests } = dependencies(
      new Response(
        new ReadableStream({
          cancel: cancelled,
          start(stream) {
            stream.enqueue(new TextEncoder().encode("partial"));
          },
        })
      )
    );
    const response = await invokeRegistryTarget(
      invocationRequest("project-1", {
        deadline: 1050,
        signal: controller.signal,
      }),
      dependency
    );
    const outcome = response.text().then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    if (cause === "deadline") {
      await vi.advanceTimersByTimeAsync(50);
    } else {
      controller.abort(new Error("caller cancelled"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await outcome).toMatchObject({
      error:
        cause === "deadline"
          ? { code: "deadline_exceeded" }
          : { message: "caller cancelled" },
    });
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "",
    ".",
    "..",
    "%",
    "%2f",
    "a%b",
    "a/b",
    "a\\b",
  ])("rejects non-canonical path segment %j before encoding", async (value) => {
    const { dependency, requests } = dependencies();

    await expect(
      invokeRegistryTarget(invocationRequest(value), dependency)
    ).rejects.toMatchObject({ code: "invalid_path_parameter" });

    expect(requests).toHaveLength(0);
  });

  it("maps an unpaired surrogate path value to invalid_path_parameter before fetch", async () => {
    const { dependency, requests } = dependencies();

    await expect(
      invokeRegistryTarget(invocationRequest("\ud800"), dependency)
    ).rejects.toMatchObject({ code: "invalid_path_parameter" });

    expect(requests).toHaveLength(0);
  });

  it("sends no operation or release control headers", async () => {
    const { dependency, requests } = dependencies();

    await invokeRegistryTarget(
      {
        ...invocationRequest("project 1"),
        input: {
          headers: { "if-match": "one" },
          path: { projectId: "project 1" },
          query: { page: "2" },
        },
      },
      dependency
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.photon.codes/projects/project%201?page=2"
    );
    expect(requests[0]?.headers.has("x-photon-mcp-operation")).toBe(false);
    expect(requests[0]?.headers.has("x-photon-mcp-release")).toBe(false);
    expect(requests[0]?.headers.get("x-forwarded-for")).toBeNull();
  });

  it("uses the configured upstream origin instead of a fixed production origin", async () => {
    const { dependency, requests } = dependencies();
    await invokeRegistryTarget(invocationRequest("project-1"), {
      ...dependency,
      upstreamUrl: "https://api.example.com",
    });

    expect(requests[0]?.url).toBe("https://api.example.com/projects/project-1");
  });

  it("serializes admitted OpenAPI defaults for query and header collections", async () => {
    const { dependency, requests } = dependencies();
    await invokeRegistryTarget(
      invocationRequest("project-1", {
        input: {
          headers: { "x-values": { a: 1, b: false } },
          path: { projectId: "project-1" },
          query: {
            filter: { active: true, count: 2 },
            tags: ["a", 2, false],
          },
        },
      }),
      dependency
    );

    expect(requests[0]?.url).toBe(
      "https://api.photon.codes/projects/project-1?active=true&count=2&tags=a&tags=2&tags=false"
    );
    expect(requests[0]?.headers.get("x-values")).toBe("a,1,b,false");
  });

  it("sends the compiler-selected content type only with a present body", async () => {
    const { dependency, requests } = dependencies();
    await invokeRegistryTarget(
      invocationRequest("project-1", {
        capability: {
          ...capability,
          method: "POST",
          requestMediaType: "application/vnd.photon+json",
        },
        input: {
          body: { enabled: true, name: "alpha" },
          headers: { "content-type": "text/plain" },
          path: { projectId: "project-1" },
        },
      }),
      dependency
    );
    const [upstreamRequest] = requests;
    if (upstreamRequest === undefined) {
      throw new Error("missing upstream request");
    }

    expect(upstreamRequest.method).toBe("POST");
    expect(upstreamRequest.headers.get("content-type")).toBe(
      "application/vnd.photon+json"
    );
    await expect(upstreamRequest.json()).resolves.toEqual({
      enabled: true,
      name: "alpha",
    });

    const absentBody = dependencies();
    await invokeRegistryTarget(
      invocationRequest("project-1", {
        capability: {
          ...capability,
          method: "POST",
          requestMediaType: "application/vnd.photon+json",
        },
        input: {
          headers: { "content-type": "text/plain" },
          path: { projectId: "project-1" },
        },
      }),
      absentBody.dependency
    );
    expect(absentBody.requests[0]?.headers.has("content-type")).toBe(false);
    expect(await absentBody.requests[0]?.text()).toBe("");
  });

  it.each([
    ["path string", "path", { type: "string" }, "alpha", "/projects/alpha"],
    ["path number", "path", { type: "number" }, 2.5, "/projects/2.5"],
    ["path boolean", "path", { type: "boolean" }, true, "/projects/true"],
    ["query string", "query", { type: "string" }, "alpha", "?value=alpha"],
    ["query number", "query", { type: "number" }, 2.5, "?value=2.5"],
    ["query boolean", "query", { type: "boolean" }, false, "?value=false"],
    [
      "query array",
      "query",
      { items: { type: "integer" }, type: "array" },
      [2, 3],
      "?value=2&value=3",
    ],
    [
      "query object",
      "query",
      {
        additionalProperties: false,
        properties: { active: { type: "boolean" }, count: { type: "integer" } },
        type: "object",
      },
      { active: true, count: 2 },
      "?active=true&count=2",
    ],
    [
      "path scalar union",
      "path",
      { anyOf: [{ type: "string" }, { type: "integer" }] },
      42,
      "/projects/42",
    ],
    [
      "header union array",
      "header",
      {
        oneOf: [
          { type: "string" },
          { items: { type: "integer" }, type: "array" },
        ],
      },
      [2, 3],
      "2,3",
    ],
    ["header string", "header", { type: "string" }, "alpha", "alpha"],
    ["header number", "header", { type: "number" }, 2.5, "2.5"],
    ["header boolean", "header", { type: "boolean" }, false, "false"],
    [
      "header array",
      "header",
      { items: { type: "integer" }, type: "array" },
      [2, 3],
      "2,3",
    ],
    [
      "header object",
      "header",
      {
        additionalProperties: false,
        properties: { active: { type: "boolean" }, count: { type: "integer" } },
        type: "object",
      },
      { active: true, count: 2 },
      "active,true,count,2",
    ],
  ] as const)("preserves compile-to-invoke %s serialization", async (_name, location, schema, value, expected) => {
    const parameterName = location === "path" ? "projectId" : "value";
    const parameters = [
      ...(location === "path"
        ? []
        : [
            {
              in: "path",
              name: "projectId",
              required: true,
              schema: { type: "string" },
            },
          ]),
      {
        in: location,
        name: parameterName,
        ...(location === "path" ? { required: true } : {}),
        schema,
      },
    ];
    const compiled = compileRelease(
      makeCompileInput({ operation: { parameters } })
    );
    const [compiledCapability] = compiled.registry;
    if (!compiledCapability) {
      throw new Error("missing compiled capability");
    }
    const input =
      location === "path"
        ? { path: { projectId: value } }
        : {
            path: { projectId: "project-1" },
            [location === "header" ? "headers" : "query"]: {
              [parameterName]: value,
            },
          };
    const { dependency, requests } = dependencies();
    await invokeRegistryTarget(
      invocationRequest("project-1", {
        capability: compiledCapability,
        input,
      }),
      dependency
    );

    if (location === "path") {
      expect(new URL(requests[0]?.url ?? "").pathname).toBe(expected);
    } else if (location === "query") {
      expect(new URL(requests[0]?.url ?? "").search).toBe(expected);
    } else {
      expect(requests[0]?.headers.get("value")).toBe(expected);
    }
  });

  it.each([
    "anyOf",
    "oneOf",
  ] as const)("preserves %s role constraints and serializes scalar or array query values", async (keyword) => {
    const role = { enum: ["member", "owner", "viewer"], type: "string" };
    const schema = {
      [keyword]: [
        role,
        { items: role, maxItems: 3, minItems: 1, type: "array" },
      ],
    };
    const [compiledCapability] = compileRelease(
      makeCompileInput({
        operation: {
          parameters: [
            {
              in: "path",
              name: "projectId",
              required: true,
              schema: { type: "string" },
            },
            { in: "query", name: "role", schema },
          ],
        },
      })
    ).registry;
    if (!compiledCapability) {
      throw new Error("missing compiled capability");
    }
    expect(compiledCapability.inputSchema).toMatchObject({
      properties: { query: { properties: { role: schema } } },
    });
    const validate = new AjvJsonSchemaValidator().getValidator(
      compiledCapability.inputSchema
    );
    await Promise.all(
      (
        [
          ["owner", "?role=owner"],
          [["member", "viewer"], "?role=member&role=viewer"],
        ] as const
      ).map(async ([value, expected]) => {
        const input = {
          path: { projectId: "project-1" },
          query: { role: value },
        };
        expect(validate(input).valid).toBe(true);
        const { dependency, requests } = dependencies();
        await invokeRegistryTarget(
          invocationRequest("project-1", {
            capability: compiledCapability,
            input,
          }),
          dependency
        );
        expect(new URL(requests[0]?.url ?? "").search).toBe(expected);
      })
    );
    for (const value of [
      "admin",
      ["admin"],
      [],
      ["owner", "owner", "owner", "owner"],
      null,
      { role: "owner" },
    ]) {
      expect(
        validate({ path: { projectId: "project-1" }, query: { role: value } })
          .valid
      ).toBe(false);
    }
  });

  it.each([
    ["path", { items: { type: "string" }, type: "array" }],
    ["query", { type: "null" }],
    [
      "query",
      { items: { items: { type: "string" }, type: "array" }, type: "array" },
    ],
    [
      "header",
      {
        additionalProperties: false,
        properties: { nested: { items: { type: "string" }, type: "array" } },
        type: "object",
      },
    ],
  ] as const)("rejects unsupported branches in a %s parameter union: %j", (location, branch) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [
              {
                in: location,
                name: "projectId",
                required: true,
                schema: { anyOf: [{ type: "string" }, branch] },
              },
            ],
          },
        })
      )
    ).toThrow("unsupported_parameter_schema");
  });

  it.each([
    { style: "spaceDelimited" },
    { explode: false },
  ])("rejects unsupported union query serialization %j", (serialization) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [
              {
                in: "query",
                name: "role",
                schema: {
                  anyOf: [
                    { type: "string" },
                    { items: { type: "string" }, type: "array" },
                  ],
                },
                ...serialization,
              },
            ],
          },
        })
      )
    ).toThrow("unsupported_parameter_serialization");
  });

  it.each([
    ["array", { items: { type: "integer" }, type: "array" }],
    [
      "object",
      {
        additionalProperties: false,
        properties: {
          active: { type: "boolean" },
          count: { type: "integer" },
        },
        type: "object",
      },
    ],
  ] as const)("rejects a %s path schema at compile time", (_name, schema) => {
    expect(() =>
      compileRelease(
        makeCompileInput({
          operation: {
            parameters: [
              { in: "path", name: "projectId", required: true, schema },
            ],
          },
        })
      )
    ).toThrow("unsupported_parameter_schema");
  });

  it.each([
    ["empty string", ""],
    ["empty array", []],
    ["nonempty array", ["project-1"]],
    ["empty object", {}],
    ["nonempty object", { id: "project-1" }],
  ])("rejects a runtime %s path value before stamping or fetch", async (_name, value) => {
    const { dependency, requests } = dependencies();
    const originalOperationId = capability.operationId;

    await expect(
      invokeRegistryTarget(invocationRequest(value), dependency)
    ).rejects.toMatchObject({ code: "invalid_path_parameter" });

    expect(requests).toHaveLength(0);
    expect(capability.operationId).toBe(originalOperationId);
  });

  it("rejects a caller-supplied trust-boundary header before fetch", async () => {
    const { dependency, requests } = dependencies();
    await expect(
      invokeRegistryTarget(
        {
          ...invocationRequest("project-1"),
          input: {
            headers: { authorization: "attacker" },
            path: { projectId: "project-1" },
          },
        },
        dependency
      )
    ).rejects.toMatchObject({ code: "forbidden_header" });
    expect(requests).toHaveLength(0);
  });

  it.each([
    "forwarded",
    "via",
    "x-real-ip",
    "x-release",
    "x-workload-id",
    "x-pho-user-id",
    "x-photon-mcp-operation",
  ])("rejects the trust-boundary header %s before fetch", async (header) => {
    const { dependency, requests } = dependencies();
    await expect(
      invokeRegistryTarget(
        {
          ...invocationRequest("project-1"),
          input: {
            headers: { [header]: "attacker" },
            path: { projectId: "project-1" },
          },
        },
        dependency
      )
    ).rejects.toMatchObject({ code: "forbidden_header" });
    expect(requests).toHaveLength(0);
  });

  it("does not retry an unclassified upstream exception", async () => {
    let calls = 0;
    const { dependency } = dependencies(undefined, () => {
      calls += 1;
      return Promise.reject(new Error("unexpected"));
    });

    await expect(
      invokeRegistryTarget(invocationRequest("project-1"), dependency)
    ).rejects.toThrow("unexpected");
    expect(calls).toBe(1);
  });

  it.each([
    [429, 3],
    [502, 3],
    [503, 3],
    [504, 3],
    [500, 1],
  ])("retries status %s with %s total attempts", async (status, expectedCalls) => {
    let calls = 0;
    const { dependency } = dependencies(undefined, () => {
      calls += 1;
      return Promise.resolve(
        new Response(null, {
          headers: { "retry-after": "0" },
          status,
        })
      );
    });

    await invokeRegistryTarget(invocationRequest("project-1"), dependency);
    expect(calls).toBe(expectedCalls);
  });

  it.each([
    ["GET", undefined, 3],
    ["HEAD", undefined, 3],
    ["POST", "idempotency-1", 3],
    ["POST", undefined, 1],
  ] as const)("bounds network retries for %s with idempotency key %s", async (method, key, expectedCalls) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const requests: Request[] = [];
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) => {
        requests.push(upstreamRequest);
        return Promise.reject(new TypeError("offline"));
      },
      {
        now: () => Date.now(),
        randomBytes: (length) => new Uint8Array(length),
      }
    );
    const pending = invokeRegistryTarget(
      invocationRequest("project-1", {
        capability: { ...capability, method },
        deadline: 11_000,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      }),
      dependency
    );
    const outcome = pending.then(
      () => "resolved",
      () => "rejected"
    );
    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toBe("rejected");
    expect(requests).toHaveLength(expectedCalls);
  });

  it.each([
    ["GET", undefined, 3],
    ["HEAD", undefined, 3],
    ["POST", "idempotency-1", 3],
    ["POST", undefined, 1],
    ["PATCH", undefined, 1],
  ] as const)("bounds retries for %s with idempotency key %s", async (method, key, expectedCalls) => {
    let calls = 0;
    const { dependency } = dependencies(undefined, () => {
      calls += 1;
      return Promise.resolve(
        new Response(null, {
          headers: { "retry-after": "0" },
          status: 503,
        })
      );
    });

    await invokeRegistryTarget(
      invocationRequest("project-1", {
        capability: { ...capability, method },
        ...(key === undefined ? {} : { idempotencyKey: key }),
      }),
      dependency
    );

    expect(calls).toBe(expectedCalls);
  });

  it.each([
    "retryable status",
    "network TypeError",
  ])("uses absent-header backoff after a %s", async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        if (calls === 1) {
          return failure === "network TypeError"
            ? Promise.reject(new TypeError("offline"))
            : Promise.resolve(new Response(null, { status: 503 }));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      {
        now: () => Date.now(),
        randomBytes: (length) => new Uint8Array(length).fill(37),
      }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 11_000 }),
      dependency
    );
    await vi.advanceTimersByTimeAsync(108);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });

  it("uses exponential full-jitter windows without crossing the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const jitter = [new Uint8Array([0, 0]), new Uint8Array([0, 55])];
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, { status: calls < 3 ? 503 : 200 })
        );
      },
      {
        now: () => Date.now(),
        randomBytes: () => jitter.shift() ?? new Uint8Array([0, 0]),
      }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 20_000 }),
      dependency
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(254);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 200 });

    let cancelled = false;
    const boundary = dependencies(
      undefined,
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancelled = true;
              },
            }),
            { status: 503 }
          )
        ),
      {
        now: () => Date.now(),
        randomBytes: () => new Uint8Array([0, 0]),
      }
    );
    await expect(
      invokeRegistryTarget(
        invocationRequest("project-1", { deadline: Date.now() + 100 }),
        boundary.dependency
      )
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(cancelled).toBe(true);
  });

  it.each([
    ["delta seconds", "2", 2000],
    ["HTTP date", new Date(13_000).toUTCString(), 2500],
  ])("honors Retry-After %s after elapsed fetch time", async (_name, value, wait) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        if (calls === 1) {
          vi.setSystemTime(10_500);
          return Promise.resolve(
            new Response(null, {
              headers: { "retry-after": value },
              status: 503,
            })
          );
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      { now: () => Date.now() }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 14_000 }),
      dependency
    );
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });

  it.each([
    "",
    "1.5",
    "1e2",
    "+1",
    "-1",
    "999999999999999999999999",
  ])("falls back to jitter for non-canonical Retry-After delta seconds %j", async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, {
            headers: { "retry-after": retryAfter },
            status: calls === 1 ? 503 : 200,
          })
        );
      },
      {
        now: () => Date.now(),
        randomBytes: () => new Uint8Array([0, 0]),
      }
    );
    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 20_000 }),
      dependency
    );
    const outcome = pending.then(
      (response) => ({ response }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toMatchObject({ response: { status: 200 } });
    expect(calls).toBe(2);
  });

  it.each([
    "Thu, 31 Feb 2026 00:00:00 GMT",
    "Fri, 01 Jan 2026 00:00:00 GMT",
  ])("falls back to jitter for a non-canonical Retry-After HTTP date %j", async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          new Response(null, {
            headers: { "retry-after": retryAfter },
            status: calls === 1 ? 503 : 200,
          })
        );
      },
      {
        now: () => Date.now(),
        randomBytes: () => new Uint8Array([0, 0]),
      }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 20_000 }),
      dependency
    );
    const outcome = pending.then(
      (response) => ({ response }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toMatchObject({ response: { status: 200 } });
    expect(calls).toBe(2);
  });

  it.each([
    [
      "synchronous TypeError",
      () => {
        throw new TypeError("cancel failed");
      },
    ],
    ["async non-TypeError", () => Promise.reject(new Error("cancel failed"))],
    ["never-settling", () => new Promise<void>(() => undefined)],
  ])("keeps deadline_exceeded stable when retry cancellation is %s", async (_name, cancel) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    let randomCalls = 0;
    const response = {
      body: { cancel },
      headers: new Headers(),
      status: 503,
    } as unknown as Response;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(response);
      },
      {
        now: () => Date.now(),
        randomBytes: () => {
          randomCalls += 1;
          return new Uint8Array([0, 0]);
        },
      }
    );

    await expect(
      invokeRegistryTarget(
        invocationRequest("project-1", { deadline: 10_100 }),
        dependency
      )
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(calls).toBe(1);
    expect(randomCalls).toBe(1);
  });

  it.each([
    [
      "synchronous TypeError",
      () => {
        throw new TypeError("cancel failed");
      },
    ],
    ["async non-TypeError", () => Promise.reject(new Error("cancel failed"))],
    ["never-settling", () => new Promise<void>(() => undefined)],
  ])("continues a retry when response cancellation is %s", async (_name, cancel) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const response = {
      body: { cancel },
      headers: new Headers(),
      status: 503,
    } as unknown as Response;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? response : new Response(null, { status: 200 })
        );
      },
      {
        now: () => Date.now(),
        randomBytes: () => new Uint8Array([0, 0]),
      }
    );
    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 20_000 }),
      dependency
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });

  it("rejects a network retry at the deadline without advancing a timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.reject(new TypeError("offline"));
      },
      {
        now: () => Date.now(),
        randomBytes: () => new Uint8Array([0, 0]),
      }
    );

    await expect(
      invokeRegistryTarget(
        invocationRequest("project-1", { deadline: 10_100 }),
        dependency
      )
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(calls).toBe(1);
  });

  it("cancels a retry response body before waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let calls = 0;
    let cancelled = false;
    const { dependency } = dependencies(
      undefined,
      () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? new Response(
                new ReadableStream({
                  cancel: () => {
                    cancelled = true;
                  },
                }),
                { status: 503 }
              )
            : new Response(null, { status: 200 })
        );
      },
      {
        now: () => Date.now(),
        randomBytes: (length) => new Uint8Array(length),
      }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 11_000 }),
      dependency
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("aborts an active fetch at the absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) =>
        new Promise((_resolve, reject) => {
          upstreamRequest.signal.addEventListener(
            "abort",
            () => reject(new TypeError("fetch aborted")),
            { once: true }
          );
        }),
      { now: () => Date.now() }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 10_050 }),
      dependency
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(50);

    await expect(outcome).resolves.toMatchObject({
      error: { code: "deadline_exceeded" },
    });
  });

  it("aborts retry waiting at the absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { dependency } = dependencies(
      undefined,
      () => Promise.resolve(new Response(null, { status: 503 })),
      {
        now: () => Date.now(),
        randomBytes: (length) => new Uint8Array(length),
      }
    );

    const pending = invokeRegistryTarget(
      invocationRequest("project-1", { deadline: 10_050 }),
      dependency
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(50);

    await expect(outcome).resolves.toMatchObject({
      error: { code: "deadline_exceeded" },
    });
  });

  it.each([
    "active fetch",
    "retry wait",
  ])("propagates the caller abort reason through execution during %s", async (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const controller = new AbortController();
    const reason = new Error(`cancel ${phase}`);
    let calls = 0;
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) => {
        calls += 1;
        if (phase === "retry wait") {
          return Promise.resolve(new Response(null, { status: 503 }));
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
        randomBytes: (length) => new Uint8Array(length),
      }
    );
    const pending = invokeRegistryTarget(
      invocationRequest("project-1", {
        deadline: 11_000,
        signal: controller.signal,
      }),
      dependency
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    controller.abort(reason);

    await expect(outcome).resolves.toEqual({ error: reason });
  });

  it.each([
    "empty",
    "consumed",
    "cancelled",
  ] as const)("cleans the deadline timer and caller listener after the body is %s", async (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const controller = new AbortController();
    let boundedSignal: AbortSignal | undefined;
    const { dependency } = dependencies(
      undefined,
      (upstreamRequest) => {
        boundedSignal = upstreamRequest.signal;
        return Promise.resolve(
          new Response(phase === "empty" ? null : "body", { status: 200 })
        );
      },
      { now: () => Date.now() }
    );

    const response = await invokeRegistryTarget(
      invocationRequest("project-1", {
        deadline: 10_050,
        signal: controller.signal,
      }),
      dependency
    );
    if (phase === "consumed") {
      expect(await response.text()).toBe("body");
    } else if (phase === "cancelled") {
      await response.body?.cancel();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort(new Error("late caller abort"));
    await vi.advanceTimersByTimeAsync(50);

    expect(boundedSignal?.aborted).toBe(false);
  });

  it("does not replay an idempotent write after a partial body fails", async () => {
    const failure = new TypeError("body connection lost");
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const { dependency, requests } = dependencies(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(new TextEncoder().encode("partial"));
          },
        })
      )
    );
    const response = await invokeRegistryTarget(
      invocationRequest("project-1", {
        capability: { ...capability, idempotency: "header", method: "POST" },
        idempotencyKey: "stable-key",
      }),
      dependency
    );
    const reading = response.text();
    source?.error(failure);
    await expect(reading).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
  });
});

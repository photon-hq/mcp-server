import { describe, expect, it } from "vitest";
import {
  type ActivatedRuntimeRelease,
  activateRuntimeRelease,
  RuntimeReleaseError,
} from "../src/runtime/runtime-release.js";
import {
  makeRuntimeRelease,
  type RuntimeReleaseFixtureOptions,
} from "./runtime-release.fixture.js";

const releaseIdentityPattern = /^[a-f0-9]{64}$/u;

async function activateFixture(
  options: RuntimeReleaseFixtureOptions = {}
): Promise<ActivatedRuntimeRelease> {
  const fixture = await makeRuntimeRelease(options);
  return activateRuntimeRelease(fixture.value, fixture.checksum);
}

async function expectRuntimeReleaseFailure(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RuntimeReleaseError);
  expect(error).toMatchObject({
    code,
    message: code,
    name: "RuntimeReleaseError",
  });
  // biome-ignore lint/suspicious/noPrototypeBuiltins: this locks own-cause absence.
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
}

describe("runtime release loading", () => {
  it("activates the producer idempotency validator", async () => {
    const fixture = await makeRuntimeRelease();
    const release = await activateRuntimeRelease(
      fixture.value,
      fixture.checksum
    );
    const execution = release.registrationPlan.find(
      (item) => item.name === "writeAlpha"
    )?.execution;
    expect(execution?.validateIdempotencyKey?.("a".repeat(32))).toBe(true);
    expect(execution?.validateIdempotencyKey?.("a".repeat(256))).toBe(false);
  });

  it.each([
    [
      "checksum mismatch",
      async () => {
        const fixture = await makeRuntimeRelease();
        return { ...fixture, checksum: "0".repeat(64) };
      },
      "release_checksum_mismatch",
    ],
    [
      "missing schema",
      async () =>
        makeRuntimeRelease({
          mutate: (value) => {
            value.schemas = {};
          },
        }),
      "release_schema_mismatch",
    ],
    [
      "unknown bundle field",
      async () =>
        makeRuntimeRelease({
          mutate: (value) => {
            value.future = true;
          },
        }),
      "invalid_runtime_release",
    ],
    [
      "future release schema",
      async () =>
        makeRuntimeRelease({
          mutate: (value) => {
            value.releaseIdentity.schemaVersion = 2;
          },
        }),
      "invalid_runtime_release",
    ],
  ] as const)("rejects %s during Worker initialization", async (_name, make, code) => {
    const fixture = await make();
    await expectRuntimeReleaseFailure(
      activateRuntimeRelease(fixture.value, fixture.checksum),
      code
    );
  });

  it("rejects a forged semantic identity even with a matching checksum", async () => {
    const fixture = await makeRuntimeRelease({
      mutate: (value) => {
        value.releaseIdentity.releaseIdentity = "0".repeat(64);
      },
    });
    await expectRuntimeReleaseFailure(
      activateRuntimeRelease(fixture.value, fixture.checksum),
      "release_identity_mismatch"
    );
  });

  it("activates a stable catalog with immutable execution facts", async () => {
    const fixture = await makeRuntimeRelease({ withOperationGetter: true });
    const release = await activateRuntimeRelease(
      fixture.value,
      fixture.checksum
    );

    expect(release.environment).toBe("staging");
    expect(release.releaseIdentity).toMatch(releaseIdentityPattern);
    expect(release.registrationPlan.map((entry) => entry.name)).toEqual([
      "getAlpha",
      "publicTool",
      "writeAlpha",
    ]);
    const capability = release.registrationPlan[0]?.execution.capability;
    const [source] = fixture.value.registry;
    if (!(source && capability)) {
      throw new Error("Missing fixture capability");
    }
    const originalPath = capability.pathTemplate;
    source.pathTemplate = "/changed-after-activation";
    expect(capability.pathTemplate).toBe(originalPath);
    Reflect.set(capability, "pathTemplate", "/changed-in-place");
    expect(capability.pathTemplate).toBe(originalPath);
  });

  it("registers tool titles and accepts releases compiled without them", async () => {
    const titled = await makeRuntimeRelease({ withTitles: true });
    const withTitles = await activateRuntimeRelease(
      titled.value,
      titled.checksum
    );
    expect(withTitles.registrationPlan[0]?.options.title).toBe(
      "Title of getAlpha"
    );

    const untitled = await makeRuntimeRelease();
    const withoutTitles = await activateRuntimeRelease(
      untitled.value,
      untitled.checksum
    );
    expect(withoutTitles.registrationPlan[0]?.options).not.toHaveProperty(
      "title"
    );
  });

  it("returns a cloned and frozen auth permission vocabulary", async () => {
    const fixture = await makeRuntimeRelease();
    const release = await activateRuntimeRelease(
      fixture.value,
      fixture.checksum
    );

    fixture.value.authPermissions.push("source:write");
    expect(() =>
      (release.authPermissions as string[]).push("attacker:write")
    ).toThrow(TypeError);
    expect(release.authPermissions).toEqual([
      "platforms:write",
      "project:read",
    ]);
  });

  it("resolves an optional Operation Getter without advertising it", async () => {
    const release = await activateFixture({ withOperationGetter: true });
    const entry = release.registrationPlan.find(
      (candidate) => candidate.name === "getAlpha"
    );
    const withoutGetter = release.registrationPlan.find(
      (candidate) => candidate.name === "publicTool"
    );

    expect(entry?.operationGetter).toMatchObject({
      capability: { method: "GET", operationId: "pollAlpha" },
    });
    expect(withoutGetter).toBeDefined();
    expect("operationGetter" in (withoutGetter ?? {})).toBe(false);
  });
});

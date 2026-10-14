import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from "jose";

export interface RequestStateKey {
  readonly key: Uint8Array;
  readonly kid: string;
}

export interface RequestStateCodec {
  readonly mint: (value: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly verify: (
    value: string
  ) => Promise<Readonly<Record<string, unknown>>>;
}

// The first key mints; every key verifies, so rotation keeps outstanding state valid.
export function createRequestStateCodec(
  input: Readonly<{
    audience: string;
    keys: readonly RequestStateKey[];
  }>
): RequestStateCodec {
  const [primary] = input.keys;
  if (!primary) {
    throw new Error("invalid_request_state_keys");
  }
  return {
    mint: async (value) =>
      await new CompactEncrypt(
        new TextEncoder().encode(
          JSON.stringify({ ...value, audience: input.audience })
        )
      )
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: primary.kid })
        .encrypt(primary.key),
    verify: async (value) => {
      const header = decodeProtectedHeader(value);
      const key = input.keys.find((candidate) => candidate.kid === header.kid);
      if (!key) {
        throw new Error("invalid_request_state");
      }
      const plaintext = await compactDecrypt(value, key.key, {
        contentEncryptionAlgorithms: ["A256GCM"],
        keyManagementAlgorithms: ["dir"],
      });
      const payload: unknown = JSON.parse(
        new TextDecoder().decode(plaintext.plaintext)
      );
      if (
        payload === null ||
        Array.isArray(payload) ||
        typeof payload !== "object" ||
        (payload as { audience?: unknown }).audience !== input.audience
      ) {
        throw new Error("invalid_request_state");
      }
      const { audience: _audience, ...state } = payload as Record<
        string,
        unknown
      >;
      return state;
    },
  };
}

# Contributing

## Development

Requires Node.js 22 or newer and pnpm 11.

```sh
pnpm install
pnpm verify
pnpm --filter @photon-ai/mcp smoke
```

The local catalog is compiled from a committed copy of the production API
contract: `packages/mcp/catalog/openapi.json` and the OAuth-grantable scopes in
`packages/mcp/catalog/oauth-scopes.json`. Building `@photon-ai/mcp` compiles
them into `packages/mcp/src/generated/runtime-release.ts` and writes a
reviewable bundle to `packages/mcp/.release/production/`, including
`tools.txt` and the operations it excluded. The same catalog always produces
the same release.

Update the catalog from `https://api.photon.codes`:

```sh
pnpm --filter @photon-ai/mcp refresh-catalog
pnpm build
```

A daily workflow does this and opens a pull request with the tool changes and
a patch version bump.

Run the built server:

```sh
PHOTON_API_KEY=pho_ask_... node packages/mcp/dist/cli.js
```

## Releasing

Each package is versioned and released on its own. Bump `version` in the
package's `package.json` through a pull request, then publish a GitHub
release on `main` tagged with the package and version:

| Package | Tag |
| --- | --- |
| `@photon-ai/mcp-core` | `mcp-core-v<version>` |
| `@photon-ai/mcp` | `mcp-v<version>` |

The release workflow verifies the tag against `package.json`, runs
`pnpm verify`, packs and attests the tarball, installs it and lists its tools,
then publishes it from the `npm` environment with trusted publishing and
provenance. Release `@photon-ai/mcp-core` before an `@photon-ai/mcp` version
that needs it; the workflow refuses an `@photon-ai/mcp` release whose core
version is not on npm.

## How tools are built

Each generated tool is one Photon HTTP operation. The compiler reads the OpenAPI
document, keeps the operations producers have not excluded with
`x-photon-mcp: { enabled: false }`, and emits a checksummed release. At
runtime the server validates arguments against the compiled schema, calls the
operation, validates the response, and polls asynchronous Operations within a
30-second budget. Mutations that declare an idempotency header get a generated
key and are retried only with that key.

The runtime also registers `search_docs` and `read_docs` separately from the
generated API catalog. They use public Mintlify content and enforce Beta in
`packages/core/src/runtime/docs.ts`. Changes to this shared runtime reach the
hosted server after releasing `@photon-ai/mcp-core` and upgrading its dependency
in `photon-hq/mcp-internal`.

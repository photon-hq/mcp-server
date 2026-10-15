# Photon MCP

Use Photon from any MCP client. This repository contains the local MCP server
and the compiler and runtime it shares with Photon's hosted MCP server.

| Package | Purpose |
| --- | --- |
| [`@photon-ai/mcp`](./packages/mcp) | Local stdio MCP server, authenticated with your own Photon key |
| [`@photon-ai/mcp-core`](./packages/core) | OpenAPI-to-MCP compiler, release verification and tool execution |

Prefer the hosted server at `https://mcp.photon.codes/mcp` when your client
supports remote MCP with OAuth: you sign in, choose what the client may do, and
never handle a key. Use the local server when your client only runs stdio
servers or you want to pin a specific tool release.

## Local Server

Create an Account Service Key in the Photon dashboard, then add the server to
your client. It runs with `npx` on Node.js 22 or newer; nothing needs to be
cloned or built. For Claude Code:

```sh
claude mcp add photon --env PHOTON_API_KEY=pho_ask_... -- npx -y @photon-ai/mcp
```

For clients configured with JSON:

```json
{
  "mcpServers": {
    "photon": {
      "command": "npx",
      "args": ["-y", "@photon-ai/mcp"],
      "env": { "PHOTON_API_KEY": "pho_ask_..." }
    }
  }
}
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PHOTON_API_KEY` | required | Bearer credential sent to the Photon API |
| `PHOTON_API_URL` | `https://api.photon.codes` | API origin; https, or http on loopback for development |

### What the key can do

An Account Service Key acts with your account's live roles. The local tool
catalog only includes operations whose required permissions are all available
to OAuth applications (`GET /v1/auth/oauth/scopes`), the same boundary as the
hosted server. Account security, API key, SSO and billing-checkout operations
are not exposed. Photon still authorizes every call; the catalog is not a
permission check.

Your MCP client decides when to ask before running a tool. The server does not
add its own confirmation step, so configure your client to confirm writes.

Keys are only read from the environment and only sent to `PHOTON_API_URL`.
Tool results never include upstream error bodies.

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

Each tool is one Photon HTTP operation. The compiler reads the OpenAPI
document, keeps the operations producers have not excluded with
`x-photon-mcp: { enabled: false }`, and emits a checksummed release. At
runtime the server validates arguments against the compiled schema, calls the
operation, validates the response, and polls asynchronous Operations within a
30-second budget. Mutations that declare an idempotency header get a generated
key and are retried only with that key.

## License

[Apache 2.0](./LICENSE)

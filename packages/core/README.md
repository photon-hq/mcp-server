# @photon-ai/mcp-core

The OpenAPI-to-MCP compiler and runtime behind Photon's MCP servers: the local
[`@photon-ai/mcp`](https://www.npmjs.com/package/@photon-ai/mcp) and the hosted
server at `https://mcp.photon.codes/mcp`.

- `compiler/compile`: compiles an OpenAPI 3.1 document into a checksummed
  release, one tool per operation, keeping its schema constraints.
- `compiler/release-artifacts/index`: writes and verifies a reviewable release
  bundle, and emits the runtime module a server embeds.
- `runtime/runtime-release`: activates an embedded release after checking its
  checksum.
- `runtime/server`: registers the release's tools on an MCP server and executes
  them: argument and response validation, retries with idempotency keys, and
  polling of asynchronous operations with encrypted continuations.

The host supplies the principal, the upstream origin and `fetch`, the
request-state keys and telemetry, so the core holds no credentials and makes no
assumptions about where it runs. `@modelcontextprotocol/server` is a peer
dependency.

The `photon-mcp-compile` command compiles and verifies bundles from the command
line:

```sh
photon-mcp-compile compile --input compile-input.json --out bundle --runtime-module runtime-release.ts
photon-mcp-compile verify-bundle --bundle bundle --expected-checksum <checksum>
```

## License

[Apache 2.0](https://github.com/photon-hq/mcp-server/blob/main/LICENSE)

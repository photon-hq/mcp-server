# Photon MCP Server

Use Photon from any MCP client.

If your client supports remote MCP servers with OAuth (Claude, ChatGPT, Cursor),
connect to the hosted server instead: `https://mcp.photon.codes/mcp`. No key is
needed. Use this local server when your client only runs stdio servers.

## Setup

1. Create an Account Service Key (`pho_ask_...`) in the Photon dashboard.
2. Add the server to your client. Node.js 22 or newer is required.

Claude Code:

```sh
claude mcp add photon --env PHOTON_API_KEY=pho_ask_... -- npx -y @photon-ai/mcp
```

Cursor, Claude Desktop and other JSON-configured clients:

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

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PHOTON_API_KEY` | required | Your Account Service Key |
| `PHOTON_API_URL` | `https://api.photon.codes` | API origin. Only `photon.codes` and loopback hosts are accepted |

The server offers the same tools as the hosted server. Operations that manage
keys, account security, SSO or billing checkout are not available. Your client
decides when to ask before running a tool, so set it to confirm writes.

## Documentation tools

`search_docs` searches Photon Beta documentation and returns snippets and page
paths. `read_docs` reads one of those pages, using a path such as
`/beta/ai-tools/mcp`. Both tools are read-only and always use Beta, which matches
the current Photon API. Stable documentation and arbitrary filesystem commands
are not available through these tools.

Documentation comes from the public Mintlify MCP at
`https://photon.codes/docs/mcp`. Calls send no Photon credentials, time out after
15 seconds, and return `docs_unavailable` if retrieval fails. API tools remain
available independently of the documentation service.

## License

[Apache 2.0](./LICENSE)

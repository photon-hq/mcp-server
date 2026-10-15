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
| `PHOTON_ALLOW_CUSTOM_API_URL` | unset | Set to `1` to allow any other https origin |

The server offers the same tools as the hosted server. Operations that manage
keys, account security, SSO or billing checkout are not available. Your client
decides when to ask before running a tool, so set it to confirm writes.

## License

[Apache 2.0](./LICENSE)

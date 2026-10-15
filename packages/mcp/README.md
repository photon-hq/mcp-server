# @photon-ai/mcp

Run Photon's MCP tools locally over stdio with your own Photon API key.

Clients that support remote MCP with OAuth can use the hosted server at
`https://mcp.photon.codes/mcp` instead: you sign in, choose what the client may
do, and never handle a key.

## Usage

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
| `PHOTON_API_URL` | `https://api.photon.codes` | API origin: an https `photon.codes` host, or a loopback host for development |
| `PHOTON_ALLOW_CUSTOM_API_URL` | unset | Set to `1` to allow any other https origin in `PHOTON_API_URL` |

## What the key can do

An Account Service Key acts with your account's live roles. The local tool
catalog only includes operations whose required permissions are all available
to OAuth applications (`GET /v1/auth/oauth/scopes`), the same boundary as the
hosted server. Account security, API key, SSO and billing-checkout operations
are not exposed, nor are operations that return, set or rotate a secret or a
verification code. Photon still authorizes every call; the catalog is not a
permission check.

Your MCP client decides when to ask before running a tool. The server does not
add its own confirmation step, so configure your client to confirm writes.

Keys are only read from the environment and only sent to `PHOTON_API_URL`.
For an upstream error, tool results include only its status and the filtered
`code`, `title`, `type` and request ID, never the response body.

## License

[Apache 2.0](https://github.com/photon-hq/mcp-server/blob/main/LICENSE)

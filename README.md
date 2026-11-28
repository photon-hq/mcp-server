# Photon MCP Server

Photon is enterprise-ready messaging infrastructure for AI agents across
iMessage, WhatsApp, Telegram and SMS. This MCP server connects your MCP client
to your Photon account, so your agent can set up projects, connect channels,
send and read messages, and check usage and billing.

Connect in one of two ways:

- **Hosted server** at `https://mcp.photon.codes/mcp`, for clients that support
  remote MCP servers with OAuth, such as Claude, ChatGPT, Cursor, VS Code and
  Codex. You sign in in the browser. There is nothing to install and no key.
- **Local server**, this package (`@photon-ai/mcp`), for clients that only run
  stdio servers, or where you can't complete an OAuth sign-in, such as in CI.

Both offer the same tools. Setup for each client is in the
[Photon MCP docs](https://photon.codes/docs/beta/ai-tools/mcp).

## What your agent can do

The server offers one tool for each Photon API operation available to OAuth
clients:

| Area | Tools |
| --- | --- |
| Projects | Create, find, update and delete projects; set the project's agent profile |
| Channels | Add iMessage and WhatsApp lines, buy SMS numbers, register 10DLC brands and campaigns, connect email domains and Telegram bots, set up voice |
| Messages | Send messages, read messages and attachments, mark messages read, manage conversations and contacts |
| Usage | Count messages, query message metrics, read the project's logs and traces |
| Webhooks | List event types and their schemas; view, update and delete webhook destinations |
| Billing | Read the billing overview, credit, invoices and plans; preview a plan change |
| Account | Read and update your profile; list your organizations and their members |

API keys, account security, SSO, organization members, payment methods and plan
changes are managed in the Photon dashboard.

## Example prompts

- "List the messages the Support project received today."
- "How many messages did the Support project send this week?"
- "Add +1 415 555 0100 to the Support project's shared iMessage line."

## Requirements

- A Photon account. New projects start on the Free plan.
- Hosted server: an MCP client with OAuth support. Each connection works in the
  one organization you choose when you sign in.
- Local server: Node.js 22 or newer and an Account Service Key (`pho_ask_...`).
  The key acts for your account, with your role in every organization you
  belong to.

Every tool call runs with your role's permissions. If your role can't perform
an action, the tool returns an error and nothing changes. For the examples
above:

- Reading and counting messages needs read access to the project
  (`project:read`) and works on every plan.
- Adding a contact to a shared iMessage line needs permission to manage the
  project's channels (`platforms:write`) and uses one of the project's
  shared-line seats: 25 on the Free plan, 100 on Pro. When every seat is
  assigned, the call returns an error until you release one. Business projects
  use dedicated iMessage lines instead of shared seats.

Your client decides when to ask before running a tool. Keep approval on for
tools that send messages, buy numbers or lines, or change and delete resources.

## Local setup

1. Create an Account Service Key (`pho_ask_...`) in the Photon dashboard.
2. Add the server to your client.

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

## License

[Apache 2.0](./LICENSE)

// Starts the CLI over stdio and lists its tools. Makes no API calls.
// Usage: node scripts/smoke.mjs [path/to/cli.js]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli =
  process.argv[2] ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [cli], {
  env: { ...process.env, PHOTON_API_KEY: "pho_ask_smoke" },
  stdio: ["pipe", "pipe", "inherit"],
});
const timeout = setTimeout(() => {
  child.kill();
  console.error("No tools/list response within 15 seconds.");
  process.exit(1);
}, 15_000);
child.on("exit", (code) => {
  console.error(`photon-mcp exited early with code ${code}.`);
  process.exit(1);
});

let buffered = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.id !== 2) {
      continue;
    }
    const count = message.result?.tools?.length ?? 0;
    clearTimeout(timeout);
    child.removeAllListeners("exit");
    child.kill();
    if (count === 0) {
      console.error("tools/list returned no tools.");
      process.exit(1);
    }
    console.log(`photon-mcp listed ${count} tools on Node ${process.version}.`);
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
send({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "photon-mcp-smoke", version: "1" },
    protocolVersion: "2025-06-18",
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ id: 2, jsonrpc: "2.0", method: "tools/list" });

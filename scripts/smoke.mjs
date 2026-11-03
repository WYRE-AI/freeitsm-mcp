#!/usr/bin/env node
// Offline smoke test: spawns dist/index.js against a local mock FreeITSM API on
// 127.0.0.1. No network access to any real host.
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const MOCK_KEY = "fitsm_smoketest0000000000000000";
const GATEWAY_KEY = "fitsm_gatewaykey000000000000000";

function check(condition, message) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
}

const seenAuth = [];
const mock = createServer((req, res) => {
  seenAuth.push(req.headers.authorization);
  res.setHeader("Content-Type", "application/json");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (bearer !== MOCK_KEY && bearer !== GATEWAY_KEY) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: { code: "invalid_key", message: "Invalid API key." } }));
    return;
  }
  if (req.method === "GET" && req.url === "/api/v1/ping") {
    res.writeHead(200);
    res.end(JSON.stringify({ data: { ok: true, permissions: ["tickets.read"] } }));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/v1/tickets?")) {
    res.writeHead(200);
    res.end(JSON.stringify({ data: [{ id: 1, subject: "Printer offline" }], meta: { page: 1, per_page: 25, total: 1 } }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: { code: "not_found", message: "No such route." } }));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

const textOf = (result) => result.content.map((c) => c.text ?? "").join("");

async function withStdio(extraEnv, run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/index.js")],
    env: {
      ...getDefaultEnvironment(),
      FREEITSM_BASE_URL: mockUrl,
      FREEITSM_API_KEY: MOCK_KEY,
      AUTH_MODE: "env",
      MCP_TRANSPORT: "stdio",
      LOG_LEVEL: "warn",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "freeitsm-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

try {
  console.log("\n[1] tools/list tier counts");
  await withStdio({ FREEITSM_TOOL_TIERS: "read,write,admin" }, async (client) => {
    const { tools } = await client.listTools();
    console.log(`  tools listed: ${tools.length}`);
    check(tools.length === 94, "94 tools are listed with all tiers");
    check(new Set(tools.map((t) => t.name)).size === 94, "tool names are unique");
  });
  await withStdio({}, async (client) => {
    const { tools } = await client.listTools();
    check(tools.length === 55, "default tier lists only the 55 read tools");
  });

  console.log("\n[2] mocked read call (env mode)");
  await withStdio({}, async (client) => {
    const result = await client.callTool({ name: "freeitsm_tickets_list", arguments: { state: "open" } });
    const text = textOf(result);
    console.log(`  freeitsm_tickets_list -> ${text}`);
    check(result.isError !== true, "freeitsm_tickets_list succeeds");
    check(text.includes("Printer offline") && text.includes('"total":1'), "data and meta are returned");
    const denied = await client.callTool({ name: "freeitsm_ticket_delete", arguments: { id: 1 } });
    check(denied.isError === true, "admin tool is refused when its tier is not enabled");
  });

  console.log("\n[3] gateway mode over HTTP (per-request key, S2S header)");
  const secret = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, [resolve(root, "dist/index.js")], {
    env: {
      ...getDefaultEnvironment(),
      FREEITSM_BASE_URL: mockUrl,
      MCP_TRANSPORT: "http",
      AUTH_MODE: "gateway",
      MCP_HTTP_PORT: "0",
      MCP_HTTP_HOST: "127.0.0.1",
      CONDUIT_S2S_SECRET: secret,
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const port = await new Promise((resolvePort, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("http server did not start")), 15000);
      child.stderr.on("data", (chunk) => {
        buf += chunk;
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(buf);
        if (m) { clearTimeout(timer); resolvePort(Number(m[1])); }
      });
      child.on("exit", (code) => reject(new Error(`http server exited early (${code})`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const s2s = () => {
      const t = Math.floor(Date.now() / 1000);
      return `t=${t},v1=${createHmac("sha256", secret).update(`t=${t}`).digest("hex")}`;
    };
    check((await fetch(`${base}/health`)).status === 200, "/health is unauthenticated");
    const post = (headers) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: "{}" });
    check((await post({})).status === 401, "/mcp without X-Gateway-S2S is rejected");
    check((await post({ "x-gateway-s2s": s2s() })).status === 401, "/mcp with S2S but no X-FreeITSM-Key is rejected");

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { "x-gateway-s2s": s2s(), "x-freeitsm-key": GATEWAY_KEY } },
    });
    const client = new Client({ name: "freeitsm-smoke-http", version: "0.0.0" });
    await client.connect(transport);
    seenAuth.length = 0;
    const result = await client.callTool({ name: "freeitsm_ping", arguments: {} });
    check(result.isError !== true, "freeitsm_ping succeeds with the gateway key");
    check(seenAuth.at(-1) === `Bearer ${GATEWAY_KEY}`, "the per-request key reached the API (not an env key)");
    await client.close();
  } finally {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  }
} catch (error) {
  console.error("smoke test crashed:", error);
  failures.push("crash");
} finally {
  await new Promise((r) => mock.close(r));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");

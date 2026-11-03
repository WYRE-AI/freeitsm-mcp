import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import { createHmac } from "node:crypto";
import { execute, timing } from "../utils/client.js";
import { ENDPOINTS } from "../endpoints.js";
import type { EndpointSpec, FreeItsmCredentials } from "../utils/types.js";
import {
  isLoopbackBindHost,
  requestCredentials,
  resolveRequestCredentials,
  resolveS2sSecret,
  startHttpTransport,
} from "../index.js";

const creds: FreeItsmCredentials = { apiKey: "fitsm_FAKEKEY_NOT_REAL_000000", baseUrl: "https://itsm.example.invalid" };
const SECRET = "a".repeat(40); // obviously fake test secret

function ep(tool: string): EndpointSpec {
  const found = ENDPOINTS.find((e) => e.tool === tool);
  if (!found) throw new Error(tool);
  return found;
}
function lastCall(m: ReturnType<typeof vi.fn>) {
  const [url, init] = m.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, init };
}

beforeEach(() => {
  vi.spyOn(timing, "sleep").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("S2S secret resolution", () => {
  const exitSpy = () =>
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

  it("accepts a >=32 char secret", () => {
    expect(resolveS2sSecret({ CONDUIT_S2S_SECRET: SECRET })).toEqual({ secret: SECRET, insecureDev: false });
  });
  it.each(["short-secret", "x".repeat(31)])("rejects short secret %#", (v) => {
    exitSpy();
    expect(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: v })).toThrow(/exit:1/);
  });
  it.each(["changeme", "Change-Me", "placeholder", "secret", "your-secret"])("rejects placeholder %s", (v) => {
    exitSpy();
    expect(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: v, MCP_ALLOW_INSECURE_DEV: "1" })).toThrow(/exit:1/);
  });
  it.each(["x".repeat(40), "X".repeat(64), "0".repeat(40), "your-secret-goes-here-please-replace", "CHANGEME-" + "a".repeat(30), "replace-with-" + "a".repeat(30)])(
    "rejects pattern placeholder %s even at 32+ chars",
    (v) => {
      exitSpy();
      expect(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: v })).toThrow(/exit:1/);
    },
  );
  it("rejects empty without the dev flag, allows with it", () => {
    exitSpy();
    expect(() => resolveS2sSecret({})).toThrow(/exit:1/);
    expect(resolveS2sSecret({ MCP_ALLOW_INSECURE_DEV: "1" })).toEqual({ secret: "", insecureDev: true });
  });
});

describe("isLoopbackBindHost", () => {
  it("classifies hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackBindHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "10.0.0.1", "example.com", "128.0.0.1"]) expect(isLoopbackBindHost(h)).toBe(false);
  });
});

describe("HTTP host check and body limit", () => {
  let server: HttpServer | undefined;
  const saved = { ...process.env };
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    process.env = { ...saved };
  });

  async function start(extra: Record<string, string> = {}) {
    process.env.FREEITSM_BASE_URL = "https://itsm.example.invalid";
    process.env.CONDUIT_S2S_SECRET = SECRET;
    process.env.MCP_HTTP_PORT = "0";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.AUTH_MODE = "env";
    delete process.env.MCP_ALLOWED_HOSTS;
    Object.assign(process.env, extra);
    server = await startHttpTransport();
    const addr = server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }
  async function raw(port: number, host: string, body = "{}", headers: Record<string, string> = {}) {
    const http = await import("node:http");
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", SECRET).update(`t=${t}`).digest("hex");
      const req = http.request(
        { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { Host: host, "x-gateway-s2s": `t=${t},v1=${sig}`, "content-type": "application/json", ...headers } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("rejects a foreign Host with 403 on loopback bind", async () => {
    const port = await start();
    expect((await raw(port, "evil.example.com")).status).toBe(403);
    expect((await raw(port, "localhost:" + port)).status).not.toBe(403);
  });
  it("honours MCP_ALLOWED_HOSTS", async () => {
    const port = await start({ MCP_ALLOWED_HOSTS: "mcp.internal.example" });
    expect((await raw(port, "mcp.internal.example")).status).not.toBe(403);
    expect((await raw(port, "other.example")).status).toBe(403);
  });
  it("returns 413 for bodies over 1 MiB", async () => {
    const port = await start();
    const big = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) });
    const r = await raw(port, "localhost", big);
    expect(r.status).toBe(413);
  });
  it("returns 400 for invalid JSON", async () => {
    const port = await start();
    expect((await raw(port, "localhost", "{nope")).status).toBe(400);
  });
});

describe("gateway mode never uses env credentials", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("errors without per-request credentials in gateway mode", () => {
    process.env.FREEITSM_BASE_URL = "https://itsm.example.invalid";
    process.env.FREEITSM_API_KEY = "fitsm_ENVKEY_NOT_REAL";
    const r = resolveRequestCredentials({ MCP_TRANSPORT: "http", AUTH_MODE: "gateway", FREEITSM_BASE_URL: "https://itsm.example.invalid", FREEITSM_API_KEY: "fitsm_ENVKEY_NOT_REAL" });
    expect(r).toEqual({ error: expect.stringContaining("gateway mode") });
  });
  it("uses scoped creds when present, env creds only outside gateway mode", () => {
    expect(requestCredentials.run(creds, () => resolveRequestCredentials({ MCP_TRANSPORT: "http", AUTH_MODE: "gateway" }))).toBe(creds);
    const env = { FREEITSM_BASE_URL: "https://itsm.example.invalid", FREEITSM_API_KEY: "fitsm_ENVKEY_NOT_REAL" };
    expect(resolveRequestCredentials(env)).toEqual({ apiKey: "fitsm_ENVKEY_NOT_REAL", baseUrl: "https://itsm.example.invalid" });
  });
});

describe("client hardening", () => {
  const pathEp: EndpointSpec = {
    tool: "t_get", method: "GET", path: "/things/{id}", tier: "read", destructive: false, permission: "none",
    description: "x", params: { id: { in: "path", required: true, description: "" }, q: { in: "query", description: "" } },
  };
  const bodyEp: EndpointSpec = {
    tool: "t_post", method: "POST", path: "/things", tier: "write", destructive: false, permission: "none",
    description: "x", params: { name: { in: "body", description: "" }, page: { in: "query", description: "" } },
  };
  const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  it.each(["", ".", "..", "a/b", "../x", "a\\b"])("rejects path param %j", async (id) => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const r = await execute(pathEp, { id }, creds);
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("accepts a normal path param", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    expect((await execute(pathEp, { id: "42" }, creds)).ok).toBe(true);
    expect(lastCall(fetchMock).url).toContain("/api/v1/things/42");
  });
  it("drops undeclared args from query and body", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await execute(pathEp, { id: "1", q: "a", evil: "b" }, creds);
    expect(lastCall(fetchMock).url).toContain("q=a");
    expect(lastCall(fetchMock).url).not.toContain("evil");
    await execute(bodyEp, { name: "n", page: 2, evil: "b" }, creds);
    const { url, init } = lastCall(fetchMock);
    expect(url).toContain("page=2");
    expect(url).not.toContain("evil");
    expect(init.body).toBe(JSON.stringify({ name: "n" }));
  });
  it("truncates long upstream message and details after redaction", async () => {
    const long = "y".repeat(5000);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "bad", message: long + creds.apiKey, details: { d: long } } }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await execute(ep("freeitsm_ping"), {}, creds);
    expect(r.ok).toBe(false);
    const msg = r.error?.message ?? "";
    expect(msg.length).toBeLessThan(1300);
    expect(msg).not.toContain(creds.apiKey);
  });
});

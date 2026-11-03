import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute, getBaseUrl, getCredentials, redact, resolveBaseUrl, timing } from "../utils/client.js";
import { ENDPOINTS } from "../endpoints.js";
import type { EndpointSpec, FreeItsmCredentials } from "../utils/types.js";

const API_KEY = "fitsm_TESTKEY0123456789abcdef";
const credentials: FreeItsmCredentials = { apiKey: API_KEY, baseUrl: "https://itsm.example.com" };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function endpoint(tool: string): EndpointSpec {
  const found = ENDPOINTS.find((item) => item.tool === tool);
  if (!found) throw new Error(`missing endpoint ${tool}`);
  return found;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(timing, "sleep").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FREEITSM_BASE_URL safety", () => {
  it("allows https and loopback http, and normalises the path", () => {
    expect(resolveBaseUrl("https://itsm.example.com")).toBe("https://itsm.example.com");
    expect(resolveBaseUrl("https://itsm.example.com/")).toBe("https://itsm.example.com");
    expect(resolveBaseUrl("https://itsm.example.com/freeitsm/api/v1/")).toBe("https://itsm.example.com/freeitsm");
    expect(resolveBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(resolveBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it.each([
    "",
    "http://itsm.example.com",
    "https://user:secret@itsm.example.com",
    "https://user@itsm.example.com",
    "https://itsm.example.com/?a=1",
    "https://itsm.example.com/#frag",
    "file:///etc/passwd",
    "ftp://itsm.example.com",
    "not-a-url",
  ])("rejects unsafe base URL %j", (value) => {
    expect(() => resolveBaseUrl(value)).toThrow(/FREEITSM_BASE_URL/);
  });

  it("does not echo userinfo secrets in the error", () => {
    expect(() => resolveBaseUrl("https://user:hunter2@itsm.example.com")).not.toThrow(/hunter2/);
  });

  it("reads the configured base URL", () => {
    expect(getBaseUrl({ FREEITSM_BASE_URL: "https://itsm.example.com" })).toBe("https://itsm.example.com");
  });
});

describe("credential resolution", () => {
  const env = { FREEITSM_BASE_URL: "https://itsm.example.com", FREEITSM_API_KEY: API_KEY };

  it("reads the key from the environment in env mode", () => {
    expect(getCredentials(env)).toEqual({ apiKey: API_KEY, baseUrl: "https://itsm.example.com" });
    expect(getCredentials({ FREEITSM_BASE_URL: env.FREEITSM_BASE_URL })).toEqual({ error: "Missing FREEITSM_API_KEY." });
  });

  it("reads only the X-FreeITSM-Key header in gateway mode, never the env key", () => {
    const names: string[] = [];
    expect(
      getCredentials(env, (name) => {
        names.push(name);
        return undefined;
      }),
    ).toEqual({ error: "Missing X-FreeITSM-Key header (gateway mode requires it)." });
    expect(names).toEqual(["X-FreeITSM-Key"]);
    expect(getCredentials(env, () => "fitsm_fromheader")).toEqual({
      apiKey: "fitsm_fromheader",
      baseUrl: "https://itsm.example.com",
    });
  });

  it("returns an error (not a throw) when the base URL is invalid", () => {
    expect(getCredentials({ FREEITSM_API_KEY: API_KEY, FREEITSM_BASE_URL: "http://evil.example.com" })).toHaveProperty("error");
  });
});

describe("request construction", () => {
  it("sends the Bearer key, GET method, manual redirects and no body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await execute(endpoint("freeitsm_tickets_list"), { state: "open", per_page: 10 }, credentials);
    const { url, init, headers } = lastCall(fetchMock);
    expect(url).toBe("https://itsm.example.com/api/v1/tickets?state=open&per_page=10");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("URL-encodes path params and sends JSON bodies on POST", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { id: 1 } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await execute(endpoint("freeitsm_ticket_note_add"), { id: "42 ?x#", text: "hello", is_internal: false }, credentials);
    const { url, init, headers } = lastCall(fetchMock);
    expect(url).toBe("https://itsm.example.com/api/v1/tickets/42%20%3Fx%23/notes");
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello", is_internal: false });
  });

  it("drops undeclared fields on PATCH and keeps the id out of the body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await execute(endpoint("freeitsm_ticket_update"), { id: 7, priority: "High", custom_extra: 1 }, credentials);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe("https://itsm.example.com/api/v1/tickets/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ priority: "High" });
  });

  it("rejects a missing path or required param without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noId = await execute(endpoint("freeitsm_ticket_get"), {}, credentials);
    expect(noId.ok).toBe(false);
    expect(noId.error?.message).toContain("id");
    const noSubject = await execute(endpoint("freeitsm_ticket_create"), { requester_email: "a@b.c" }, credentials);
    expect(noSubject.error?.message).toContain("subject");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("response handling", () => {
  it("unwraps the {data, meta} envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ id: 1 }], meta: { page: 1, total: 1 } })));
    const result = await execute(endpoint("freeitsm_tickets_list"), {}, credentials);
    expect(result).toEqual({ ok: true, data: [{ id: 1 }], meta: { page: 1, total: 1 } });
  });

  it("returns data without meta when none is sent, and null for an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { id: 1 } })));
    expect(await execute(endpoint("freeitsm_ticket_get"), { id: 1 }, credentials)).toEqual({ ok: true, data: { id: 1 } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await execute(endpoint("freeitsm_ticket_delete"), { id: 1 }, credentials)).toEqual({ ok: true, data: null });
  });

  it("surfaces the error code, status and message from the error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "missing_field", message: "'text' is empty or missing.", details: { field: "text" } } }, 422),
      ),
    );
    const result = await execute(endpoint("freeitsm_ticket_note_add"), { id: 1, text: "x" }, credentials);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: "upstream", status: 422, code: "missing_field" });
    expect(result.error?.message).toContain("missing_field");
    expect(result.error?.message).toContain("HTTP 422");
    expect(result.error?.message).toContain("'text' is empty or missing.");
    expect(result.error?.message).toContain('"field":"text"');
  });

  it("turns a 403 into a permission error naming the missing permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "forbidden", message: "This API key does not have the 'tickets.delete' permission." } }, 403),
      ),
    );
    const result = await execute(endpoint("freeitsm_ticket_delete"), { id: 1 }, credentials);
    expect(result.error?.kind).toBe("permission");
    expect(result.error?.message).toContain("Missing permission: 'tickets.delete'");
  });

  it("falls back to the endpoint permission when a 403 message names none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "forbidden", message: "Nope." } }, 403)));
    const result = await execute(endpoint("freeitsm_tickets_list"), {}, credentials);
    expect(result.error?.message).toContain("Missing permission: 'tickets.read'");
  });

  it("does not call a disabled or expired key a missing permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "key_expired", message: "This API key expired." } }, 403)));
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.error?.kind).toBe("upstream");
    expect(result.error?.message).toContain("key_expired");
    expect(result.error?.message).not.toContain("Missing permission");
  });

  it("handles a non-JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("HTTP 502");
  });

  it("treats 3xx as an error and does not follow it", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("redirect");
    expect(result.error?.message).not.toContain("evil.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.error).toMatchObject({ kind: "network" });
  });
});

describe("429 handling", () => {
  it("honours Retry-After and retries exactly once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "rate_limited", message: "slow down" } }, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(timing.sleep).toHaveBeenCalledWith(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "rate_limited", message: "slow down" } }, 429, { "retry-after": "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: "rate_limit", status: 429, code: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not wait when Retry-After is unreasonably long", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "rate_limited", message: "x" } }, 429, { "retry-after": "600" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.error?.kind).toBe("rate_limit");
    expect(timing.sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("redaction", () => {
  it("redacts the key and key-shaped strings", () => {
    expect(redact(`bad ${API_KEY} and fitsm_other_123 and Bearer abc.def`, [API_KEY])).toBe(
      "bad [REDACTED] and [REDACTED] and Bearer [REDACTED]",
    );
  });

  it("redacts the key if the server echoes it in an error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "invalid_key", message: `Bad key ${API_KEY}`, details: { key: API_KEY } } }, 401)),
    );
    const result = await execute(endpoint("freeitsm_ping"), {}, credentials);
    expect(result.error?.kind).toBe("auth");
    expect(result.error?.message).not.toContain(API_KEY);
    expect(result.error?.message).toContain("[REDACTED]");
  });

  it("redacts the key from network errors and non-JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`failed with ${API_KEY}`); }));
    expect((await execute(endpoint("freeitsm_ping"), {}, credentials)).error?.message).not.toContain(API_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`oops ${API_KEY}`, { status: 500 })));
    expect((await execute(endpoint("freeitsm_ping"), {}, credentials)).error?.message).not.toContain(API_KEY);
  });
});

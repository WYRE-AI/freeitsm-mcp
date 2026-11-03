import { readFileSync } from "node:fs";
import { Agent } from "undici";
import type { ApiResult, EndpointSpec, FreeItsmCredentials } from "./types.js";

export const API_PREFIX = "/api/v1";
export const KEY_HEADER = "X-FreeITSM-Key";
const REQUEST_TIMEOUT_MS = 30_000;
/** Longest Retry-After we are willing to wait for before the single retry. */
export const MAX_RETRY_WAIT_MS = 30_000;

/** Test seam: replaced in unit tests so the 429 retry does not really sleep. */
export const timing = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Validate FREEITSM_BASE_URL. https only (http only for 127.0.0.1/localhost),
 * no userinfo, query or fragment. A trailing slash or "/api/v1" is stripped.
 */
export function resolveBaseUrl(raw?: string): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("FREEITSM_BASE_URL is not set.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid FREEITSM_BASE_URL: not a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("Invalid FREEITSM_BASE_URL: userinfo (user:password@) is not allowed.");
  }
  if (url.search || url.hash) {
    throw new Error("Invalid FREEITSM_BASE_URL: query strings and fragments are not allowed.");
  }
  if (!url.hostname) throw new Error("Invalid FREEITSM_BASE_URL: hostname is required.");
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new Error("Invalid FREEITSM_BASE_URL: http is only allowed for localhost.");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("Invalid FREEITSM_BASE_URL: only https is allowed (http only for localhost).");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith(API_PREFIX)) path = path.slice(0, -API_PREFIX.length);
  return `${url.origin}${path}`;
}

export function getBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl(env.FREEITSM_BASE_URL);
}

/**
 * Resolve credentials. Without `getHeader` (env mode) the key comes from
 * FREEITSM_API_KEY. With `getHeader` (gateway mode) it comes only from the
 * X-FreeITSM-Key request header; there is no fallback to the environment.
 */
export function getCredentials(
  env: NodeJS.ProcessEnv = process.env,
  getHeader?: (name: string) => string | undefined,
): FreeItsmCredentials | { error: string } {
  let baseUrl: string;
  try {
    baseUrl = getBaseUrl(env);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (getHeader) {
    const apiKey = (getHeader(KEY_HEADER) ?? "").trim();
    if (!apiKey) return { error: `Missing ${KEY_HEADER} header (gateway mode requires it).` };
    return { apiKey, baseUrl };
  }
  const apiKey = (env.FREEITSM_API_KEY ?? "").trim();
  if (!apiKey) return { error: "Missing FREEITSM_API_KEY." };
  return { apiKey, baseUrl };
}

/** Remove the API key (and anything shaped like one) from text. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[REDACTED]") : acc), text);
  out = out.replace(/fitsm_[A-Za-z0-9_-]+/g, "[REDACTED]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  return out;
}

function fail(
  kind: NonNullable<ApiResult["error"]>["kind"],
  message: string,
  extra: { status?: number; code?: string } = {},
): ApiResult {
  return { ok: false, error: { kind, message, ...extra } };
}

let cachedAgent: { path: string; agent: Agent } | undefined;

/** Optional private CA for self-hosted installs (FREEITSM_CA_CERT_FILE). */
function getAgent(): Agent | undefined {
  const certPath = process.env.FREEITSM_CA_CERT_FILE;
  if (!certPath) return undefined;
  if (cachedAgent?.path === certPath) return cachedAgent.agent;
  const agent = new Agent({ connect: { ca: readFileSync(certPath, "utf8") } });
  cachedAgent = { path: certPath, agent };
  return agent;
}

function stringifyQuery(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Milliseconds to wait before retrying a 429, or null when unknown. */
function retryDelayMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - Date.now());
  return null;
}

interface RequestParts {
  url: string;
  body: string | undefined;
}

function buildRequest(
  endpoint: EndpointSpec,
  args: Record<string, unknown>,
  creds: FreeItsmCredentials,
): RequestParts | { missing: string[] } {
  const missing: string[] = [];
  let path = endpoint.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  const isBodyMethod = endpoint.method === "POST" || endpoint.method === "PATCH";

  for (const [key, spec] of Object.entries(endpoint.params)) {
    const value = args[key];
    const absent = value === undefined || value === null || value === "";
    if (spec.in === "path") {
      if (absent) missing.push(key);
      else path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else if (spec.required && absent) {
      missing.push(key);
    }
  }
  if (missing.length > 0) return { missing };

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const spec = endpoint.params[key];
    if (spec?.in === "path") continue;
    const location = spec?.in ?? (isBodyMethod ? "body" : "query");
    // A body-typed value on a GET/DELETE has nowhere to go but the query string.
    if (location === "body" && isBodyMethod) body[key] = value;
    else query.set(key, stringifyQuery(value));
  }

  const qs = query.toString();
  const url = `${creds.baseUrl}${API_PREFIX}${path}${qs ? `?${qs}` : ""}`;
  return { url, body: isBodyMethod && Object.keys(body).length > 0 ? JSON.stringify(body) : undefined };
}

function permissionFromMessage(message: string): string | undefined {
  return /'([a-z_]+\.[a-z_]+)'\s+permission/i.exec(message)?.[1];
}

export async function execute(
  endpoint: EndpointSpec,
  args: Record<string, unknown>,
  creds: FreeItsmCredentials,
): Promise<ApiResult> {
  const secrets = [creds.apiKey];
  const request = buildRequest(endpoint, args, creds);
  if ("missing" in request) {
    return fail("config", `Missing required parameter(s) for ${endpoint.tool}: ${request.missing.join(", ")}.`);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiKey}`,
    Accept: "application/json",
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  let retried = false;
  for (;;) {
    let response: Response;
    try {
      const dispatcher = getAgent();
      response = await fetch(request.url, {
        method: endpoint.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail("network", redact(`Request to FreeITSM failed: ${reason}`, secrets));
    }

    if (response.status >= 300 && response.status < 400) {
      return fail("http", `FreeITSM returned an unexpected redirect (HTTP ${response.status}); redirects are not followed.`, {
        status: response.status,
      });
    }

    if (response.status === 429) {
      const delay = retryDelayMs(response) ?? 1000;
      if (!retried && delay <= MAX_RETRY_WAIT_MS) {
        retried = true;
        await response.text().catch(() => "");
        await timing.sleep(delay);
        continue;
      }
      const wait = Math.ceil(delay / 1000);
      return fail(
        "rate_limit",
        retried
          ? `FreeITSM rate limit (HTTP 429, rate_limited) still exceeded after one retry. Try again in about ${wait}s.`
          : `FreeITSM rate limit exceeded (HTTP 429, rate_limited). Retry-After is ${wait}s, too long to wait; try again later.`,
        { status: 429, code: "rate_limited" },
      );
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!response.ok) return httpError(endpoint, response.status, json, text, secrets);

    if (json === undefined) {
      if (text.trim() === "") return { ok: true, data: null };
      return fail("upstream", "FreeITSM returned a non-JSON success response.", { status: response.status });
    }
    if (typeof json === "object" && json !== null && "data" in json) {
      const envelope = json as { data: unknown; meta?: unknown };
      return envelope.meta !== undefined
        ? { ok: true, data: envelope.data, meta: envelope.meta }
        : { ok: true, data: envelope.data };
    }
    return { ok: true, data: json };
  }
}

function httpError(
  endpoint: EndpointSpec,
  status: number,
  json: unknown,
  text: string,
  secrets: readonly string[],
): ApiResult {
  const err = (typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined) as
    | { code?: unknown; message?: unknown; details?: unknown }
    | undefined;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const apiMessage =
    typeof err?.message === "string" ? err.message : redact(text.slice(0, 300), secrets) || "no error body";
  const details = err?.details !== undefined ? ` Details: ${JSON.stringify(err.details)}` : "";
  const label = `FreeITSM error${code ? ` ${code}` : ""} (HTTP ${status})`;

  if (status === 403 && (code === "forbidden" || code === undefined)) {
    const perm = permissionFromMessage(apiMessage) ?? (endpoint.permission !== "none" ? endpoint.permission : undefined);
    const hint = perm
      ? ` Missing permission: '${perm}'. Grant it to this API key in FreeITSM (System > API).`
      : "";
    return fail("permission", redact(`${label}: ${apiMessage}${hint}`, secrets), { status, code: code ?? "forbidden" });
  }
  const kind = status === 401 ? "auth" : "upstream";
  return fail(kind, redact(`${label}: ${apiMessage}${details}`, secrets), { status, code });
}

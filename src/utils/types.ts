import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type { Tool, CallToolResult };

export type Tier = "read" | "write" | "admin";
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ParamSpec {
  /** Where the value is sent: URL path, query string or JSON body. */
  in: "path" | "query" | "body";
  type?: "string" | "integer" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  description?: string;
}

export interface EndpointSpec {
  tool: string;
  method: HttpMethod;
  /** Path relative to {FREEITSM_BASE_URL}/api/v1, with {name} placeholders. */
  path: string;
  tier: Tier;
  destructive: boolean;
  /** API-key permission the endpoint needs ("none" when any valid key works). */
  permission: string;
  description: string;
  params: Record<string, ParamSpec>;
}

export interface FreeItsmCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface ApiResult {
  ok: boolean;
  data?: unknown;
  /** Pagination and other metadata from the response envelope, when present. */
  meta?: unknown;
  error?: {
    kind: "config" | "auth" | "permission" | "network" | "http" | "rate_limit" | "upstream";
    message: string;
    status?: number;
    code?: string;
  };
}

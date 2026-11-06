import type { CallToolResult, EndpointSpec, FreeItsmCredentials, Tool } from "./types.js";
import { execute } from "./client.js";
import { getEnabledTiers, isToolEnabled } from "../tiers.js";
import { TOOL_TIERS } from "../tool-tiers.js";
import { ENDPOINTS } from "../endpoints.js";

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function getEndpoint(tool: string): EndpointSpec | undefined {
  return ENDPOINTS.find((endpoint) => endpoint.tool === tool);
}

function toTool(endpoint: EndpointSpec): Tool {
  const required = Object.entries(endpoint.params)
    .filter(([, param]) => param.in === "path" || param.required)
    .map(([key]) => key);
  return {
    name: endpoint.tool,
    // Destructive warnings are written into the description itself (see endpoints.ts).
    description: endpoint.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(endpoint.params).map(([key, param]) => [
          key,
          {
            ...(param.type ? { type: param.type } : {}),
            description: `[${param.in}] ${param.description ?? ""}`.trim(),
          },
        ]),
      ),
      required,
      // Only declared params are forwarded (see buildRequest).
      additionalProperties: false,
    },
    annotations: {
      destructiveHint: endpoint.destructive,
      readOnlyHint: endpoint.method === "GET",
    },
  } as Tool;
}

export function listTools(tiers: readonly string[] = getEnabledTiers()): Tool[] {
  const enabled = new Set(tiers);
  return ENDPOINTS.filter((endpoint) => enabled.has(endpoint.tier)).map(toTool);
}

export async function callTool(
  tool: string,
  args: Record<string, unknown>,
  creds: FreeItsmCredentials,
): Promise<CallToolResult> {
  const endpoint = getEndpoint(tool);
  if (!endpoint) return errorResult(`Unknown tool: ${tool}`);
  if (!isToolEnabled(tool, getEnabledTiers())) {
    return errorResult(`Tool ${tool} requires the "${TOOL_TIERS[tool].tier}" tier, which is not enabled (set FREEITSM_TOOL_TIERS).`);
  }
  const result = await execute(endpoint, args, creds);
  if (!result.ok) return errorResult(result.error?.message ?? "FreeITSM request failed.");
  const payload = result.meta !== undefined ? { data: result.data ?? null, meta: result.meta } : { data: result.data ?? null };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

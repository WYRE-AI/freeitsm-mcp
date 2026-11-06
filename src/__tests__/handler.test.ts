import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, listTools } from "../utils/handler.js";
import { TOOL_TIERS } from "../tool-tiers.js";
import { ENDPOINTS } from "../endpoints.js";
import { getEnabledTiers } from "../tiers.js";
import type { FreeItsmCredentials } from "../utils/types.js";

const credentials: FreeItsmCredentials = {
  apiKey: "fitsm_TESTKEY0123456789abcdef",
  baseUrl: "https://itsm.example.com",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FREEITSM_TOOL_TIERS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FREEITSM_TOOL_TIERS;
});

describe("FreeITSM tool registry", () => {
  it("lists exactly 55 read, 30 write, and 9 admin tools (94 total)", () => {
    const tools = listTools(["read", "write", "admin"]);
    expect(tools).toHaveLength(94);
    const count = (tier: string) => Object.values(TOOL_TIERS).filter((info) => info.tier === tier).length;
    expect(count("read")).toBe(55);
    expect(count("write")).toBe(30);
    expect(count("admin")).toBe(9);
    expect(listTools(["read"])).toHaveLength(55);
    expect(listTools(["write"])).toHaveLength(30);
    expect(listTools(["admin"])).toHaveLength(9);
  });

  it("has unique freeitsm_-prefixed names and one tier on every tool", () => {
    const names = ENDPOINTS.map((endpoint) => endpoint.tool);
    expect(new Set(names).size).toBe(names.length);
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.tool).toMatch(/^freeitsm_[a-z0-9_]+$/);
      expect(["read", "write", "admin"]).toContain(TOOL_TIERS[endpoint.tool]?.tier);
    }
    expect(names).toEqual(expect.arrayContaining([
      "freeitsm_tickets_list", "freeitsm_ticket_get", "freeitsm_ticket_create", "freeitsm_ticket_note_add", "freeitsm_ticket_delete",
    ]));
  });

  it("matches the committed schema/tiers.json", () => {
    const file = JSON.parse(readFileSync(new URL("../../schema/tiers.json", import.meta.url), "utf8")) as {
      tools: Record<string, { tier: string; destructive: boolean }>;
    };
    expect(file.tools).toEqual(TOOL_TIERS);
  });

  it("maps HTTP methods to tiers: GET is read, DELETE is admin, writes are POST/PATCH", () => {
    for (const endpoint of ENDPOINTS) {
      if (endpoint.tier === "read") expect(endpoint.method).toBe("GET");
      if (endpoint.tier === "admin") expect(endpoint.method).toBe("DELETE");
      if (endpoint.tier === "write") expect(["POST", "PATCH"]).toContain(endpoint.method);
    }
  });

  it("marks every admin tool destructive, with the warning and annotation", () => {
    const admin = listTools(["admin"]);
    for (const tool of admin) {
      expect(tool.description).toMatch(/^⚠ DESTRUCTIVE/);
      expect(tool.annotations?.destructiveHint).toBe(true);
    }
    const ticketDelete = admin.find((tool) => tool.name === "freeitsm_ticket_delete");
    expect(ticketDelete?.description).toContain("moves the ticket to trash");
    for (const tool of listTools(["read", "write"])) expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it("requires path params in the input schema", () => {
    const tool = listTools(["read"]).find((item) => item.name === "freeitsm_ticket_get");
    expect(tool?.inputSchema.required).toEqual(["id"]);
  });

  it("defaults to the read tier and rejects unknown tiers", () => {
    expect(getEnabledTiers({})).toEqual(["read"]);
    expect(getEnabledTiers({ FREEITSM_TOOL_TIERS: "read, write" })).toEqual(["read", "write"]);
    expect(() => getEnabledTiers({ FREEITSM_TOOL_TIERS: "root" })).toThrow(/FREEITSM_TOOL_TIERS/);
  });
});

describe("FreeITSM tool call", () => {
  it("performs a mocked read call end to end", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 42, subject: "Printer offline" }], meta: { page: 1, per_page: 25, total: 1 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("freeitsm_tickets_list", { state: "open" }, credentials);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      data: [{ id: 42, subject: "Printer offline" }],
      meta: { page: 1, per_page: 25, total: 1 },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://itsm.example.com/api/v1/tickets?state=open");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${credentials.apiKey}`);
  });

  it("returns tool errors for API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "Ticket not found." } }), { status: 404 })));
    const result = await callTool("freeitsm_ticket_get", { id: 999 }, credentials);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not_found");
  });

  it("refuses tools whose tier is not enabled, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("freeitsm_ticket_delete", { id: 1 }, credentials);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("admin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs admin tools once the tier is enabled and reports unknown tools", async () => {
    process.env.FREEITSM_TOOL_TIERS = "read,write,admin";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { deleted: true } }), { status: 200 })));
    expect((await callTool("freeitsm_ticket_delete", { id: 1 }, credentials)).isError).toBeUndefined();
    expect((await callTool("freeitsm_nope", {}, credentials)).isError).toBe(true);
  });
});

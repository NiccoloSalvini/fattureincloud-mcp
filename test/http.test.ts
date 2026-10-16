import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { parseToolsets } from "../src/server.js";

let server: http.Server;
let url: string;

beforeAll(async () => {
  process.env.MCPRUSH_TOKEN = "mgw_test";
  process.env.FIC_MCP_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "fic-http-"));
  server = startHttp({ port: 0, host: "127.0.0.1", toolsets: parseToolsets(undefined) });
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => {
  server.close();
  delete process.env.MCPRUSH_TOKEN;
});

let id = 0;
async function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } };
const gw = { "x-mcprush-token": "mgw_test" };

describe("dietro il gateway mcprush", () => {
  it("rifiuta le chiamate senza token o con un token sbagliato", async () => {
    expect((await rpc("initialize", init)).status).toBe(401);
    expect((await rpc("initialize", init, { "x-mcprush-token": "mgw_wrong" })).status).toBe(401);
  });

  it("risponde a initialize e tools/list senza credenziali Fatture in Cloud", async () => {
    expect((await rpc("initialize", init, gw)).status).toBe(200);
    const { body } = await rpc("tools/list", {}, gw);
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_issued_documents");
    expect(names).not.toContain("bank_reconcile");
    expect(names).not.toContain("schedule_create");
  });

  it("una chiamata senza X-Env-FIC_ACCESS_TOKEN dice cosa manca", async () => {
    const { body } = await rpc("tools/call", { name: "list_clients", arguments: {} }, gw);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Manca il token/);
  });

  it("non legge file dal disco del server", async () => {
    const { body } = await rpc(
      "tools/call",
      { name: "upload_attachment", arguments: { file_path: "/etc/hosts" } },
      { ...gw, "x-env-fic_access_token": "a/b" },
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/server è remoto/);
  });
});

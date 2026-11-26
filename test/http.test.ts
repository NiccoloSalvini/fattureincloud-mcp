import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHttp } from "../src/http.js";
import { parseToolsets } from "../src/server.js";

// a path of its own: some local security software rewrites responses on /mcp
const PATH = "/rpc";
let server: Server;

function listTools(headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        path: PATH,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  vi.stubEnv("FIC_ACCESS_TOKEN", "token-del-server");
  vi.spyOn(console, "error").mockImplementation(() => {});
  server = startHttp({ port: 0, host: "127.0.0.1", toolsets: parseToolsets("all"), path: PATH });
  await new Promise((r) => server.once("listening", r));
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("HTTP server", () => {
  it("never lends the server's token to a caller without one", async () => {
    const r = await listTools({});
    expect(r.status).toBe(401);
  });

  it("refuses pages from other origins", async () => {
    for (const Origin of ["http://sito-estraneo.example", "null"]) {
      expect((await listTools({ Authorization: "Bearer t", Origin })).status).toBe(403);
    }
    expect((await listTools({ Authorization: "Bearer t", Origin: "http://localhost:5173" })).status).toBe(200);
  });

  it("serves callers with a token, without local-file tools", async () => {
    const r = await listTools({ "X-FIC-Token": "t" });
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_companies");
    expect(names).not.toContain("bank_parse_statement");
    expect(names).not.toContain("upload_attachment");
  });
});

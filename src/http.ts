/**
 * Streamable HTTP transport, stateless: every request carries its own
 * credentials (Authorization: Bearer <token> or X-FIC-Token, plus optional
 * X-FIC-Company), so the server stores none.
 */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { FicClient } from "./client.js";
import { createServer } from "./server.js";
import type { Toolset } from "./tools/define.js";
import { ScheduleStore } from "./schedules.js";

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("Body troppo grande");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export function startHttp(opts: { port: number; host: string; toolsets: Set<Toolset>; path?: string }) {
  const mcpPath = opts.path ?? "/mcp";
  const store = new ScheduleStore();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (url.pathname !== mcpPath) return sendError(res, 404, "Not found");
    if (req.method !== "POST") return sendError(res, 405, "Usa POST (server stateless)");

    const auth = header(req, "authorization");
    const token = header(req, "x-fic-token") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : undefined) ?? process.env.FIC_ACCESS_TOKEN;
    if (!token) return sendError(res, 401, "Manca il token: header Authorization: Bearer <token> o X-FIC-Token");
    const company = header(req, "x-fic-company") ?? process.env.FIC_COMPANY_ID;

    try {
      const body = await readJson(req);
      const client = new FicClient({ token, companyId: company ? Number(company) : undefined, baseUrl: process.env.FIC_API_BASE });
      const mcp = createServer(client, { store, toolsets: opts.toolsets });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) sendError(res, 400, e instanceof Error ? e.message : String(e));
    }
  });
  server.listen(opts.port, opts.host, () => {
    console.error(`fattureincloud-mcp in ascolto su http://${opts.host}:${opts.port}${mcpPath}`);
  });
  return server;
}

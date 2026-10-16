/**
 * Streamable HTTP transport, stateless: every request carries its own
 * credentials (Authorization: Bearer <token> or X-FIC-Token, plus optional
 * X-FIC-Company), so the server stores none.
 *
 * Behind the mcprush gateway: with MCPRUSH_TOKEN set, every call must carry
 * the same value in x-mcprush-token, and the buyer's variables arrive as
 * X-Env-<NAME> headers (X-Env-FIC_ACCESS_TOKEN, X-Env-FIC_COMPANY_ID).
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { FicClient } from "./client.js";
import { createServer } from "./server.js";
import type { Toolset } from "./tools/define.js";
import { ScheduleStore, dataDir } from "./schedules.js";

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** The buyer's variable as forwarded by mcprush: X-Env-FIC_ACCESS_TOKEN (or with dashes). */
function envHeader(req: http.IncomingMessage, name: string): string | undefined {
  return header(req, `x-env-${name}`) ?? header(req, `x-env-${name.replace(/_/g, "-")}`);
}

function sameSecret(want: string, sent: string | undefined): boolean {
  const a = Buffer.from(want);
  const b = Buffer.from(sent ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Without a token the server still answers initialize and tools/list; a tool call says what is missing. */
const missingToken: typeof fetch = async () => {
  throw new Error("Manca il token Fatture in Cloud: header Authorization: Bearer <token>, X-FIC-Token o X-Env-FIC_ACCESS_TOKEN");
};

/** Toolsets that need the user's machine: bank keys and statements, schedules run by the local cron. */
const LOCAL_ONLY: Toolset[] = ["bank", "automation"];

/** One folder per buyer (tax profile, ...), named after a hash of their token. */
function tenantStore(token: string | undefined): ScheduleStore {
  if (!token) return new ScheduleStore(path.join(os.tmpdir(), "fattureincloud-mcp", randomUUID()));
  const id = createHash("sha256").update(token).digest("hex").slice(0, 32);
  return new ScheduleStore(path.join(dataDir(), "tenants", id));
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
  const hostedToolsets = new Set([...opts.toolsets].filter((t) => !LOCAL_ONLY.includes(t)));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (url.pathname !== mcpPath) return sendError(res, 404, "Not found");
    const gateway = process.env.MCPRUSH_TOKEN;
    if (gateway && !sameSecret(gateway, header(req, "x-mcprush-token"))) return sendError(res, 401, "Unauthorized");
    if (req.method !== "POST") return sendError(res, 405, "Usa POST (server stateless)");

    const auth = header(req, "authorization");
    // Behind the gateway the Authorization header is not the buyer's: only X-Env-* counts, never our own env.
    const token = gateway
      ? envHeader(req, "FIC_ACCESS_TOKEN")
      : (header(req, "x-fic-token") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : undefined) ?? process.env.FIC_ACCESS_TOKEN);
    const company = gateway ? envHeader(req, "FIC_COMPANY_ID") : (header(req, "x-fic-company") ?? process.env.FIC_COMPANY_ID);
    if (!token && !gateway) return sendError(res, 401, "Manca il token: header Authorization: Bearer <token> o X-FIC-Token");

    try {
      const body = await readJson(req);
      const client = new FicClient({
        token: token ?? "missing",
        companyId: company ? Number(company) : undefined,
        baseUrl: process.env.FIC_API_BASE,
        fetchImpl: token ? undefined : missingToken,
      });
      const mcp = gateway
        ? createServer(client, { store: tenantStore(token), toolsets: hostedToolsets, hosted: true })
        : createServer(client, { store, toolsets: opts.toolsets });
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

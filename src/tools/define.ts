import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { FicClient } from "../client.js";
import type { ScheduleStore } from "../schedules.js";

export const TOOLSETS = ["documents", "registry", "received", "accounting", "automation", "reports", "taxes", "admin"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface Ctx {
  server: McpServer;
  client: FicClient;
  store: ScheduleStore;
}

const companyArg = {
  company_id: z
    .number()
    .int()
    .optional()
    .describe("Azienda su cui operare. Default: FIC_COMPANY_ID o l'unica azienda del token"),
};

type Shape = z.ZodRawShape;
type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

/**
 * Registers a tool with an optional `company_id` argument, JSON output and
 * errors reported as tool errors (so the model can read and fix them).
 */
export function tool<S extends Shape>(
  ctx: Ctx,
  name: string,
  config: { description: string; input?: S; annotations?: ToolAnnotations; noCompany?: boolean },
  handler: (args: Args<S> & { company_id?: number }, client: FicClient) => Promise<unknown>,
) {
  const inputSchema = { ...(config.input ?? ({} as S)), ...(config.noCompany ? {} : companyArg) };
  ctx.server.registerTool(
    name,
    { description: config.description, inputSchema, annotations: config.annotations },
    (async (args: any) => {
      try {
        const client = ctx.client.withCompany(args?.company_id);
        const result = await handler(args, client);
        const text = typeof result === "string" ? result : JSON.stringify(result ?? { ok: true }, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }) as any,
  );
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");

export const listArgs = {
  q: z
    .string()
    .optional()
    .describe("Filtro Fatture in Cloud, es. \"date >= '2026-01-01' and entity.name like '%rossi%'\" o \"amount_gross > 1000\""),
  sort: z.string().optional().describe("Campo di ordinamento, prefisso - per decrescente (es. '-date')"),
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(5).max(100).optional(),
  fieldset: z.enum(["basic", "detailed"]).optional().describe("basic (default) o detailed (con righe e pagamenti)"),
};

/** Drops the *_url pagination noise from list responses. */
export function trimList(res: any, map: (row: any) => unknown = (x) => x) {
  return {
    page: res?.current_page,
    last_page: res?.last_page,
    total: res?.total,
    data: (res?.data ?? []).map(map),
  };
}

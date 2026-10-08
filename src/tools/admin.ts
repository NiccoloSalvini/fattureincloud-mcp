import { z } from "zod";
import { type Ctx, listArgs, tool, trimList } from "./define.js";

const COMPANY_LOOKUPS = [
  "vat_types",
  "payment_methods",
  "payment_accounts",
  "revenue_centers",
  "cost_centers",
  "product_categories",
  "received_document_categories",
  "archive_categories",
] as const;
const GLOBAL_LOOKUPS = ["templates", "currencies", "languages", "countries", "measures", "dn_causals"] as const;

export function registerAdminTools(ctx: Ctx) {
  tool(
    ctx,
    "list_companies",
    {
      description: "Aziende accessibili con il token, con il loro id (da usare in company_id se ne gestisci più di una).",
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async () => (await ctx.client.listCompanies()).map((c) => ({ id: c.id, name: c.name, type: c.type, access: c.access_info?.role })),
  );

  tool(
    ctx,
    "get_company_info",
    {
      description: "Dati dell'azienda (anagrafica, piano, impostazioni) e, se richiesto, l'uso del piano per categoria.",
      input: { plan_usage: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ plan_usage }, c) => {
      const info = (await c.get("/company/info")).data;
      if (!plan_usage) return info;
      const usage: Record<string, unknown> = {};
      for (const category of ["clients", "suppliers", "products", "documents"]) {
        usage[category] = (await c.get("/company/plan_usage", { category }).catch((e) => ({ data: e.message }))).data;
      }
      return { ...info, plan_usage: usage };
    },
  );

  tool(
    ctx,
    "lookup",
    {
      description:
        "Tabelle di supporto: aliquote IVA (con id da usare nelle righe), metodi di pagamento, conti di saldo, centri di ricavo/costo, " +
        "categorie, modelli grafici, valute, lingue, paesi, unità di misura, causali DDT.",
      input: {
        kind: z.enum([...COMPANY_LOOKUPS, ...GLOBAL_LOOKUPS]),
        context: z.enum(["products", "issued_documents", "received_documents"]).optional().describe("Solo per product_categories"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, context }, c) => {
      if ((GLOBAL_LOOKUPS as readonly string[]).includes(kind)) {
        return (await c.request("GET", `/info/${kind}`, { query: kind === "templates" ? { type: "all" } : undefined })).data;
      }
      const query = kind === "product_categories" ? { context: context ?? "products" } : undefined;
      return (await c.get(`/info/${kind}`, query)).data;
    },
  );

  tool(
    ctx,
    "list_sent_emails",
    {
      description: "Storico delle email inviate da Fatture in Cloud, con destinatari e stato di consegna.",
      input: listArgs,
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, ...query }, c) => trimList(await c.get("/emails", { sort: "-id", ...query })),
  );

  tool(
    ctx,
    "api_request",
    {
      description:
        "Chiamata diretta all'API v2 per tutto ciò che non ha un tool dedicato (impostazioni, listini, webhook, documenti in attesa...). " +
        "`path` relativo all'azienda (es. '/settings/payment_accounts') oppure assoluto se inizia con /user, /info o /c/. " +
        "Riferimento: https://developers.fattureincloud.it/api-reference/",
      input: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        path: z.string().startsWith("/"),
        query: z.record(z.string(), z.any()).optional(),
        body: z.any().optional().describe("Corpo JSON, di solito { data: {...} }"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, query, body }, c) => {
      const absolute = /^\/(user|info|c)\b/.test(path);
      return c.request(method, absolute ? path : await c.cpath(path), { query, body });
    },
  );
}

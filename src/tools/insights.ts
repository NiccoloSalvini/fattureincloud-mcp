import { z } from "zod";
import type { FicClient, IssuedDocument } from "../client.js";
import { audit, clientStatement, FORFETTARIO_LIMIT, receivables, revenueSummary } from "../reports.js";
import { todayISO } from "../schedules.js";
import { type Ctx, isoDate, tool } from "./define.js";

async function fetchDocs(c: FicClient, types: string[], q: string, limit = 2000): Promise<IssuedDocument[]> {
  const out: IssuedDocument[] = [];
  for (const type of types) out.push(...(await c.listAll("/issued_documents", { type, q, fieldset: "detailed", sort: "date" }, limit)));
  return out;
}

function withClient(q: string, clientId?: number) {
  return clientId ? `${q} and entity.id = ${clientId}` : q;
}

export function registerInsightTools(ctx: Ctx) {
  tool(
    ctx,
    "receivables_report",
    {
      description: "Crediti da incassare: rate non saldate, scaduto per fasce (1-30, 31-60, 61-90, oltre 90 giorni) e totali per cliente.",
      input: {
        from: isoDate.optional().describe("Considera fatture da questa data (default: 2 anni fa)"),
        client_id: z.number().int().optional(),
        as_of: isoDate.optional().describe("Data di riferimento, default oggi"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, client_id, as_of }, c) => {
      const today = as_of ?? todayISO();
      const since = from ?? `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
      const docs = await fetchDocs(c, ["invoice"], withClient(`date >= '${since}'`, client_id));
      return receivables(docs, today);
    },
  );

  tool(
    ctx,
    "revenue_summary",
    {
      description:
        "Fatturato e incassato dell'anno, per mese e per cliente. Per il regime forfettario mostra quanto manca alla soglia di 85.000 € " +
        "(principio di cassa) e la proiezione a fine anno.",
      input: {
        year: z.number().int().optional().describe("Default: anno corrente"),
        limit: z.number().optional().describe(`Soglia, default ${FORFETTARIO_LIMIT}`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ year, limit }, c) => {
      const today = todayISO();
      const y = year ?? Number(today.slice(0, 4));
      // previous year too: invoices issued in December can be collected in January
      const docs = await fetchDocs(c, ["invoice", "credit_note"], `date >= '${y - 1}-01-01' and date <= '${y}-12-31'`);
      return revenueSummary(docs, y, today, limit);
    },
  );

  tool(
    ctx,
    "audit_documents",
    {
      description:
        "Controlli sui documenti dell'anno: fatture elettroniche create ma non inviate, scartate o rifiutate; bollo mancante su fatture senza IVA " +
        "sopra 77,47 €; pagamenti scaduti; buchi, doppioni o date fuori ordine nella numerazione.",
      input: { year: z.number().int().optional().describe("Default: anno corrente") },
      annotations: { readOnlyHint: true },
    },
    async ({ year }, c) => {
      const today = todayISO();
      const y = year ?? Number(today.slice(0, 4));
      const docs = await fetchDocs(c, ["invoice", "credit_note"], `date >= '${y}-01-01' and date <= '${y}-12-31'`);
      return { year: y, ...audit(docs, today, { check_stamp_duty: true }) };
    },
  );

  tool(
    ctx,
    "client_statement",
    {
      description: "Estratto conto di un cliente: documenti, pagato, saldo aperto e scaduto.",
      input: { client_id: z.number().int(), from: isoDate.optional().describe("Default: inizio dell'anno precedente") },
      annotations: { readOnlyHint: true },
    },
    async ({ client_id, from }, c) => {
      const today = todayISO();
      const since = from ?? `${Number(today.slice(0, 4)) - 1}-01-01`;
      const docs = await fetchDocs(c, ["invoice", "credit_note"], withClient(`date >= '${since}'`, client_id));
      return { client_id, from: since, ...clientStatement(docs, today) };
    },
  );
}

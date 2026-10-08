import { z } from "zod";
import type { FicClient } from "../client.js";
import { duplicateDocument, emailDocument, forEachCollect, sendToSdi } from "../actions.js";
import { summarizeDocument } from "../reports.js";
import { todayISO, upcoming, type Schedule } from "../schedules.js";
import { runDue, runNow } from "../runner.js";
import { type Ctx, isoDate, tool } from "./define.js";
import { docType, overridesSchema } from "./documents.js";

const emailSchema = z.object({
  enabled: z.boolean().default(true),
  recipient_email: z.string().optional().describe("Default: email del cliente in Fatture in Cloud"),
  subject: z.string().optional(),
  body: z.string().optional().describe("HTML"),
  send_copy: z.boolean().optional(),
});

const selector = {
  ids: z.array(z.number().int()).optional().describe("Documenti espliciti"),
  type: docType.optional().describe("Con q: tipo da cercare (default invoice)"),
  q: z.string().optional().describe("In alternativa a ids: filtro, es. \"date >= '2026-09-01' and date <= '2026-09-30'\""),
};

async function resolveIds(c: FicClient, a: { ids?: number[]; type?: string; q?: string }, max = 200): Promise<number[]> {
  if (a.ids?.length) return a.ids;
  if (!a.q) throw new Error("Passa `ids` oppure un filtro `q`");
  // oldest first, so new numbers follow the original order
  const docs = await c.listAll("/issued_documents", { type: a.type ?? "invoice", q: a.q, sort: "date", fieldset: "basic" }, max);
  return docs.map((d) => d.id as number);
}

function describeSchedule(s: Schedule, n = 3) {
  return { ...s, history: s.history.slice(-5), upcoming: upcoming(s, n) };
}

export function registerAutomationTools(ctx: Ctx) {
  const { store } = ctx;

  // ---- Bulk -----------------------------------------------------------------

  tool(
    ctx,
    "bulk_duplicate",
    {
      description:
        "Copia molti documenti in una volta, es. tutte le fatture di settembre con data di oggi. dry_run è TRUE per default: " +
        "controlla l'anteprima, poi rilancia con dry_run=false.",
      input: {
        ...selector,
        date: isoDate.optional().describe("Data delle copie, default oggi"),
        overrides: overridesSchema.optional().describe("Applicate a tutte le copie"),
        dry_run: z.boolean().default(true),
      },
    },
    async ({ date, overrides, dry_run, ...sel }, c) => {
      const ids = await resolveIds(c, sel);
      const d = date ?? todayISO();
      const res = await forEachCollect(ids, (id) => duplicateDocument(c, id, { date: d, overrides, dry_run }));
      return {
        dry_run,
        ok: res.ok,
        failed: res.failed,
        results: res.results.map((r) =>
          "error" in r ? { source_id: r.item, error: r.error } : { source_id: r.item, document: summarizeDocument(r.result.document) },
        ),
      };
    },
  );

  tool(
    ctx,
    "bulk_send_einvoice",
    {
      description:
        "Verifica e invia allo SdI molte fatture. dry_run è TRUE per default (solo verifica). Le fatture con XML non valido vengono saltate e segnalate.",
      input: { ...selector, dry_run: z.boolean().default(true) },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ dry_run, ...sel }, c) => forEachCollect(await resolveIds(c, sel), (id) => sendToSdi(c, id, { dry_run })),
  );

  tool(
    ctx,
    "bulk_email",
    {
      description:
        "Invia per email molti documenti, ognuno al proprio cliente, con i testi di default. dry_run è TRUE per default: mostra destinatari e oggetti.",
      input: { ...selector, dry_run: z.boolean().default(true) },
      annotations: { openWorldHint: true },
    },
    async ({ dry_run, ...sel }, c) =>
      forEachCollect(await resolveIds(c, sel), async (id) => {
        if (!dry_run) return emailDocument(c, id);
        const d = await c.getEmailData(id);
        return { document_id: id, recipient_email: d?.recipient_email || null, subject: d?.subject, would_send: !!d?.recipient_email };
      }),
  );

  // ---- Ricorrenze -----------------------------------------------------------

  tool(
    ctx,
    "schedule_create",
    {
      description:
        "Crea una fattura ricorrente: a ogni scadenza copia `source_document_id` con la data del giorno e il numero successivo. " +
        "action='create' la lascia da controllare e inviare (consigliato se l'importo varia); 'create_and_send_sdi' la verifica e la invia allo SdI. " +
        "Si esegue con `fattureincloud-mcp run-due` (installabile con `fattureincloud-mcp install-scheduler`) o con schedule_run_due.",
      input: {
        name: z.string().min(1).describe("Nome univoco, es. 'Acme mensile'"),
        source_document_id: z.number().int().describe("Documento modello"),
        every_months: z.number().int().min(1).max(24).default(1).describe("1 mensile, 2 bimestrale, 3 trimestrale, 6 semestrale, 12 annuale"),
        day_of_month: z.number().int().min(1).max(31).describe("Giorno di emissione; 31 = ultimo del mese"),
        start_date: isoDate.optional().describe("Prima data utile, default oggi"),
        end_date: isoDate.optional(),
        action: z.enum(["create", "create_and_send_sdi"]).default("create"),
        email: emailSchema.optional().describe("Invia anche per email al cliente dopo la creazione"),
        overrides: overridesSchema.optional(),
        enabled: z.boolean().default(true),
      },
    },
    async ({ company_id: _ignored, ...a }, c) => {
      const source = await c.getDocument(a.source_document_id);
      const s = await store.add({ ...a, start_date: a.start_date ?? todayISO(), company_id: await c.getCompanyId() });
      return { schedule: describeSchedule(s), source: summarizeDocument(source), store: store.file };
    },
  );

  tool(
    ctx,
    "schedule_list",
    {
      description: "Elenca le fatture ricorrenti con prossime date ed esito dell'ultima esecuzione.",
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async () => ({
      store: store.file,
      schedules: (await store.load()).map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        company_id: s.company_id,
        source_document_id: s.source_document_id,
        every_months: s.every_months,
        day_of_month: s.day_of_month,
        action: s.action,
        email: !!s.email?.enabled,
        upcoming: upcoming(s, 3),
        last_run: s.history.at(-1) ?? null,
      })),
    }),
  );

  tool(
    ctx,
    "schedule_get",
    {
      description: "Dettaglio di una ricorrenza (id o nome), con storico e prossime N date.",
      input: { id: z.string(), upcoming: z.number().int().min(1).max(36).default(6) },
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async ({ id, upcoming: n }) => {
      const s = await store.get(id);
      return { ...s, upcoming: upcoming(s, n) };
    },
  );

  tool(
    ctx,
    "schedule_update",
    {
      description: "Modifica una ricorrenza (solo i campi passati). Cambiare cadenza o date ricalcola la prossima esecuzione.",
      input: {
        id: z.string(),
        name: z.string().optional(),
        source_document_id: z.number().int().optional(),
        every_months: z.number().int().min(1).max(24).optional(),
        day_of_month: z.number().int().min(1).max(31).optional(),
        start_date: isoDate.optional(),
        end_date: isoDate.optional(),
        next_run: isoDate.optional().describe("Forza la prossima esecuzione"),
        action: z.enum(["create", "create_and_send_sdi"]).optional(),
        email: emailSchema.optional(),
        overrides: overridesSchema.optional(),
        enabled: z.boolean().optional(),
      },
      annotations: { idempotentHint: true },
      noCompany: true,
    },
    async ({ id, ...patch }) => describeSchedule(await store.update(id, patch as Partial<Schedule>)),
  );

  tool(
    ctx,
    "schedule_delete",
    {
      description: "Elimina una ricorrenza. I documenti già creati restano.",
      input: { id: z.string() },
      annotations: { destructiveHint: true },
      noCompany: true,
    },
    async ({ id }) => ({ deleted: (await store.remove(id)).name }),
  );

  tool(
    ctx,
    "schedule_run_due",
    {
      description: "Esegue le ricorrenze in scadenza (next_run <= oggi), come il job pianificato. dry_run è TRUE per default.",
      input: { dry_run: z.boolean().default(true) },
      noCompany: true,
    },
    async ({ dry_run }) => {
      const reports = await runDue(ctx.client, store, { dry_run });
      return reports.length ? reports : { message: "Nessuna ricorrenza in scadenza oggi." };
    },
  );

  tool(
    ctx,
    "schedule_run_now",
    {
      description: "Esegue subito una ricorrenza fuori calendario, senza spostare la prossima esecuzione. dry_run è TRUE per default.",
      input: { id: z.string(), date: isoDate.optional(), dry_run: z.boolean().default(true) },
      noCompany: true,
    },
    async ({ id, date, dry_run }) => runNow(ctx.client, store, id, { date, dry_run }),
  );
}

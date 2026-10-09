/**
 * Purchase invoices arriving from the SdI: Fatture in Cloud parks them in
 * "documenti ricevuti in attesa" (pending) until they are registered as
 * received documents. Tools to review, categorise and register them, plus a
 * report of recurring suppliers.
 */
import { z } from "zod";
import { forEachCollect } from "../actions.js";
import { FicApiError, type FicClient, type Json } from "../client.js";
import {
  buildSupplierHistory,
  pendingDate,
  pendingGross,
  receivedFromPending,
  recurringExpenses,
  suggestCategory,
  supplierOf,
  type CategorySuggestion,
  addMonths,
} from "../expenses.js";
import { todayISO } from "../schedules.js";
import { type Ctx, isoDate, tool } from "./define.js";

const PENDING_SOURCES = ["agyo", "mail", "browser"] as const;

const FORFETTARIO_NOTE =
  "Nel regime forfettario le fatture d'acquisto non hanno effetto fiscale (niente IVA detraibile né costi deducibili), ma si possono comunque archiviare.";

const sourceArg = z
  .enum([...PENDING_SOURCES, "all"])
  .default("agyo")
  .describe("Provenienza: agyo = fatture elettroniche ricevute dallo SdI (default), mail, browser (caricate a mano), all = tutte");

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pending documents of one or all sources. The spec makes `type` required,
 * but the live API returned every pending document whatever the type, so rows
 * are deduplicated and filtered here, and the loop stops as soon as a listing
 * shows rows of other sources (the filter was ignored: nothing else to fetch).
 */
async function listPending(c: FicClient, source: string, q?: string, limit = 500): Promise<Json[]> {
  const sources = source === "all" ? PENDING_SOURCES : [source];
  const byId = new Map<unknown, Json>();
  for (const type of sources) {
    const rows = await c.listAll("/received_documents/pending", { type, q, fieldset: "detailed" }, limit);
    for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
    if (rows.some((r) => r.type && r.type !== type)) break;
  }
  const out = [...byId.values()];
  return source === "all" ? out : out.filter((r) => !r.type || r.type === source);
}

export function summarizePending(p: Json) {
  const s = supplierOf(p);
  const open = (p.payments_list ?? []).filter((x: Json) => x.status !== "paid");
  return {
    id: p.id,
    source: p.type,
    document_type: p.document_type ?? undefined,
    supplier: s.name,
    vat_number: s.vat_number,
    date: pendingDate(p),
    received_at: p.date && p.date.length > 10 ? p.date : undefined,
    invoice_number: p.ei_number || p.invoice_number || undefined,
    description: p.subject ?? p.description ?? undefined,
    category: p.category || undefined,
    amount_net: p.amount_net ?? undefined,
    amount_vat: p.amount_vat ?? undefined,
    amount_gross: pendingGross(p),
    currency: p.currency?.id && p.currency.id !== "EUR" ? p.currency.id : undefined,
    next_due_date: open[0]?.due_date ?? undefined,
    installments: p.payments_list?.length || undefined,
    xml: /\.xml(\.p7m)?$/i.test(p.filename ?? "") || p.type === "agyo",
    attachment: !!p.attachment_url,
    other_attachments: p.other_attachments?.length || undefined,
    import_error: p.import_error || undefined,
  };
}

/** Received documents of the last `months` months, all pages, one request per 100 rows. */
async function receivedSince(c: FicClient, months: number, limit = 3000): Promise<Json[]> {
  const since = addMonths(todayISO(), -months);
  return c.listAll("/received_documents", { type: "expense", q: `date >= '${since}'`, fieldset: "detailed", sort: "date" }, limit);
}

/**
 * Categories available in Fatture in Cloud (defaults plus the user's own).
 * Live, /info/received_document_categories answered 404 while the
 * pre-create info carries the list, so that is what is read.
 */
async function existingCategories(c: FicClient): Promise<string[]> {
  const res = await c.get("/received_documents/info", { type: "expense" }).catch(() => null);
  return (res?.data?.categories_list ?? []).filter((x: unknown) => typeof x === "string");
}

async function suggester(c: FicClient) {
  const [history, available] = await Promise.all([receivedSince(c, 24).then(buildSupplierHistory), existingCategories(c)]);
  return (doc: Json) => suggestCategory(doc, history, available);
}

export function registerReceivedTools(ctx: Ctx) {
  tool(
    ctx,
    "list_pending_received_documents",
    {
      description:
        "Fatture passive in attesa di registrazione (arrivate dallo SdI in «documenti ricevuti in attesa»): fornitore, data, numero, " +
        "imponibile, IVA, totale, scadenza, disponibilità di XML e allegati, con i totali. " +
        FORFETTARIO_NOTE,
      input: {
        source: sourceArg,
        q: z.string().optional().describe("Filtro Fatture in Cloud, es. \"date >= '2026-09-01'\""),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ source, q, limit }, c) => {
      const docs = (await listPending(c, source, q, limit)).map(summarizePending);
      const sum = (k: "amount_net" | "amount_vat" | "amount_gross") => round2(docs.reduce((s, d) => s + (d[k] ?? 0), 0));
      return {
        source,
        count: docs.length,
        totals: { amount_net: sum("amount_net"), amount_vat: sum("amount_vat"), amount_gross: sum("amount_gross") },
        documents: docs,
      };
    },
  );

  tool(
    ctx,
    "get_pending_received_document",
    {
      description: "Dettaglio completo di una fattura passiva in attesa di registrazione, con link temporaneo all'allegato (attachment_url).",
      input: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }, c) => (await c.get(`/received_documents/pending/${id}`, { fieldset: "detailed" })).data,
  );

  tool(
    ctx,
    "suggest_expense_categories",
    {
      description:
        "Propone la categoria di spesa per le fatture passive in attesa (o per i documenti indicati): riusa la categoria già usata per lo " +
        "stesso fornitore (P.IVA o nome) negli ultimi 24 mesi, altrimenti applica regole su nome e descrizione (utenze, telefono, software, " +
        "carburante, consulenze, affitti...). Restituisce confidenza e motivo; non modifica nulla.",
      input: {
        ids: z.array(z.number().int()).optional().describe("Documenti in attesa da categorizzare; default tutti quelli della provenienza"),
        source: sourceArg,
        documents: z
          .array(z.object({ supplier: z.string(), vat_number: z.string().optional(), description: z.string().optional() }))
          .optional()
          .describe("In alternativa: fornitori liberi da classificare"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, source, documents }, c) => {
      const suggest = await suggester(c);
      if (documents?.length) {
        return documents.map((d) => ({
          supplier: d.supplier,
          ...suggest({ supplier_name: d.supplier, supplier_vat_number: d.vat_number, subject: d.description }),
        }));
      }
      const pending = await pendingByIds(c, source, ids);
      return pending.map((p) => {
        const s = summarizePending(p);
        return { id: p.id, supplier: s.supplier, description: s.description, amount_gross: s.amount_gross, current: s.category, ...suggest(p) };
      });
    },
  );

  tool(
    ctx,
    "register_pending_received_documents",
    {
      description:
        "Registra le fatture passive in attesa come documenti ricevuti (spese), collegandole al documento in attesa (pending_id) così " +
        "Fatture in Cloud mantiene XML e allegati. Le rate coprono sempre il totale lordo; con paid=true vengono segnate pagate. " +
        "dry_run è TRUE per default: mostra le spese che verrebbero create, poi rilancia con dry_run=false. " +
        FORFETTARIO_NOTE,
      input: {
        ids: z.array(z.number().int()).optional().describe("Documenti in attesa da registrare"),
        all: z.boolean().default(false).describe("Registra tutti quelli della provenienza indicata"),
        source: sourceArg,
        categories: z.record(z.string(), z.string()).optional().describe("Categoria per documento: { \"<id>\": \"Utenze\" }"),
        default_category: z.string().optional().describe("Categoria per i documenti senza una categoria esplicita"),
        auto_category: z
          .boolean()
          .default(false)
          .describe("Per i documenti senza categoria usa la proposta di suggest_expense_categories (solo confidenza alta o media)"),
        paid: z.boolean().default(false).describe("Segna le rate come pagate"),
        paid_date: isoDate.optional().describe("Data di pagamento; default la data già indicata nella rata, altrimenti la scadenza"),
        payment_account_id: z.number().int().optional().describe("Conto di pagamento (lookup payment_accounts)"),
        remove_pending: z.boolean().default(false).describe("Dopo la registrazione elimina il documento dalla lista in attesa (operazione non documentata dall'API: se rifiutata viene segnalata)"),
        dry_run: z.boolean().default(true),
      },
      annotations: { destructiveHint: true },
    },
    async (a, c) => {
      if (!a.ids?.length && !a.all) throw new Error("Passa `ids` oppure `all: true`");
      const pending = await pendingByIds(c, a.source, a.ids);
      if (!pending.length) return { dry_run: a.dry_run, message: "Nessun documento in attesa da registrare" };
      const suggest = a.auto_category ? await suggester(c) : undefined;

      const plans = pending.map((p) => {
        let category: string | undefined = a.categories?.[String(p.id)] ?? a.default_category;
        let suggestion: CategorySuggestion | undefined;
        if (!category && !p.category && suggest) {
          suggestion = suggest(p);
          if (suggestion.category && suggestion.confidence !== "low") category = suggestion.category;
        }
        const data = receivedFromPending(p, { category, paid: a.paid, paid_date: a.paid_date, payment_account_id: a.payment_account_id });
        const warnings: string[] = [];
        if (data.payments_list.some((x: Json) => x.status === "paid" && !x.payment_account))
          warnings.push("Rata pagata senza conto: indica payment_account_id");
        if (!data.category) warnings.push("Senza categoria");
        if (p.import_error) warnings.push(`Errore di importazione: ${p.import_error}`);
        return { pending: p, data, suggestion, warnings };
      });

      const preview = (x: (typeof plans)[number]) => ({
        pending_id: x.pending.id,
        supplier: x.data.entity?.name,
        date: x.data.date,
        invoice_number: x.data.invoice_number,
        category: x.data.category,
        category_reason: x.suggestion?.reason,
        amount_gross: pendingGross(x.pending),
        payments_list: x.data.payments_list,
        warnings: x.warnings.length ? x.warnings : undefined,
      });

      if (a.dry_run) {
        return {
          dry_run: true,
          to_create: plans.length,
          remove_pending: a.remove_pending,
          documents: plans.map((x) => ({ ...preview(x), data: x.data })),
          next: "Controlla e rilancia con dry_run=false.",
        };
      }

      const res = await forEachCollect(plans, async (x) => {
        const created = (await c.post("/received_documents", { pending_id: x.pending.id, data: x.data })).data;
        let removed: boolean | string | undefined;
        if (a.remove_pending) removed = await removePending(c, x.pending.id);
        return { created, removed };
      });
      return {
        dry_run: false,
        ok: res.ok,
        failed: res.failed,
        results: res.results.map((r) =>
          "error" in r
            ? { pending_id: r.item.pending.id, supplier: r.item.data.entity?.name, error: r.error }
            : {
                ...preview(r.item),
                received_document_id: r.result.created?.id,
                pending_removed: r.result.removed === undefined ? undefined : r.result.removed === true,
                pending_note: typeof r.result.removed === "string" ? r.result.removed : undefined,
              },
        ),
      };
    },
  );

  tool(
    ctx,
    "recurring_expenses_report",
    {
      description:
        "Spese ricorrenti dai documenti ricevuti degli ultimi N mesi: fornitori con almeno 3 fatture a cadenza regolare (mensile, " +
        "bimestrale, trimestrale, semestrale, annuale), importo medio, ultima data, prossima attesa, totale annuo stimato. Segnala gli " +
        "aumenti oltre la soglia rispetto alla media precedente e le fatture attese che non sono arrivate.",
      input: {
        months: z.number().int().min(3).max(60).default(12),
        increase_threshold_pct: z.number().min(0).default(10).describe("Aumento da segnalare, in % sulla media precedente"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ months, increase_threshold_pct }, c) => {
      const docs = await receivedSince(c, months);
      return {
        months,
        documents: docs.length,
        ...recurringExpenses(docs, { today: todayISO(), increaseThreshold: increase_threshold_pct / 100 }),
      };
    },
  );
}

/**
 * Pending documents by id with as few requests as possible: one listing of
 * the source (100 per page), then a GET only for ids not found there.
 */
async function pendingByIds(c: FicClient, source: string, ids?: number[]): Promise<Json[]> {
  const get = async (id: number) => (await c.get(`/received_documents/pending/${id}`, { fieldset: "detailed" })).data;
  if (ids?.length && ids.length < 3) return Promise.all(ids.map(get));
  const listed = await listPending(c, source);
  if (!ids?.length) return listed;
  const byId = new Map(listed.map((p) => [p.id, p]));
  const out: Json[] = [];
  for (const id of ids) out.push(byId.get(id) ?? (await get(id)));
  return out;
}

/**
 * The public spec documents only GET on pending documents: registering with
 * pending_id should already take it off the list. The DELETE is attempted
 * anyway; if the API refuses it the outcome is reported, not raised, since
 * the received document has already been created.
 */
async function removePending(c: FicClient, id: number): Promise<true | string> {
  try {
    await c.del(`/received_documents/pending/${id}`);
    return true;
  } catch (e) {
    if (e instanceof FicApiError && [404, 405, 410].includes(e.status))
      return `Eliminazione non disponibile via API (${e.status}): il documento potrebbe essere già stato rimosso dalla registrazione; altrimenti eliminalo dall'app.`;
    return e instanceof Error ? e.message : String(e);
  }
}

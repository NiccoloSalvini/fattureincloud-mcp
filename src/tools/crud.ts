/**
 * CRUD tools generated from a table: one entry per API resource gives
 * list_/get_/create_/update_/delete_ tools with consistent behaviour.
 */
import { z } from "zod";
import { DOCUMENT_TYPES } from "../client.js";
import { summarizeDocument } from "../reports.js";
import { type Ctx, type Toolset, listArgs, isoDate, tool, trimList } from "./define.js";

interface Resource {
  toolset: Toolset;
  plural: string;
  singular: string;
  path: string;
  label: string;
  /** Extra notes appended to create/update descriptions. */
  notes?: string;
  /** Required `type` filter on list (issued/received documents). */
  listType?: { values: readonly [string, ...string[]]; default: string };
  /** Custom list arguments instead of the standard q/sort/page. */
  customList?: z.ZodRawShape;
  summarize?: (row: any) => unknown;
  createOptions?: boolean;
}

export const RESOURCES: Resource[] = [
  {
    toolset: "documents",
    plural: "issued_documents",
    singular: "issued_document",
    path: "/issued_documents",
    label: "documento emesso (fattura, nota di credito, proforma, preventivo, ordine, DDT...)",
    notes:
      "Ometti `number` per la numerazione automatica. Per forfettari aggiungi `stamp_duty: 2` sopra 77,47 €. " +
      "Per ripetere un documento esistente usa duplicate_document.",
    listType: { values: DOCUMENT_TYPES, default: "invoice" },
    summarize: summarizeDocument,
    createOptions: true,
  },
  {
    toolset: "registry",
    plural: "clients",
    singular: "client",
    path: "/entities/clients",
    label: "cliente",
    notes: "Per la fattura elettronica servono vat_number o tax_code, address_* e ei_code (codice SDI) o certified_email (PEC).",
  },
  { toolset: "registry", plural: "suppliers", singular: "supplier", path: "/entities/suppliers", label: "fornitore" },
  { toolset: "registry", plural: "products", singular: "product", path: "/products", label: "prodotto o servizio a listino" },
  {
    toolset: "received",
    plural: "received_documents",
    singular: "received_document",
    path: "/received_documents",
    label: "documento ricevuto (spesa, nota di credito passiva, DDT passivo)",
    notes: "L'API richiede `payments_list` che copra l'intero amount_gross anche per spese semplici.",
    listType: { values: ["expense", "passive_credit_note", "passive_delivery_note", "self_invoice"], default: "expense" },
  },
  {
    toolset: "accounting",
    plural: "receipts",
    singular: "receipt",
    path: "/receipts",
    label: "corrispettivo (scontrino / ricevuta giornaliera)",
  },
  { toolset: "accounting", plural: "f24", singular: "f24", path: "/taxes", label: "modello F24" },
  { toolset: "accounting", plural: "archive_documents", singular: "archive_document", path: "/archive", label: "documento d'archivio" },
  {
    toolset: "accounting",
    plural: "cashbook_entries",
    singular: "cashbook_entry",
    path: "/cashbook",
    label: "movimento di prima nota (incassi e pagamenti)",
    customList: {
      date_from: isoDate,
      date_to: isoDate,
      type: z.enum(["all", "in", "out"]).optional(),
      payment_account_id: z.number().int().optional(),
    },
  },
];

export function registerCrud(ctx: Ctx, enabled: Set<Toolset>) {
  for (const r of RESOURCES) {
    if (!enabled.has(r.toolset)) continue;
    const typeArg: z.ZodRawShape = r.listType
      ? { type: z.enum(r.listType.values).default(r.listType.default as any).describe("Tipo di documento") }
      : {};

    tool(
      ctx,
      `list_${r.plural}`,
      {
        description: `Elenca ${r.label}. Risposta paginata con page, last_page, total.`,
        input: { ...typeArg, ...(r.customList ?? listArgs) },
        annotations: { readOnlyHint: true },
      },
      async (args, c) => {
        const { company_id, ...query } = args as any;
        const res = await c.get(r.path, r.customList ? query : { fieldset: "basic", ...query });
        return trimList(res, query.fieldset === "detailed" ? undefined : r.summarize);
      },
    );

    tool(
      ctx,
      `get_${r.singular}`,
      { description: `Dettaglio completo di un ${r.label}.`, input: { id: z.number().int() }, annotations: { readOnlyHint: true } },
      async ({ id }, c) => (await c.get(`${r.path}/${id}`, r.customList ? undefined : { fieldset: "detailed" })).data,
    );

    tool(
      ctx,
      `create_${r.singular}`,
      {
        description: `Crea un ${r.label}. \`data\` segue lo schema dell'API v2 di Fatture in Cloud. ${r.notes ?? ""}`.trim(),
        input: {
          data: z.record(z.string(), z.any()),
          ...(r.createOptions ? { fix_payments: z.boolean().default(true).describe("Adegua l'ultima rata al totale") } : {}),
        },
      },
      async (args, c) => {
        const body: any = { data: args.data };
        if (r.createOptions) body.options = { fix_payments: (args as any).fix_payments };
        const created = (await c.post(r.path, body)).data;
        return r.summarize ? r.summarize(created) : created;
      },
    );

    tool(
      ctx,
      `update_${r.singular}`,
      {
        description: `Modifica un ${r.label}: passa solo i campi da cambiare.${r.notes ? " " + r.notes : ""}`,
        input: { id: z.number().int(), data: z.record(z.string(), z.any()) },
        annotations: { idempotentHint: true },
      },
      async ({ id, data }, c) => {
        const updated = (await c.put(`${r.path}/${id}`, { data })).data;
        return r.summarize ? r.summarize(updated) : updated;
      },
    );

    tool(
      ctx,
      `delete_${r.singular}`,
      {
        description: `Elimina un ${r.label}.${r.plural.endsWith("documents") ? " I documenti finiscono nel cestino e si recuperano con recover_document." : ""}`,
        input: { id: z.number().int() },
        annotations: { destructiveHint: true },
      },
      async ({ id }, c) => {
        await c.del(`${r.path}/${id}`);
        return { deleted: id, resource: r.plural };
      },
    );
  }
}

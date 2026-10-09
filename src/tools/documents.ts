import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { DOCUMENT_TYPES } from "../client.js";
import { duplicateDocument, emailDocument, joinDocuments, sendToSdi, setPaid, transformDocument } from "../actions.js";
import { summarizeDocument } from "../reports.js";
import { todayISO } from "../schedules.js";
import { type Ctx, isoDate, tool, trimList } from "./define.js";

export const docType = z.enum(DOCUMENT_TYPES);

export const overridesSchema = z
  .object({
    subject: z.string().optional(),
    visible_subject: z.string().optional(),
    notes: z.string().optional(),
    type: docType.optional().describe("Cambia tipo nella copia, es. proforma → invoice"),
    numeration: z.string().optional().describe("Sezionale, es. '/A'"),
    items: z
      .array(
        z.object({
          index: z.number().int().min(0).describe("Posizione della riga, da 0"),
          name: z.string().optional(),
          description: z.string().optional(),
          qty: z.number().optional(),
          net_price: z.number().optional(),
          gross_price: z.number().optional(),
        }),
      )
      .optional()
      .describe("Modifiche alle singole righe (importo, quantità, descrizione)"),
    items_list: z.array(z.record(z.string(), z.any())).optional().describe("Sostituisce tutte le righe"),
  })
  .describe(
    "Modifiche rispetto all'originale. Nei testi puoi usare {{mese}}, {{anno}}, {{mese_precedente}}, {{anno_mese_precedente}}, " +
      "{{mese_successivo}}, {{trimestre}}, {{data}}; con |maiuscolo l'iniziale diventa maiuscola. Es. 'Consulenza {{mese_precedente}} {{anno_mese_precedente}}'.",
  );

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xml: "application/xml",
  p7m: "application/pkcs7-mime",
  zip: "application/zip",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function expandHome(p: string) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

async function saveFile(target: string, defaultName: string, bytes: Uint8Array | string) {
  let file = expandHome(target);
  const stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) file = path.join(file, defaultName);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return path.resolve(file);
}

export function registerDocumentTools(ctx: Ctx) {
  // A remote server has no filesystem of the user's to save to
  const saveTo: { save_to?: z.ZodOptional<z.ZodString> } = ctx.remote ? {} : { save_to: z.string().optional() };

  tool(
    ctx,
    "get_new_document_defaults",
    {
      description: "Prossimi numeri liberi per sezionale, valori predefiniti, aliquote e modelli: utile prima di creare un documento.",
      input: { type: docType.default("invoice") },
      annotations: { readOnlyHint: true },
    },
    async ({ type }, c) => (await c.get("/issued_documents/info", { type })).data,
  );

  tool(
    ctx,
    "duplicate_document",
    {
      description:
        "Copia un documento esistente (come «Duplica», ma completo): stesso cliente, righe, bollo, metodo e conto di pagamento; " +
        "nuova data, numero successivo, scadenze spostate dello stesso intervallo. La copia NON viene inviata allo SdI né per email. " +
        "Usa dry_run=true per vedere il documento prima di crearlo.",
      input: {
        source_id: z.number().int(),
        date: isoDate.optional().describe("Default: oggi"),
        number: z.number().int().optional().describe("Default: prossimo numero libero"),
        overrides: overridesSchema.optional(),
        dry_run: z.boolean().default(false),
      },
    },
    async ({ source_id, date, number, overrides, dry_run }, c) => {
      const r = await duplicateDocument(c, source_id, { date: date ?? todayISO(), number, overrides, dry_run });
      return r.dry_run ? r : { source_id, created: summarizeDocument(r.document) };
    },
  );

  tool(
    ctx,
    "transform_document",
    {
      description:
        "Trasforma un documento in un altro tipo con il collegamento nativo di Fatture in Cloud: proforma → fattura, preventivo → ordine o fattura, " +
        "ordine → DDT/fattura, DDT → fattura.",
      input: {
        id: z.number().int(),
        new_type: docType,
        keep_copy: z.boolean().default(true).describe("Mantieni il documento originale"),
        e_invoice: z.boolean().optional().describe("Crea come fattura elettronica"),
        date: isoDate.optional(),
        dry_run: z.boolean().default(false),
      },
    },
    async ({ id, ...opts }, c) => {
      const r = await transformDocument(c, id, opts);
      return r.dry_run ? r : { created: summarizeDocument(r.document) };
    },
  );

  tool(
    ctx,
    "join_documents",
    {
      description: "Raggruppa più DDT, ordini, preventivi o rapportini in un unico documento (es. fattura riepilogativa di fine mese).",
      input: {
        ids: z.array(z.number().int()).min(2),
        source_type: z.enum(["delivery_notes", "orders", "quotes", "work_reports"]),
        group: z.boolean().optional().describe("Raggruppa le righe uguali"),
        date: isoDate.optional(),
        dry_run: z.boolean().default(false),
      },
    },
    async ({ ids, ...opts }, c) => {
      const r = await joinDocuments(c, ids, opts);
      return r.dry_run ? r : { created: summarizeDocument(r.document) };
    },
  );

  tool(
    ctx,
    "mark_paid",
    {
      description:
        "Segna come saldate tutte le rate aperte di uno o più documenti. Se una rata non ha conto, usa payment_account_id o il primo conto configurato.",
      input: {
        ids: z.array(z.number().int()).min(1),
        paid_date: isoDate.optional().describe("Default: oggi"),
        payment_account_id: z.number().int().optional().describe("Conto di saldo (vedi lookup payment_accounts)"),
      },
      annotations: { idempotentHint: true },
    },
    async ({ ids, paid_date, payment_account_id }, c) => {
      const out = [];
      for (const id of ids) {
        try {
          out.push(await setPaid(c, id, { paid: true, paid_date, payment_account_id }));
        } catch (e: any) {
          out.push({ document_id: id, error: e.message });
        }
      }
      return out;
    },
  );

  tool(
    ctx,
    "mark_unpaid",
    {
      description: "Riapre le rate saldate di un documento (annulla mark_paid).",
      input: { id: z.number().int() },
      annotations: { idempotentHint: true },
    },
    async ({ id }, c) => setPaid(c, id, { paid: false }),
  );

  tool(
    ctx,
    "email_document",
    {
      description:
        "Invia il documento per email al cliente, con link e PDF. Mittente, destinatario, oggetto e testo di default sono quelli impostati in Fatture in Cloud.",
      input: {
        id: z.number().int(),
        recipient_email: z.string().optional().describe("Più indirizzi separati da virgola"),
        subject: z.string().optional(),
        body: z.string().optional().describe("HTML; {{allegati}} viene sostituito dai pulsanti"),
        send_copy: z.boolean().optional().describe("Copia all'indirizzo CC dell'azienda"),
        attach_pdf: z.boolean().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ id, ...rest }, c) => emailDocument(c, id, rest),
  );

  tool(
    ctx,
    "verify_einvoice",
    {
      description: "Verifica formale dell'XML della fattura elettronica: campi obbligatori e formati. Non invia nulla.",
      input: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }, c) => c.verifyEInvoiceXml(id),
  );

  tool(
    ctx,
    "send_einvoice",
    {
      description:
        "Verifica l'XML e invia la fattura elettronica allo SdI. IRREVERSIBILE: una fattura inviata si corregge solo con nota di credito. " +
        "dry_run=true esegue tutti i controlli senza inviare.",
      input: { id: z.number().int(), dry_run: z.boolean().default(false) },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ id, dry_run }, c) => sendToSdi(c, id, { dry_run }),
  );

  tool(
    ctx,
    "get_einvoice_xml",
    {
      description: ctx.remote
        ? "Scarica l'XML FatturaPA di un documento e lo restituisce."
        : "Scarica l'XML FatturaPA di un documento. Con save_to lo salva su file (percorso o cartella), altrimenti lo restituisce.",
      input: {
        id: z.number().int(),
        include_attachment: z.boolean().optional(),
        ...saveTo,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, include_attachment, ...rest }, c) => {
      const { save_to } = rest as { save_to?: string };
      const xml = await c.get(`/issued_documents/${id}/e_invoice/xml`, { include_attachment });
      const text = typeof xml === "string" ? xml : JSON.stringify(xml);
      if (!save_to) return text;
      return { saved: await saveFile(save_to, `fattura-${id}.xml`, text) };
    },
  );

  tool(
    ctx,
    "einvoice_rejection_reason",
    {
      description: "Motivo dello scarto SdI di una fattura elettronica, con le indicazioni per correggerla.",
      input: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }, c) => (await c.get(`/issued_documents/${id}/e_invoice/error_reason`)).data,
  );

  tool(
    ctx,
    "get_document_pdf",
    {
      description: ctx.remote
        ? "Link al PDF del documento (anche DDT e fattura accompagnatoria)."
        : "Link al PDF del documento (anche DDT e fattura accompagnatoria). Con save_to scarica il PDF su file o in una cartella.",
      input: { id: z.number().int(), ...saveTo },
      annotations: { readOnlyHint: true },
    },
    async ({ id, ...rest }, c) => {
      const { save_to } = rest as { save_to?: string };
      const d = await c.getDocument(id);
      const links = { pdf: d.url, delivery_note_pdf: d.dn_url ?? undefined, accompanying_invoice_pdf: d.ai_url ?? undefined, attachment: d.attachment_url ?? undefined };
      if (!save_to) return links;
      if (!d.url) throw new Error("Il documento non ha un PDF disponibile");
      const name = `${d.type}-${d.number ?? id}${(d.numeration ?? "").replace(/[^\w-]/g, "")}-${d.date}.pdf`;
      return { ...links, saved: await saveFile(save_to, name, await c.download(d.url)) };
    },
  );

  // Reads a local path: only on the user's machine
  if (!ctx.remote) {
    tool(
      ctx,
      "upload_attachment",
      {
        description:
          "Carica un file locale come allegato e restituisce l'attachment_token. Poi collegalo con update_* passando { attachment_token }.",
        input: {
          file_path: z.string(),
          resource: z.enum(["issued_documents", "received_documents", "archive", "taxes"]).default("issued_documents"),
        },
      },
      async ({ file_path, resource }, c) => {
        const file = expandHome(file_path);
        const bytes = new Uint8Array(await fs.readFile(file));
        const name = path.basename(file);
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        const token = await c.uploadAttachment(resource, bytes, name, MIME[ext] ?? "application/octet-stream");
        return { attachment_token: token, file: name, next: `update_… con data: { "attachment_token": "${token}" }` };
      },
    );
  }

  tool(
    ctx,
    "list_deleted_documents",
    {
      description: "Documenti emessi o ricevuti nel cestino, recuperabili con recover_document.",
      input: { kind: z.enum(["issued", "received"]).default("issued") },
      annotations: { readOnlyHint: true },
    },
    async ({ kind }, c) => {
      const res = await c.get(`/bin/${kind}_documents`);
      return trimList(res, kind === "issued" ? summarizeDocument : undefined);
    },
  );

  tool(
    ctx,
    "recover_document",
    {
      description: "Ripristina un documento dal cestino.",
      input: { id: z.number().int(), kind: z.enum(["issued", "received"]).default("issued") },
    },
    async ({ id, kind }, c) => {
      await c.post(`/bin/${kind}_documents/${id}/recover`);
      return { recovered: id };
    },
  );
}

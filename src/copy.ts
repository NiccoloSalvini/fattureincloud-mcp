/**
 * Pure helpers to turn an existing issued document into the body of a new one
 * ("Duplica", but scriptable): new date, automatic numbering, shifted due dates,
 * placeholders and per-item overrides.
 */
import type { IssuedDocument } from "./client.js";

/** Fields that belong to the original document and must not be copied. */
const DROP_FIELDS = [
  "id",
  "number",
  "year",
  "url",
  "dn_url",
  "ai_url",
  "attachment_url",
  "attachment_token",
  "ei_raw",
  "ei_status",
  "locked",
  "created_at",
  "updated_at",
  "seen_date",
  "next_due_date",
  "is_marked",
  "dn_number",
  "dn_date",
  // read-only totals, recomputed by the API
  "amount_net",
  "amount_vat",
  "amount_gross",
  "amount_cassa",
  "amount_rivalsa",
  "amount_withholding_tax",
  "amount_other_withholding_tax",
];

const TEXT_FIELDS = ["subject", "visible_subject", "notes"] as const;

export interface ItemOverride {
  /** 0-based position in items_list */
  index: number;
  name?: string;
  description?: string;
  qty?: number;
  net_price?: number;
  gross_price?: number;
}

export interface CopyOverrides {
  subject?: string;
  visible_subject?: string;
  notes?: string;
  items?: ItemOverride[];
  /** Replace the whole items_list (placeholders still applied). */
  items_list?: Record<string, any>[];
  /** Change the document type (e.g. proforma → invoice). */
  type?: IssuedDocument["type"];
  numeration?: string;
}

export interface CopyOptions {
  /** ISO date of the new document (YYYY-MM-DD). */
  date: string;
  overrides?: CopyOverrides;
  /** Explicit number; omit to let Fatture in Cloud assign the next one. */
  number?: number;
}

const MESI = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

export function parseISODate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Data non valida (atteso YYYY-MM-DD): ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseISODate(toIso).getTime() - parseISODate(fromIso).getTime()) / 86_400_000);
}

/**
 * Placeholders usable in subject, notes and item names/descriptions:
 * {{mese}} {{anno}} {{mese_precedente}} {{anno_mese_precedente}}
 * {{mese_successivo}} {{trimestre}} {{data}} — Italian month names, lowercase.
 * Add `|maiuscolo` for a capitalised month, e.g. {{mese_precedente|maiuscolo}}.
 */
export function placeholderValues(iso: string): Record<string, string> {
  const d = parseISODate(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m + 1, 1));
  return {
    mese: MESI[m],
    anno: String(y),
    mese_precedente: MESI[prev.getUTCMonth()],
    anno_mese_precedente: String(prev.getUTCFullYear()),
    mese_successivo: MESI[next.getUTCMonth()],
    anno_mese_successivo: String(next.getUTCFullYear()),
    trimestre: String(Math.floor(m / 3) + 1),
    data: `${String(d.getUTCDate()).padStart(2, "0")}/${String(m + 1).padStart(2, "0")}/${y}`,
  };
}

export function applyPlaceholders(text: string, iso: string): string;
export function applyPlaceholders(text: string | null | undefined, iso: string): string | null | undefined;
export function applyPlaceholders(text: string | null | undefined, iso: string) {
  if (typeof text !== "string") return text;
  const values = placeholderValues(iso);
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|\s*(maiuscolo))?\s*\}\}/g, (whole, key: string, mod?: string) => {
    const v = values[key];
    if (v === undefined) return whole;
    return mod ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  });
}

export function buildCopy(source: IssuedDocument, opts: CopyOptions): IssuedDocument {
  const ov = opts.overrides ?? {};
  const doc: IssuedDocument = structuredClone(source);
  for (const f of DROP_FIELDS) delete doc[f];

  doc.date = opts.date;
  if (opts.number !== undefined) doc.number = opts.number;
  if (ov.type) doc.type = ov.type;
  if (ov.numeration !== undefined) doc.numeration = ov.numeration;

  for (const f of TEXT_FIELDS) {
    if (ov[f] !== undefined) doc[f] = ov[f];
    doc[f] = applyPlaceholders(doc[f], opts.date);
  }

  let items = ov.items_list ? structuredClone(ov.items_list) : (doc.items_list ?? []);
  items = items.map((it) => {
    const { id, ...rest } = it;
    return rest;
  });
  for (const o of ov.items ?? []) {
    const it = items[o.index];
    if (!it) throw new Error(`Override per la riga ${o.index}, ma il documento ha ${items.length} righe`);
    for (const k of ["name", "description", "qty", "net_price", "gross_price"] as const) {
      if (o[k] !== undefined) it[k] = o[k];
    }
    // gross/net are linked: drop the other one so the API recomputes it
    if (o.net_price !== undefined && o.gross_price === undefined) delete it.gross_price;
    if (o.gross_price !== undefined && o.net_price === undefined) delete it.net_price;
  }
  for (const it of items) {
    it.name = applyPlaceholders(it.name, opts.date);
    it.description = applyPlaceholders(it.description, opts.date);
  }
  doc.items_list = items;

  // Payments: keep the same terms, shift due dates by the same offset, reset status.
  // Amounts are reconciled server side via options.fix_payments.
  const shift = source.date ? daysBetween(source.date, opts.date) : 0;
  doc.payments_list = (doc.payments_list ?? []).map((p) => {
    const { id, ei_raw, paid_date, ...rest } = p;
    return {
      ...rest,
      due_date: rest.due_date ? addDays(rest.due_date, shift) : opts.date,
      status: "not_paid",
    };
  });

  return doc;
}

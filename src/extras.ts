/**
 * Pure helpers for: bollo virtuale on e-invoices, credit notes, client data
 * from VIES, and the regime forfettario section of the tax return (quadro LM).
 */
import type { IssuedDocument, Json } from "./client.js";
import { buildCopy } from "./copy.js";
import { stampOf, STAMP_DUTY_THRESHOLD } from "./reports.js";
import type { YearCalc } from "./taxes.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- Bollo virtuale ----------------------------------------------------------

/** Codici tributo F24 dell'imposta di bollo sulle fatture elettroniche, per trimestre. */
export const STAMP_CODES = ["2521", "2522", "2523", "2524"] as const;

/** Statutory deadline (as month-day) of each quarter: Q1 31/5, Q2 30/9, Q3 30/11, Q4 28/2 of the next year. */
export function stampDeadline(year: number, quarter: 1 | 2 | 3 | 4): string {
  if (quarter === 4) {
    const leap = (year + 1) % 4 === 0 && ((year + 1) % 100 !== 0 || (year + 1) % 400 === 0);
    return `${year + 1}-02-${leap ? 29 : 28}`;
  }
  return [`${year}-05-31`, `${year}-09-30`, `${year}-11-30`][quarter - 1];
}

/**
 * Stamp duty due per quarter on issued documents (invoices and credit notes)
 * that carry a bollo, by document date. From 2024 forfettari issue only
 * e-invoices, so every document with a bollo counts.
 */
export function stampDutyQuarters(docs: IssuedDocument[], year: number, today: string) {
  const quarters = ([1, 2, 3, 4] as const).map((q) => ({
    quarter: q,
    code: STAMP_CODES[q - 1],
    documents: 0,
    amount: 0,
    deadline: stampDeadline(year, q),
    status: "" as "chiuso" | "in corso" | "futuro",
  }));
  for (const d of docs) {
    if (!d.date?.startsWith(String(year)) || (d.type !== "invoice" && d.type !== "credit_note")) continue;
    const stamp = stampOf(d);
    if (!stamp) continue;
    const q = quarters[Math.floor((Number(d.date.slice(5, 7)) - 1) / 3)];
    q.documents++;
    q.amount = r2(q.amount + 2);
  }
  for (const q of quarters) {
    const end = `${year}-${String(q.quarter * 3).padStart(2, "0")}-31`;
    const start = `${year}-${String(q.quarter * 3 - 2).padStart(2, "0")}-01`;
    q.status = today > end ? "chiuso" : today >= start ? "in corso" : "futuro";
  }
  return {
    year,
    quarters,
    total: r2(quarters.reduce((s, q) => s + q.amount, 0)),
    notes: [
      "2 € per ogni fattura o nota di credito con bollo, anche se l'importo è addebitato al cliente: lo versa chi emette.",
      "Se il primo trimestre non supera 5.000 € si può versare entro il 30/9; se primo e secondo insieme non superano 5.000 €, entro il 30/11.",
      "Il trimestre in corso è parziale: l'importo cresce con le fatture emesse fino a fine trimestre.",
    ],
  };
}

// ---- Nota di credito ----------------------------------------------------------

export interface CreditNoteOptions {
  date: string;
  /** Partial credit: a single line of this net amount instead of all the original lines. */
  amount?: number;
  description?: string;
  items_list?: Json[];
}

/**
 * Credit note body from an invoice: same client and terms, own numbering,
 * linked to the original for the SdI (DatiFattureCollegate).
 */
export function buildCreditNote(invoice: IssuedDocument, opts: CreditNoteOptions): IssuedDocument {
  if (invoice.type !== "invoice") throw new Error(`Il documento ${invoice.id} non è una fattura (tipo ${invoice.type})`);
  const label = `fattura n. ${invoice.number}${invoice.numeration ?? ""} del ${formatDate(invoice.date)}`;
  const doc = buildCopy(invoice, { date: opts.date, overrides: { type: "credit_note" } });
  delete doc.numeration; // credit notes have their own series
  const firstVat = invoice.items_list?.[0]?.vat;
  if (opts.items_list) {
    doc.items_list = opts.items_list;
  } else if (opts.amount !== undefined) {
    doc.items_list = [{ name: opts.description ?? `Storno parziale ${label}`, qty: 1, net_price: opts.amount, vat: firstVat ? { id: firstVat.id } : undefined }];
    // rivalsa/bollo lines of the original do not apply to a partial line
    if (opts.amount <= STAMP_DUTY_THRESHOLD) delete doc.stamp_duty;
  } else if (opts.description) {
    doc.items_list = (doc.items_list ?? []).map((it, i) => (i === 0 ? { ...it, description: opts.description } : it));
  }
  doc.visible_subject = doc.visible_subject || `Nota di credito a storno ${opts.amount === undefined && !opts.items_list ? "totale" : "parziale"} della ${label}`;
  doc.ei_data = { ...(invoice.ei_data ?? {}), invoice_number: `${invoice.number}${invoice.numeration ?? ""}`, invoice_date: invoice.date };
  // a single refund installment due today; amounts reconciled by fix_payments
  const account = invoice.payments_list?.[0]?.payment_account;
  doc.payments_list = [{ amount: 0, due_date: opts.date, status: "not_paid", ...(account ? { payment_account: account } : {}) }];
  return doc;
}

function formatDate(iso?: string | null) {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "?";
}

// ---- Cliente da VIES ----------------------------------------------------------

/** Parses the VIES address of an Italian company: "VIA X N 1 \n50136 FIRENZE FI\n". */
export function parseItalianAddress(address: string) {
  const lines = address.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  const m = /^(\d{5})\s+(.+?)\s+([A-Z]{2})$/.exec(last);
  if (!m) return { street: lines.join(", ") || undefined };
  return { street: lines.slice(0, -1).join(", ") || undefined, postal_code: m[1], city: m[2], province: m[3] };
}

const titleCase = (s?: string) => s?.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

/** VIES answers with userError codes; these mean "try again later", not "invalid number". */
export const VIES_TEMPORARY = new Set(["MS_MAX_CONCURRENT_REQ", "MS_UNAVAILABLE", "SERVICE_UNAVAILABLE", "TIMEOUT", "GLOBAL_MAX_CONCURRENT_REQ"]);

export function clientFromVies(vies: Json, country = "IT") {
  if (VIES_TEMPORARY.has(vies?.userError)) throw new Error(`VIES temporaneamente non disponibile per ${country} (${vies.userError}): riprova tra qualche minuto`);
  if (!vies?.isValid) throw new Error(`Partita IVA non valida o non registrata al VIES (${vies?.userError ?? "risposta vuota"})`);
  const addr = country === "IT" ? parseItalianAddress(vies.address ?? "") : { street: (vies.address ?? "").replace(/\n/g, ", ").trim() };
  return {
    name: vies.name && vies.name !== "---" ? vies.name : undefined,
    vat_number: vies.vatNumber,
    type: "company",
    address_street: titleCase(addr.street),
    address_postal_code: "postal_code" in addr ? addr.postal_code : undefined,
    address_city: "city" in addr ? titleCase(addr.city) : undefined,
    address_province: "province" in addr ? addr.province : undefined,
    country: country === "IT" ? "Italia" : undefined,
    country_iso: country,
  };
}

// ---- Quadro LM ----------------------------------------------------------------

/**
 * Values for the regime forfettario section (quadro LM, Redditi PF), from the
 * same model used by tax_estimate. Line labels follow recent models: always
 * check them against the form of the year.
 */
export function quadroLM(y: YearCalc, ateco?: string, coefficient?: number) {
  const advances = r2(y.tax_advances[0] + y.tax_advances[1]);
  return {
    year: y.year,
    righi: [
      { rigo: "LM22", voce: "Codice attività, coefficiente e ricavi/compensi", valori: { codice_attivita: ateco ?? "(imposta l'ATECO nel profilo)", coefficiente: coefficient, ricavi: y.revenue, reddito: y.gross_income } },
      { rigo: "LM34", voce: "Reddito lordo", valore: y.gross_income },
      { rigo: "LM35", voce: "Contributi previdenziali e assistenziali versati nell'anno (deducibili)", valore: y.contributions_paid_in_year },
      { rigo: "LM36", voce: "Reddito netto", valore: y.taxable_income },
      { rigo: "LM39", voce: "Imposta sostitutiva", valore: y.tax_due },
      { rigo: "LM43/LM44", voce: "Acconti versati", valore: advances },
      { rigo: "LM45/LM46", voce: y.tax_balance >= 0 ? "Imposta a debito (saldo)" : "Imposta a credito", valore: Math.abs(y.tax_balance) },
    ],
    contributi_inps: { dovuti: y.contributions_due, acconti: r2(y.contribution_advances[0] + y.contribution_advances[1]), saldo: y.contribution_balance },
    notes: [
      "Numerazione dei righi indicativa: verifica sul modello Redditi PF dell'anno; quadro RR per i contributi INPS.",
      "I ricavi sono gli incassi dell'anno (principio di cassa); se hai incassi fuori da Fatture in Cloud aggiungili con tax_profile_set overrides.",
    ],
  };
}

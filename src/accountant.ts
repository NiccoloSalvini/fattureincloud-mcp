/**
 * Pacchetto annuale per il commercialista: un unico zip con CSV in formato
 * italiano (separatore ;, virgola decimale), PDF, XML FatturaPA e un riepilogo.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import type { FicClient, IssuedDocument, Json } from "./client.js";
import { fetchIssued, estimateTaxes } from "./finance.js";
import { audit, receivables, revenueSummary } from "./reports.js";
import { todayISO } from "./schedules.js";
import type { TaxProfile } from "./taxes.js";

const eur = (n: number | null | undefined) => (n == null ? "" : n.toFixed(2).replace(".", ","));

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

const docNumber = (d: IssuedDocument) => `${d.number ?? ""}${d.numeration ?? ""}`;
const sign = (d: IssuedDocument) => (d.type === "credit_note" ? -1 : 1);

export function invoicesCsv(docs: IssuedDocument[]): string {
  return toCsv(
    ["Tipo", "Numero", "Data", "Cliente", "Partita IVA", "Codice fiscale", "Imponibile", "IVA", "Bollo", "Totale", "Elettronica", "Stato SdI", "Incassato", "Ultimo incasso", "Da incassare"],
    docs.map((d) => {
      const paid = (d.payments_list ?? []).filter((p) => p.status === "paid");
      const open = (d.payments_list ?? []).filter((p) => p.status === "not_paid");
      return [
        d.type === "credit_note" ? "Nota di credito" : "Fattura",
        docNumber(d),
        d.date,
        d.entity?.name,
        d.entity?.vat_number,
        d.entity?.tax_code,
        eur((d.amount_net ?? 0) * sign(d)),
        eur((d.amount_vat ?? 0) * sign(d)),
        eur(d.stamp_duty ?? 0),
        eur((d.amount_gross ?? 0) * sign(d)),
        d.e_invoice ? "sì" : "no",
        d.ei_status ?? "",
        eur(paid.reduce((s, p) => s + (p.amount ?? 0), 0) * sign(d)),
        paid.map((p) => p.paid_date).sort().at(-1) ?? "",
        eur(open.reduce((s, p) => s + (p.amount ?? 0), 0) * sign(d)),
      ];
    }),
  );
}

export function collectionsCsv(docs: IssuedDocument[], year: number): string {
  const rows: (string | undefined)[][] = [];
  for (const d of docs) {
    for (const p of d.payments_list ?? []) {
      if (p.status !== "paid" || !p.paid_date?.startsWith(String(year))) continue;
      rows.push([p.paid_date, eur((p.amount ?? 0) * sign(d)), `${d.type === "credit_note" ? "NC" : "FT"} ${docNumber(d)} del ${d.date}`, d.entity?.name, p.payment_account?.name]);
    }
  }
  rows.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return toCsv(["Data incasso", "Importo", "Documento", "Cliente", "Conto"], rows);
}

export function expensesCsv(expenses: Json[]): string {
  return toCsv(
    ["Data", "Fornitore", "Descrizione", "Categoria", "Imponibile", "IVA", "Totale", "Pagato"],
    expenses.map((e) => [
      e.date,
      e.entity?.name,
      e.description,
      e.category,
      eur(e.amount_net),
      eur(e.amount_vat),
      eur(e.amount_gross),
      (e.payments_list ?? []).every((p: Json) => p.status === "paid") ? "sì" : "no",
    ]),
  );
}

function summaryMarkdown(year: number, rev: ReturnType<typeof revenueSummary>, aud: ReturnType<typeof audit>, rec: ReturnType<typeof receivables>, tax: any, counts: Json): string {
  const f = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  const lines = [
    `# Riepilogo ${year}`,
    "",
    `Generato il ${todayISO()} da fattureincloud-mcp.`,
    "",
    "## Ricavi",
    "",
    `- Fatturato (competenza, imponibile): ${f(rev.issued.net)}`,
    `- Incassato (cassa, al netto IVA): ${f(rev.collected.net_estimate)}`,
    `- Bolli addebitati: ${f(rev.issued.stamp_duty)}`,
    `- Soglia forfettario: ${rev.forfettario.used_pct}% di ${f(rev.forfettario.limit)}${rev.forfettario.warning ? ` — ${rev.forfettario.warning}` : ""}`,
    "",
    "## Crediti aperti a oggi",
    "",
    `- Da incassare: ${f(rec.total_outstanding)}, di cui scaduti ${f(rec.total_overdue)}`,
    "",
  ];
  if (tax) {
    const s = tax.year_summary;
    lines.push(
      "## Stima imposta e contributi (da verificare)",
      "",
      `- Reddito lordo: ${f(s.gross_income)}`,
      `- Contributi dovuti: ${f(s.contributions_due)}; versati nell'anno (deducibili): ${f(s.contributions_paid_in_year)}`,
      `- Imponibile: ${f(s.taxable_income)}; imposta sostitutiva: ${f(s.tax_due)}`,
      `- Acconti d'imposta: ${f(s.tax_advances[0] + s.tax_advances[1])}; saldo stimato: ${f(s.tax_balance)}`,
      "",
    );
  }
  lines.push(
    "## Controlli",
    "",
    `- Fatture elettroniche non inviate: ${aud.einvoice_not_sent.length}`,
    `- Fatture scartate o rifiutate: ${aud.einvoice_problems.length}`,
    `- Bollo mancante: ${aud.missing_stamp_duty.length}`,
    `- Buchi di numerazione: ${aud.numbering.gaps.map((g) => `${g.series}: ${g.missing.join(", ")}`).join("; ") || "nessuno"}`,
    "",
    "## Contenuto",
    "",
    `- \`fatture.csv\`: ${counts.documents} documenti emessi`,
    `- \`incassi.csv\`: incassi dell'anno per data`,
    `- \`crediti_aperti.csv\``,
    `- \`spese.csv\`: ${counts.expenses} documenti ricevuti`,
    `- \`pdf/\`: ${counts.pdf} PDF`,
    `- \`xml/\`: ${counts.xml} XML FatturaPA`,
    ...(counts.errors.length ? ["", "## File non scaricati", "", ...counts.errors.map((e: string) => `- ${e}`)] : []),
    "",
  );
  return lines.join("\n");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_");

export async function buildAccountantPackage(
  c: FicClient,
  opts: { year: number; output_dir?: string; include_pdf?: boolean; include_xml?: boolean; profile?: TaxProfile | null },
) {
  const { year } = opts;
  const today = todayISO();
  const docs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${year}-01-01' and date <= '${year}-12-31'`);
  // invoices of the previous year collected this year matter for the cash view
  const prevDocs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${year - 1}-01-01' and date <= '${year - 1}-12-31'`);
  const expenses = await c.listAll("/received_documents", { type: "expense", q: `date >= '${year}-01-01' and date <= '${year}-12-31'`, fieldset: "detailed" }, 3000).catch(() => []);

  const files: Record<string, Uint8Array> = {};
  const errors: string[] = [];
  files["fatture.csv"] = strToU8(invoicesCsv(docs));
  files["incassi.csv"] = strToU8(collectionsCsv([...prevDocs, ...docs], year));
  const rec = receivables(docs, today);
  files["crediti_aperti.csv"] = strToU8(
    toCsv(["Documento", "Cliente", "Scadenza", "Importo", "Giorni di ritardo"], rec.rows.map((r) => [r.document, r.client, r.due_date, eur(r.amount), r.days_overdue])),
  );
  files["spese.csv"] = strToU8(expensesCsv(expenses));

  let pdf = 0;
  let xml = 0;
  await mapLimit(docs, 4, async (d) => {
    const base = safe(`${year}-${d.type === "credit_note" ? "NC" : "FT"}-${String(d.number ?? d.id).padStart(3, "0")}${d.numeration ?? ""}-${d.entity?.name ?? ""}`);
    if (opts.include_pdf !== false && d.url) {
      try {
        files[`pdf/${base}.pdf`] = await c.download(d.url);
        pdf++;
      } catch (e: any) {
        errors.push(`PDF ${docNumber(d)}: ${e.message}`);
      }
    }
    if (opts.include_xml !== false && d.e_invoice) {
      try {
        const x = await c.get(`/issued_documents/${d.id}/e_invoice/xml`);
        files[`xml/${base}.xml`] = strToU8(typeof x === "string" ? x : JSON.stringify(x));
        xml++;
      } catch (e: any) {
        errors.push(`XML ${docNumber(d)}: ${e.message}`);
      }
    }
  });

  const rev = revenueSummary([...prevDocs, ...docs], year, today);
  const aud = audit(docs, today, { check_stamp_duty: true });
  const tax = opts.profile ? await estimateTaxes(c, opts.profile, year, { projection: "to_date", today }).catch(() => null) : null;
  files["riepilogo.md"] = strToU8(summaryMarkdown(year, rev, aud, rec, tax, { documents: docs.length, expenses: expenses.length, pdf, xml, errors }));

  const dir = (opts.output_dir ?? path.join(os.homedir(), "Downloads")).replace(/^~(?=\/)/, os.homedir());
  await fs.mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, `commercialista-${year}.zip`);
  const prefixed = Object.fromEntries(Object.entries(files).map(([k, v]) => [`commercialista-${year}/${k}`, v]));
  await fs.writeFile(zipPath, zipSync(prefixed, { level: 6 }));
  return { zip: zipPath, documents: docs.length, expenses: expenses.length, pdf, xml, errors };
}

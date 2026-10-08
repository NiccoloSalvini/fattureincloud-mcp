/**
 * Pure analytics over issued documents: receivables, revenue (with the
 * regime forfettario threshold) and consistency checks.
 */
import type { IssuedDocument, Json } from "./client.js";
import { daysBetween } from "./copy.js";

/** Soglia di ricavi/compensi del regime forfettario (L. 197/2022, dal 2023). */
export const FORFETTARIO_LIMIT = 85_000;
/** Sopra questa soglia si esce dal forfettario nell'anno stesso. */
export const FORFETTARIO_HARD_LIMIT = 100_000;
/** Imposta di bollo dovuta su fatture senza IVA sopra 77,47 €. */
export const STAMP_DUTY_THRESHOLD = 77.47;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeDocument(d: IssuedDocument) {
  const unpaid = (d.payments_list ?? []).filter((p) => p.status === "not_paid");
  return {
    id: d.id,
    type: d.type,
    number: d.number,
    numeration: d.numeration || undefined,
    date: d.date,
    client: d.entity?.name,
    client_id: d.entity?.id ?? undefined,
    subject: d.subject || d.visible_subject || undefined,
    amount_net: d.amount_net,
    amount_gross: d.amount_gross,
    stamp_duty: d.stamp_duty || undefined,
    e_invoice: d.e_invoice || undefined,
    ei_status: d.ei_status ?? undefined,
    next_due_date: d.next_due_date ?? undefined,
    unpaid_amount: d.payments_list ? round2(unpaid.reduce((s, p) => s + (p.amount ?? 0), 0)) : undefined,
  };
}

function docLabel(d: IssuedDocument) {
  return `${d.number ?? "?"}${d.numeration ?? ""} del ${d.date}`;
}

// ---- Crediti ---------------------------------------------------------------

export interface ReceivableRow {
  document_id: number;
  document: string;
  client: string;
  client_id?: number;
  due_date: string;
  amount: number;
  days_overdue: number;
}

export function receivables(docs: IssuedDocument[], today: string) {
  const rows: ReceivableRow[] = [];
  for (const d of docs) {
    if (d.type === "credit_note") continue;
    for (const p of d.payments_list ?? []) {
      if (p.status !== "not_paid") continue;
      const due = p.due_date ?? d.date ?? today;
      rows.push({
        document_id: d.id!,
        document: docLabel(d),
        client: d.entity?.name ?? "?",
        client_id: d.entity?.id ?? undefined,
        due_date: due,
        amount: round2(p.amount ?? 0),
        days_overdue: Math.max(0, daysBetween(due, today)),
      });
    }
  }
  rows.sort((a, b) => a.due_date.localeCompare(b.due_date));

  const buckets = { non_scaduto: 0, "1-30": 0, "31-60": 0, "61-90": 0, oltre_90: 0 };
  const byClient = new Map<string, { client: string; client_id?: number; total: number; overdue: number; documents: number }>();
  for (const r of rows) {
    const k = r.days_overdue === 0 ? "non_scaduto" : r.days_overdue <= 30 ? "1-30" : r.days_overdue <= 60 ? "31-60" : r.days_overdue <= 90 ? "61-90" : "oltre_90";
    buckets[k] = round2(buckets[k] + r.amount);
    const key = String(r.client_id ?? r.client);
    const c = byClient.get(key) ?? { client: r.client, client_id: r.client_id, total: 0, overdue: 0, documents: 0 };
    c.total = round2(c.total + r.amount);
    if (r.days_overdue > 0) c.overdue = round2(c.overdue + r.amount);
    c.documents++;
    byClient.set(key, c);
  }
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const overdue = round2(rows.filter((r) => r.days_overdue > 0).reduce((s, r) => s + r.amount, 0));
  return {
    today,
    total_outstanding: total,
    total_overdue: overdue,
    aging: buckets,
    by_client: [...byClient.values()].sort((a, b) => b.total - a.total),
    rows,
  };
}

// ---- Ricavi ----------------------------------------------------------------

/**
 * Revenue for a calendar year.
 * - `issued`: competenza, by document date (credit notes subtract).
 * - `collected`: cassa, by paid_date of each payment — the basis of the
 *   forfettario threshold. Net share estimated as amount × net/gross.
 */
export function revenueSummary(docs: IssuedDocument[], year: number, today: string, limit = FORFETTARIO_LIMIT) {
  const y = String(year);
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, issued_net: 0, collected_net: 0 }));
  const byClient = new Map<string, { client: string; issued_net: number; collected_net: number }>();
  let issuedNet = 0;
  let issuedGross = 0;
  let collectedNet = 0;
  let collectedGross = 0;
  let stampDuty = 0;

  for (const d of docs) {
    const sign = d.type === "credit_note" ? -1 : 1;
    const net = (d.amount_net ?? 0) * sign;
    const gross = (d.amount_gross ?? 0) * sign;
    const client = d.entity?.name ?? "?";
    const c = byClient.get(client) ?? { client, issued_net: 0, collected_net: 0 };
    if (d.date?.startsWith(y)) {
      issuedNet += net;
      issuedGross += gross;
      stampDuty += (d.stamp_duty ?? 0) * sign;
      months[Number(d.date.slice(5, 7)) - 1].issued_net += net;
      c.issued_net += net;
    }
    const ratio = d.amount_gross ? (d.amount_net ?? 0) / d.amount_gross : 1;
    for (const p of d.payments_list ?? []) {
      if (p.status !== "paid" || !p.paid_date?.startsWith(y)) continue;
      const amt = (p.amount ?? 0) * sign;
      collectedGross += amt;
      collectedNet += amt * ratio;
      months[Number(p.paid_date.slice(5, 7)) - 1].collected_net += amt * ratio;
      c.collected_net += amt * ratio;
    }
    byClient.set(client, c);
  }

  const dayOfYear = today.startsWith(y) ? daysBetween(`${y}-01-01`, today) + 1 : 365;
  const projection = dayOfYear < 365 ? (collectedNet / dayOfYear) * 365 : collectedNet;
  return {
    year,
    issued: { net: round2(issuedNet), gross: round2(issuedGross), stamp_duty: round2(stampDuty) },
    collected: { net_estimate: round2(collectedNet), gross: round2(collectedGross) },
    forfettario: {
      limit,
      hard_limit: FORFETTARIO_HARD_LIMIT,
      used_pct: round2((collectedNet / limit) * 100),
      remaining: round2(limit - collectedNet),
      projected_year_end: round2(projection),
      warning:
        collectedNet > FORFETTARIO_HARD_LIMIT
          ? "Superati i 100.000 €: uscita immediata dal forfettario, IVA dovuta dall'operazione che ha superato la soglia."
          : collectedNet > limit
            ? "Superati gli 85.000 €: dal prossimo anno regime ordinario."
            : projection > limit
              ? "Al ritmo attuale supererai gli 85.000 € entro fine anno."
              : null,
    },
    by_month: months.map((m) => ({ ...m, issued_net: round2(m.issued_net), collected_net: round2(m.collected_net) })),
    by_client: [...byClient.values()]
      .map((c) => ({ ...c, issued_net: round2(c.issued_net), collected_net: round2(c.collected_net) }))
      .filter((c) => c.issued_net || c.collected_net)
      .sort((a, b) => b.issued_net - a.issued_net),
  };
}

// ---- Controlli -------------------------------------------------------------

const EI_TO_SEND = new Set([null, undefined, "not_sent", "missing"]);
const EI_PROBLEMS = new Set(["error", "discarded", "not_delivered", "rejected", "manual_rejected", "no_response"]);

/** True when a document carries no VAT at all (forfettario, esente, fuori campo). */
export function hasNoVat(d: IssuedDocument): boolean {
  if (typeof d.amount_vat === "number") return d.amount_vat === 0;
  return (d.items_list ?? []).every((it) => !it.vat?.value);
}

export function missingStampDuty(d: IssuedDocument): boolean {
  if (d.type === "credit_note" || d.type === "quote" || d.type === "order") return false;
  return hasNoVat(d) && (d.amount_net ?? 0) > STAMP_DUTY_THRESHOLD && !d.stamp_duty;
}

export function numberingIssues(docs: IssuedDocument[]) {
  const groups = new Map<string, IssuedDocument[]>();
  for (const d of docs) {
    if (d.number == null || !d.date) continue;
    const key = `${d.type}|${d.numeration ?? ""}|${d.date.slice(0, 4)}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const gaps: { series: string; missing: number[] }[] = [];
  const duplicates: { series: string; number: number; ids: number[] }[] = [];
  const outOfOrder: { series: string; document: string; previous: string }[] = [];
  for (const [key, list] of groups) {
    const [type, numeration, year] = key.split("|");
    const series = `${type} ${numeration || "(senza sezionale)"} ${year}`;
    list.sort((a, b) => a.number! - b.number!);
    const missing: number[] = [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.number === prev.number) duplicates.push({ series, number: cur.number!, ids: [prev.id!, cur.id!] });
      for (let n = prev.number! + 1; n < cur.number!; n++) missing.push(n);
      if (cur.date! < prev.date!) outOfOrder.push({ series, document: docLabel(cur), previous: docLabel(prev) });
    }
    if (missing.length) gaps.push({ series, missing });
  }
  return { gaps, duplicates, out_of_order: outOfOrder };
}

export function audit(docs: IssuedDocument[], today: string, opts: { check_stamp_duty: boolean }) {
  const pick = (d: IssuedDocument) => ({ id: d.id, document: docLabel(d), client: d.entity?.name, amount_gross: d.amount_gross });
  const eInvoices = docs.filter((d) => d.e_invoice);
  const rec = receivables(docs, today);
  const findings = {
    einvoice_not_sent: eInvoices.filter((d) => EI_TO_SEND.has(d.ei_status)).map(pick),
    einvoice_problems: eInvoices.filter((d) => EI_PROBLEMS.has(d.ei_status)).map((d) => ({ ...pick(d), ei_status: d.ei_status })),
    missing_stamp_duty: opts.check_stamp_duty ? docs.filter(missingStampDuty).map(pick) : [],
    overdue_payments: rec.rows.filter((r) => r.days_overdue > 0),
    numbering: numberingIssues(docs.filter((d) => d.type === "invoice" || d.type === "credit_note")),
  };
  const count =
    findings.einvoice_not_sent.length +
    findings.einvoice_problems.length +
    findings.missing_stamp_duty.length +
    findings.overdue_payments.length +
    findings.numbering.gaps.length +
    findings.numbering.duplicates.length +
    findings.numbering.out_of_order.length;
  return { checked_documents: docs.length, issues: count, ...findings };
}

export function clientStatement(docs: IssuedDocument[], today: string) {
  const sorted = [...docs].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  let billed = 0;
  let paid = 0;
  const rows = sorted.map((d) => {
    const sign = d.type === "credit_note" ? -1 : 1;
    const gross = (d.amount_gross ?? 0) * sign;
    const paidHere = (d.payments_list ?? []).filter((p: Json) => p.status === "paid").reduce((s: number, p: Json) => s + (p.amount ?? 0), 0) * sign;
    billed += gross;
    paid += paidHere;
    return { ...summarizeDocument(d), paid: round2(paidHere), balance: round2(gross - paidHere) };
  });
  const rec = receivables(docs, today);
  return {
    billed: round2(billed),
    paid: round2(paid),
    outstanding: round2(billed - paid),
    overdue: rec.total_overdue,
    documents: rows,
  };
}

/**
 * Ricavi incassati per anno di incasso (principio di cassa), al netto dell'IVA:
 * ogni rata saldata pesa amount × (lordo − IVA) / lordo; le note di credito sottraggono.
 * Per un forfettario coincide con l'incassato (bollo e rivalsa INPS addebitati inclusi).
 */
export function collectedByYear(docs: IssuedDocument[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const d of docs) {
    const sign = d.type === "credit_note" ? -1 : 1;
    const gross = d.amount_gross ?? 0;
    const ratio = gross ? (gross - (d.amount_vat ?? 0)) / gross : 1;
    for (const p of d.payments_list ?? []) {
      if (p.status !== "paid" || !p.paid_date) continue;
      const y = Number(p.paid_date.slice(0, 4));
      out[y] = (out[y] ?? 0) + (p.amount ?? 0) * ratio * sign;
    }
  }
  for (const y of Object.keys(out)) out[+y] = round2(out[+y]);
  return out;
}

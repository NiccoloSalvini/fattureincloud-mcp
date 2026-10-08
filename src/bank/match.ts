/**
 * Matches incoming bank transfers to open invoice installments.
 *
 * Score (0–100+):
 *   amount equal to the installment (or to the whole open balance)   +50
 *   amount off by ≤ 2 € (bollo or bank fees not paid)                  +30
 *   invoice number in the description (FT 26, fattura n. 26, 26/2026)  +30
 *   VAT number or tax code of the client in the description            +30
 *   client name tokens in the description                              up to +25
 *   payment dated before the invoice                                   −40
 * Confidence: high ≥ 75, medium ≥ 60, low otherwise (amount only).
 * Assignment is greedy on score, one transfer ↔ one installment set.
 */
import type { IssuedDocument } from "../client.js";
import { daysBetween } from "../copy.js";
import type { BankTransaction } from "./parse.js";

export interface OpenItem {
  document_id: number;
  document: string;
  number: number | null;
  date: string;
  client: string;
  vat_number?: string;
  tax_code?: string;
  /** Installment indexes in payments_list covered by this item. */
  installments: number[];
  amount: number;
  due_date: string;
}

export type Confidence = "high" | "medium" | "low";

export interface MatchProposal {
  transaction: BankTransaction;
  item: OpenItem;
  score: number;
  confidence: Confidence;
  reasons: string[];
}

const LEGAL = new Set(["srl", "srls", "spa", "sas", "snc", "sapa", "ss", "scarl", "scrl", "ltd", "llc", "gmbh", "inc", "sa", "sl", "bv", "di", "e", "and", "the", "del", "della", "dei", "studio", "societa", "company", "co"]);

export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/s\.r\.l\.?|s\.p\.a\.?|s\.a\.s\.?|s\.n\.c\.?/g, (m) => m.replace(/\./g, ""))
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

export function nameTokens(name: string): string[] {
  return [...new Set(normalizeText(name).split(" ").filter((t) => t.length >= 3 && !LEGAL.has(t) && !/^\d+$/.test(t)))];
}

export function mentionsInvoiceNumber(desc: string, number: number | null, date: string): boolean {
  if (number == null) return false;
  const n = String(number);
  const yyyy = date.slice(0, 4);
  const yy = date.slice(2, 4);
  const d = normalizeText(desc);
  const patterns = [
    new RegExp(`\\b(fatt\\w*|fattura|ft|fat|fatt n|fattura n|nr|n|num|numero|invoice|inv|doc)\\s*0*${n}\\b`),
    new RegExp(`\\b0*${n}\\s*/\\s*(${yyyy}|${yy})\\b`),
    new RegExp(`\\b(${yyyy}|${yy})\\s*/\\s*0*${n}\\b`),
  ];
  return patterns.some((p) => p.test(d));
}

/** Open items: each unpaid installment, plus the whole open balance when there are several. */
export function openItems(docs: IssuedDocument[]): OpenItem[] {
  const out: OpenItem[] = [];
  for (const d of docs) {
    if (d.type === "credit_note" || !d.id) continue;
    const base = {
      document_id: d.id,
      document: `${d.number ?? "?"}${d.numeration ?? ""} del ${d.date}`,
      number: d.number ?? null,
      date: d.date ?? "",
      client: d.entity?.name ?? "",
      vat_number: d.entity?.vat_number?.replace(/^IT/i, "") || undefined,
      tax_code: d.entity?.tax_code || undefined,
    };
    const open = (d.payments_list ?? []).map((p, i) => ({ p, i })).filter(({ p }) => p.status === "not_paid");
    for (const { p, i } of open) out.push({ ...base, installments: [i], amount: p.amount ?? 0, due_date: p.due_date ?? base.date });
    if (open.length > 1) {
      out.push({
        ...base,
        installments: open.map((o) => o.i),
        amount: Math.round(open.reduce((s, o) => s + (o.p.amount ?? 0), 0) * 100) / 100,
        due_date: open[0].p.due_date ?? base.date,
      });
    }
  }
  return out;
}

export function scoreMatch(tx: BankTransaction, item: OpenItem): { score: number; reasons: string[] } | null {
  const diff = Math.round((tx.amount - item.amount) * 100) / 100;
  const reasons: string[] = [];
  let score = 0;
  if (Math.abs(diff) < 0.01) {
    score += 50;
    reasons.push("importo esatto");
  } else if (diff < 0 && diff >= -2.01) {
    score += 30;
    reasons.push(`importo inferiore di ${Math.abs(diff).toFixed(2)} € (bollo o commissioni?)`);
  } else {
    return null;
  }

  const desc = `${tx.description} ${tx.counterparty ?? ""}`;
  const norm = normalizeText(desc);
  if (mentionsInvoiceNumber(desc, item.number, item.date)) {
    score += 30;
    reasons.push(`numero fattura ${item.number} nella causale`);
  }
  const compact = norm.replace(/\s/g, "");
  if ((item.vat_number && compact.includes(item.vat_number.toLowerCase())) || (item.tax_code && compact.includes(item.tax_code.toLowerCase()))) {
    score += 30;
    reasons.push("P.IVA o codice fiscale del cliente nella causale");
  }
  const tokens = nameTokens(item.client);
  if (tokens.length) {
    const words = new Set(norm.split(" "));
    const hit = tokens.filter((t) => words.has(t) || (t.length >= 5 && norm.includes(t)));
    if (hit.length) {
      score += Math.round((25 * hit.length) / tokens.length);
      reasons.push(`nome cliente (${hit.join(", ")})`);
    }
  }
  if (item.date && tx.date < item.date && daysBetween(tx.date, item.date) > 3) {
    score -= 40;
    reasons.push("pagamento precedente alla fattura");
  }
  return { score, reasons };
}

/** Below this a candidate is not proposed at all (e.g. amount only, but paid before the invoice). */
const MIN_SCORE = 40;

export function confidenceOf(score: number): Confidence {
  return score >= 75 ? "high" : score >= 60 ? "medium" : "low";
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const atLeast = (c: Confidence, min: Confidence) => RANK[c] >= RANK[min];

export function reconcile(transactions: BankTransaction[], items: OpenItem[]) {
  const credits = transactions.filter((t) => t.amount > 0);
  const pairs: { t: number; i: number; score: number; reasons: string[] }[] = [];
  credits.forEach((tx, t) =>
    items.forEach((item, i) => {
      const s = scoreMatch(tx, item);
      if (s && s.score >= MIN_SCORE) pairs.push({ t, i, ...s });
    }),
  );
  // best first; on ties prefer the oldest due date
  pairs.sort((a, b) => b.score - a.score || items[a.i].due_date.localeCompare(items[b.i].due_date));

  const usedTx = new Set<number>();
  const usedInst = new Set<string>();
  const matches: MatchProposal[] = [];
  for (const p of pairs) {
    if (usedTx.has(p.t)) continue;
    const item = items[p.i];
    const keys = item.installments.map((k) => `${item.document_id}:${k}`);
    if (keys.some((k) => usedInst.has(k))) continue;
    let confidence = confidenceOf(p.score);
    const reasons = [...p.reasons];
    // another unused candidate with the same score → ambiguous
    const free = (q: (typeof pairs)[number]) => !items[q.i].installments.some((k) => usedInst.has(`${items[q.i].document_id}:${k}`));
    const rival = pairs.find((q) => q !== p && q.t === p.t && q.score === p.score && items[q.i].document_id !== item.document_id && free(q));
    if (rival && confidence === "high") {
      confidence = "medium";
      reasons.push(`ambiguo: anche ${items[rival.i].document} ha lo stesso punteggio`);
    }
    usedTx.add(p.t);
    keys.forEach((k) => usedInst.add(k));
    matches.push({ transaction: credits[p.t], item, score: p.score, confidence, reasons });
  }

  matches.sort((a, b) => a.transaction.date.localeCompare(b.transaction.date));
  return {
    matches,
    unmatched_credits: credits.filter((_, t) => !usedTx.has(t)),
    still_open: items.filter((it) => it.installments.length === 1 && !usedInst.has(`${it.document_id}:${it.installments[0]}`)),
  };
}

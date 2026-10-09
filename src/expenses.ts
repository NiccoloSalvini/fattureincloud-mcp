/**
 * Pure logic over purchase invoices (received documents): turning a pending
 * SdI document into a received document, heuristic expense categories and
 * recurring-supplier detection.
 */
import type { Json } from "./client.js";
import { addDays, daysBetween, parseISODate, toISODate } from "./copy.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- Fornitori ---------------------------------------------------------------

/** "IT 01234567890" → "01234567890"; empty values → undefined. */
export function normalizeVat(vat: string | null | undefined): string | undefined {
  const v = (vat ?? "").replace(/[\s.-]/g, "").toUpperCase().replace(/^IT(?=\d{11}$)/, "");
  return v || undefined;
}

const LEGAL_FORMS = /\b(s\.?\s?r\.?\s?l\.?s?|s\.?\s?p\.?\s?a\.?|s\.?\s?a\.?\s?s\.?|s\.?\s?n\.?\s?c\.?|soc(ietà)?\.?\s?coop(erativa)?|unipersonale|ltd|limited|inc|gmbh|llc|b\.?v\.?|s\.?a\.?r\.?l\.?|italia|italy)\b\.?/g;

/** Lowercase name without legal form and punctuation, for matching the same supplier. */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(LEGAL_FORMS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Supplier of a received or pending document (pending ones may only carry supplier_name). */
export function supplierOf(d: Json): { name?: string; vat_number?: string } {
  return {
    name: d.entity?.name ?? d.supplier_name ?? undefined,
    vat_number: normalizeVat(d.entity?.vat_number ?? d.supplier_vat_number),
  };
}

function supplierKey(d: Json): string {
  const s = supplierOf(d);
  return s.vat_number ? `vat:${s.vat_number}` : `name:${normalizeName(s.name)}`;
}

// ---- Da documento in attesa a spesa -------------------------------------------

export interface RegisterOptions {
  category?: string | null;
  paid?: boolean;
  paid_date?: string;
  payment_account_id?: number;
}

/**
 * Invoice date of a pending document. Live API: `date` is the reception
 * timestamp ("2026-07-22 00:11:45") and `emission_date` the invoice date
 * (the spec spells it `emssion_date`).
 */
export function pendingDate(p: Json): string | undefined {
  const d: string | undefined = p.emission_date ?? p.emssion_date ?? p.date ?? undefined;
  return d?.slice(0, 10);
}

/** Gross total of a pending document; some imports leave it empty. */
export function pendingGross(p: Json): number {
  if (typeof p.amount_gross === "number") return round2(p.amount_gross);
  return round2((p.amount_net ?? 0) + (p.amount_vat ?? 0));
}

/**
 * Builds the `data` of POST /received_documents from a pending document.
 * The API rejects a received document whose payments_list does not cover
 * amount_gross, so installments are reused only when they add up to the total;
 * otherwise there is a single installment. Rounding goes on the last one.
 */
export function receivedFromPending(p: Json, opts: RegisterOptions = {}): Json {
  const gross = pendingGross(p);
  const date = pendingDate(p);
  const source = (p.payments_list ?? []).filter((x: Json) => (x.amount ?? 0) > 0);
  const sourceTotal = round2(source.reduce((s: number, x: Json) => s + x.amount, 0));
  const installments: Json[] =
    source.length && Math.abs(sourceTotal - gross) <= 0.01
      ? source.map((x: Json) => ({ ...x }))
      : [{ amount: gross, due_date: source[0]?.due_date ?? p.next_due_date ?? date }];
  const allButLast = installments.slice(0, -1).reduce((s, x) => s + x.amount, 0);
  installments[installments.length - 1].amount = round2(gross - allButLast);

  const payments_list = installments.map((x) => {
    const due = x.due_date ?? date;
    const account = opts.payment_account_id ?? x.payment_account?.id;
    const paid = opts.paid || (x.status === "paid" && !!x.paid_date);
    return clean({
      amount: round2(x.amount),
      due_date: due,
      status: paid ? "paid" : "not_paid",
      paid_date: paid ? (opts.paid ? (opts.paid_date ?? x.paid_date ?? due) : x.paid_date) : undefined,
      payment_account: account ? { id: account } : undefined,
    });
  });

  const s = supplierOf(p);
  const entity = p.entity?.id
    ? { id: p.entity.id, name: p.entity.name ?? s.name }
    : clean({ name: s.name, vat_number: p.entity?.vat_number ?? undefined, tax_code: p.entity?.tax_code ?? undefined });

  return clean({
    type: p.document_type ?? "expense",
    entity,
    date,
    // the live API returns "" for a missing category
    category: opts.category || p.category || undefined,
    description: p.subject ?? p.description ?? undefined,
    invoice_number: p.ei_number || p.invoice_number || undefined,
    amount_net: p.amount_net ?? round2(gross - (p.amount_vat ?? 0)),
    amount_vat: p.amount_vat ?? round2(gross - (p.amount_net ?? gross)),
    currency: p.currency?.id ? { id: p.currency.id } : undefined,
    rc_center: p.cost_center || undefined,
    payments_list,
  });
}

function clean<T extends Json>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null) delete o[k];
  return o;
}

// ---- Categorie ----------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";

export interface CategorySuggestion {
  category: string | null;
  /** True when the category already exists in Fatture in Cloud. */
  existing: boolean;
  confidence: Confidence;
  source: "storico" | "regola" | "nessuna";
  reason: string;
}

interface Rule {
  category: string;
  pattern: RegExp;
  confidence: Confidence;
  /** Default Fatture in Cloud categories to use when the account has them. */
  aliases?: string[];
}

/**
 * Keyword rules on supplier name and description, first match wins: order
 * matters (Eni Plenitude is energy before Eni is fuel, AWS is cloud before
 * Amazon is shopping).
 */
export const CATEGORY_RULES: Rule[] = [
  { category: "Utenze", pattern: /\b(energia|energie|luce|gas|elettric\w*|plenitude|enel|a2a|hera|iren|edison|acea|sorgenia|engie|illumia|octopus|acquedott\w*|servizio idrico)\b/, confidence: "medium", aliases: ["Servizi ed edifici"] },
  { category: "Telefono e internet", pattern: /\b(telefon\w*|tim|telecom|vodafone|iliad|fastweb|wind\s?tre|windtre|tiscali|eolo|kena|ho mobile|very mobile|postemobile|fibra|connettivita)\b/, confidence: "medium" },
  { category: "Software e servizi cloud", pattern: /\b(aruba|google|aws|amazon web services|microsoft|adobe|github|openai|anthropic|teamsystem|fatture in cloud|register it|hetzner|ovh|dropbox|notion|slack|zoom|atlassian|jetbrains|vercel|digitalocean|cloudflare|figma|canva|apple|hosting|dominio|abbonamento software|saas)\b/, confidence: "medium", aliases: ["Server e hosting", "Servizi aziendali"] },
  { category: "Carburante", pattern: /\b(carburant\w*|benzina|gasolio|diesel|eni|agip|q8|esso|tamoil|italiana petroli|shell|rifornimento)\b/, confidence: "medium", aliases: ["Auto ed altri veicoli"] },
  { category: "Assicurazioni", pattern: /\b(assicura\w*|polizza|generali|allianz|unipol\w*|axa|zurich|reale mutua)\b/, confidence: "medium", aliases: ["Assicurazioni e quote"] },
  { category: "Affitti", pattern: /\b(affitto|affitti|locazione|canone di locazione|coworking)\b/, confidence: "medium", aliases: ["Servizi ed edifici"] },
  { category: "Consulenze", pattern: /\b(commercialist\w*|consulen\w*|avvocat\w*|notai\w*)\b/, confidence: "medium", aliases: ["Spese legali e contabili"] },
  { category: "Consulenze", pattern: /\bstudio\b/, confidence: "low", aliases: ["Spese legali e contabili"] },
  { category: "Acquisti", pattern: /\b(amazon|ebay|mediaworld|unieuro|ikea|euronics)\b/, confidence: "low" },
];

/** Past categories per supplier, from received documents already registered. */
export type SupplierHistory = Map<string, { name: string; counts: Map<string, number>; total: number }>;

export function buildSupplierHistory(received: Json[]): SupplierHistory {
  const h: SupplierHistory = new Map();
  for (const d of received) {
    if (!d.category) continue;
    const s = supplierOf(d);
    // indexed both by VAT number and by name, so either can match later
    const keys = [s.vat_number ? `vat:${s.vat_number}` : null, s.name ? `name:${normalizeName(s.name)}` : null].filter(Boolean) as string[];
    for (const k of keys) {
      const e = h.get(k) ?? { name: s.name ?? "?", counts: new Map(), total: 0 };
      e.counts.set(d.category, (e.counts.get(d.category) ?? 0) + 1);
      e.total++;
      h.set(k, e);
    }
  }
  return h;
}

/**
 * Maps a suggested label onto an existing category: same name, one of the
 * aliases, or a shared word stem ("Telefono e internet" → "Telefonia").
 */
export function matchExisting(suggested: string, available: string[], aliases: string[] = []): string | undefined {
  const norm = (s: string) => normalizeName(s);
  for (const name of [suggested, ...aliases]) {
    const exact = available.find((a) => norm(a) === norm(name));
    if (exact) return exact;
  }
  const stem = norm(suggested).split(" ")[0].slice(0, 5);
  if (stem.length < 4) return undefined;
  return available.find((a) => norm(a).split(" ").some((w) => w.startsWith(stem)));
}

export function suggestCategory(doc: Json, history: SupplierHistory, available: string[] = []): CategorySuggestion {
  const s = supplierOf(doc);
  const finish = (category: string, confidence: Confidence, source: CategorySuggestion["source"], reason: string, aliases?: string[]): CategorySuggestion => {
    const match = matchExisting(category, available, aliases);
    return { category: match ?? category, existing: !!match, confidence, source, reason };
  };

  const byVat = s.vat_number ? history.get(`vat:${s.vat_number}`) : undefined;
  const byName = s.name ? history.get(`name:${normalizeName(s.name)}`) : undefined;
  const past = byVat ?? byName;
  if (past) {
    const [category, n] = [...past.counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = n / past.total;
    const how = byVat ? `stessa P.IVA (${s.vat_number})` : `stesso nome (${past.name})`;
    const confidence: Confidence = share >= 0.67 && (byVat || past.total >= 2) ? "high" : "medium";
    return finish(category, confidence, "storico", `Usata in ${n} su ${past.total} spese precedenti dello stesso fornitore, ${how}`);
  }

  const text = normalizeName(`${s.name ?? ""} ${doc.subject ?? doc.description ?? ""}`);
  for (const r of CATEGORY_RULES) {
    const m = text.match(r.pattern);
    if (m) return finish(r.category, r.confidence, "regola", `Parola chiave «${m[0]}» nel fornitore o nella descrizione`, r.aliases);
  }
  return { category: null, existing: false, confidence: "low", source: "nessuna", reason: "Nessuno storico per il fornitore e nessuna parola chiave riconosciuta" };
}

// ---- Spese ricorrenti ------------------------------------------------------------

const CADENCES = [
  { months: 1, label: "mensile", min: 20, max: 40 },
  { months: 2, label: "bimestrale", min: 50, max: 70 },
  { months: 3, label: "trimestrale", min: 75, max: 105 },
  { months: 6, label: "semestrale", min: 160, max: 200 },
  { months: 12, label: "annuale", min: 330, max: 400 },
] as const;

/** Same day N months later, clamped to the end of the month (31 Jan + 1 → 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = parseISODate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toISODate(d);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface RecurringExpense {
  supplier: string;
  vat_number?: string;
  category?: string;
  cadence: string;
  occurrences: number;
  average_amount: number;
  average_net: number;
  last_date: string;
  last_amount: number;
  expected_next: string;
  /** Average × occurrences per year. */
  yearly_estimate: number;
  total_in_period: number;
  price_increase?: { last_amount: number; previous_average: number; pct: number };
  /** The expected document is more than 15 days late: contract ended or invoice not yet arrived. */
  late?: boolean;
}

/**
 * Recurring suppliers among received documents: at least `minOccurrences`
 * invoices (same supplier by VAT number, else by name) whose median interval
 * fits a cadence and where at least 2/3 of intervals are within ±35% of it.
 * Invoices of the same supplier on the same day count as one occurrence.
 * Credit notes are ignored.
 */
export function recurringExpenses(
  docs: Json[],
  opts: { today: string; minOccurrences?: number; increaseThreshold?: number },
) {
  const minOcc = opts.minOccurrences ?? 3;
  const threshold = opts.increaseThreshold ?? 0.1;
  const groups = new Map<string, Json[]>();
  for (const d of docs) {
    if (!d.date || (d.type && d.type !== "expense")) continue;
    const k = supplierKey(d);
    if (k === "name:") continue;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }

  const out: RecurringExpense[] = [];
  for (const list of groups.values()) {
    const byDate = new Map<string, { gross: number; net: number }>();
    for (const d of list) {
      const e = byDate.get(d.date) ?? { gross: 0, net: 0 };
      e.gross += d.amount_gross ?? 0;
      e.net += d.amount_net ?? 0;
      byDate.set(d.date, e);
    }
    const occ = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
    if (occ.length < minOcc) continue;
    const gaps = occ.slice(1).map((o, i) => daysBetween(occ[i].date, o.date));
    const med = median(gaps);
    const cadence = CADENCES.find((c) => med >= c.min && med <= c.max);
    if (!cadence) continue;
    const target = cadence.months * 30.44;
    const regular = gaps.filter((g) => Math.abs(g - target) <= target * 0.35).length;
    if (regular < (gaps.length * 2) / 3) continue;

    const amounts = occ.map((o) => o.gross);
    const avg = amounts.reduce((s, x) => s + x, 0) / amounts.length;
    const last = occ[occ.length - 1];
    const previous = amounts.slice(0, -1);
    const prevAvg = previous.reduce((s, x) => s + x, 0) / previous.length;
    const expected = addMonths(last.date, cadence.months);
    const categories = new Map<string, number>();
    for (const d of list) if (d.category) categories.set(d.category, (categories.get(d.category) ?? 0) + 1);
    const s = supplierOf(list[list.length - 1]);

    out.push({
      supplier: s.name ?? "?",
      vat_number: s.vat_number,
      category: [...categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
      cadence: cadence.label,
      occurrences: occ.length,
      average_amount: round2(avg),
      average_net: round2(occ.reduce((s, o) => s + o.net, 0) / occ.length),
      last_date: last.date,
      last_amount: round2(last.gross),
      expected_next: expected,
      yearly_estimate: round2((avg * 12) / cadence.months),
      total_in_period: round2(amounts.reduce((s, x) => s + x, 0)),
      price_increase:
        prevAvg > 0 && last.gross > prevAvg * (1 + threshold)
          ? { last_amount: round2(last.gross), previous_average: round2(prevAvg), pct: round2(((last.gross - prevAvg) / prevAvg) * 100) }
          : undefined,
      late: addDays(expected, 15) < opts.today || undefined,
    });
  }
  out.sort((a, b) => b.yearly_estimate - a.yearly_estimate);
  const yearly = round2(out.reduce((s, r) => s + r.yearly_estimate, 0));
  return {
    today: opts.today,
    recurring_suppliers: out.length,
    yearly_estimate: yearly,
    monthly_equivalent: round2(yearly / 12),
    price_increases: out.filter((r) => r.price_increase).map((r) => ({ supplier: r.supplier, ...r.price_increase! })),
    late: out.filter((r) => r.late).map((r) => ({ supplier: r.supplier, expected_next: r.expected_next })),
    suppliers: out,
  };
}

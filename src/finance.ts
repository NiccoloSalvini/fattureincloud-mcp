/**
 * Data loading shared by taxes, cash-flow forecast and the accountant package.
 */
import type { FicClient, IssuedDocument } from "./client.js";
import { daysBetween } from "./copy.js";
import { collectedByYear } from "./reports.js";
import { todayISO } from "./schedules.js";
import { taxReport, type TaxProfile } from "./taxes.js";
import { stampDutyQuarters } from "./extras.js";

export async function fetchIssued(
  c: FicClient,
  types: string[],
  q: string,
  opts: { fieldset?: "basic" | "detailed"; limit?: number } = {},
): Promise<IssuedDocument[]> {
  const out: IssuedDocument[] = [];
  for (const type of types) {
    out.push(...(await c.listAll("/issued_documents", { type, q, fieldset: opts.fieldset ?? "detailed", sort: "date" }, opts.limit ?? 3000)));
  }
  return out;
}

export type Projection = "linear" | "to_date";

type Deadline = { date: string; total: number; items: { what: string; amount: number }[]; planned?: boolean };

/** Joins deadlines that fall on the same day into one F24. */
function mergeSameDate(list: Deadline[]): Deadline[] {
  const byDate = new Map<string, Deadline>();
  for (const d of list) {
    const cur = byDate.get(d.date);
    byDate.set(d.date, cur ? { date: d.date, total: Math.round((cur.total + d.total) * 100) / 100, items: [...cur.items, ...d.items] } : d);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Linear projection of `collected` (so far in `year`) to Dec 31. */
export function projectYear(collected: number, year: number, today: string): number {
  if (!today.startsWith(String(year))) return collected;
  const elapsed = daysBetween(`${year}-01-01`, today) + 1;
  return Math.round((collected / elapsed) * 365 * 100) / 100;
}

export async function estimateTaxes(
  c: FicClient,
  profile: TaxProfile,
  year: number,
  opts: { projection?: Projection; revenue_estimate?: number; today?: string } = {},
) {
  return (await estimateWithDocs(c, profile, year, opts)).report;
}

async function estimateWithDocs(
  c: FicClient,
  profile: TaxProfile,
  year: number,
  opts: { projection?: Projection; revenue_estimate?: number; today?: string } = {},
) {
  const today = opts.today ?? todayISO();
  const from = Math.max(profile.start_year ?? year - 3, year - 3);
  const docs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${from - 1}-01-01' and date <= '${year}-12-31'`);
  const revenue = collectedByYear(docs);
  const isCurrent = today.startsWith(String(year));
  let projected = opts.revenue_estimate;
  if (projected === undefined && isCurrent && (opts.projection ?? "linear") === "linear") projected = projectYear(revenue[year] ?? 0, year, today);
  const report = {
    revenue_by_year: revenue,
    collected_to_date: revenue[year] ?? 0,
    revenue_basis: opts.revenue_estimate !== undefined ? "stima fornita" : projected !== undefined ? "proiezione lineare a fine anno" : "incassi effettivi",
    ...taxReport(profile, revenue, year, { projected_revenue: projected }),
  };
  return { report, docs };
}

/**
 * Tax deadlines from today on, covering the current and the next tax year.
 * Next year's revenue is assumed equal to this year's projection.
 */
export async function upcomingTaxDeadlines(
  c: FicClient,
  profile: TaxProfile,
  opts: { today?: string; revenue_estimate?: number } = {},
) {
  const today = opts.today ?? todayISO();
  const y = Number(today.slice(0, 4));
  const { report: cur, docs } = await estimateWithDocs(c, profile, y, { today, revenue_estimate: opts.revenue_estimate });
  const projected = opts.revenue_estimate ?? projectYear(cur.collected_to_date, y, today);
  const revenues = { ...cur.revenue_by_year, [y]: projected, [y + 1]: projected };
  const next = taxReport(profile, revenues, y + 1);
  let deadlines: Deadline[] = [...cur.deadlines.filter((d) => d.date.startsWith(String(y))), ...next.deadlines].filter((d) => d.date >= today);
  // bollo virtuale: quarters of last year (Q4 due in February) and this year
  for (const yy of [y - 1, y]) {
    for (const q of stampDutyQuarters(docs, yy, today).quarters) {
      if (q.amount > 0 && q.deadline >= today) {
        const label = `Bollo fatture elettroniche ${q.quarter}° trimestre ${yy} (cod. ${q.code})${q.status === "in corso" ? ", parziale" : ""}`;
        deadlines.push({ date: q.deadline, total: q.amount, items: [{ what: label, amount: q.amount }] });
      }
    }
  }
  deadlines = mergeSameDate(deadlines);
  const planned = (profile.planned_payments ?? []).filter((p) => p.date >= today);
  if (planned.length) {
    deadlines = [
      ...deadlines,
      ...planned.map((p) => ({ date: p.date, total: p.amount, items: [{ what: p.label, amount: p.amount }], planned: true })),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }
  return { deadlines, current: cur, projected_revenue: projected };
}

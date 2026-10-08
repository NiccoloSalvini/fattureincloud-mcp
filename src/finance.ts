/**
 * Data loading shared by taxes, cash-flow forecast and the accountant package.
 */
import type { FicClient, IssuedDocument } from "./client.js";
import { daysBetween } from "./copy.js";
import { collectedByYear } from "./reports.js";
import { todayISO } from "./schedules.js";
import { taxReport, type TaxProfile } from "./taxes.js";

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
  const today = opts.today ?? todayISO();
  const from = Math.max(profile.start_year ?? year - 3, year - 3);
  const docs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${from - 1}-01-01' and date <= '${year}-12-31'`);
  const revenue = collectedByYear(docs);
  const isCurrent = today.startsWith(String(year));
  let projected = opts.revenue_estimate;
  if (projected === undefined && isCurrent && (opts.projection ?? "linear") === "linear") projected = projectYear(revenue[year] ?? 0, year, today);
  return {
    revenue_by_year: revenue,
    collected_to_date: revenue[year] ?? 0,
    revenue_basis: opts.revenue_estimate !== undefined ? "stima fornita" : projected !== undefined ? "proiezione lineare a fine anno" : "incassi effettivi",
    ...taxReport(profile, revenue, year, { projected_revenue: projected }),
  };
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
  const cur = await estimateTaxes(c, profile, y, { today, revenue_estimate: opts.revenue_estimate });
  const projected = opts.revenue_estimate ?? projectYear(cur.collected_to_date, y, today);
  const revenues = { ...cur.revenue_by_year, [y]: projected, [y + 1]: projected };
  const next = taxReport(profile, revenues, y + 1);
  const deadlines = [...cur.deadlines.filter((d) => d.date.startsWith(String(y))), ...next.deadlines].filter((d) => d.date >= today);
  return { deadlines, current: cur, projected_revenue: projected };
}

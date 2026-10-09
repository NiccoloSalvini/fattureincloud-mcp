import { describe, expect, it } from "vitest";
import { collectedByYear } from "../src/reports.js";
import { computeYears, taxAdvances, taxReport, type TaxProfile } from "../src/taxes.js";

const gs: TaxProfile = { coefficient: 0.78, tax_rate: 0.15, start_year: 2024, inps: { type: "gestione_separata", rate: 0.2607 } };

describe("taxAdvances", () => {
  it("follows the 51.65 / 257.52 thresholds and the 50/50 split", () => {
    expect(taxAdvances(50)).toEqual([0, 0]);
    expect(taxAdvances(200)).toEqual([0, 200]);
    expect(taxAdvances(1000)).toEqual([500, 500]);
  });
});

describe("computeYears, gestione separata", () => {
  // 2024: primo anno, 30.000 incassati; 2025: 40.000
  const years = computeYears(gs, { 2024: 30000, 2025: 40000 }, 2024, 2025);
  const y24 = years.get(2024)!;
  const y25 = years.get(2025)!;

  it("first year: no advances, nothing deductible, everything at balance", () => {
    expect(y24.gross_income).toBe(23400);
    expect(y24.contributions_due).toBe(6100.38); // 23400 × 26.07%
    expect(y24.contributions_paid_in_year).toBe(0);
    expect(y24.tax_due).toBe(3510); // 23400 × 15%
    expect(y24.tax_advances).toEqual([0, 0]);
    expect(y24.tax_balance).toBe(3510);
  });

  it("second year: deducts the balance and advances paid in the year", () => {
    // acconti GS 2025 = 80% di 6100.38; saldo GS 2024 = 6100.38 → versati nel 2025 = 6100.38 + 4880.30
    expect(y25.contribution_advances).toEqual([2440.15, 2440.15]);
    expect(y25.contributions_paid_in_year).toBe(10980.68);
    expect(y25.gross_income).toBe(31200);
    expect(y25.taxable_income).toBe(20219.32);
    expect(y25.tax_due).toBe(3032.9);
    expect(y25.tax_advances).toEqual([1755, 1755]);
    expect(y25.tax_balance).toBeCloseTo(-477.1, 1);
  });

  it("builds the June/November calendar", () => {
    const rep = taxReport(gs, { 2024: 30000, 2025: 40000 }, 2025);
    const june = rep.deadlines.find((d) => d.date === "2025-06-30")!;
    // saldo imposta 2024 + 1° acconto 2025 + saldo GS 2024 + 1° acconto GS 2025
    expect(june.total).toBe(3510 + 1755 + 6100.38 + 2440.15);
    const nov = rep.deadlines.find((d) => d.date === "2025-11-30")!;
    expect(nov.total).toBe(1755 + 2440.15);
    expect(rep.notes.some((n) => n.includes("metodo previsionale"))).toBe(true);
    expect(rep.year_summary.total_burden).toBe(3032.9 + 8133.84);
  });
});

describe("other regimes and overrides", () => {
  it("artigiani with 35% reduction: fixed quarterly installments plus excess", () => {
    const p: TaxProfile = {
      coefficient: 0.67,
      tax_rate: 0.05,
      inps: { type: "artigiani", fixed_annual: 4400, minimum_income: 18000, reduction_35: true },
    };
    const y = computeYears(p, { 2026: 60000 }, 2026, 2026).get(2026)!;
    expect(y.contributions_fixed).toBe(2860);
    expect(y.contributions_variable).toBe(Math.round((40200 - 18000) * 0.24 * 0.65 * 100) / 100);
    const dl = taxReport(p, { 2026: 60000 }, 2026).deadlines.map((d) => d.date);
    expect(dl).toEqual(expect.arrayContaining(["2026-05-16", "2026-08-20", "2026-11-30"]));
  });

  it("per-year INPS rate (e.g. 24% during a PhD)", () => {
    const p = { ...gs, overrides: { "2025": { inps_rate: 0.24 } } };
    const ys = computeYears(p, { 2024: 30000, 2025: 40000 }, 2024, 2025);
    expect(ys.get(2024)!.contributions_due).toBe(6100.38);
    expect(ys.get(2025)!.contributions_due).toBe(7488);
  });

  it("overrides replace modelled payments", () => {
    const p = { ...gs, overrides: { "2025": { contributions_paid: 5000, tax_advances_paid: 3000 } } };
    const y = computeYears(p, { 2024: 30000, 2025: 40000 }, 2024, 2025).get(2025)!;
    expect(y.taxable_income).toBe(26200);
    expect(y.tax_advances).toEqual([1500, 1500]);
  });

  it("collectedByYear uses paid dates and nets credit notes", () => {
    const r = collectedByYear([
      { type: "invoice", amount_gross: 1002, amount_vat: 0, payments_list: [{ amount: 1002, status: "paid", paid_date: "2026-01-03" }] },
      { type: "invoice", amount_gross: 1220, amount_vat: 220, payments_list: [{ amount: 1220, status: "paid", paid_date: "2025-12-30" }] },
      { type: "credit_note", amount_gross: 100, amount_vat: 0, payments_list: [{ amount: 100, status: "paid", paid_date: "2026-02-01" }] },
      { type: "invoice", amount_gross: 500, payments_list: [{ amount: 500, status: "not_paid" }] },
    ] as any);
    expect(r).toEqual({ 2025: 1000, 2026: 902 });
  });
});

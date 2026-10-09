import { describe, expect, it } from "vitest";
import { compareRegimes, employeeDeduction, forfettario, irpef, ordinario, REGIME_DEFAULTS, selfEmployedDeduction, srl } from "../src/regime.js";

const base = { ...REGIME_DEFAULTS, costs: 0 };

describe("building blocks", () => {
  it("IRPEF brackets 23/33/43", () => {
    expect(irpef(20_000, base.irpef_brackets)).toBe(4_600);
    expect(irpef(40_000, base.irpef_brackets)).toBeCloseTo(6_440 + 3_960, 6);
    expect(irpef(60_000, base.irpef_brackets)).toBeCloseTo(6_440 + 7_260 + 4_300, 6);
  });
  it("deductions", () => {
    expect(selfEmployedDeduction(5_000)).toBe(1_265);
    expect(selfEmployedDeduction(28_000)).toBe(500);
    expect(selfEmployedDeduction(60_000)).toBe(0);
    expect(employeeDeduction(10_000)).toBe(1_955);
    expect(employeeDeduction(0)).toBe(0);
  });
});

describe("scenarios", () => {
  it("forfettario ignores costs and is ineligible above 85k", () => {
    const a = forfettario({ ...base, revenue: 50_000, costs: 0, coefficient: 0.67, forfettario_rate: 0.05 });
    const b = forfettario({ ...base, revenue: 50_000, costs: 20_000, coefficient: 0.67, forfettario_rate: 0.05 });
    expect(a.total_taxes).toBe(b.total_taxes);
    expect(a.taxes.inps).toBeCloseTo(33_500 * 0.2607, 2);
    expect(a.taxes.imposta_sostitutiva).toBeCloseTo((33_500 - 33_500 * 0.2607) * 0.05, 2);
    expect(forfettario({ ...base, revenue: 90_000, costs: 0 }).eligible).toBe(false);
  });

  it("ordinario deducts real costs", () => {
    const low = ordinario({ ...base, revenue: 60_000, costs: 0 });
    const high = ordinario({ ...base, revenue: 60_000, costs: 30_000 });
    expect(high.total_taxes).toBeLessThan(low.total_taxes);
    expect(low.taxes.irpef).toBeGreaterThan(0);
  });

  it("SRL picks the compensation that minimises taxes and pays fixed costs", () => {
    const s = srl({ ...base, revenue: 150_000, costs: 10_000 });
    const zero = srl({ ...base, revenue: 150_000, costs: 10_000 }, 0);
    expect(s.total_taxes).toBeLessThanOrEqual(zero.total_taxes);
    expect(s.net).toBeCloseTo(150_000 - 10_000 - base.srl_fixed_costs - s.total_taxes, 2);
  });
});

describe("compareRegimes", () => {
  it("startup forfettario wins at moderate revenue with low costs", () => {
    const r = compareRegimes({ revenue: 60_000, costs: 2_000, coefficient: 0.67, forfettario_rate: 0.05 });
    expect(r.best).toMatch(/Forfettario/);
    expect(r.scenarios.map((s) => s.id)).toEqual(["forfettario", "ordinario", "srl"]);
  });

  it("with high costs ordinario can beat forfettario before the threshold", () => {
    const r = compareRegimes({ revenue: 70_000, costs: 45_000, coefficient: 0.78, forfettario_rate: 0.15 });
    expect(r.best).not.toMatch(/Forfettario/);
    expect(typeof r.forfettario_stops_being_best_at).toBe("object");
  });

  it("above 100k the forfettario is never the recommendation", () => {
    const r = compareRegimes({ revenue: 120_000, costs: 5_000 });
    expect(r.best).not.toMatch(/Forfettario/);
  });
});

/**
 * Confronto tra regimi per un'attività individuale: forfettario, ordinario
 * (ditta individuale / professionista) e SRL unipersonale.
 *
 * Steady-state model for one year (competenza, contributions deducted in the same
 * year). It answers "which structure leaves more money in my pocket at this
 * revenue and cost level", not "how much do I owe": parameters are approximations
 * and every assumption is returned with the result.
 */

export interface IrpefBracket {
  upTo: number | null;
  rate: number;
}

export interface RegimeParams {
  /** Ricavi annui (senza IVA). */
  revenue: number;
  /** Costi reali deducibili dell'attività (irrilevanti nel forfettario). */
  costs: number;
  coefficient: number;
  /** 0.05 nei primi cinque anni, poi 0.15. */
  forfettario_rate: number;
  inps_rate: number;
  inps_max_income: number;
  irpef_brackets: IrpefBracket[];
  /** Addizionali regionale + comunale, come aliquota media sul reddito imponibile. */
  local_surcharge_rate: number;
  // SRL
  ires_rate: number;
  irap_rate: number;
  dividend_tax_rate: number;
  /** Contributi INPS dell'amministratore in gestione separata (quota totale). */
  director_inps_rate: number;
  /** Costi fissi della società: commercialista, bilancio, diritti camerali, PEC, conto. */
  srl_fixed_costs: number;
  /** Contributi minimi del socio lavoratore (gestione commercianti), se dovuti. */
  srl_partner_inps: number;
}

/** Defaults for 2026 (verify yearly: brackets, rates and caps change with the budget law). */
export const REGIME_DEFAULTS: Omit<RegimeParams, "revenue" | "costs"> = {
  coefficient: 0.78,
  forfettario_rate: 0.15,
  inps_rate: 0.2607,
  inps_max_income: 120_607,
  irpef_brackets: [
    { upTo: 28_000, rate: 0.23 },
    { upTo: 50_000, rate: 0.33 },
    { upTo: null, rate: 0.43 },
  ],
  local_surcharge_rate: 0.02,
  ires_rate: 0.24,
  irap_rate: 0.039,
  dividend_tax_rate: 0.26,
  director_inps_rate: 0.3503,
  srl_fixed_costs: 3_500,
  srl_partner_inps: 0,
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function irpef(taxable: number, brackets: IrpefBracket[]): number {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (taxable > lower) tax += (Math.min(taxable, upper) - lower) * b.rate;
    lower = upper;
  }
  return tax;
}

/** Detrazione per redditi di lavoro autonomo (art. 13, c. 5 TUIR). */
export function selfEmployedDeduction(income: number): number {
  if (income <= 5_500) return 1_265;
  if (income <= 28_000) return 500 + (765 * (28_000 - income)) / 22_500;
  if (income <= 50_000) return (500 * (50_000 - income)) / 22_000;
  return 0;
}

/** Detrazione per redditi assimilati a lavoro dipendente (art. 13, c. 1 TUIR), e.g. director compensation. */
export function employeeDeduction(income: number): number {
  if (income <= 0) return 0;
  if (income <= 15_000) return 1_955;
  if (income <= 28_000) return 1_910 + (1_190 * (28_000 - income)) / 13_000;
  if (income <= 50_000) return (1_910 * (50_000 - income)) / 22_000;
  return 0;
}

export interface ScenarioResult {
  id: "forfettario" | "ordinario" | "srl";
  name: string;
  eligible: boolean;
  taxes: Record<string, number>;
  total_taxes: number;
  net: number;
  effective_rate: number;
  notes: string[];
}

function result(id: ScenarioResult["id"], name: string, p: RegimeParams, taxes: Record<string, number>, notes: string[], eligible = true, extraCosts = 0): ScenarioResult {
  const total = Object.values(taxes).reduce((s, v) => s + v, 0);
  const net = p.revenue - p.costs - extraCosts - total;
  return {
    id,
    name,
    eligible,
    taxes: Object.fromEntries(Object.entries(taxes).map(([k, v]) => [k, r2(v)])),
    total_taxes: r2(total),
    net: r2(net),
    effective_rate: p.revenue ? r2((total / p.revenue) * 100) : 0,
    notes,
  };
}

export function forfettario(p: RegimeParams): ScenarioResult {
  const income = p.revenue * p.coefficient;
  const inps = Math.min(income, p.inps_max_income) * p.inps_rate;
  const tax = Math.max(0, income - inps) * p.forfettario_rate;
  const notes = [
    `Reddito = ricavi × ${p.coefficient * 100}%: i costi reali (${p.costs} €) non contano.`,
    `Imposta sostitutiva al ${p.forfettario_rate * 100}%, niente IRPEF né addizionali, niente IVA sulle fatture.`,
  ];
  let eligible = true;
  if (p.revenue > 100_000) {
    eligible = false;
    notes.push("Oltre 100.000 € si esce dal forfettario nell'anno stesso.");
  } else if (p.revenue > 85_000) {
    eligible = false;
    notes.push("Oltre 85.000 € il forfettario non è più applicabile dall'anno successivo.");
  }
  return result("forfettario", `Forfettario ${p.forfettario_rate * 100}%`, p, { inps, imposta_sostitutiva: tax }, notes, eligible);
}

export function ordinario(p: RegimeParams): ScenarioResult {
  const income = Math.max(0, p.revenue - p.costs);
  const inps = Math.min(income, p.inps_max_income) * p.inps_rate;
  const taxable = Math.max(0, income - inps);
  const gross = irpef(taxable, p.irpef_brackets);
  const irpefNet = Math.max(0, gross - selfEmployedDeduction(taxable));
  const surcharge = taxable * p.local_surcharge_rate;
  return result("ordinario", "Ordinario (ditta individuale)", p, { inps, irpef: irpefNet, addizionali: surcharge }, [
    "Reddito = ricavi − costi reali; IRPEF a scaglioni con detrazione per lavoro autonomo.",
    "IVA addebitata ai clienti e detraibile sugli acquisti: neutra con clienti aziende, pesa con clienti privati.",
    "IRAP esclusa (persone fisiche esenti dal 2022).",
  ]);
}

/**
 * SRL unipersonale: best split between director compensation and dividends,
 * searched on a grid. Compensation is deductible for IRES (not for IRAP), pays
 * gestione separata (2/3 company, 1/3 director) and IRPEF; profit after IRES is
 * distributed as dividends at 26%.
 */
export function srl(p: RegimeParams, compensation?: number): ScenarioResult {
  const evaluate = (comp: number) => {
    const inpsTotal = Math.min(comp, p.inps_max_income) * p.director_inps_rate;
    const companyInps = (inpsTotal * 2) / 3;
    const directorInps = inpsTotal / 3;
    const valueAdded = Math.max(0, p.revenue - p.costs - p.srl_fixed_costs);
    const irap = valueAdded * p.irap_rate;
    const profit = Math.max(0, p.revenue - p.costs - p.srl_fixed_costs - comp - companyInps - irap);
    const ires = profit * p.ires_rate;
    const dividendTax = (profit - ires) * p.dividend_tax_rate;
    const directorTaxable = Math.max(0, comp - directorInps);
    const irpefDir = Math.max(0, irpef(directorTaxable, p.irpef_brackets) - employeeDeduction(directorTaxable));
    const surcharge = directorTaxable * p.local_surcharge_rate;
    const taxes = {
      ires,
      irap,
      tassazione_dividendi: dividendTax,
      inps_amministratore: inpsTotal,
      irpef_amministratore: irpefDir,
      addizionali: surcharge,
      ...(p.srl_partner_inps ? { inps_socio: p.srl_partner_inps } : {}),
    };
    return { comp, taxes, total: Object.values(taxes).reduce((s, v) => s + v, 0) };
  };
  const maxComp = Math.max(0, p.revenue - p.costs - p.srl_fixed_costs);
  let best = evaluate(compensation ?? 0);
  if (compensation === undefined) {
    for (let comp = 0; comp <= maxComp; comp += 500) {
      const e = evaluate(comp);
      if (e.total < best.total) best = e;
    }
  }
  return result(
    "srl",
    `SRL unipersonale (compenso amministratore ${Math.round(best.comp)} €)`,
    p,
    best.taxes,
    [
      `Compenso ${compensation === undefined ? "scelto per minimizzare le imposte" : "indicato"}: ${Math.round(best.comp)} €; il resto dell'utile distribuito come dividendi.`,
      `Costi fissi della società stimati in ${p.srl_fixed_costs} € l'anno (commercialista, bilancio, diritti, conto).`,
      "Non considera utili lasciati in società, TFM, auto aziendale, né l'eventuale iscrizione del socio lavoratore alla gestione commercianti (srl_partner_inps).",
    ],
    true,
    p.srl_fixed_costs,
  );
}

export function compareRegimes(input: Partial<RegimeParams> & { revenue: number; costs?: number }) {
  const p: RegimeParams = { ...REGIME_DEFAULTS, costs: 0, ...input };
  const scenarios = [forfettario(p), ordinario(p), srl(p)];
  const ranking = [...scenarios].sort((a, b) => b.net - a.net);
  const bestEligible = ranking.find((s) => s.eligible)!;

  // Lowest revenue (same cost ratio) at which another structure beats the forfettario,
  // searched only up to the 85.000 € threshold where the forfettario stops anyway
  const costRatio = p.revenue ? p.costs / p.revenue : 0;
  let crossover: { revenue: number; best: string } | null = null;
  for (let rev = 10_000; rev <= 85_000; rev += 1_000) {
    const q = { ...p, revenue: rev, costs: rev * costRatio };
    const f = forfettario(q);
    const better = [ordinario(q), srl(q)].find((o) => o.net > f.net);
    if (better) {
      crossover = { revenue: rev, best: better.name };
      break;
    }
  }

  return {
    assumptions: {
      revenue: p.revenue,
      costs: p.costs,
      coefficient: p.coefficient,
      forfettario_rate: p.forfettario_rate,
      inps_rate: p.inps_rate,
      irpef_brackets: p.irpef_brackets,
      local_surcharge_rate: p.local_surcharge_rate,
      srl: { ires: p.ires_rate, irap: p.irap_rate, dividends: p.dividend_tax_rate, fixed_costs: p.srl_fixed_costs, director_inps: p.director_inps_rate },
    },
    scenarios,
    best: bestEligible.name,
    difference_vs_second: r2(ranking[0].net - ranking[1].net),
    forfettario_stops_being_best_at: crossover ?? "Con questo rapporto costi/ricavi il forfettario resta il più conveniente fino alla soglia di 85.000 €.",
    notes: [
      "Confronto a regime su un anno (competenza): non considera acconti, il primo anno di una SRL, né le differenze di cassa.",
      "Aliquote 2026 da verificare ogni anno; per una decisione serve il commercialista.",
    ],
  };
}

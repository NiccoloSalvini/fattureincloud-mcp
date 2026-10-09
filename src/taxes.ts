/**
 * Stima di imposta sostitutiva e contributi per il regime forfettario.
 *
 * Modello (principio di cassa):
 *   reddito lordo       = ricavi incassati × coefficiente di redditività
 *   contributi dovuti   = calcolati sul reddito lordo (gestione separata, artigiani/commercianti, cassa)
 *   imponibile          = reddito lordo − contributi effettivamente VERSATI nell'anno
 *   imposta sostitutiva = imponibile × 15% (5% nei primi cinque anni, se spetta)
 *
 * Versamenti (metodo storico):
 *   30 giugno   saldo dell'anno prima + 1° acconto
 *   30 novembre 2° acconto
 *   Acconti imposta: 100% dell'imposta dell'anno prima, 50% + 50% (forfettari = soggetti ISA ai fini degli acconti);
 *   nessun acconto sotto 51,65 €, unica rata a novembre sotto 257,52 €.
 *   Acconti gestione separata: 80% dei contributi dell'anno prima, 40% + 40%.
 *
 * È una stima: non sostituisce il commercialista né il modello Redditi.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./schedules.js";

export const DEFAULTS = {
  /** Aliquota gestione separata INPS per chi non ha altra copertura (2025). */
  gestione_separata_rate: 0.2607,
  /** Massimale contributivo gestione separata (2025). */
  gestione_separata_max: 120_607,
  artigiani_rate: 0.24,
  commercianti_rate: 0.2448,
  tax_advance_min: 51.65,
  tax_advance_single_max: 257.52,
};

export type InpsProfile =
  | { type: "gestione_separata"; rate?: number; max_income?: number }
  | {
      type: "artigiani" | "commercianti";
      /** Contributi fissi annui sul minimale (dalle tabelle INPS dell'anno). */
      fixed_annual: number;
      /** Reddito minimale (dalle tabelle INPS dell'anno). */
      minimum_income: number;
      rate?: number;
      /** Riduzione del 35% riservata ai forfettari. */
      reduction_35?: boolean;
    }
  | { type: "cassa"; name?: string; rate: number; minimum?: number }
  | { type: "none" };

export interface YearOverride {
  /** Ricavi incassati, se diversi da quelli in Fatture in Cloud (es. attività precedente). */
  revenue?: number;
  /** Contributi previdenziali versati nell'anno (deducibili). */
  contributions_paid?: number;
  /** Acconti di imposta sostitutiva versati per l'anno. */
  tax_advances_paid?: number;
  /** Acconti contributivi versati per l'anno. */
  contribution_advances_paid?: number;
}

/** A payment already arranged (e.g. an installment plan of the June F24). */
export interface PlannedPayment {
  date: string;
  amount: number;
  label: string;
}

export interface TaxProfile {
  /** Coefficiente di redditività dell'ATECO, es. 0.78 per i professionisti. */
  coefficient: number;
  /** 0.15, oppure 0.05 per i primi cinque anni di una nuova attività. */
  tax_rate: number;
  /** Primo anno di attività: prima non c'è nulla da versare. */
  start_year?: number;
  inps: InpsProfile;
  overrides?: Record<string, YearOverride>;
  /** Known future payments (rateizzazione, F24 già fissati), added to the modelled deadlines. */
  planned_payments?: PlannedPayment[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface YearCalc {
  year: number;
  revenue: number;
  gross_income: number;
  contributions_due: number;
  contributions_fixed: number;
  contributions_variable: number;
  contribution_advances: [number, number];
  contribution_balance: number;
  contributions_paid_in_year: number;
  taxable_income: number;
  tax_due: number;
  tax_advances: [number, number];
  tax_balance: number;
}

function contributionsDue(p: TaxProfile, grossIncome: number): { fixed: number; variable: number } {
  const inps = p.inps;
  switch (inps.type) {
    case "gestione_separata":
      return {
        fixed: 0,
        variable: Math.min(grossIncome, inps.max_income ?? DEFAULTS.gestione_separata_max) * (inps.rate ?? DEFAULTS.gestione_separata_rate),
      };
    case "artigiani":
    case "commercianti": {
      const rate = inps.rate ?? (inps.type === "artigiani" ? DEFAULTS.artigiani_rate : DEFAULTS.commercianti_rate);
      const factor = inps.reduction_35 ? 0.65 : 1;
      return { fixed: inps.fixed_annual * factor, variable: Math.max(0, grossIncome - inps.minimum_income) * rate * factor };
    }
    case "cassa": {
      const v = grossIncome * inps.rate;
      return { fixed: 0, variable: Math.max(v, inps.minimum ?? 0) };
    }
    case "none":
      return { fixed: 0, variable: 0 };
  }
}

/** Acconti sul variabile: 80% (40+40) per gestione separata e casse, 100% (50+50) per artigiani/commercianti. */
function contributionAdvances(p: TaxProfile, prevVariable: number): [number, number] {
  if (p.inps.type === "none" || prevVariable <= 0) return [0, 0];
  if (p.inps.type === "artigiani" || p.inps.type === "commercianti") return [prevVariable * 0.5, prevVariable * 0.5];
  return [prevVariable * 0.4, prevVariable * 0.4];
}

export function taxAdvances(prevTax: number): [number, number] {
  if (prevTax <= DEFAULTS.tax_advance_min) return [0, 0];
  if (prevTax < DEFAULTS.tax_advance_single_max) return [0, prevTax];
  return [prevTax * 0.5, prevTax * 0.5];
}

/**
 * Computes every year from `from` to `to` in order, because each year's
 * deductions and advances depend on the previous one.
 */
export function computeYears(p: TaxProfile, revenueByYear: Record<number, number>, from: number, to: number): Map<number, YearCalc> {
  const out = new Map<number, YearCalc>();
  for (let y = from; y <= to; y++) {
    const ov = p.overrides?.[String(y)] ?? {};
    const active = !p.start_year || y >= p.start_year;
    const prev = out.get(y - 1);
    const revenue = active ? (ov.revenue ?? revenueByYear[y] ?? 0) : 0;
    const gross = revenue * p.coefficient;
    const { fixed, variable } = contributionsDue(p, gross);

    const cAdv = (() => {
      if (ov.contribution_advances_paid !== undefined) return [ov.contribution_advances_paid / 2, ov.contribution_advances_paid / 2] as [number, number];
      return prev ? contributionAdvances(p, prev.contributions_variable) : ([0, 0] as [number, number]);
    })();
    const contributionBalance = variable - cAdv[0] - cAdv[1];
    // Deducibili per cassa: fissi dell'anno + saldo dell'anno prima + acconti dell'anno
    const paidInYear = ov.contributions_paid ?? fixed + Math.max(0, prev?.contribution_balance ?? 0) + cAdv[0] + cAdv[1];

    const taxable = Math.max(0, gross - paidInYear);
    const tax = taxable * p.tax_rate;
    const tAdv = (() => {
      if (ov.tax_advances_paid !== undefined) return [ov.tax_advances_paid / 2, ov.tax_advances_paid / 2] as [number, number];
      return prev ? taxAdvances(prev.tax_due) : ([0, 0] as [number, number]);
    })();

    out.set(y, {
      year: y,
      revenue: r2(revenue),
      gross_income: r2(gross),
      contributions_due: r2(fixed + variable),
      contributions_fixed: r2(fixed),
      contributions_variable: r2(variable),
      contribution_advances: [r2(cAdv[0]), r2(cAdv[1])],
      contribution_balance: r2(contributionBalance),
      contributions_paid_in_year: r2(paidInYear),
      taxable_income: r2(taxable),
      tax_due: r2(tax),
      tax_advances: [r2(tAdv[0]), r2(tAdv[1])],
      tax_balance: r2(tax - tAdv[0] - tAdv[1]),
    });
  }
  return out;
}

export interface Deadline {
  date: string;
  total: number;
  items: { what: string; amount: number }[];
}

function deadline(date: string, items: { what: string; amount: number }[]): Deadline {
  const kept = items.filter((i) => Math.abs(i.amount) >= 0.01).map((i) => ({ ...i, amount: r2(i.amount) }));
  return { date, total: r2(kept.reduce((s, i) => s + i.amount, 0)), items: kept };
}

/** Payment calendar for calendar year `y` (cash out), plus the June of y+1. */
export function deadlinesFor(p: TaxProfile, years: Map<number, YearCalc>, y: number): Deadline[] {
  const cur = years.get(y)!;
  const prev = years.get(y - 1);
  const next = years.get(y + 1);
  const label = p.inps.type === "cassa" ? p.inps.name ?? "cassa" : p.inps.type === "gestione_separata" ? "INPS gestione separata" : `INPS ${p.inps.type}`;
  const out: Deadline[] = [];

  if (p.inps.type === "artigiani" || p.inps.type === "commercianti") {
    const q = cur.contributions_fixed / 4;
    const prevQ = (prev?.contributions_fixed ?? 0) / 4;
    out.push(deadline(`${y}-02-16`, [{ what: `${label}: 4ª rata fissi ${y - 1}`, amount: prevQ }]));
    out.push(deadline(`${y}-05-16`, [{ what: `${label}: 1ª rata fissi ${y}`, amount: q }]));
  }
  out.push(
    deadline(`${y}-06-30`, [
      { what: `Imposta sostitutiva: saldo ${y - 1}`, amount: Math.max(0, prev?.tax_balance ?? 0) },
      { what: `Imposta sostitutiva: 1° acconto ${y}`, amount: cur.tax_advances[0] },
      { what: `${label}: saldo ${y - 1}`, amount: Math.max(0, prev?.contribution_balance ?? 0) },
      { what: `${label}: 1° acconto ${y}`, amount: cur.contribution_advances[0] },
    ]),
  );
  if (p.inps.type === "artigiani" || p.inps.type === "commercianti") {
    out.push(deadline(`${y}-08-20`, [{ what: `${label}: 2ª rata fissi ${y}`, amount: cur.contributions_fixed / 4 }]));
  }
  out.push(
    deadline(`${y}-11-30`, [
      { what: `Imposta sostitutiva: 2° acconto ${y}`, amount: cur.tax_advances[1] },
      { what: `${label}: 2° acconto ${y}`, amount: cur.contribution_advances[1] },
      ...(p.inps.type === "artigiani" || p.inps.type === "commercianti"
        ? [{ what: `${label}: 3ª rata fissi ${y}`, amount: cur.contributions_fixed / 4 }]
        : []),
    ]),
  );
  if (next) {
    out.push(
      deadline(`${y + 1}-06-30`, [
        { what: `Imposta sostitutiva: saldo ${y} (stima)`, amount: Math.max(0, cur.tax_balance) },
        { what: `Imposta sostitutiva: 1° acconto ${y + 1} (stima)`, amount: next.tax_advances[0] },
        { what: `${label}: saldo ${y} (stima)`, amount: Math.max(0, cur.contribution_balance) },
        { what: `${label}: 1° acconto ${y + 1} (stima)`, amount: next.contribution_advances[0] },
      ]),
    );
  }
  return out.filter((d) => d.items.length);
}

export function taxReport(p: TaxProfile, revenueByYear: Record<number, number>, year: number, opts: { projected_revenue?: number } = {}) {
  const from = Math.max(p.start_year ?? year - 3, year - 3);
  const revenues = { ...revenueByYear };
  if (opts.projected_revenue !== undefined) revenues[year] = opts.projected_revenue;
  const years = computeYears(p, revenues, from, year + 1);
  const cur = years.get(year)!;
  const prev = years.get(year - 1);
  const burden = cur.tax_due + cur.contributions_due;
  const credits = [
    prev && prev.tax_balance < 0 ? `Credito d'imposta ${year - 1} di ${r2(-prev.tax_balance)} €: compensabile in F24.` : null,
    cur.tax_balance < 0 ? `Gli acconti ${year} superano l'imposta stimata di ${r2(-cur.tax_balance)} €: valuta il metodo previsionale per il 2° acconto.` : null,
  ].filter(Boolean);
  return {
    year,
    revenue_used: cur.revenue,
    year_summary: {
      ...cur,
      total_burden: r2(burden),
      burden_pct_of_revenue: cur.revenue ? r2((burden / cur.revenue) * 100) : 0,
      net_after_taxes: r2(cur.revenue - burden),
    },
    set_aside_advice: cur.revenue
      ? `Accantona circa il ${Math.ceil((burden / cur.revenue) * 100)}% di ogni incasso per imposta e contributi di competenza ${year}.`
      : null,
    deadlines: deadlinesFor(p, years, year),
    notes: [
      ...credits,
      "Il versamento del 30 giugno si può fare entro il 30 luglio con la maggiorazione dello 0,40%.",
      "Stima basata sugli incassi registrati in Fatture in Cloud e sui parametri del profilo: verifica con il commercialista prima di pagare.",
    ],
    previous_years: [...years.values()].filter((y) => y.year < year),
  };
}

// ---- Profilo salvato ------------------------------------------------------

export function profileFile(): string {
  return path.join(dataDir(), "tax-profile.json");
}

export async function loadProfile(file = profileFile()): Promise<TaxProfile | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function saveProfile(p: TaxProfile, file = profileFile()): Promise<void> {
  validateProfile(p);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(p, null, 2) + "\n");
}

export function validateProfile(p: TaxProfile) {
  if (!(p.coefficient > 0 && p.coefficient <= 1)) throw new Error("coefficient deve essere tra 0 e 1 (es. 0.78)");
  if (!(p.tax_rate >= 0 && p.tax_rate <= 0.5)) throw new Error("tax_rate deve essere una frazione (0.15 o 0.05)");
  if ((p.inps.type === "artigiani" || p.inps.type === "commercianti") && (!p.inps.fixed_annual || !p.inps.minimum_income))
    throw new Error("Per artigiani/commercianti servono fixed_annual e minimum_income dalle tabelle INPS dell'anno");
}

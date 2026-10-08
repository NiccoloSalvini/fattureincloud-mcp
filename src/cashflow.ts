/**
 * Previsione di cassa mese per mese e accantonamento per le scadenze fiscali.
 */
import { addDays, daysBetween, parseISODate } from "./copy.js";

export type CashKind = "credito" | "credito_scaduto" | "ricorrente" | "tasse" | "spese";

export interface CashEvent {
  date: string;
  /** Positive = entrata, negative = uscita. */
  amount: number;
  kind: CashKind;
  label: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** YYYY-MM keys from the month of `start`, `count` months long. */
export function monthRange(start: string, count: number): string[] {
  const d = parseISODate(start);
  return Array.from({ length: count }, (_, i) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    return m.toISOString().slice(0, 7);
  });
}

/**
 * Minimum fixed monthly amount to set aside, starting this month, so that the
 * fund covers every tax deadline on time (sinking fund over the worst deadline).
 */
export function monthlySetAside(taxes: { date: string; amount: number }[], today: string, fund = 0) {
  const sorted = [...taxes].filter((t) => t.date >= today && t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const months = monthRange(today, 240);
  let cumulative = 0;
  let monthly = 0;
  const checkpoints = sorted.map((t) => {
    cumulative += t.amount;
    // months available = from this month up to (excluding) the deadline month,
    // plus the deadline month itself if the payment is not on its first days
    const idx = months.indexOf(monthKey(t.date));
    const available = Math.max(1, idx + (Number(t.date.slice(8, 10)) > 15 ? 1 : 0));
    const needed = (cumulative - fund) / available;
    monthly = Math.max(monthly, needed);
    return { date: t.date, amount: r2(t.amount), cumulative: r2(cumulative), months_available: available };
  });
  return { monthly: r2(Math.max(0, Math.ceil(monthly * 100) / 100)), fund: r2(fund), checkpoints };
}

export function forecast(
  events: CashEvent[],
  opts: { today: string; months: number; opening_balance?: number; tax_fund?: number },
) {
  const keys = monthRange(opts.today, opts.months);
  const last = keys[keys.length - 1];
  const inHorizon = events.filter((e) => monthKey(e.date) <= last);
  const taxes = inHorizon.filter((e) => e.kind === "tasse").map((e) => ({ date: e.date, amount: -e.amount }));
  const setAside = monthlySetAside(taxes, opts.today, opts.tax_fund ?? 0);

  let balance = opts.opening_balance;
  const warnings: string[] = [];
  const rows = keys.map((k) => {
    const evs = inHorizon.filter((e) => (monthKey(e.date) < keys[0] ? k === keys[0] : monthKey(e.date) === k));
    const sum = (kinds: CashKind[]) => r2(evs.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + e.amount, 0));
    const inflows = sum(["credito", "credito_scaduto", "ricorrente"]);
    const outflows = sum(["tasse", "spese"]);
    const net = r2(inflows + outflows);
    if (balance !== undefined) {
      balance = r2(balance + net);
      if (balance < 0) warnings.push(`${k}: saldo previsto negativo (${balance} €).`);
    }
    return {
      month: k,
      crediti: sum(["credito"]),
      crediti_scaduti: sum(["credito_scaduto"]),
      ricorrenti: sum(["ricorrente"]),
      tasse: sum(["tasse"]),
      spese: sum(["spese"]),
      net,
      balance,
      events: evs.filter((e) => e.kind !== "spese").map((e) => ({ date: e.date, amount: r2(e.amount), what: e.label })),
    };
  });

  const overdue = inHorizon.filter((e) => e.kind === "credito_scaduto").reduce((s, e) => s + e.amount, 0);
  if (overdue > 0) warnings.push(`${r2(overdue)} € di crediti già scaduti sono conteggiati nel mese corrente: se non arrivano, la previsione peggiora.`);

  return {
    from: keys[0],
    to: last,
    totals: {
      entrate: r2(rows.reduce((s, r) => s + r.crediti + r.crediti_scaduti + r.ricorrenti, 0)),
      tasse: r2(rows.reduce((s, r) => s + r.tasse, 0)),
      spese: r2(rows.reduce((s, r) => s + r.spese, 0)),
    },
    set_aside: {
      ...setAside,
      advice: setAside.checkpoints.length
        ? `Metti da parte ${setAside.monthly} € al mese da ora per coprire tutte le scadenze fiscali fino al ${setAside.checkpoints.at(-1)!.date}.`
        : "Nessuna scadenza fiscale nel periodo.",
    },
    warnings,
    months: rows,
  };
}

/** Expected collection date of a recurring invoice: issue date + the template's payment delay. */
export function recurringCollection(runDate: string, templateDate: string | null | undefined, templateDue: string | null | undefined): string {
  if (!templateDate || !templateDue) return runDate;
  return addDays(runDate, Math.max(0, daysBetween(templateDate, templateDue)));
}

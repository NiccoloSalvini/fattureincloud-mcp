import { describe, expect, it } from "vitest";
import {
  addMonths,
  buildSupplierHistory,
  matchExisting,
  normalizeName,
  normalizeVat,
  receivedFromPending,
  recurringExpenses,
  suggestCategory,
} from "../src/expenses.js";

const sum = (xs: any[]) => Math.round(xs.reduce((s, x) => s + x.amount, 0) * 100) / 100;

describe("receivedFromPending", () => {
  const base = { id: 1, type: "agyo", document_type: "expense", supplier_name: "Enel Energia S.p.A.", date: "2026-10-01", subject: "Luce", amount_net: 100, amount_vat: 22, amount_gross: 122 };

  it("reuses installments that cover the gross total", () => {
    const d = receivedFromPending({ ...base, payments_list: [{ amount: 61, due_date: "2026-10-20" }, { amount: 61, due_date: "2026-11-20" }] });
    expect(d.payments_list).toEqual([
      { amount: 61, due_date: "2026-10-20", status: "not_paid" },
      { amount: 61, due_date: "2026-11-20", status: "not_paid" },
    ]);
    expect(d).toMatchObject({ type: "expense", entity: { name: "Enel Energia S.p.A." }, date: "2026-10-01", description: "Luce", amount_net: 100, amount_vat: 22 });
    expect(d).not.toHaveProperty("amount_gross");
  });

  it("falls back to a single installment when they do not add up", () => {
    const d = receivedFromPending({ ...base, payments_list: [{ amount: 60, due_date: "2026-10-31" }] });
    expect(d.payments_list).toEqual([{ amount: 122, due_date: "2026-10-31", status: "not_paid" }]);
    expect(receivedFromPending({ ...base }).payments_list).toEqual([{ amount: 122, due_date: "2026-10-01", status: "not_paid" }]);
  });

  it("puts rounding on the last installment and marks paid with account", () => {
    const d = receivedFromPending(
      { ...base, amount_net: 81.97, amount_vat: 18.03, amount_gross: 100, payments_list: [{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.34 }] },
      { paid: true, paid_date: "2026-10-05", payment_account_id: 3, category: "Utenze" },
    );
    expect(sum(d.payments_list)).toBe(100);
    expect(d.payments_list.every((x: any) => x.status === "paid" && x.paid_date === "2026-10-05" && x.payment_account.id === 3)).toBe(true);
    expect(d.category).toBe("Utenze");
  });

  it("uses emission_date and ei_number from the live API shape", () => {
    const d = receivedFromPending({ ...base, date: "2026-07-22 00:11:45", emission_date: "2026-07-19", ei_number: "269207/3W" });
    expect(d).toMatchObject({ date: "2026-07-19", invoice_number: "269207/3W" });
    expect(d.payments_list[0].due_date).toBe("2026-07-19");
    expect(receivedFromPending({ ...base, date: "2026-07-22 00:11:45" }).date).toBe("2026-07-22");
    expect(receivedFromPending({ ...base, category: "" })).not.toHaveProperty("category");
  });

  it("keeps an existing supplier id and computes a missing gross", () => {
    const d = receivedFromPending({ id: 2, entity: { id: 9, name: "Acme" }, amount_net: 10, amount_vat: 2.2, currency: { id: "EUR" } });
    expect(d.entity).toEqual({ id: 9, name: "Acme" });
    expect(sum(d.payments_list)).toBe(12.2);
    expect(d.currency).toEqual({ id: "EUR" });
  });
});

describe("categories", () => {
  const history = buildSupplierHistory([
    { entity: { name: "Vodafone Italia SpA", vat_number: "IT08539010010" }, category: "Telefonia" },
    { entity: { name: "Vodafone Italia SpA", vat_number: "IT08539010010" }, category: "Telefonia" },
    { entity: { name: "Mario Bianchi" }, category: "Collaboratori" },
  ]);

  it("normalizes VAT numbers and names", () => {
    expect(normalizeVat("IT 08539010010")).toBe("08539010010");
    expect(normalizeName("Vodafone Italia S.p.A.")).toBe("vodafone");
    expect(normalizeName("Studio Rossi S.r.l.s.")).toBe("studio rossi");
  });

  it("prefers the supplier history, by VAT then by name", () => {
    const byVat = suggestCategory({ supplier_name: "VODAFONE", supplier_vat_number: "08539010010" }, history);
    expect(byVat).toMatchObject({ category: "Telefonia", confidence: "high", source: "storico" });
    expect(byVat.reason).toMatch(/P\.IVA/);
    const byName = suggestCategory({ entity: { name: "Mario Bianchi" } }, history);
    expect(byName).toMatchObject({ category: "Collaboratori", confidence: "medium", source: "storico" });
  });

  it("applies keyword rules in order", () => {
    const s = (name: string, subject?: string) => suggestCategory({ supplier_name: name, subject }, new Map());
    expect(s("Enel Energia SpA").category).toBe("Utenze");
    expect(s("Eni Plenitude SpA").category).toBe("Utenze");
    expect(s("Eni Station 123").category).toBe("Carburante");
    expect(s("Iliad Italia").category).toBe("Telefono e internet");
    expect(s("Amazon Web Services EMEA").category).toBe("Software e servizi cloud");
    expect(s("Anthropic PBC").category).toBe("Software e servizi cloud");
    expect(s("TeamSystem S.p.A.").category).toBe("Software e servizi cloud");
    expect(s("Amazon EU Sarl")).toMatchObject({ category: "Acquisti", confidence: "low" });
    expect(s("Studio Rossi")).toMatchObject({ category: "Consulenze", confidence: "low" });
    expect(s("Rossi Immobiliare", "Canone di locazione ottobre").category).toBe("Affitti");
    expect(s("Pinco Pallino")).toMatchObject({ category: null, source: "nessuna" });
  });

  it("maps suggestions onto existing categories", () => {
    expect(matchExisting("Telefono e internet", ["Telefonia", "Utenze"])).toBe("Telefonia");
    expect(matchExisting("utenze", ["Utenze"])).toBe("Utenze");
    expect(matchExisting("Affitti", ["Telefonia"])).toBeUndefined();
    const defaults = ["Servizi ed edifici", "Auto ed altri veicoli", "Telefono e internet", "Server e hosting", "Spese legali e contabili"];
    expect(suggestCategory({ supplier_name: "Q8 Quaser" }, new Map(), defaults)).toMatchObject({ category: "Auto ed altri veicoli", existing: true });
    expect(suggestCategory({ supplier_name: "Aruba SpA" }, new Map(), defaults)).toMatchObject({ category: "Server e hosting", existing: true });
    expect(suggestCategory({ supplier_name: "Iliad" }, new Map(), defaults).category).toBe("Telefono e internet");
    const r = suggestCategory({ supplier_name: "TIM SpA" }, new Map(), ["Telefonia"]);
    expect(r).toMatchObject({ category: "Telefonia", existing: true });
  });
});

describe("recurringExpenses", () => {
  const exp = (name: string, date: string, gross: number, extra: any = {}) => ({
    type: "expense", date, entity: { name, ...extra }, amount_gross: gross, amount_net: Math.round((gross / 1.22) * 100) / 100, category: "Utenze",
  });
  const monthly = ["2026-01-15", "2026-02-14", "2026-03-16", "2026-04-15", "2026-05-15", "2026-06-15"].map((d, i) => exp("Enel Energia", d, i === 5 ? 140 : 100));
  const quarterly = ["2025-10-05", "2026-01-05", "2026-04-04", "2026-07-06"].map((d) => exp("Studio Rossi", d, 610));
  const irregular = ["2026-01-02", "2026-01-20", "2026-05-30", "2026-06-02"].map((d) => exp("Amazon", d, 50));
  const twice = ["2026-01-01", "2026-02-01"].map((d) => exp("Iliad", d, 9.99));

  const r = recurringExpenses([...monthly, ...quarterly, ...irregular, ...twice, { ...exp("Enel Energia", "2026-03-01", -20), type: "passive_credit_note" }], {
    today: "2026-07-10",
  });

  it("finds regular suppliers and skips irregular or rare ones", () => {
    expect(r.suppliers.map((s) => s.supplier).sort()).toEqual(["Enel Energia", "Studio Rossi"]);
    const enel = r.suppliers.find((s) => s.supplier === "Enel Energia")!;
    expect(enel).toMatchObject({ cadence: "mensile", occurrences: 6, last_date: "2026-06-15", expected_next: "2026-07-15", average_amount: 106.67, category: "Utenze" });
    expect(enel.yearly_estimate).toBeCloseTo(1280, 0);
    const rossi = r.suppliers.find((s) => s.supplier === "Studio Rossi")!;
    expect(rossi).toMatchObject({ cadence: "trimestrale", expected_next: "2026-10-06", yearly_estimate: 2440 });
  });

  it("flags price increases above the threshold and late invoices", () => {
    expect(r.price_increases).toEqual([{ supplier: "Enel Energia", last_amount: 140, previous_average: 100, pct: 40 }]);
    expect(r.late).toEqual([]);
    const later = recurringExpenses(monthly, { today: "2026-08-15" });
    expect(later.late).toEqual([{ supplier: "Enel Energia", expected_next: "2026-07-15" }]);
    expect(recurringExpenses(monthly, { today: "2026-07-01", increaseThreshold: 0.5 }).price_increases).toEqual([]);
  });

  it("groups by VAT number across name variants", () => {
    const v = ["2026-01-10", "2026-02-10", "2026-03-10"].map((d, i) => exp(i ? "Vodafone Italia SpA" : "VODAFONE", d, 30, { vat_number: "IT08539010010" }));
    expect(recurringExpenses(v, { today: "2026-03-20" }).suppliers[0]).toMatchObject({ occurrences: 3, vat_number: "08539010010" });
  });

  it("addMonths clamps to the end of the month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-10-09", -12)).toBe("2025-10-09");
  });
});

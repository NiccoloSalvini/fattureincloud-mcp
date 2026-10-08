import { describe, expect, it } from "vitest";
import { audit, clientStatement, missingStampDuty, numberingIssues, receivables, revenueSummary } from "../src/reports.js";

const inv = (o: any) => ({ type: "invoice", numeration: "", entity: { id: 1, name: "Acme" }, amount_vat: 0, ...o });

const docs = [
  inv({ id: 1, number: 1, date: "2026-01-10", amount_net: 1000, amount_gross: 1002, stamp_duty: 2,
    payments_list: [{ amount: 1002, due_date: "2026-02-10", status: "paid", paid_date: "2026-02-12" }] }),
  inv({ id: 2, number: 2, date: "2026-08-01", amount_net: 500, amount_gross: 500, e_invoice: true, ei_status: "not_sent",
    payments_list: [{ amount: 500, due_date: "2026-08-31", status: "not_paid" }] }),
  inv({ id: 4, number: 4, date: "2026-07-01", amount_net: 50, amount_gross: 50, e_invoice: true, ei_status: "discarded",
    entity: { id: 2, name: "Beta" }, payments_list: [{ amount: 50, due_date: "2026-10-30", status: "not_paid" }] }),
  { id: 5, type: "credit_note", number: 1, date: "2026-03-01", entity: { id: 1, name: "Acme" }, amount_net: 100, amount_gross: 100,
    payments_list: [{ amount: 100, status: "paid", paid_date: "2026-03-01" }] },
] as any[];

describe("receivables", () => {
  it("ages open installments and groups by client", () => {
    const r = receivables(docs, "2026-10-08");
    expect(r.total_outstanding).toBe(550);
    expect(r.total_overdue).toBe(500);
    expect(r.aging["31-60"]).toBe(500);
    expect(r.aging.non_scaduto).toBe(50);
    expect(r.by_client[0]).toMatchObject({ client: "Acme", total: 500, overdue: 500 });
  });
});

describe("revenueSummary", () => {
  it("separates issued and collected, nets credit notes", () => {
    const r = revenueSummary(docs, 2026, "2026-10-08");
    expect(r.issued.net).toBe(1450);
    expect(r.collected.gross).toBe(902);
    expect(r.collected.net_estimate).toBe(900);
    expect(r.by_month[1].collected_net).toBe(1000);
    expect(r.forfettario.remaining).toBe(85000 - 900);
    expect(r.forfettario.warning).toBeNull();
  });

  it("warns when the projection crosses the threshold", () => {
    const big = [inv({ id: 9, number: 1, date: "2026-01-02", amount_net: 70000, amount_gross: 70000,
      payments_list: [{ amount: 70000, status: "paid", paid_date: "2026-03-01" }] })];
    expect(revenueSummary(big, 2026, "2026-06-30").forfettario.warning).toMatch(/supererai/);
  });
});

describe("checks", () => {
  it("flags missing stamp duty only on VAT-free documents above 77.47", () => {
    expect(missingStampDuty(inv({ amount_net: 500 }))).toBe(true);
    expect(missingStampDuty(inv({ amount_net: 500, stamp_duty: 2 }))).toBe(false);
    expect(missingStampDuty(inv({ amount_net: 50 }))).toBe(false);
    expect(missingStampDuty(inv({ amount_net: 500, amount_vat: 110 }))).toBe(false);
  });

  it("finds numbering gaps, duplicates and out-of-order dates", () => {
    const n = numberingIssues([
      inv({ id: 1, number: 1, date: "2026-01-10" }),
      inv({ id: 2, number: 2, date: "2026-03-01" }),
      inv({ id: 3, number: 3, date: "2026-02-01" }),
      inv({ id: 4, number: 3, date: "2026-03-05" }),
      inv({ id: 5, number: 6, date: "2026-04-01" }),
      inv({ id: 6, number: 1, numeration: "/A", date: "2026-04-01" }),
    ]);
    expect(n.gaps).toEqual([{ series: "invoice (senza sezionale) 2026", missing: [4, 5] }]);
    expect(n.duplicates).toHaveLength(1);
    expect(n.out_of_order).toHaveLength(1);
  });

  it("audit collects everything", () => {
    const a = audit(docs, "2026-10-08", { check_stamp_duty: true });
    expect(a.einvoice_not_sent.map((d) => d.id)).toEqual([2]);
    expect(a.einvoice_problems.map((d) => d.id)).toEqual([4]);
    expect(a.missing_stamp_duty.map((d) => d.id)).toEqual([2]);
    expect(a.overdue_payments).toHaveLength(1);
    expect(a.numbering.gaps[0].missing).toEqual([3]);
  });

  it("client statement balances", () => {
    const s = clientStatement(docs.filter((d) => d.entity.id === 1), "2026-10-08");
    expect(s).toMatchObject({ billed: 1402, paid: 902, outstanding: 500, overdue: 500 });
  });
});

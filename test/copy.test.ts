import { describe, expect, it } from "vitest";
import { applyPlaceholders, buildCopy } from "../src/copy.js";

const source = {
  id: 26,
  type: "invoice",
  number: 26,
  numeration: "",
  date: "2026-10-02",
  year: 2026,
  entity: { id: 7, name: "Acme Srl" },
  subject: "",
  visible_subject: "Consulenza settembre",
  stamp_duty: 2,
  amount_net: 1200,
  amount_gross: 1202,
  ei_status: "not_sent",
  url: "https://x/pdf",
  locked: true,
  e_invoice: true,
  items_list: [{ id: 1, name: "Consulenza", net_price: 1200, qty: 1, vat: { id: 6, value: 0 } }],
  payments_list: [
    { id: 9, amount: 1202, due_date: "2026-11-01", status: "paid", paid_date: "2026-10-20", payment_account: { id: 3 } },
  ],
} as any;

describe("buildCopy", () => {
  it("drops identity, state and read-only fields", () => {
    const c = buildCopy(source, { date: "2026-11-05" });
    for (const k of ["id", "number", "year", "ei_status", "url", "locked", "amount_net", "amount_gross"]) expect(c).not.toHaveProperty(k);
    expect(c.items_list![0]).not.toHaveProperty("id");
    expect(c.payments_list![0]).not.toHaveProperty("id");
  });

  it("keeps client, stamp duty and e-invoice flag", () => {
    const c = buildCopy(source, { date: "2026-11-05" });
    expect(c.entity).toEqual({ id: 7, name: "Acme Srl" });
    expect(c.stamp_duty).toBe(2);
    expect(c.e_invoice).toBe(true);
  });

  it("shifts due dates by the date offset and resets payment status", () => {
    const c = buildCopy(source, { date: "2026-11-05" });
    expect(c.date).toBe("2026-11-05");
    expect(c.payments_list![0]).toMatchObject({ due_date: "2026-12-05", status: "not_paid", payment_account: { id: 3 } });
    expect(c.payments_list![0]).not.toHaveProperty("paid_date");
  });

  it("does not mutate the source", () => {
    buildCopy(source, { date: "2026-11-05", overrides: { items: [{ index: 0, net_price: 1 }] } });
    expect(source.items_list[0].net_price).toBe(1200);
    expect(source.id).toBe(26);
  });

  it("applies overrides and placeholders", () => {
    const c = buildCopy(source, {
      date: "2026-01-05",
      overrides: {
        visible_subject: "Consulenza {{mese_precedente}} {{anno_mese_precedente}}",
        items: [{ index: 0, name: "Servizi {{mese_precedente|maiuscolo}}", net_price: 3000 }],
      },
    });
    expect(c.visible_subject).toBe("Consulenza dicembre 2025");
    expect(c.items_list![0]).toMatchObject({ name: "Servizi Dicembre", net_price: 3000 });
    expect(c.items_list![0]).not.toHaveProperty("gross_price");
  });

  it("rejects overrides on missing rows", () => {
    expect(() => buildCopy(source, { date: "2026-11-05", overrides: { items: [{ index: 3, qty: 2 }] } })).toThrow(/riga 3/);
  });

  it("can change type and set an explicit number", () => {
    const c = buildCopy({ ...source, type: "proforma" }, { date: "2026-11-05", number: 40, overrides: { type: "invoice" } });
    expect(c).toMatchObject({ type: "invoice", number: 40 });
  });
});

describe("applyPlaceholders", () => {
  it("leaves unknown placeholders alone", () => {
    expect(applyPlaceholders("{{boh}} {{trimestre}} {{data}}", "2026-08-31")).toBe("{{boh}} 3 31/08/2026");
  });
  it("handles year boundaries", () => {
    expect(applyPlaceholders("{{mese_successivo}} {{anno_mese_successivo}}", "2026-12-10")).toBe("gennaio 2027");
  });
});

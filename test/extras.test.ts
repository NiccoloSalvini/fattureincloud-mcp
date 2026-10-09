import { describe, expect, it } from "vitest";
import { buildCreditNote, clientFromVies, parseItalianAddress, quadroLM, stampDeadline, stampDutyQuarters } from "../src/extras.js";
import { computeYears } from "../src/taxes.js";

const inv = (o: any) => ({ type: "invoice", numeration: "", entity: { id: 1, name: "Acme" }, amount_vat: 0, ...o });

describe("bollo virtuale", () => {
  it("deadlines per quarter, including leap years", () => {
    expect(stampDeadline(2026, 1)).toBe("2026-05-31");
    expect(stampDeadline(2026, 3)).toBe("2026-11-30");
    expect(stampDeadline(2027, 4)).toBe("2028-02-29");
    expect(stampDeadline(2026, 4)).toBe("2027-02-28");
  });

  it("counts documents with a bollo field or line, by quarter", () => {
    const r = stampDutyQuarters(
      [
        inv({ date: "2026-01-10", stamp_duty: 2 }),
        inv({ date: "2026-02-10", items_list: [{ name: "Marca da bollo", net_price: 2 }] }),
        inv({ date: "2026-02-11", type: "credit_note", stamp_duty: 2 }),
        inv({ date: "2026-05-01" }),
        inv({ date: "2026-08-01", stamp_duty: 2 }),
        inv({ date: "2026-10-02", stamp_duty: 2 }),
        inv({ date: "2025-12-30", stamp_duty: 2 }),
        { type: "proforma", date: "2026-01-02", stamp_duty: 2 },
      ] as any,
      2026,
      "2026-10-09",
    );
    expect(r.quarters.map((q) => [q.documents, q.amount, q.status])).toEqual([
      [3, 6, "chiuso"],
      [0, 0, "chiuso"],
      [1, 2, "chiuso"],
      [1, 2, "in corso"],
    ]);
    expect(r.total).toBe(10);
  });
});

describe("nota di credito", () => {
  const invoice = inv({
    id: 26, number: 26, date: "2026-10-02", stamp_duty: 2, e_invoice: true, rivalsa: 4,
    ei_data: { payment_method: "MP05" },
    items_list: [{ id: 1, name: "Consulenza", net_price: 4000, qty: 1, vat: { id: 66, value: 0 } }],
    payments_list: [{ id: 9, amount: 4162, due_date: "2026-11-01", status: "paid", payment_account: { id: 3 } }],
  });

  it("total credit note keeps lines and links the original invoice", () => {
    const n = buildCreditNote(invoice as any, { date: "2026-10-09" });
    expect(n.type).toBe("credit_note");
    expect(n).not.toHaveProperty("id");
    expect(n).not.toHaveProperty("number");
    expect(n.items_list).toHaveLength(1);
    expect(n.ei_data).toMatchObject({ payment_method: "MP05", invoice_number: "26", invoice_date: "2026-10-02" });
    expect(n.visible_subject).toMatch(/storno totale della fattura n. 26 del 02\/10\/2026/);
    expect(n.payments_list).toEqual([{ amount: 0, due_date: "2026-10-09", status: "not_paid", payment_account: { id: 3 } }]);
    expect(n.stamp_duty).toBe(2);
  });

  it("partial credit note has one line and drops the bollo under 77.47", () => {
    const n = buildCreditNote(invoice as any, { date: "2026-10-09", amount: 50, description: "Sconto concordato" });
    expect(n.items_list).toEqual([{ name: "Sconto concordato", qty: 1, net_price: 50, vat: { id: 66 } }]);
    expect(n).not.toHaveProperty("stamp_duty");
    expect(buildCreditNote(invoice as any, { date: "2026-10-09", amount: 500 }).stamp_duty).toBe(2);
  });

  it("refuses non-invoices", () => {
    expect(() => buildCreditNote({ ...invoice, type: "proforma" } as any, { date: "2026-10-09" })).toThrow(/non è una fattura/);
  });
});

describe("VIES", () => {
  it("parses Italian addresses", () => {
    expect(parseItalianAddress("VIA ARETINA N 178 \n50136 FIRENZE FI\n")).toEqual({ street: "VIA ARETINA N 178", postal_code: "50136", city: "FIRENZE", province: "FI" });
    expect(parseItalianAddress("PIAZZA DUOMO 1\n20121 MILANO MI")).toMatchObject({ city: "MILANO", province: "MI" });
  });

  it("builds client data and rejects invalid numbers", () => {
    const c = clientFromVies({ isValid: true, name: "ACME SRL", address: "VIA ROMA 1 \n00184 ROMA RM\n", vatNumber: "01234567890" });
    expect(c).toMatchObject({ name: "ACME SRL", vat_number: "01234567890", address_street: "Via Roma 1", address_postal_code: "00184", address_city: "Roma", address_province: "RM", country: "Italia" });
    expect(() => clientFromVies({ isValid: false, userError: "INVALID" })).toThrow(/non valida/);
    expect(() => clientFromVies({ isValid: false, userError: "MS_MAX_CONCURRENT_REQ" })).toThrow(/temporaneamente/);
  });
});

describe("quadro LM", () => {
  it("maps the yearly model onto the LM lines", () => {
    const p = { coefficient: 0.67, tax_rate: 0.05, start_year: 2024, inps: { type: "gestione_separata" as const } };
    const y = computeYears(p, { 2024: 15672.8, 2025: 32000 }, 2024, 2025).get(2025)!;
    const lm = quadroLM(y, "62.01.00", 0.67);
    const get = (r: string) => lm.righi.find((x) => x.rigo === r)!;
    expect(get("LM22").valori).toMatchObject({ codice_attivita: "62.01.00", ricavi: 32000, reddito: 21440 });
    expect(get("LM34").valore).toBe(21440);
    expect(get("LM36").valore).toBe(y.taxable_income);
    expect(get("LM39").valore).toBe(y.tax_due);
  });
});

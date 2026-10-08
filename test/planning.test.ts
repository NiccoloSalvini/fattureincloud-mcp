import { describe, expect, it } from "vitest";
import { forecast, monthlySetAside, monthRange, recurringCollection } from "../src/cashflow.js";
import { buildIcs } from "../src/ics.js";
import { invoicesCsv, toCsv } from "../src/accountant.js";

describe("monthlySetAside", () => {
  it("finds the binding deadline", () => {
    // from 8 Oct: Nov 30 (2 months: Oct, Nov) needs 1000; Jun 30 (9 months) needs 1000 + 4400
    const r = monthlySetAside(
      [
        { date: "2026-11-30", amount: 1000 },
        { date: "2027-06-30", amount: 4400 },
      ],
      "2026-10-08",
    );
    expect(r.checkpoints.map((c) => c.months_available)).toEqual([2, 9]);
    expect(r.monthly).toBe(600);
  });

  it("accounts for what is already set aside", () => {
    expect(monthlySetAside([{ date: "2026-11-30", amount: 1000 }], "2026-10-08", 1000).monthly).toBe(0);
  });
});

describe("forecast", () => {
  it("builds monthly rows, running balance and warnings", () => {
    const r = forecast(
      [
        { date: "2026-09-01", amount: 500, kind: "credito_scaduto", label: "vecchia" },
        { date: "2026-10-20", amount: 1000, kind: "credito", label: "a" },
        { date: "2026-11-30", amount: -2500, kind: "tasse", label: "acconto" },
        { date: "2027-01-10", amount: 1200, kind: "ricorrente", label: "r" },
        { date: "2028-01-10", amount: 9999, kind: "credito", label: "fuori orizzonte" },
      ],
      { today: "2026-10-08", months: 4, opening_balance: 800 },
    );
    expect(r.months.map((m) => m.month)).toEqual(["2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(r.months[0]).toMatchObject({ crediti: 1000, crediti_scaduti: 500, balance: 2300 });
    expect(r.months[1]).toMatchObject({ tasse: -2500, balance: -200 });
    expect(r.months[3].balance).toBe(1000);
    expect(r.totals.entrate).toBe(2700);
    expect(r.warnings.some((w) => w.includes("2026-11"))).toBe(true);
    expect(r.set_aside.monthly).toBe(1250);
  });

  it("month helpers", () => {
    expect(monthRange("2026-11-30", 3)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(recurringCollection("2026-11-05", "2026-10-02", "2026-11-01")).toBe("2026-12-05");
    expect(recurringCollection("2026-11-05", "2026-10-02", null)).toBe("2026-11-05");
  });
});

describe("ics", () => {
  it("writes valid all-day events with alarms and folded lines", () => {
    const ics = buildIcs(
      [{ uid: "x@y", date: "2026-11-30", summary: "F24: 1.234,56 €; acconto", description: "riga 1\nriga 2 ".repeat(10), alarms: [7] }],
      { name: "Test", now: new Date("2026-10-08T10:00:00Z") },
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261130\r\nDTEND;VALUE=DATE:20261201");
    expect(ics).toContain("SUMMARY:F24: 1.234\\,56 €\; acconto");
    expect(ics).toContain("TRIGGER:-P7D");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});

describe("csv", () => {
  it("uses Italian formatting, quoting and BOM", () => {
    expect(toCsv(["a", "b"], [["x;y", 'di "lui"']])).toBe('﻿a;b\r\n"x;y";"di ""lui"""\r\n');
    const csv = invoicesCsv([
      { type: "credit_note", number: 1, numeration: "", date: "2026-03-01", entity: { name: "Acme" }, amount_net: 100, amount_vat: 0, amount_gross: 100, payments_list: [] },
    ] as any);
    expect(csv).toContain("Nota di credito;1;2026-03-01;Acme;;;-100,00;0,00;0,00;-100,00");
  });
});


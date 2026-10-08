import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nextOccurrence, ScheduleStore, upcoming } from "../src/schedules.js";

const monthly = { start_date: "2026-01-05", every_months: 1, day_of_month: 5 };

describe("nextOccurrence", () => {
  it("finds the next monthly date, inclusive by default", () => {
    expect(nextOccurrence(monthly, "2026-10-05")).toBe("2026-10-05");
    expect(nextOccurrence(monthly, "2026-10-05", true)).toBe("2026-11-05");
    expect(nextOccurrence(monthly, "2026-10-06")).toBe("2026-11-05");
  });

  it("clamps day 31 to the end of the month", () => {
    const eom = { start_date: "2026-01-01", every_months: 1, day_of_month: 31 };
    expect(upcoming({ ...eom, next_run: "2026-01-31" }, 4)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("keeps quarterly alignment with the start month", () => {
    const q = { start_date: "2026-02-10", every_months: 3, day_of_month: 10 };
    expect(nextOccurrence(q, "2026-03-01")).toBe("2026-05-10");
    expect(upcoming({ ...q, next_run: "2026-05-10" }, 3)).toEqual(["2026-05-10", "2026-08-10", "2026-11-10"]);
  });

  it("never returns a date before start_date", () => {
    expect(nextOccurrence({ start_date: "2026-03-20", every_months: 1, day_of_month: 5 }, "2026-01-01")).toBe("2026-04-05");
  });

  it("stops after end_date", () => {
    expect(nextOccurrence({ ...monthly, end_date: "2026-12-31" }, "2026-12-06")).toBeNull();
  });
});

describe("ScheduleStore", () => {
  const base = {
    name: "Acme",
    company_id: 1,
    source_document_id: 26,
    every_months: 1,
    day_of_month: 5,
    start_date: "2026-01-01",
    action: "create" as const,
    enabled: true,
  };

  it("adds, updates and removes schedules", async () => {
    const store = new ScheduleStore(await mkdtemp(path.join(os.tmpdir(), "fic-")));
    const s = await store.add(base, "2026-10-08");
    expect(s.next_run).toBe("2026-11-05");
    await expect(store.add(base, "2026-10-08")).rejects.toThrow(/Esiste già/);

    const u = await store.update("Acme", { day_of_month: 20 }, "2026-10-08");
    expect(u.next_run).toBe("2026-10-20");
    const forced = await store.update(s.id, { next_run: "2026-10-08" });
    expect(forced.next_run).toBe("2026-10-08");

    await store.remove(s.id);
    expect(await store.load()).toEqual([]);
  });

  it("validates input", async () => {
    const store = new ScheduleStore(await mkdtemp(path.join(os.tmpdir(), "fic-")));
    await expect(store.add({ ...base, day_of_month: 0 })).rejects.toThrow(/day_of_month/);
    await expect(store.add({ ...base, start_date: "05/01/2026" })).rejects.toThrow(/Data non valida/);
  });

  it("refuses concurrent runs", async () => {
    const store = new ScheduleStore(await mkdtemp(path.join(os.tmpdir(), "fic-")));
    let inner: Promise<unknown> | undefined;
    await store.withLock(async () => {
      inner = store.withLock(async () => "never");
      await expect(inner).rejects.toThrow(/in corso/);
    });
    expect(await store.withLock(async () => "free")).toBe("free");
  });
});

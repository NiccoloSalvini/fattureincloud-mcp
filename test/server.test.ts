import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { FicClient } from "../src/client.js";
import { ScheduleStore } from "../src/schedules.js";
import { createServer, parseToolsets } from "../src/server.js";
import { fakeApi } from "./fake-api.js";
import { writeFile } from "node:fs/promises";
import { intesaXlsx } from "./fixtures.js";

let api: ReturnType<typeof fakeApi>;
let mcp: Client;
let store: ScheduleStore;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res: any = await mcp.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

beforeEach(async () => {
  api = fakeApi();
  store = new ScheduleStore(await mkdtemp(path.join(os.tmpdir(), "fic-")));
  const server = createServer(new FicClient({ token: "t", fetchImpl: api.fetchImpl }), { store });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(b);
});

describe("tool catalogue", () => {
  it("covers CRUD for every resource plus automation and reports", async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const r of ["issued_document", "received_document", "client", "supplier", "product", "receipt", "f24", "archive_document", "cashbook_entry"]) {
      for (const verb of ["get", "create", "update", "delete"]) expect(names).toContain(`${verb}_${r}`);
    }
    for (const n of [
      "list_companies", "get_company_info", "lookup", "upload_attachment", "get_einvoice_xml", "duplicate_document", "bulk_duplicate",
      "transform_document", "join_documents", "mark_paid", "send_einvoice", "bulk_send_einvoice", "email_document", "bulk_email",
      "get_document_pdf", "schedule_create", "schedule_run_due", "receivables_report", "revenue_summary", "audit_documents",
      "client_statement", "api_request", "recover_document", "tax_profile_set", "tax_estimate", "regime_simulator", "cashflow_forecast", "tax_deadlines_export", "accountant_package", "bank_reconcile", "bank_link_start",
    ]) expect(names).toContain(n);
    expect(names.length).toBeGreaterThan(70);
  });

  it("toolsets restrict the catalogue", () => {
    expect([...parseToolsets("documents")]).toEqual(["documents", "admin"]);
    expect(() => parseToolsets("boh")).toThrow(/sconosciuti/);
  });

  it("exposes the prompts", async () => {
    const prompts = (await mcp.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["chiusura_mese", "nuova_ricorrenza"]);
  });
});

describe("documents", () => {
  it("duplicate_document creates a clean copy with automatic numbering", async () => {
    const r = await call("duplicate_document", { source_id: 26, date: "2026-11-05" });
    expect(r.created).toMatchObject({ number: 27, date: "2026-11-05", client: "Acme Srl" });
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/c/1/issued_documents")!;
    expect(post.body.options).toEqual({ fix_payments: true });
    expect(post.body.data).not.toHaveProperty("id");
    expect(post.body.data).not.toHaveProperty("number");
    expect(post.body.data.stamp_duty).toBe(2);
  });

  it("dry_run creates nothing", async () => {
    const r = await call("duplicate_document", { source_id: 26, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("send_einvoice does not send when the XML check fails", async () => {
    api.state.verifyOk = false;
    const r = await call("send_einvoice", { id: 26 });
    expect(r).toMatchObject({ verified: false, sent: false });
    expect(api.state.sent).toEqual([]);
  });

  it("mark_paid closes open installments", async () => {
    const [r] = await call("mark_paid", { ids: [26], paid_date: "2026-10-08" });
    expect(r.payments[0]).toMatchObject({ status: "paid", paid_date: "2026-10-08" });
  });

  it("email_document uses Fatture in Cloud defaults", async () => {
    await call("email_document", { id: 26 });
    expect(api.state.emails[0]).toMatchObject({ sender_id: 5, recipient_email: "amministrazione@acme.example", attach_pdf: true });
  });

  it("API errors come back as readable tool errors", async () => {
    await expect(call("get_issued_document", { id: 999 })).rejects.toThrow(/404.*Not found/);
  });

  it("bulk tools default to dry run", async () => {
    const r = await call("bulk_send_einvoice", { ids: [26] });
    expect(r.ok).toBe(1);
    expect(api.state.sent).toEqual([]);
  });
});

describe("schedules", () => {
  it("creates, previews and runs a recurring invoice exactly once", async () => {
    const { schedule } = await call("schedule_create", {
      name: "Acme mensile",
      source_document_id: 26,
      day_of_month: 5,
      start_date: "2026-01-01",
      action: "create_and_send_sdi",
      email: { enabled: true },
      overrides: { visible_subject: "Consulenza {{mese_precedente}} {{anno_mese_precedente}}" },
    });
    expect(schedule.company_id).toBe(1);

    // force it due today
    await call("schedule_update", { id: schedule.id, next_run: "2026-01-05" });
    const preview = await call("schedule_run_due", {});
    expect(preview[0].run.status).toBe("dry_run");
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/c/1/issued_documents")).toBe(false);

    const [report] = await call("schedule_run_due", { dry_run: false });
    expect(report.run).toMatchObject({ status: "ok", number: 27, sent_sdi: true, emailed: true });
    expect(api.state.sent).toEqual([100]);
    expect(api.docs.get(100).visible_subject).toMatch(/^Consulenza \w+ \d{4}$/);

    // second run the same day does nothing
    const again = await call("schedule_run_due", { dry_run: false });
    expect(again.message).toMatch(/Nessuna/);
    const saved = await store.get(schedule.id);
    expect(saved.history).toHaveLength(1);
    expect(saved.next_run! > "2026-01-05").toBe(true);
  });
});

describe("taxes", () => {
  it("requires a profile, then estimates from collected invoices", async () => {
    await expect(call("tax_estimate", { year: 2026 })).rejects.toThrow(/tax_profile_set/);
    await call("tax_profile_set", { coefficient: 0.78, tax_rate: 0.15, start_year: 2026 });
    api.docs.get(26).payments_list[0] = { amount: 1202, status: "paid", paid_date: "2026-03-01" };
    const r = await call("tax_estimate", { year: 2026, projection: "to_date" });
    expect(r.collected_to_date).toBe(1202);
    expect(r.year_summary.gross_income).toBeCloseTo(937.56, 2);
    expect(r.deadlines.at(-1).date).toBe("2027-06-30");
  });
});

describe("planning", () => {
  beforeEach(async () => {
    await call("tax_profile_set", { coefficient: 0.78, tax_rate: 0.15, start_year: 2024, overrides: { "2025": { revenue: 30000 } } });
  });

  it("cashflow_forecast combines receivables, recurring invoices and taxes", async () => {
    const { schedule } = await call("schedule_create", { name: "Acme mensile", source_document_id: 26, day_of_month: 5 });
    const r = await call("cashflow_forecast", { months: 12, opening_balance: 5000 });
    const all = r.months.flatMap((m: any) => m.events.map((e: any) => e.what));
    expect(all.some((w: string) => w.startsWith("Acme Srl: fattura 26"))).toBe(true);
    expect(all.filter((w: string) => w.startsWith("Acme mensile")).length).toBeGreaterThanOrEqual(10);
    expect(r.months.some((m: any) => m.tasse < 0)).toBe(true);
    expect(r.set_aside.monthly).toBeGreaterThan(0);
    expect(schedule.id).toBeTruthy();
  });

  it("planned payments (rateizzazione) enter the forecast", async () => {
    await call("tax_profile_set", { planned_payments: [{ date: "2099-01-16", amount: 1030.5, label: "Rata 6/6 rateizzazione" }] });
    const r = await call("tax_deadlines_export", {});
    expect(r.deadlines.at(-1)).toMatchObject({ date: "2099-01-16", total: 1030.5, planned: true });
  });

  it("tax_deadlines_export writes an ics and creates F24 once", async () => {
    const dir = store.dir;
    const r = await call("tax_deadlines_export", { ics_path: dir, create_f24: true, dry_run: false });
    expect(await readFile(r.ics, "utf8")).toContain("BEGIN:VEVENT");
    const created = api.state.f24.length;
    expect(created).toBeGreaterThan(0);
    const again = await call("tax_deadlines_export", { create_f24: true, dry_run: false });
    expect(again.f24.actions.every((x: any) => x.action === "update")).toBe(true);
    expect(api.state.f24.length).toBe(created);
  });

  it("accountant_package builds a zip with csv, pdf, xml and summary", async () => {
    const r = await call("accountant_package", { year: 2026, output_dir: store.dir });
    const files = unzipSync(new Uint8Array(await readFile(r.zip)));
    const names = Object.keys(files);
    expect(names).toEqual(
      expect.arrayContaining([
        "commercialista-2026/fatture.csv",
        "commercialista-2026/incassi.csv",
        "commercialista-2026/spese.csv",
        "commercialista-2026/riepilogo.md",
        expect.stringMatching(/pdf\/2026-FT-026-Acme_Srl\.pdf$/),
        expect.stringMatching(/xml\/.*\.xml$/),
      ]),
    );
    expect(strFromU8(files["commercialista-2026/fatture.csv"])).toContain("IT01234567890");
    expect(strFromU8(files["commercialista-2026/riepilogo.md"])).toContain("Stima imposta e contributi");
  });
});

describe("bank", () => {
  it("bank_reconcile proposes in dry run, then marks the installment paid on the transfer date", async () => {
    const file = path.join(store.dir, "lista.xlsx");
    await writeFile(file, intesaXlsx());
    const preview = await call("bank_reconcile", { file_path: file });
    expect(preview.source).toMatch(/Intesa/);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0]).toMatchObject({ confidence: "high", fattura: { id: 26 }, will_apply: true });
    expect(api.docs.get(26).payments_list[0].status).toBe("not_paid");

    const done = await call("bank_reconcile", { file_path: file, dry_run: false });
    expect(done.applied[0]).toMatchObject({ document_id: 26, paid_date: "2026-10-05" });
    expect(api.docs.get(26).payments_list[0]).toMatchObject({ status: "paid", paid_date: "2026-10-05", payment_account: { id: 3 } });

    const again = await call("bank_reconcile", { file_path: file });
    expect(again.matches).toHaveLength(0);
  });

  it("bank_link_start explains missing configuration", async () => {
    delete process.env.ENABLE_BANKING_APP_ID;
    await expect(call("bank_link_start", {})).rejects.toThrow(/ENABLE_BANKING_APP_ID/);
  });
});

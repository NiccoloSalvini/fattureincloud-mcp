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
      "client_statement", "api_request", "recover_document", "list_pending_received_documents", "get_pending_received_document", "register_pending_received_documents", "suggest_expense_categories", "recurring_expenses_report", "tax_profile_set", "tax_estimate", "regime_simulator", "preview_totals", "create_credit_note", "client_from_vat", "lookup_city", "stamp_duty_report", "quadro_lm", "list_price_lists", "receipts_monthly_totals", "update_payment_account", "create_vat_type", "cashflow_forecast", "tax_deadlines_export", "accountant_package", "bank_reconcile", "bank_link_start",
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
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/c/1/issued_documents")).toBe(false);
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

describe("fatture passive", () => {
  const posts = () => api.calls.filter((c) => c.method === "POST" && c.path === "/c/1/received_documents");

  it("list_pending_received_documents summarizes SdI invoices with totals", async () => {
    const r = await call("list_pending_received_documents", {});
    expect(r.count).toBe(2);
    expect(r.totals).toEqual({ amount_net: 150, amount_vat: 33, amount_gross: 183 });
    expect(r.documents[0]).toMatchObject({
      id: 501, supplier: "Enel Energia S.p.A.", date: "2026-10-01", received_at: "2026-10-02 00:11:45", invoice_number: "E-123",
      xml: true, attachment: true, next_due_date: "2026-10-20",
    });
    expect(r.documents[1]).toMatchObject({ id: 502, vat_number: "08539010010", installments: 2 });
    const before = api.calls.length;
    const all = await call("list_pending_received_documents", { source: "all" });
    expect(all.count).toBe(3);
    // the API ignores the type filter: one listing is enough
    expect(api.calls.length - before).toBe(1);
    expect((await call("get_pending_received_document", { id: 503 })).supplier_name).toBe("Studio Rossi");
  });

  it("suggest_expense_categories uses history first, then rules, on existing categories", async () => {
    const r = await call("suggest_expense_categories", { source: "all" });
    const by = Object.fromEntries(r.map((x: any) => [x.id, x]));
    expect(by[502]).toMatchObject({ category: "Telefonia", confidence: "high", source: "storico", existing: true });
    expect(by[501]).toMatchObject({ category: "Servizi ed edifici", source: "regola", existing: true });
    expect(by[503]).toMatchObject({ category: "Spese legali e contabili", confidence: "low", existing: true });
    const free = await call("suggest_expense_categories", { documents: [{ supplier: "GitHub Inc" }] });
    expect(free[0]).toMatchObject({ supplier: "GitHub Inc", category: "Server e hosting" });
  });

  it("register dry run shows the documents and creates nothing", async () => {
    const r = await call("register_pending_received_documents", { all: true, default_category: "Varie" });
    expect(r).toMatchObject({ dry_run: true, to_create: 2 });
    expect(r.documents[1].payments_list).toEqual([{ amount: 61, due_date: "2026-10-31", status: "not_paid" }]);
    expect(posts()).toHaveLength(0);
    expect(api.pending.size).toBe(3);
    await expect(call("register_pending_received_documents", {})).rejects.toThrow(/ids/);
  });

  it("registers with pending_id, payments covering amount_gross, and removes pending on request", async () => {
    const r = await call("register_pending_received_documents", {
      ids: [501, 502, 503],
      categories: { "503": "Consulenze" },
      auto_category: true,
      paid: true,
      paid_date: "2026-10-08",
      payment_account_id: 3,
      remove_pending: true,
      dry_run: false,
    });
    expect(r).toMatchObject({ ok: 3, failed: 0 });
    expect(posts().map((c) => c.body.pending_id)).toEqual([501, 502, 503]);
    for (const res of r.results) {
      const doc = api.received.get(res.received_document_id);
      expect(doc.is_from_pending_expenses).toBe(true);
      const paid = doc.payments_list.reduce((s: number, x: any) => s + x.amount, 0);
      expect(paid).toBeCloseTo(doc.amount_gross, 2);
      expect(doc.payments_list.every((x: any) => x.status === "paid" && x.paid_date === "2026-10-08" && x.payment_account.id === 3)).toBe(true);
      expect(res.pending_removed).toBe(true);
    }
    expect(r.results.map((x: any) => x.category)).toEqual(["Servizi ed edifici", "Telefonia", "Consulenze"]);
    expect(api.pending.size).toBe(0);
  });

  it("keeps pending entries unless remove_pending is set", async () => {
    const r = await call("register_pending_received_documents", { ids: [501], dry_run: false });
    expect(r.ok).toBe(1);
    expect(r.results[0].pending_removed).toBeUndefined();
    expect(api.pending.has(501)).toBe(true);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a refused pending DELETE is reported without failing the registration", async () => {
    api.state.pendingDelete = false;
    const r = await call("register_pending_received_documents", { ids: [501], remove_pending: true, dry_run: false });
    expect(r).toMatchObject({ ok: 1, failed: 0 });
    expect(r.results[0]).toMatchObject({ pending_removed: false, pending_note: expect.stringMatching(/405/) });
  });

  it("recurring_expenses_report reads received documents with one listing", async () => {
    const r = await call("recurring_expenses_report", {});
    expect(r).toMatchObject({ months: 12, recurring_suppliers: 0 });
    expect(api.calls.filter((c) => c.path === "/c/1/received_documents")).toHaveLength(1);
  });
});

describe("0.5 tools", () => {
  it("duplicate dry run includes Fatture in Cloud totals", async () => {
    const r = await call("duplicate_document", { source_id: 26, dry_run: true });
    expect(r.totals).toMatchObject({ amount_net: 1200, stamp_duty: 2 });
  });

  it("create_credit_note previews, then creates a linked credit note", async () => {
    const preview = await call("create_credit_note", { invoice_id: 26, amount: 200, description: "Sconto" });
    expect(preview.dry_run).toBe(true);
    expect(preview.totals.amount_net).toBe(200);
    const done = await call("create_credit_note", { invoice_id: 26, dry_run: false });
    expect(done.created.type).toBe("credit_note");
    const post = api.calls.filter((c) => c.method === "POST" && c.path === "/c/1/issued_documents").at(-1)!;
    expect(post.body.data.ei_data).toMatchObject({ invoice_number: "26", invoice_date: "2026-10-02" });
  });

  it("client_from_vat uses VIES and normalises the city", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ isValid: true, name: "ACME SRL", address: "VIA ROMA 1 \n00184 ROMA RM\n", vatNumber: "01234567890" }), { status: 200 })) as typeof fetch;
    try {
      const r = await call("client_from_vat", { vat_number: "IT01234567890" });
      expect(r.client).toMatchObject({ name: "ACME SRL", address_city: "Roma", address_province: "RM", tax_code: "01234567890" });
      expect(r.missing[0]).toMatch(/codice destinatario/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

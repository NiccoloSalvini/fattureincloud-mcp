import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { intesaXlsx } from "./fixtures.js";
import { EnableBanking, mapEbTransaction, signJwt } from "../src/bank/enablebanking.js";
import { mentionsInvoiceNumber, nameTokens, openItems, reconcile } from "../src/bank/match.js";
import { parseAmount, parseDate, parseStatement } from "../src/bank/parse.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("value parsing", () => {
  it("amounts in Italian and English formats", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("-14,49")).toBe(-14.49);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("1.200")).toBe(1200);
    expect(parseAmount("€ 99,90")).toBe(99.9);
    expect(parseAmount("12,00-")).toBe(-12);
    expect(parseAmount("")).toBeNull();
  });
  it("dates in every bank flavour", () => {
    expect(parseDate("05/10/2026")).toBe("2026-10-05");
    expect(parseDate("05.10.26")).toBe("2026-10-05");
    expect(parseDate("2026-10-05 10:22:01")).toBe("2026-10-05");
    expect(parseDate("29 gennaio 2026")).toBe("2026-01-29");
    expect(parseDate(46300)).toBe("2026-10-05");
  });
});

describe("parseStatement", () => {
  it("Intesa XLSX: finds the header below metadata, skips non-booked rows", () => {
    const s = parseStatement(intesaXlsx(), "lista.xlsx");
    expect(s.bank).toBe("intesa");
        expect(s.transactions).toHaveLength(2);
    expect(s.transactions[0]).toMatchObject({ date: "2026-10-05", amount: 1202, description: "Bonifico a vostro favore — ACME SRL - SALDO FT 26/2026" });
    expect(s.skipped_rows).toBe(1);
  });

  it("UniCredit CSV", () => {
    const csv = "Data Registrazione;Data valuta;Descrizione;Importo (EUR)\n05.10.2026;05.10.2026;BONIFICO DA ACME SRL;1.202,00\n06.10.2026;06.10.2026;COMMISSIONI;-1,50\n";
    const s = parseStatement(enc(csv), "movimenti.csv");
    expect(s.bank).toBe("unicredit");
    expect(s.transactions.map((t) => t.amount)).toEqual([1202, -1.5]);
  });

  it("Revolut CSV keeps only completed rows and nets fees", () => {
    const csv = [
      "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
      "TOPUP,Current,2026-10-01 09:00:00,2026-10-01 09:01:00,Payment from Acme Srl,1202.00,0.00,EUR,COMPLETED,1300",
      "CARD_PAYMENT,Current,2026-10-02 09:00:00,,Bar,-3.00,0.00,EUR,PENDING,1297",
    ].join("\n");
    const s = parseStatement(enc(csv), "revolut.csv");
    expect(s.bank).toBe("revolut");
    expect(s.transactions).toEqual([expect.objectContaining({ date: "2026-10-01", amount: 1202 })]);
  });

  it("unknown bank: automatic column detection and Windows-1252 encoding", () => {
    const latin1 = Buffer.from("Data operazione;Causale;Avere;Dare\n05/10/2026;Bonifico Società Acme;1.202,00;\n", "latin1");
    const s = parseStatement(new Uint8Array(latin1), "export.csv");
    expect(s.bank).toBe("generic");
    expect(s.transactions[0]).toMatchObject({ amount: 1202, description: "Bonifico Società Acme" });
  });

  it("explicit mapping", () => {
    const csv = "Quando;Quanto;Note\n2026-10-05;1202;Acme\n";
    const s = parseStatement(enc(csv), "x.csv", { mapping: { date: "Quando", amount: "Quanto", description: "Note" } });
    expect(s.transactions[0]).toMatchObject({ date: "2026-10-05", amount: 1202, description: "Acme" });
  });

  it("explains unknown formats", () => {
    expect(() => parseStatement(enc("a;b\n1;2\n"), "x.csv")).toThrow(/Formato non riconosciuto/);
  });
});

const doc = (o: any) => ({ type: "invoice", numeration: "", entity: { id: 1, name: "Acme Srl", vat_number: "IT01234567890" }, ...o });

describe("matching", () => {
  it("helpers", () => {
    expect(nameTokens("Studio Rossi & Bianchi S.r.l.")).toEqual(["rossi", "bianchi"]);
    expect(mentionsInvoiceNumber("SALDO FT 26/2026", 26, "2026-10-02")).toBe(true);
    expect(mentionsInvoiceNumber("fattura n. 026", 26, "2026-10-02")).toBe(true);
    expect(mentionsInvoiceNumber("rif 126", 26, "2026-10-02")).toBe(false);
  });

  it("scores and assigns one-to-one, oldest first on ties", () => {
    const docs = [
      doc({ id: 1, number: 26, date: "2026-10-02", payments_list: [{ amount: 1202, status: "not_paid", due_date: "2026-11-01" }] }),
      doc({ id: 2, number: 27, date: "2026-10-03", payments_list: [{ amount: 1202, status: "not_paid", due_date: "2026-11-02" }] }),
      doc({ id: 3, number: 28, date: "2026-10-03", entity: { name: "Beta Spa" }, payments_list: [{ amount: 300, status: "not_paid", due_date: "2026-11-02" }, { amount: 300, status: "not_paid", due_date: "2026-12-02" }] }),
    ];
    const txs = [
      { date: "2026-10-05", amount: 1202, description: "BONIFICO ACME SRL SALDO FT 26/2026", bank: "x" },
      { date: "2026-10-06", amount: 1202, description: "BONIFICO ACME", bank: "x" },
      { date: "2026-10-07", amount: 600, description: "BETA SPA", bank: "x" },
      { date: "2026-10-08", amount: 77, description: "rimborso", bank: "x" },
      { date: "2026-10-08", amount: -50, description: "uscita", bank: "x" },
    ];
    const r = reconcile(txs, openItems(docs as any));
    expect(r.matches.map((m) => [m.item.document_id, m.confidence])).toEqual([
      [1, "high"],
      [2, "high"],
      [3, "high"],
    ]);
    expect(r.matches[2].item.installments).toEqual([0, 1]);
    expect(r.unmatched_credits.map((t) => t.amount)).toEqual([77]);
  });

  it("amount alone is low confidence; payment before the invoice is penalised", () => {
    const docs = [doc({ id: 1, number: 5, date: "2026-10-02", payments_list: [{ amount: 100, status: "not_paid" }] })];
    expect(reconcile([{ date: "2026-10-05", amount: 100, description: "bonifico", bank: "x" }], openItems(docs as any)).matches[0].confidence).toBe("low");
    expect(reconcile([{ date: "2026-08-01", amount: 100, description: "bonifico", bank: "x" }], openItems(docs as any)).matches).toHaveLength(0);
  });

  it("flags a transfer that fits two open invoices equally well", () => {
    const docs = [
      doc({ id: 1, number: 5, date: "2026-09-02", payments_list: [{ amount: 500, status: "not_paid", due_date: "2026-10-02" }] }),
      doc({ id: 2, number: 6, date: "2026-09-03", payments_list: [{ amount: 500, status: "not_paid", due_date: "2026-10-02" }] }),
    ];
    const m = reconcile([{ date: "2026-10-05", amount: 500, description: "ACME SRL", bank: "x" }], openItems(docs as any)).matches[0];
    expect(m.confidence).toBe("medium");
    expect(m.reasons.at(-1)).toMatch(/ambiguo/);
  });

  it("tolerates up to 2 € short (unpaid stamp duty)", () => {
    const docs = [doc({ id: 1, number: 5, date: "2026-10-02", payments_list: [{ amount: 1202, status: "not_paid" }] })];
    const m = reconcile([{ date: "2026-10-05", amount: 1200, description: "ACME SRL fattura 5", bank: "x" }], openItems(docs as any)).matches[0];
    expect(m.confidence).toBe("high");
    expect(m.reasons[0]).toMatch(/inferiore di 2.00/);
  });
});

describe("Enable Banking", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs a verifiable RS256 JWT with the expected claims", () => {
    const jwt = signJwt("app-123", pem, 1_700_000_000);
    const [h, b, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ typ: "JWT", alg: "RS256", kid: "app-123" });
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toEqual({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: 1_700_000_000, exp: 1_700_003_600 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${b}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("paginates transactions and maps them", async () => {
    const calls: string[] = [];
    const fake = (async (url: any) => {
      const u = new URL(String(url));
      calls.push(u.pathname + u.search);
      const page2 = u.searchParams.get("continuation_key") === "k2";
      return new Response(
        JSON.stringify({
          transactions: page2
            ? [{ transaction_amount: { amount: "50.00", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-10-06", creditor: { name: "Aruba" } }]
            : [{ transaction_amount: { amount: "1202.00", currency: "EUR" }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-10-05", debtor: { name: "ACME SRL" }, remittance_information: ["FT 26/2026"] }],
          continuation_key: page2 ? null : "k2",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new EnableBanking({ appId: "a", privateKey: pem, redirectUrl: "https://x" }, fake);
    const txs = (await client.transactions("acc-1", "2026-10-01")).map((t) => mapEbTransaction(t));
    expect(calls).toHaveLength(2);
    expect(txs).toEqual([
      expect.objectContaining({ date: "2026-10-05", amount: 1202, description: "ACME SRL — FT 26/2026", counterparty: "ACME SRL" }),
      expect.objectContaining({ amount: -50, counterparty: "Aruba" }),
    ]);
    expect(mapEbTransaction({ status: "PDNG", transaction_amount: { amount: "1" }, booking_date: "2026-10-01" })).toBeNull();
  });
});

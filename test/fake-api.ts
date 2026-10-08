/** In-memory fake of the Fatture in Cloud API, enough for end-to-end tests. */
export function fakeApi() {
  const docs = new Map<number, any>();
  const calls: { method: string; path: string; body?: any }[] = [];
  let nextId = 100;
  let nextNumber = 27;
  const state = { verifyOk: true, emails: [] as any[], sent: [] as number[], f24: [] as any[] };

  docs.set(26, {
    id: 26, type: "invoice", number: 26, numeration: "", date: "2026-10-02",
    entity: { id: 7, name: "Acme Srl", vat_number: "IT01234567890" }, url: "https://files.example/26.pdf", visible_subject: "Consulenza", stamp_duty: 2, e_invoice: true, ei_status: "not_sent",
    amount_net: 1200, amount_gross: 1202, amount_vat: 0,
    items_list: [{ id: 1, name: "Consulenza", net_price: 1200, qty: 1, vat: { id: 6, value: 0 } }],
    payments_list: [{ id: 9, amount: 1202, due_date: "2026-11-01", status: "not_paid", payment_account: { id: 3 } }],
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const p = url.pathname;
    calls.push({ method, path: p, body });
    let m: RegExpMatchArray | null;

    if (url.host === "files.example") return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    if (p === "/user/companies") return json({ data: { companies: [{ id: 1, name: "Studio" }] } });
    if (p === "/c/1/issued_documents" && method === "GET")
      return json({ current_page: 1, last_page: 1, total: docs.size, data: [...docs.values()].filter((d) => d.type === url.searchParams.get("type")) });
    if (p === "/c/1/issued_documents" && method === "POST") {
      const d = { ...body.data, id: nextId++, number: body.data.number ?? nextNumber++, amount_net: 1200, amount_gross: 1202 };
      docs.set(d.id, d);
      return json({ data: d });
    }
    if ((m = p.match(/^\/c\/1\/issued_documents\/(\d+)$/))) {
      const d = docs.get(Number(m[1]));
      if (!d) return json({ error: { message: "Not found" } }, 404);
      if (method === "PUT") {
        Object.assign(d, body.data);
        return json({ data: d });
      }
      if (method === "DELETE") {
        docs.delete(d.id);
        return json(null);
      }
      return json({ data: d });
    }
    if ((m = p.match(/^\/c\/1\/issued_documents\/(\d+)\/e_invoice\/xml_verify$/)))
      return state.verifyOk ? json({ data: { success: true } }) : json({ error: { message: "Campo mancante: CodiceDestinatario" } }, 422);
    if ((m = p.match(/^\/c\/1\/issued_documents\/(\d+)\/e_invoice\/send$/))) {
      if (!body.options?.dry_run) state.sent.push(Number(m[1]));
      return json({ data: { name: "IT0123_00001.xml", date: "2026-10-08" } });
    }
    if ((m = p.match(/^\/c\/1\/issued_documents\/(\d+)\/email$/))) {
      if (method === "GET")
        return json({ data: { recipient_email: "amministrazione@acme.example", default_sender_email: { id: 5, email: "me@x.it" }, subject: "Fattura", body: "Ciao" } });
      state.emails.push({ id: Number(m[1]), ...body.data });
      return json(null);
    }
    if ((m = p.match(/^\/c\/1\/issued_documents\/(\d+)\/e_invoice\/xml$/)))
      return new Response("<FatturaElettronica/>", { status: 200, headers: { "Content-Type": "application/xml" } });
    if (p === "/c/1/taxes" && method === "GET") return json({ current_page: 1, last_page: 1, data: state.f24 });
    if (p === "/c/1/taxes" && method === "POST") {
      const f = { ...body.data, id: nextId++ };
      state.f24.push(f);
      return json({ data: f });
    }
    if ((m = p.match(/^\/c\/1\/taxes\/(\d+)$/)) && method === "PUT") {
      const f = state.f24.find((x) => x.id === Number(m![1]));
      Object.assign(f, body.data);
      return json({ data: f });
    }
    if (p === "/c/1/received_documents")
      return json({ current_page: 1, last_page: 1, data: [{ id: 1, date: "2026-02-01", entity: { name: "Aruba" }, description: "Hosting", amount_net: 100, amount_vat: 22, amount_gross: 122, payments_list: [{ status: "paid" }] }] });
    if (p === "/c/1/info/payment_accounts") return json({ data: [{ id: 3, name: "Banca" }] });
    if (p === "/c/1/entities/clients") return json({ current_page: 1, last_page: 1, total: 1, data: [{ id: 7, name: "Acme Srl" }] });
    return json({ error: { message: `fake: ${method} ${p} non gestito` } }, 404);
  }) as typeof fetch;

  return { docs, calls, state, fetchImpl };
}

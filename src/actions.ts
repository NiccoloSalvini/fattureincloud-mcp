/**
 * High-level operations shared by the MCP tools and the scheduler.
 */
import type { FicClient, IssuedDocument, Json } from "./client.js";
import { todayISO } from "./schedules.js";
import { buildCopy, type CopyOverrides } from "./copy.js";

export interface DuplicateResult {
  source_id: number;
  dry_run: boolean;
  document: IssuedDocument;
}

export async function duplicateDocument(
  client: FicClient,
  sourceId: number,
  opts: { date: string; overrides?: CopyOverrides; number?: number; dry_run?: boolean },
): Promise<DuplicateResult> {
  const source = await client.getDocument(sourceId);
  const body = buildCopy(source, opts);
  if (opts.dry_run) return { source_id: sourceId, dry_run: true, document: body };
  const created = await client.createDocument(body);
  return { source_id: sourceId, dry_run: false, document: created };
}

export async function emailDocument(
  client: FicClient,
  id: number,
  opts: { recipient_email?: string; subject?: string; body?: string; send_copy?: boolean; attach_pdf?: boolean } = {},
) {
  const defaults = await client.getEmailData(id);
  const recipient = opts.recipient_email ?? defaults?.recipient_email;
  if (!recipient) throw new Error(`Nessun destinatario email per il documento ${id}: specifica recipient_email`);
  const sender = defaults?.default_sender_email;
  const data = {
    ...(sender?.id ? { sender_id: sender.id } : { sender_email: sender?.email }),
    recipient_email: recipient,
    subject: opts.subject ?? defaults?.subject,
    body: opts.body ?? defaults?.body,
    include: { document: true, delivery_note: false, attachment: false, accompanying_invoice: false },
    attach_pdf: opts.attach_pdf ?? defaults?.default_attach_pdf ?? true,
    send_copy: opts.send_copy ?? false,
  };
  await client.scheduleEmail(id, data);
  return { document_id: id, recipient_email: recipient, subject: data.subject };
}

export interface SdiResult {
  document_id: number;
  verified: boolean;
  sent: boolean;
  dry_run: boolean;
  detail: unknown;
}

/** Formal XML check first, then (unless dry_run) send to the SdI. */
export async function sendToSdi(client: FicClient, id: number, opts: { dry_run?: boolean } = {}): Promise<SdiResult> {
  const check = await client.verifyEInvoiceXml(id);
  if (!check.ok) return { document_id: id, verified: false, sent: false, dry_run: !!opts.dry_run, detail: check.detail };
  const res = await client.sendEInvoice(id, { dry_run: opts.dry_run });
  return { document_id: id, verified: true, sent: !opts.dry_run, dry_run: !!opts.dry_run, detail: res };
}

/** Runs `fn` over `items` sequentially (the API is rate limited) and collects per-item outcomes. */
export async function forEachCollect<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<{ ok: number; failed: number; results: ({ item: T; result: R } | { item: T; error: string })[] }> {
  const results: ({ item: T; result: R } | { item: T; error: string })[] = [];
  let ok = 0;
  for (const item of items) {
    try {
      results.push({ item, result: await fn(item) });
      ok++;
    } catch (e: any) {
      results.push({ item, error: e?.message ?? String(e) });
    }
  }
  return { ok, failed: items.length - ok, results };
}

/** Marks every open installment of a document as paid (or reopens them). */
export async function setPaid(
  client: FicClient,
  id: number,
  opts: { paid: boolean; paid_date?: string; payment_account_id?: number },
) {
  const doc = await client.getDocument(id);
  const payments = doc.payments_list ?? [];
  if (!payments.length) throw new Error(`Il documento ${id} non ha rate di pagamento`);
  let fallbackAccount = opts.payment_account_id;
  const updated: Json[] = [];
  for (const p of payments) {
    if (!opts.paid) {
      updated.push(p.status === "paid" ? { ...p, status: "not_paid", paid_date: null } : p);
      continue;
    }
    if (p.status === "paid") {
      updated.push(p);
      continue;
    }
    let account = opts.payment_account_id ?? p.payment_account?.id;
    if (!account) {
      if (fallbackAccount === undefined) {
        const accounts = (await client.get("/info/payment_accounts")).data ?? [];
        if (!accounts.length) throw new Error("Nessun conto di saldo configurato: crealo o passa payment_account_id");
        fallbackAccount = accounts[0].id as number;
      }
      account = fallbackAccount;
    }
    updated.push({ ...p, status: "paid", paid_date: opts.paid_date ?? todayISO(), payment_account: { id: account } });
  }
  const saved = await client.modifyDocument(id, { payments_list: updated });
  return { document_id: id, payments: (saved.payments_list ?? updated).map(({ amount, due_date, status, paid_date }) => ({ amount, due_date, status, paid_date })) };
}

/** Proforma → fattura, preventivo → ordine/fattura, ecc. via the native transform endpoint. */
export async function transformDocument(
  client: FicClient,
  id: number,
  opts: { new_type: string; keep_copy?: boolean; e_invoice?: boolean; date?: string; dry_run?: boolean },
) {
  const res = await client.get("/issued_documents/transform", {
    original_document_id: id,
    new_type: opts.new_type,
    e_invoice: opts.e_invoice,
    transform_keep_copy: opts.keep_copy ?? true,
  });
  const data = { ...res.data };
  if (opts.date) data.date = opts.date;
  if (opts.dry_run) return { dry_run: true, document: data };
  return { dry_run: false, document: await client.createDocument(data, { ...res.options, fix_payments: true }) };
}

/** Joins several delivery notes / orders / quotes / work reports into one document. */
export async function joinDocuments(
  client: FicClient,
  ids: number[],
  opts: { source_type: "delivery_notes" | "orders" | "quotes" | "work_reports"; group?: boolean; date?: string; dry_run?: boolean },
) {
  const res = await client.get("/issued_documents/join", { ids: ids.join(","), type: opts.source_type, group: opts.group });
  const data = { ...res.data };
  if (opts.date) data.date = opts.date;
  if (opts.dry_run) return { dry_run: true, document: data };
  return { dry_run: false, document: await client.createDocument(data, { ...res.options, fix_payments: true }) };
}

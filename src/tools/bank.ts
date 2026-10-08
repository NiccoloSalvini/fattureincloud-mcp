import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { markInstallmentsPaid } from "../actions.js";
import { BankLinkStore, ebConfigFromEnv, EnableBanking, mapEbTransaction } from "../bank/enablebanking.js";
import { atLeast, type Confidence, openItems, reconcile } from "../bank/match.js";
import { type BankTransaction, parseStatement, PROFILES } from "../bank/parse.js";
import { addDays } from "../copy.js";
import { fetchIssued } from "../finance.js";
import { todayISO } from "../schedules.js";
import { type Ctx, isoDate, tool } from "./define.js";

const mappingSchema = z
  .object({
    date: z.string().describe("Intestazione della colonna data"),
    amount: z.string().optional().describe("Colonna importo con segno"),
    credit: z.string().optional().describe("Colonna accrediti/entrate (in alternativa ad amount)"),
    debit: z.string().optional().describe("Colonna addebiti/uscite"),
    description: z.union([z.string(), z.array(z.string())]).describe("Colonna/e descrizione"),
    value_date: z.string().optional(),
  })
  .describe("Solo per banche non riconosciute: nomi delle colonne nell'intestazione del file");

const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());

async function loadFile(file_path: string, bank?: string, mapping?: z.infer<typeof mappingSchema>) {
  const file = expand(file_path);
  const bytes = new Uint8Array(await fs.readFile(file));
  return parseStatement(bytes, path.basename(file), { bank, mapping });
}

function summarize(txs: BankTransaction[]) {
  const credits = txs.filter((t) => t.amount > 0);
  const debits = txs.filter((t) => t.amount < 0);
  const sum = (l: BankTransaction[]) => Math.round(l.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  return {
    transactions: txs.length,
    period: txs.length ? { from: txs[0].date, to: txs[txs.length - 1].date } : null,
    credits: { count: credits.length, total: sum(credits) },
    debits: { count: debits.length, total: sum(debits) },
  };
}

export function registerBankTools(ctx: Ctx) {
  const links = new BankLinkStore(ctx.store.dir);
  const eb = () => new EnableBanking(ebConfigFromEnv());

  async function enableBankingTransactions(from: string, to?: string): Promise<BankTransaction[]> {
    const data = await links.load();
    const active = data.sessions.filter((s) => s.valid_until > new Date().toISOString());
    if (!active.length) throw new Error("Nessun conto collegato o consenso scaduto: usa bank_link_start.");
    const client = eb();
    const out: BankTransaction[] = [];
    for (const s of active) {
      for (const a of s.accounts) {
        for (const t of await client.transactions(a.uid, from, to)) {
          const tx = mapEbTransaction(t, `${s.bank}${a.iban ? ` ${a.iban.slice(-4)}` : ""}`);
          if (tx) out.push(tx);
        }
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  tool(
    ctx,
    "bank_formats",
    {
      description: "Banche e formati di estratto conto riconosciuti automaticamente nell'import.",
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async () => ({
      formats: PROFILES.map((p) => ({ id: p.id, name: p.name, columns: p.requires })),
      other_banks: "Qualsiasi CSV/XLSX con colonne data, importo (o entrate/uscite) e descrizione: riconoscimento automatico o `mapping` esplicito.",
      live: "Collegamento diretto tramite Enable Banking (Intesa, UniCredit, BPER, Banco BPM, Poste, Fineco, ING, Mediolanum…): bank_link_start.",
    }),
  );

  tool(
    ctx,
    "bank_parse_statement",
    {
      description: "Legge un estratto conto esportato dall'home banking (XLSX, XLS, CSV) e mostra banca riconosciuta, periodo, entrate e uscite.",
      input: {
        file_path: z.string(),
        bank: z.string().optional().describe("Forza il formato (vedi bank_formats), es. 'intesa'"),
        mapping: mappingSchema.optional(),
      },
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async ({ file_path, bank, mapping }) => {
      const s = await loadFile(file_path, bank, mapping);
      return { bank: s.bank_name, header_row: s.header_row, skipped_rows: s.skipped_rows, ...summarize(s.transactions), sample: s.transactions.slice(-10) };
    },
  );

  tool(
    ctx,
    "bank_reconcile",
    {
      description:
        "Riconciliazione bancaria: abbina gli accrediti dell'estratto conto (file o conto collegato) alle fatture aperte per importo, numero fattura " +
        "in causale, P.IVA e nome del cliente, e segna come pagate le rate abbinate con la data dell'accredito. dry_run è TRUE per default: " +
        "mostra le proposte con il livello di confidenza; rilancia con dry_run=false per registrare quelle ≥ min_confidence.",
      input: {
        file_path: z.string().optional().describe("Estratto conto esportato; ometti per usare il conto collegato con Enable Banking"),
        bank: z.string().optional(),
        mapping: mappingSchema.optional(),
        from: isoDate.optional().describe("Solo movimenti da questa data (default: 90 giorni fa per il conto collegato)"),
        to: isoDate.optional(),
        dry_run: z.boolean().default(true),
        min_confidence: z.enum(["high", "medium", "low"]).default("high"),
        payment_account_id: z.number().int().optional().describe("Conto di saldo su cui registrare gli incassi (vedi lookup payment_accounts)"),
      },
    },
    async (a, c) => {
      let txs: BankTransaction[];
      let source: string;
      if (a.file_path) {
        const s = await loadFile(a.file_path, a.bank, a.mapping);
        txs = s.transactions;
        source = s.bank_name;
      } else {
        txs = await enableBankingTransactions(a.from ?? addDays(todayISO(), -90), a.to);
        source = "Enable Banking";
      }
      if (a.from) txs = txs.filter((t) => t.date >= a.from!);
      if (a.to) txs = txs.filter((t) => t.date <= a.to!);
      const earliest = txs[0]?.date ?? todayISO();
      // invoices up to 2 years before the first transaction can still be paid late
      const docs = await fetchIssued(c, ["invoice"], `date >= '${Number(earliest.slice(0, 4)) - 2}-01-01'`);
      const result = reconcile(txs, openItems(docs));
      const min = a.min_confidence as Confidence;

      const applied: unknown[] = [];
      if (!a.dry_run) {
        for (const m of result.matches.filter((m) => atLeast(m.confidence, min))) {
          try {
            applied.push(await markInstallmentsPaid(c, m.item.document_id, m.item.installments, { paid_date: m.transaction.date, payment_account_id: a.payment_account_id }));
          } catch (e: any) {
            applied.push({ document_id: m.item.document_id, error: e.message });
          }
        }
      }
      const view = (m: (typeof result.matches)[number]) => ({
        confidence: m.confidence,
        score: m.score,
        accredito: { date: m.transaction.date, amount: m.transaction.amount, description: m.transaction.description.slice(0, 160) },
        fattura: { id: m.item.document_id, document: m.item.document, client: m.item.client, amount: m.item.amount, rate: m.item.installments },
        reasons: m.reasons,
        will_apply: atLeast(m.confidence, min),
      });
      return {
        source,
        dry_run: a.dry_run,
        ...summarize(txs),
        matches: result.matches.map(view),
        applied: a.dry_run ? undefined : applied,
        unmatched_credits: result.unmatched_credits.map((t) => ({ date: t.date, amount: t.amount, description: t.description.slice(0, 160) })),
        still_open_invoices: result.still_open.length,
        next: a.dry_run
          ? `Controlla le proposte; rilancia con dry_run=false per registrare le ${result.matches.filter((m) => atLeast(m.confidence, min)).length} con confidenza ≥ ${min}.`
          : undefined,
      };
    },
  );

  tool(
    ctx,
    "bank_list_banks",
    {
      description: "Banche collegabili tramite Enable Banking (nome esatto da usare in bank_link_start).",
      input: { country: z.string().length(2).default("IT"), search: z.string().optional() },
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async ({ country, search }) => {
      const banks = await eb().listBanks(country);
      const q = search?.toLowerCase();
      return banks.filter((b) => !q || b.name.toLowerCase().includes(q)).map((b) => ({ name: b.name, psu_types: b.psu_types, max_consent_seconds: b.maximum_consent_validity }));
    },
  );

  tool(
    ctx,
    "bank_link_start",
    {
      description:
        "Collega un conto corrente via Enable Banking (PSD2). Restituisce un link: aprilo, autorizza nella tua banca, poi copia l'indirizzo della " +
        "pagina finale (anche se dà errore) e passalo a bank_link_finish. Il consenso dura fino a 180 giorni.",
      input: {
        bank: z.string().default("Intesa Sanpaolo").describe("Nome esatto come in bank_list_banks"),
        country: z.string().length(2).default("IT"),
        psu_type: z.enum(["personal", "business"]).default("personal").describe("business per conti aziendali"),
        days: z.number().int().min(1).max(180).default(180),
      },
      noCompany: true,
    },
    async ({ bank, country, psu_type, days }) => {
      const r = await eb().startAuthorization({ bank, country, psu_type, days });
      const data = await links.load();
      data.pending[r.state] = { bank, country, valid_until: r.valid_until };
      await links.save(data);
      return { open_this_url: r.url, then: "Dopo l'autorizzazione copia l'URL completo della pagina di ritorno e chiama bank_link_finish." };
    },
  );

  tool(
    ctx,
    "bank_link_finish",
    {
      description: "Completa il collegamento: passa l'URL di ritorno (contiene ?code=...&state=...) oppure il solo code.",
      input: { redirect_url: z.string().optional(), code: z.string().optional() },
      noCompany: true,
    },
    async ({ redirect_url, code }) => {
      let state: string | undefined;
      if (redirect_url) {
        const u = new URL(redirect_url);
        if (u.searchParams.get("error")) throw new Error(`La banca ha rifiutato: ${u.searchParams.get("error")} ${u.searchParams.get("error_description") ?? ""}`);
        code = u.searchParams.get("code") ?? undefined;
        state = u.searchParams.get("state") ?? undefined;
      }
      if (!code) throw new Error("Manca il code: passa l'URL completo della pagina di ritorno.");
      const data = await links.load();
      const pending = state ? data.pending[state] : Object.values(data.pending).at(-1);
      const session = await eb().createSession(code);
      const linked = {
        session_id: session.session_id,
        bank: pending?.bank ?? session.aspsp?.name ?? "banca",
        country: pending?.country ?? session.aspsp?.country ?? "IT",
        valid_until: session.access?.valid_until ?? pending?.valid_until ?? "",
        created_at: new Date().toISOString(),
        accounts: (session.accounts ?? []).map((acc: any) => ({ uid: acc.uid, iban: acc.account_id?.iban, name: acc.name, currency: acc.currency })),
      };
      if (state) delete data.pending[state];
      data.sessions = [...data.sessions.filter((s) => s.bank !== linked.bank), linked];
      await links.save(data);
      return { linked: { bank: linked.bank, valid_until: linked.valid_until, accounts: linked.accounts.map((x: any) => ({ iban: x.iban, name: x.name })) } };
    },
  );

  tool(
    ctx,
    "bank_accounts",
    {
      description: "Conti collegati con Enable Banking e scadenza del consenso.",
      annotations: { readOnlyHint: true },
      noCompany: true,
    },
    async () => {
      const data = await links.load();
      const now = new Date().toISOString();
      return data.sessions.map((s) => ({
        bank: s.bank,
        valid_until: s.valid_until,
        expired: s.valid_until <= now,
        accounts: s.accounts.map((a) => ({ iban: a.iban, name: a.name })),
      }));
    },
  );
}

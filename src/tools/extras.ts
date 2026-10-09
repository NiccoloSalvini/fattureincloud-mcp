import path from "node:path";
import { z } from "zod";
import { buildCreditNote, clientFromVies, quadroLM, stampDutyQuarters, VIES_TEMPORARY } from "../extras.js";
import { fetchIssued } from "../finance.js";
import { collectedByYear, summarizeDocument } from "../reports.js";
import { todayISO } from "../schedules.js";
import { computeYears, loadProfile } from "../taxes.js";
import { type Ctx, isoDate, tool } from "./define.js";

const VIES = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";

export function registerExtraTools(ctx: Ctx, enabled: Set<string>) {
  if (enabled.has("documents")) {
    tool(
      ctx,
      "preview_totals",
      {
        description:
          "Calcola con Fatture in Cloud i totali di un documento senza crearlo: imponibile, rivalsa, IVA, ritenute, bollo, totale e somma delle rate. " +
          "Usalo per controllare una fattura prima di emetterla.",
        input: { data: z.record(z.string(), z.any()).describe("Oggetto IssuedDocument, come per create_issued_document") },
        annotations: { readOnlyHint: true },
      },
      async ({ data }, c) => (await c.post("/issued_documents/totals", { data })).data,
    );

    tool(
      ctx,
      "create_credit_note",
      {
        description:
          "Crea la nota di credito di una fattura, totale o parziale, collegata alla fattura originale come richiede lo SdI (numero e data della " +
          "fattura nei dati della fattura elettronica). È l'unico modo per correggere una fattura elettronica già inviata. dry_run è TRUE per default: " +
          "mostra la nota e i suoi totali; non viene inviata allo SdI (usa poi send_einvoice).",
        input: {
          invoice_id: z.number().int(),
          amount: z.number().positive().optional().describe("Storno parziale: importo netto da stornare. Ometti per lo storno totale"),
          description: z.string().optional().describe("Motivo, es. 'Storno per errato importo'"),
          items_list: z.array(z.record(z.string(), z.any())).optional().describe("Righe esplicite, in alternativa ad amount"),
          date: isoDate.optional().describe("Default: oggi"),
          dry_run: z.boolean().default(true),
        },
      },
      async (a, c) => {
        const invoice = await c.getDocument(a.invoice_id);
        const note = buildCreditNote(invoice, { date: a.date ?? todayISO(), amount: a.amount, description: a.description, items_list: a.items_list });
        if (a.dry_run) {
          const totals = (await c.post("/issued_documents/totals", { data: note })).data;
          return { dry_run: true, original: summarizeDocument(invoice), credit_note: note, totals };
        }
        const created = await c.createDocument(note, { fix_payments: true });
        return { original: summarizeDocument(invoice), created: summarizeDocument(created), next: "Controllala e inviala con send_einvoice." };
      },
    );
  }

  if (enabled.has("registry")) {
    tool(
      ctx,
      "lookup_city",
      {
        description: "Comuni italiani da CAP o nome: città, CAP e sigla della provincia corretti, necessari per le fatture elettroniche.",
        input: { postal_code: z.string().optional(), city: z.string().optional() },
        annotations: { readOnlyHint: true },
        noCompany: true,
      },
      async ({ postal_code, city }) => {
        if (!postal_code && !city) throw new Error("Passa postal_code oppure city");
        return (await ctx.client.request("GET", "/info/cities", { query: { postal_code, city } })).data;
      },
    );

    tool(
      ctx,
      "client_from_vat",
      {
        description:
          "Prepara l'anagrafica di un cliente dalla partita IVA usando VIES (il registro europeo): ragione sociale e indirizzo, con città e provincia " +
          "verificate. Il codice destinatario SDI non è pubblico: chiedilo al cliente o usa la sua PEC. Con create=true crea il cliente.",
        input: {
          vat_number: z.string().describe("Partita IVA, con o senza prefisso paese"),
          country: z.string().length(2).default("IT"),
          ei_code: z.string().optional().describe("Codice destinatario SDI (7 caratteri)"),
          certified_email: z.string().optional().describe("PEC"),
          email: z.string().optional(),
          create: z.boolean().default(false),
        },
      },
      async (a, c) => {
        const vat = a.vat_number.replace(/\s/g, "").replace(/^[A-Z]{2}/i, "");
        const url = `${VIES}/${a.country.toUpperCase()}/vat/${vat}`;
        let vies: any;
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetch(url, { headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error(`VIES non disponibile (${res.status}): riprova più tardi`);
          vies = await res.json();
          if (!VIES_TEMPORARY.has(vies?.userError)) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        const data: Record<string, any> = { ...clientFromVies(vies, a.country.toUpperCase()) };
        // companies use the VAT number as tax code; a sole trader's tax code is personal
        const isCompany = /\b(S\.?R\.?L\.?S?|S\.?P\.?A\.?|S\.?N\.?C\.?|S\.?A\.?S\.?|S\.?S\.?|COOP\w*|CONSORZIO|FONDAZIONE|ASSOCIAZIONE|UNIVERSITA|SOCIETA)\b/i.test(data.name ?? "");
        if (a.country.toUpperCase() === "IT" && isCompany) data.tax_code = data.vat_number;
        const missingTaxCode = a.country.toUpperCase() === "IT" && !isCompany ? ["tax_code: ditta individuale, serve il codice fiscale personale del titolare"] : [];
        if (data.address_postal_code) {
          const cities = (await c.request("GET", "/info/cities", { query: { postal_code: data.address_postal_code } }).catch(() => null))?.data ?? [];
          const match = cities.find((x: any) => x.city?.toLowerCase() === data.address_city?.toLowerCase()) ?? (cities.length === 1 ? cities[0] : null);
          if (match) Object.assign(data, { address_city: match.city, address_province: match.province });
        }
        for (const k of ["ei_code", "certified_email", "email"] as const) if (a[k]) data[k] = a[k];
        const missing = [...(data.ei_code || data.certified_email ? [] : ["ei_code (codice destinatario) o certified_email (PEC) per la fattura elettronica"]), ...missingTaxCode];
        if (!a.create) return { client: data, missing, next: "Rilancia con create=true per crearlo." };
        return { created: (await c.post("/entities/clients", { data })).data, missing };
      },
    );

    tool(
      ctx,
      "list_price_lists",
      { description: "Listini prezzi configurati in Fatture in Cloud.", annotations: { readOnlyHint: true } },
      async (_a, c) => (await c.get("/price_lists")).data,
    );

    tool(
      ctx,
      "get_price_list_items",
      { description: "Prezzi dei prodotti in un listino.", input: { price_list_id: z.string() }, annotations: { readOnlyHint: true } },
      async ({ price_list_id }, c) => (await c.get(`/price_lists/${price_list_id}/items`)).data,
    );
  }

  if (enabled.has("accounting")) {
    tool(
      ctx,
      "receipts_monthly_totals",
      {
        description: "Totali mensili dei corrispettivi (scontrini o ricevute) di un anno.",
        input: { year: z.number().int(), type: z.enum(["sales_receipt", "till_receipt"]).default("till_receipt") },
        annotations: { readOnlyHint: true },
      },
      async ({ year, type }, c) => (await c.get("/receipts/monthly_totals", { year, type })).data,
    );
  }

  if (enabled.has("taxes")) {
    tool(
      ctx,
      "stamp_duty_report",
      {
        description:
          "Bollo virtuale sulle fatture elettroniche: documenti con bollo e importo da versare per trimestre (F24 codici 2521-2524), con le scadenze " +
          "(31/5, 30/9, 30/11, 28/2). Rientra anche nelle scadenze di tax_deadlines_export e cashflow_forecast.",
        input: { year: z.number().int().optional().describe("Default: anno corrente") },
        annotations: { readOnlyHint: true },
      },
      async ({ year }, c) => {
        const today = todayISO();
        const y = year ?? Number(today.slice(0, 4));
        const docs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${y}-01-01' and date <= '${y}-12-31'`);
        return stampDutyQuarters(docs, y, today);
      },
    );

    tool(
      ctx,
      "quadro_lm",
      {
        description:
          "Valori del quadro LM (regime forfettario) della dichiarazione per un anno chiuso: ricavi, reddito, contributi dedotti, imposta, acconti e " +
          "saldo, dagli incassi in Fatture in Cloud e dal profilo fiscale. Da controllare col commercialista.",
        input: { year: z.number().int().optional().describe("Default: anno precedente") },
        annotations: { readOnlyHint: true },
      },
      async ({ year }, c) => {
        const profile = await loadProfile(path.join(ctx.store.dir, "tax-profile.json"));
        if (!profile) throw new Error("Profilo fiscale non impostato: usa prima tax_profile_set.");
        const y = year ?? Number(todayISO().slice(0, 4)) - 1;
        const from = Math.max(profile.start_year ?? y - 3, y - 3);
        const docs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${from - 1}-01-01' and date <= '${y}-12-31'`);
        const years = computeYears(profile, collectedByYear(docs), from, y);
        return quadroLM(years.get(y)!, profile.ateco, profile.coefficient);
      },
    );
  }
}

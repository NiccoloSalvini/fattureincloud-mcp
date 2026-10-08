import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildAccountantPackage } from "../accountant.js";
import { type CashEvent, forecast, monthRange, recurringCollection } from "../cashflow.js";
import { fetchIssued, upcomingTaxDeadlines } from "../finance.js";
import { buildIcs } from "../ics.js";
import { todayISO, upcoming } from "../schedules.js";
import { loadProfile } from "../taxes.js";
import { type Ctx, tool } from "./define.js";
import { profilePath } from "./taxes.js";

const MARKER = "[fattureincloud-mcp]";
const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());

async function requireProfile(ctx: Ctx) {
  const p = await loadProfile(profilePath(ctx));
  if (!p) throw new Error("Profilo fiscale non impostato: usa prima tax_profile_set.");
  return p;
}

export function registerPlanningTools(ctx: Ctx) {
  tool(
    ctx,
    "cashflow_forecast",
    {
      description:
        "Previsione di cassa mese per mese: incassi attesi dalle fatture aperte, fatture ricorrenti future, scadenze fiscali (30 giugno, 30 novembre) " +
        "e spese fisse. Calcola quanto accantonare ogni mese per arrivare coperto a ogni scadenza e segnala i mesi con saldo negativo.",
      input: {
        months: z.number().int().min(1).max(24).default(12),
        opening_balance: z.number().optional().describe("Saldo attuale del conto, per avere il saldo previsto mese per mese"),
        tax_fund: z.number().optional().describe("Quanto hai già accantonato per le tasse"),
        monthly_expenses: z.number().optional().describe("Uscite fisse mensili (affitto, software, prelievi...)"),
        include_overdue: z.boolean().default(true).describe("Conta i crediti scaduti come incassati nel mese corrente"),
        revenue_estimate: z.number().optional().describe("Incassi annui previsti, per la stima delle tasse"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a, c) => {
      const today = todayISO();
      const keys = monthRange(today, a.months);
      const horizonEnd = `${keys.at(-1)}-31`;
      const events: CashEvent[] = [];
      const notes: string[] = [];

      // 1. Crediti aperti
      const docs = await fetchIssued(c, ["invoice"], `date >= '${Number(today.slice(0, 4)) - 2}-01-01'`);
      for (const d of docs) {
        for (const p of d.payments_list ?? []) {
          if (p.status !== "not_paid") continue;
          const due = p.due_date ?? d.date ?? today;
          const overdue = due < today;
          if (overdue && !a.include_overdue) continue;
          events.push({
            date: overdue ? today : due,
            amount: p.amount ?? 0,
            kind: overdue ? "credito_scaduto" : "credito",
            label: `${d.entity?.name ?? "?"}: fattura ${d.number ?? "?"}${d.numeration ?? ""}${overdue ? ` (scaduta il ${due})` : ""}`,
          });
        }
      }

      // 2. Ricorrenze
      const companyId = await c.getCompanyId();
      for (const s of (await ctx.store.load()).filter((s) => s.enabled && s.company_id === companyId)) {
        const tpl = await c.getDocument(s.source_document_id).catch(() => null);
        if (!tpl) {
          notes.push(`Ricorrenza "${s.name}": documento modello ${s.source_document_id} non trovato.`);
          continue;
        }
        const firstDue = tpl.payments_list?.[0]?.due_date;
        for (const run of upcoming(s, 30).filter((d) => d <= horizonEnd)) {
          const date = recurringCollection(run, tpl.date, firstDue);
          if (date > horizonEnd) continue;
          events.push({ date, amount: tpl.amount_gross ?? 0, kind: "ricorrente", label: `${s.name} (emessa il ${run})` });
        }
        if (s.overrides?.items?.some((i) => i.net_price !== undefined || i.qty !== undefined))
          notes.push(`Ricorrenza "${s.name}": importo stimato dal modello, le modifiche alle righe non sono considerate.`);
      }

      // 3. Tasse
      const profile = await loadProfile(profilePath(ctx));
      if (profile) {
        const t = await upcomingTaxDeadlines(c, profile, { today, revenue_estimate: a.revenue_estimate });
        for (const d of t.deadlines) events.push({ date: d.date, amount: -d.total, kind: "tasse", label: d.items.map((i) => i.what).join(" + ") });
        notes.push(`Tasse stimate su incassi annui di ${t.projected_revenue} € (${a.revenue_estimate !== undefined ? "stima fornita" : "proiezione"}).`);
      } else {
        notes.push("Profilo fiscale non impostato: le tasse non sono incluse (usa tax_profile_set).");
      }

      // 4. Spese fisse
      if (a.monthly_expenses) for (const k of keys) events.push({ date: `${k}-01`, amount: -a.monthly_expenses, kind: "spese", label: "Spese fisse" });

      const res = forecast(events, { today, months: a.months, opening_balance: a.opening_balance, tax_fund: a.tax_fund });
      return { ...res, notes };
    },
  );

  tool(
    ctx,
    "tax_deadlines_export",
    {
      description:
        "Porta le scadenze fiscali stimate (imposta sostitutiva e contributi, 30 giugno e 30 novembre) nel calendario e/o nello scadenziario F24 di " +
        "Fatture in Cloud. ics_path crea un file .ics con promemoria 7 giorni e 1 giorno prima (importalo in Calendario, Google, Outlook). " +
        "create_f24 crea o aggiorna gli F24 previsti, senza duplicarli; dry_run è TRUE per default.",
      input: {
        ics_path: z.string().optional().describe("File o cartella dove salvare il .ics, es. ~/Downloads"),
        create_f24: z.boolean().default(false),
        dry_run: z.boolean().default(true).describe("Solo per create_f24"),
        revenue_estimate: z.number().optional(),
      },
    },
    async (a, c) => {
      const profile = await requireProfile(ctx);
      const { deadlines, projected_revenue } = await upcomingTaxDeadlines(c, profile, { revenue_estimate: a.revenue_estimate });
      const fmt = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const out: Record<string, unknown> = { projected_revenue, deadlines };

      if (a.ics_path) {
        const ics = buildIcs(
          deadlines.map((d) => ({
            uid: `tax-${d.date}@fattureincloud-mcp`,
            date: d.date,
            summary: `F24 tasse e contributi: ${fmt(d.total)} € (stima)`,
            description: [...d.items.map((i) => `${i.what}: ${fmt(i.amount)} €`), "", "Stima di fattureincloud-mcp: verifica gli importi con il commercialista."].join("\n"),
            alarms: [7, 1],
          })),
          { name: "Scadenze fiscali" },
        );
        let file = expand(a.ics_path);
        if ((await fs.stat(file).catch(() => null))?.isDirectory() || !file.endsWith(".ics")) file = path.join(file, "scadenze-fiscali.ics");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, ics);
        out.ics = file;
      }

      if (a.create_f24) {
        const existing = await c.listAll("/taxes", { fieldset: "detailed" }, 1000);
        const actions = [];
        for (const d of deadlines) {
          const description = `${d.items.map((i) => i.what).join(" + ")} ${MARKER}`;
          const match = existing.find((f) => f.due_date === d.date && String(f.description ?? "").includes(MARKER));
          if (match?.status === "paid") {
            actions.push({ date: d.date, action: "skip", reason: "F24 già pagato", id: match.id });
            continue;
          }
          const action = match ? "update" : "create";
          if (!a.dry_run) {
            const data = { due_date: d.date, amount: d.total, description, status: "not_paid" };
            const res = match ? await c.put(`/taxes/${match.id}`, { data }) : await c.post("/taxes", { data });
            actions.push({ date: d.date, action, amount: d.total, id: res?.data?.id });
          } else {
            actions.push({ date: d.date, action, amount: d.total, ...(match ? { id: match.id, current_amount: match.amount } : {}) });
          }
        }
        out.f24 = { dry_run: a.dry_run, actions };
      }
      return out;
    },
  );

  tool(
    ctx,
    "accountant_package",
    {
      description:
        "Crea lo zip annuale per il commercialista: fatture.csv, incassi.csv, crediti_aperti.csv, spese.csv (formato italiano per Excel), " +
        "PDF di tutte le fatture e note di credito, XML FatturaPA e riepilogo.md con ricavi, soglia del forfettario, stima delle tasse e controlli.",
      input: {
        year: z.number().int().optional().describe("Default: anno precedente"),
        output_dir: z.string().optional().describe("Default: ~/Downloads"),
        include_pdf: z.boolean().default(true),
        include_xml: z.boolean().default(true),
      },
    },
    async (a, c) =>
      buildAccountantPackage(c, {
        year: a.year ?? Number(todayISO().slice(0, 4)) - 1,
        output_dir: a.output_dir,
        include_pdf: a.include_pdf,
        include_xml: a.include_xml,
        profile: await loadProfile(profilePath(ctx)),
      }),
  );
}

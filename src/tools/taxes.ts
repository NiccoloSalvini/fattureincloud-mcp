import path from "node:path";
import { z } from "zod";
import { todayISO } from "../schedules.js";
import { estimateTaxes } from "../finance.js";
import { DEFAULTS, loadProfile, saveProfile, type TaxProfile } from "../taxes.js";
import { type Ctx, tool } from "./define.js";

const yearOverride = z.object({
  revenue: z.number().optional().describe("Ricavi incassati, se non tutti in Fatture in Cloud"),
  contributions_paid: z.number().optional().describe("Contributi previdenziali effettivamente versati nell'anno"),
  tax_advances_paid: z.number().optional().describe("Acconti di imposta sostitutiva versati per l'anno"),
  contribution_advances_paid: z.number().optional().describe("Acconti contributivi versati per l'anno"),
});

const inpsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("gestione_separata"),
    rate: z.number().optional().describe(`Default ${DEFAULTS.gestione_separata_rate}`),
    max_income: z.number().optional().describe(`Massimale, default ${DEFAULTS.gestione_separata_max}`),
  }),
  z.object({
    type: z.enum(["artigiani", "commercianti"]),
    fixed_annual: z.number().describe("Contributi fissi annui sul minimale (tabelle INPS)"),
    minimum_income: z.number().describe("Reddito minimale (tabelle INPS)"),
    rate: z.number().optional(),
    reduction_35: z.boolean().optional().describe("Riduzione 35% per forfettari"),
  }),
  z.object({
    type: z.literal("cassa"),
    name: z.string().optional().describe("Es. Inarcassa, Cassa Forense"),
    rate: z.number().describe("Aliquota del contributo soggettivo, es. 0.145"),
    minimum: z.number().optional().describe("Contributo minimo annuo"),
  }),
  z.object({ type: z.literal("none") }),
]);

export const profilePath = (ctx: Ctx) => path.join(ctx.store.dir, "tax-profile.json");

export function registerTaxTools(ctx: Ctx) {
  const file = profilePath(ctx);

  tool(
    ctx,
    "tax_profile_get",
    {
      description:
        "Profilo fiscale usato per stimare le tasse (coefficiente, aliquota, previdenza) e regime registrato in Fatture in Cloud.",
      annotations: { readOnlyHint: true },
    },
    async (_a, c) => {
      const fic = await c.get("/settings/tax_profile").then((r) => r.data).catch(() => null);
      return { profile: await loadProfile(file), file: file, fatture_in_cloud: fic };
    },
  );

  tool(
    ctx,
    "tax_profile_set",
    {
      description:
        "Imposta il profilo fiscale del forfettario: coefficiente di redditività (78% professionisti, 67% altre attività, 40% commercio, " +
        "86% costruzioni, 62% intermediari), aliquota (15%, o 5% per i primi 5 anni), previdenza (gestione separata, artigiani/commercianti, cassa) " +
        "e importi reali già versati per anno. I campi non passati restano invariati.",
      input: {
        coefficient: z.number().gt(0).lte(1).optional().describe("Es. 0.78"),
        tax_rate: z.number().min(0).max(0.5).optional().describe("0.15 o 0.05"),
        start_year: z.number().int().optional().describe("Anno di apertura della partita IVA"),
        inps: inpsSchema.optional(),
        overrides: z.record(z.string().regex(/^\d{4}$/), yearOverride).optional().describe("Per anno, es. { \"2025\": { contributions_paid: 3200 } }"),
      },
    },
    async (a, c) => {
      const current = await loadProfile(file);
      // first setup: take the rate from the regime registered in Fatture in Cloud (forfettario_5 / forfettario_15)
      let defaultRate = 0.15;
      if (!current && a.tax_rate === undefined) {
        const regime = String((await c.get("/settings/tax_profile").catch(() => null))?.data?.regime ?? "");
        if (/forfettario_5\b/.test(regime)) defaultRate = 0.05;
      }
      const merged = {
        coefficient: 0.78,
        tax_rate: defaultRate,
        inps: { type: "gestione_separata" },
        ...current,
        ...Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && k !== "overrides")),
        overrides: { ...current?.overrides, ...a.overrides },
      } as TaxProfile;
      await saveProfile(merged, file);
      return { saved: file, profile: merged };
    },
  );

  tool(
    ctx,
    "tax_estimate",
    {
      description:
        "Stima imposta sostitutiva e contributi del forfettario: quanto pagare il 30 giugno (saldo + 1° acconto) e il 30 novembre (2° acconto), " +
        "totale annuo di competenza, percentuale da accantonare. Usa gli incassi registrati in Fatture in Cloud e il profilo di tax_profile_set. " +
        "Per l'anno in corso proietta gli incassi a fine anno (projection='linear') o usa solo quelli già avvenuti ('to_date').",
      input: {
        year: z.number().int().optional().describe("Default: anno corrente"),
        projection: z.enum(["linear", "to_date"]).default("linear"),
        revenue_estimate: z.number().optional().describe("Incassi previsti per l'anno, se li conosci meglio della proiezione"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ year, projection, revenue_estimate }, c) => {
      const profile = await loadProfile(file);
      if (!profile) throw new Error("Profilo fiscale non impostato: usa prima tax_profile_set (coefficiente, aliquota, previdenza).");
      return estimateTaxes(c, profile, year ?? Number(todayISO().slice(0, 4)), { projection, revenue_estimate });
    },
  );
}

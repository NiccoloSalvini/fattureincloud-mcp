import path from "node:path";
import { z } from "zod";
import { projectYear, fetchIssued } from "../finance.js";
import { compareRegimes, REGIME_DEFAULTS } from "../regime.js";
import { collectedByYear } from "../reports.js";
import { todayISO } from "../schedules.js";
import { loadProfile } from "../taxes.js";
import { type Ctx, tool } from "./define.js";

export function registerRegimeTools(ctx: Ctx) {
  tool(
    ctx,
    "regime_simulator",
    {
      description:
        "Confronta forfettario, ordinario (ditta individuale) e SRL unipersonale: imposte, contributi e netto in tasca a parità di ricavi e costi, " +
        "con la soglia di ricavi oltre cui il forfettario smette di convenire. Ricavi di default: proiezione dell'anno in corso dagli incassi in " +
        "Fatture in Cloud; coefficiente, aliquota e INPS dal profilo fiscale. Mostra anche il forfettario al 15% (dopo i primi cinque anni).",
      input: {
        revenue: z.number().optional().describe("Ricavi annui senza IVA"),
        costs: z.number().optional().describe("Costi reali annui dell'attività (software, hardware, coworking, formazione...); default 0"),
        srl_fixed_costs: z.number().optional().describe(`Costi fissi annui della SRL, default ${REGIME_DEFAULTS.srl_fixed_costs}`),
        srl_partner_inps: z.number().optional().describe("Contributi minimi del socio lavoratore (gestione commercianti), se dovuti"),
        local_surcharge_rate: z.number().optional().describe("Addizionali regionale + comunale, default 0.02"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a, c) => {
      const profile = await loadProfile(path.join(ctx.store.dir, "tax-profile.json"));
      let revenue = a.revenue;
      let basis = "indicati";
      if (revenue === undefined) {
        const today = todayISO();
        const y = Number(today.slice(0, 4));
        const docs = await fetchIssued(c, ["invoice", "credit_note"], `date >= '${y - 1}-01-01'`);
        revenue = projectYear(collectedByYear(docs)[y] ?? 0, y, today);
        basis = `proiezione ${y} dagli incassi in Fatture in Cloud`;
      }
      const inpsRate = profile?.inps.type === "gestione_separata" ? (profile.inps.rate ?? REGIME_DEFAULTS.inps_rate) : REGIME_DEFAULTS.inps_rate;
      const base = {
        revenue,
        costs: a.costs ?? 0,
        coefficient: profile?.coefficient ?? REGIME_DEFAULTS.coefficient,
        forfettario_rate: profile?.tax_rate ?? REGIME_DEFAULTS.forfettario_rate,
        inps_rate: inpsRate,
        ...(a.srl_fixed_costs !== undefined ? { srl_fixed_costs: a.srl_fixed_costs } : {}),
        ...(a.srl_partner_inps !== undefined ? { srl_partner_inps: a.srl_partner_inps } : {}),
        ...(a.local_surcharge_rate !== undefined ? { local_surcharge_rate: a.local_surcharge_rate } : {}),
      };
      const now = compareRegimes(base);
      const after = base.forfettario_rate < 0.15 ? compareRegimes({ ...base, forfettario_rate: 0.15 }) : null;
      return {
        revenue_basis: basis,
        profile_used: profile ? { coefficient: base.coefficient, forfettario_rate: base.forfettario_rate, inps_rate: inpsRate } : "nessun profilo: coefficiente 78%, aliquota 15%",
        ...now,
        ...(after
          ? {
              after_startup_period: {
                note: "Stesso confronto con il forfettario al 15%, come dopo i primi cinque anni.",
                best: after.best,
                forfettario_net: after.scenarios[0].net,
                forfettario_stops_being_best_at: after.forfettario_stops_being_best_at,
              },
            }
          : {}),
      };
    },
  );
}

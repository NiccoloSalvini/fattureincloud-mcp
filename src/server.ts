import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FicClient } from "./client.js";
import { ScheduleStore } from "./schedules.js";
import { type Ctx, type Toolset, TOOLSETS } from "./tools/define.js";
import { registerCrud } from "./tools/crud.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerAutomationTools } from "./tools/automation.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerTaxTools } from "./tools/taxes.js";
import { registerRegimeTools } from "./tools/regime.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerBankTools } from "./tools/bank.js";
import { registerReceivedTools } from "./tools/received.js";

export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/** FIC_TOOLSETS="documents,automation" → only those groups (admin is always on). */
export function parseToolsets(value: string | undefined): Set<Toolset> {
  if (!value || value.trim() === "all") return new Set(TOOLSETS);
  const wanted = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !(TOOLSETS as readonly string[]).includes(w));
  if (unknown.length) throw new Error(`Toolset sconosciuti: ${unknown.join(", ")}. Disponibili: ${TOOLSETS.join(", ")}`);
  return new Set([...(wanted as Toolset[]), "admin"]);
}

export function createServer(client: FicClient, opts: { store?: ScheduleStore; toolsets?: Set<Toolset> } = {}) {
  const server = new McpServer(
    { name: "fattureincloud-mcp", version: VERSION },
    {
      instructions:
        "Server per Fatture in Cloud (fatturazione italiana). Regole: le azioni verso l'esterno (invio SdI, email) sono irreversibili, " +
        "quindi prima mostra all'utente cosa verrà inviato e usa dry_run quando disponibile. Una fattura elettronica inviata si corregge " +
        "solo con nota di credito. Per ripetere fatture usa duplicate_document o le ricorrenze (schedule_*), non ricostruirle a mano.",
    },
  );
  const ctx: Ctx = { server, client, store: opts.store ?? new ScheduleStore() };
  const enabled = opts.toolsets ?? new Set(TOOLSETS);

  registerAdminTools(ctx);
  registerCrud(ctx, enabled);
  if (enabled.has("documents")) registerDocumentTools(ctx);
  if (enabled.has("received")) registerReceivedTools(ctx);
  if (enabled.has("automation")) registerAutomationTools(ctx);
  if (enabled.has("reports")) registerInsightTools(ctx);
  if (enabled.has("taxes")) {
    registerTaxTools(ctx);
    registerRegimeTools(ctx);
  }
  if (enabled.has("planning")) registerPlanningTools(ctx);
  if (enabled.has("bank")) registerBankTools(ctx);
  registerPrompts(server);
  return server;
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "chiusura_mese",
    {
      title: "Chiusura del mese",
      description: "Controlla il mese: fatture da emettere o inviare, incassi, scaduti, bollo, ricorrenze.",
      argsSchema: { mese: z.string().optional().describe("YYYY-MM, default il mese scorso") },
    },
    ({ mese }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Facciamo la chiusura di ${mese ?? "il mese scorso"} su Fatture in Cloud.\n` +
              "1. audit_documents: elenca fatture non inviate allo SdI, scartate, senza bollo, buchi di numerazione.\n" +
              "2. receivables_report: chi deve ancora pagare e cosa è scaduto.\n" +
              "3. schedule_list: ricorrenze del mese e loro esito.\n" +
              "4. revenue_summary: incassato da inizio anno e distanza dalla soglia del forfettario.\n" +
              "Riassumi in una tabella e proponi le azioni (invio, solleciti, mark_paid), senza eseguire nulla di irreversibile prima che io confermi.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "nuova_ricorrenza",
    {
      title: "Imposta una fattura ricorrente",
      description: "Guida alla creazione di una ricorrenza partendo dall'ultima fattura di un cliente.",
      argsSchema: { cliente: z.string().describe("Nome del cliente") },
    },
    ({ cliente }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Voglio fatturare ${cliente} in automatico ogni mese.\n` +
              `Trova la sua ultima fattura (list_issued_documents con q "entity.name like '%${cliente}%'", sort -date), mostramela, ` +
              "chiedimi giorno di emissione, se l'importo è fisso, se inviarla subito allo SdI o lasciarla da controllare, e se mandare l'email. " +
              "Proponi un oggetto con segnaposto (es. 'Servizi di {{mese_precedente}} {{anno_mese_precedente}}'), fai schedule_create e poi " +
              "schedule_run_now in dry_run per farmi vedere la prima fattura.",
          },
        },
      ],
    }),
  );
}

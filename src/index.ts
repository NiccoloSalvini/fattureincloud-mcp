#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FicClient } from "./client.js";
import { envFile, loadEnvFile } from "./env.js";
import { runDue, type RunReport } from "./runner.js";
import { ScheduleStore, dataDir, upcoming } from "./schedules.js";
import { createServer, parseToolsets, VERSION } from "./server.js";

const HELP = `fattureincloud-mcp ${VERSION} — MCP server per Fatture in Cloud

Uso:
  fattureincloud-mcp                     avvia il server MCP su stdio (per Claude, Cursor, ...)
  fattureincloud-mcp http [--port 3000] [--host 127.0.0.1] [--oauth]
                                         server MCP Streamable HTTP, stateless; con --oauth
                                         login "Accedi con Fatture in Cloud" (claude.ai)
  fattureincloud-mcp run-due [--dry-run] [--notify]
                                         esegue le fatture ricorrenti in scadenza oggi
  fattureincloud-mcp schedules           elenca le fatture ricorrenti
  fattureincloud-mcp install-scheduler [--hour 8] [--minute 0]
                                         esegue run-due ogni giorno (launchd su macOS, cron altrove)
  fattureincloud-mcp uninstall-scheduler

Variabili: FIC_ACCESS_TOKEN (obbligatoria), FIC_COMPANY_ID, FIC_TOOLSETS, FIC_MCP_DATA_DIR.
Modalità OAuth: PUBLIC_URL, FIC_OAUTH_CLIENT_ID, FIC_OAUTH_CLIENT_SECRET, OAUTH_ENCRYPTION_KEY, FIC_OAUTH_SCOPES.
Le variabili possono stare in ${envFile()}.`;

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const LAUNCHD_LABEL = "com.github.fattureincloud-mcp.run-due";

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  loadEnvFile();

  switch (cmd) {
    case undefined:
    case "serve":
    case "stdio": {
      const server = createServer(FicClient.fromEnv(), { toolsets: parseToolsets(process.env.FIC_TOOLSETS) });
      await server.connect(new StdioServerTransport());
      return;
    }
    case "http": {
      const common = {
        port: Number(option(args, "port", process.env.PORT ?? "3000")),
        host: option(args, "host", process.env.HOST ?? "127.0.0.1"),
        toolsets: parseToolsets(process.env.FIC_TOOLSETS),
      };
      // OAuth mode: explicit flag, or implied by the Fatture in Cloud OAuth app credentials
      if (flag(args, "oauth") || process.env.FIC_OAUTH_CLIENT_ID) {
        const { oauthConfigFromEnv, startOAuthHttp } = await import("./oauth.js");
        startOAuthHttp({ ...common, config: oauthConfigFromEnv() });
        return;
      }
      const { startHttp } = await import("./http.js");
      startHttp(common);
      return;
    }
    case "run-due":
      return cmdRunDue(flag(args, "dry-run"), flag(args, "notify"));
    case "schedules":
      return cmdSchedules();
    case "install-scheduler":
      return installScheduler(Number(option(args, "hour", "8")), Number(option(args, "minute", "0")));
    case "uninstall-scheduler":
      return uninstallScheduler();
    case "-v":
    case "--version":
      console.log(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Comando sconosciuto: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

async function cmdRunDue(dryRun: boolean, notifyUser: boolean) {
  const reports = await runDue(FicClient.fromEnv(), new ScheduleStore(), { dry_run: dryRun });
  const stamp = new Date().toISOString();
  if (!reports.length) {
    console.log(`${stamp} nessuna ricorrenza in scadenza`);
    return;
  }
  for (const r of reports) console.log(`${stamp} ${formatReport(r)}`);
  if (dryRun) console.log(JSON.stringify(reports.map((r) => r.preview), null, 2));
  const errors = reports.filter((r) => r.run.status === "error");
  if (notifyUser) {
    const ok = reports.length - errors.length;
    notify(
      errors.length ? `${errors.length} ricorrenze con errori` : `${ok} documenti creati`,
      reports.map((r) => `${r.name}: ${r.run.status === "error" ? "ERRORE" : `n. ${r.run.number ?? "?"}`}`).join(", "),
    );
  }
  if (errors.length) process.exitCode = 1;
}

function formatReport(r: RunReport): string {
  const parts = [`[${r.run.status}]`, r.name];
  if (r.run.document_id) parts.push(`documento ${r.run.document_id} n. ${r.run.number ?? "?"}`);
  if (r.run.sent_sdi) parts.push("inviato SdI");
  if (r.run.emailed) parts.push("email inviata");
  if (r.run.message) parts.push(`— ${r.run.message}`);
  return parts.join(" ");
}

function notify(title: string, message: string) {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFileSync("osascript", ["-e", `display notification "${esc(message)}" with title "Fatture in Cloud" subtitle "${esc(title)}"`]);
  } catch {
    /* notifications are best effort */
  }
}

async function cmdSchedules() {
  const store = new ScheduleStore();
  const all = await store.load();
  if (!all.length) {
    console.log(`Nessuna ricorrenza (${store.file}). Creane una dal tuo client MCP con schedule_create.`);
    return;
  }
  for (const s of all) {
    const last = s.history.at(-1);
    console.log(
      `${s.enabled ? "●" : "○"} ${s.name} [${s.id}] doc ${s.source_document_id}, ogni ${s.every_months} mesi il giorno ${s.day_of_month}, ${s.action}` +
        `\n    prossime: ${upcoming(s, 3).join(", ") || "—"}` +
        (last ? `\n    ultima: ${last.date} ${last.status}${last.number ? ` n. ${last.number}` : ""}${last.message ? ` (${last.message})` : ""}` : ""),
    );
  }
}

function scriptPath(): string {
  return realpathSync(process.argv[1]);
}

async function installScheduler(hour: number, minute: number) {
  if (!process.env.FIC_ACCESS_TOKEN) {
    console.error(`Prima salva il token in ${envFile()}:\n  FIC_ACCESS_TOKEN=...\n  FIC_COMPANY_ID=...   (facoltativo)`);
    process.exit(1);
  }
  const script = scriptPath();
  if (script.includes("/_npx/")) {
    console.error("Stai usando npx: il percorso cambia a ogni versione. Installa prima con `npm i -g github:NiccoloSalvini/fattureincloud-mcp`.");
    process.exit(1);
  }
  const log = path.join(dataDir(), "run-due.log");
  await fs.mkdir(dataDir(), { recursive: true });

  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${script}</string>
    <string>run-due</string>
    <string>--notify</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.writeFile(plist, xml);
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plist], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist]);
    console.log(
      `Installato: ogni giorno alle ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (se il Mac è in stop, al risveglio; le scadenze perse vengono recuperate alla prima esecuzione).\n` +
        `  job: ${plist}\n  log: ${log}\n  token letto da: ${envFile()}`,
    );
    return;
  }

  const line = `${minute} ${hour} * * * ${process.execPath} ${script} run-due >> ${log} 2>&1`;
  console.log(`Aggiungi questa riga con \`crontab -e\`:\n\n${line}\n\nIl token viene letto da ${envFile()}.`);
}

async function uninstallScheduler() {
  if (process.platform !== "darwin") {
    console.log("Rimuovi la riga `run-due` con `crontab -e`.");
    return;
  }
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plist], { stdio: "ignore" });
  } catch {
    /* already unloaded */
  }
  await fs.rm(plist, { force: true });
  console.log("Pianificazione rimossa.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

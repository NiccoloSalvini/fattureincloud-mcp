/**
 * Loads KEY=VALUE pairs from ~/.config/fattureincloud-mcp/.env (or
 * $FIC_MCP_DATA_DIR/.env) without overriding variables already set.
 * Lets cron/launchd run `run-due` without secrets in the job definition.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./schedules.js";

export function envFile(): string {
  return path.join(dataDir(), ".env");
}

export function loadEnvFile(file = envFile()): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

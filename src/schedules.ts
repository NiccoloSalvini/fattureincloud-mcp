/**
 * Recurring documents ("fatture ricorrenti"), stored locally as JSON.
 *
 * Fatture in Cloud has no native scheduling, so a schedule lives on your machine
 * and is executed by `fattureincloud-mcp run-due` (cron / launchd / any scheduler)
 * or on demand through the MCP tools.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CopyOverrides } from "./copy.js";
import { parseISODate, toISODate } from "./copy.js";

export type ScheduleAction = "create" | "create_and_send_sdi";

export interface ScheduleEmail {
  enabled: boolean;
  recipient_email?: string;
  subject?: string;
  body?: string;
  send_copy?: boolean;
}

export interface ScheduleRun {
  run_at: string;
  date: string;
  status: "ok" | "error" | "dry_run";
  document_id?: number;
  number?: number | null;
  sent_sdi?: boolean;
  emailed?: boolean;
  message?: string;
}

export interface Schedule {
  id: string;
  name: string;
  company_id: number;
  /** Document copied at every run (the "template"). */
  source_document_id: number;
  /** 1 = monthly, 3 = quarterly, 12 = yearly, ... */
  every_months: number;
  /** Day of the month; values beyond the month length mean "last day". */
  day_of_month: number;
  /** First possible run date (YYYY-MM-DD). */
  start_date: string;
  end_date?: string;
  next_run: string | null;
  action: ScheduleAction;
  email?: ScheduleEmail;
  overrides?: CopyOverrides;
  enabled: boolean;
  created_at: string;
  history: ScheduleRun[];
}

// ---- Date logic (pure) ----------------------------------------------------

function occurrence(startIso: string, everyMonths: number, dayOfMonth: number, k: number): string {
  const s = parseISODate(startIso);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth() + k * everyMonths;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toISODate(new Date(Date.UTC(y, m, Math.min(dayOfMonth, lastDay))));
}

/**
 * First occurrence on or after `fromIso` (strictly after if `strict`),
 * aligned to start_date's month and the schedule period. Null past end_date.
 */
export function nextOccurrence(
  s: Pick<Schedule, "start_date" | "every_months" | "day_of_month" | "end_date">,
  fromIso: string,
  strict = false,
): string | null {
  for (let k = 0; k < 12 * 200; k++) {
    const d = occurrence(s.start_date, s.every_months, s.day_of_month, k);
    if (d < s.start_date) continue;
    if (strict ? d > fromIso : d >= fromIso) {
      return s.end_date && d > s.end_date ? null : d;
    }
  }
  return null;
}

export function upcoming(
  s: Pick<Schedule, "start_date" | "every_months" | "day_of_month" | "end_date" | "next_run">,
  n: number,
): string[] {
  const out: string[] = [];
  let d = s.next_run;
  while (d && out.length < n) {
    out.push(d);
    d = nextOccurrence(s, d, true);
  }
  return out;
}

export function todayISO(now = new Date()): string {
  // Local calendar date, not UTC: a run at 00:30 in Italy belongs to that day.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---- Storage --------------------------------------------------------------

export function dataDir(env = process.env): string {
  return env.FIC_MCP_DATA_DIR ?? path.join(os.homedir(), ".config", "fattureincloud-mcp");
}

export class ScheduleStore {
  readonly file: string;
  readonly lockFile: string;

  constructor(readonly dir = dataDir()) {
    this.file = path.join(dir, "schedules.json");
    this.lockFile = path.join(dir, "run.lock");
  }

  async load(): Promise<Schedule[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")).schedules ?? [];
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async save(schedules: Schedule[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, schedules }, null, 2) + "\n");
    await fs.rename(tmp, this.file);
  }

  async get(id: string): Promise<Schedule> {
    const s = (await this.load()).find((x) => x.id === id || x.name === id);
    if (!s) throw new Error(`Pianificazione non trovata: ${id}`);
    return s;
  }

  async add(input: Omit<Schedule, "id" | "created_at" | "history" | "next_run">, today = todayISO()): Promise<Schedule> {
    validate(input);
    const all = await this.load();
    if (all.some((x) => x.name === input.name)) throw new Error(`Esiste già una pianificazione "${input.name}"`);
    const s: Schedule = {
      ...input,
      id: randomUUID().slice(0, 8),
      created_at: new Date().toISOString(),
      history: [],
      next_run: nextOccurrence(input, input.start_date > today ? input.start_date : today),
    };
    all.push(s);
    await this.save(all);
    return s;
  }

  async update(id: string, patch: Partial<Schedule>, today = todayISO()): Promise<Schedule> {
    const all = await this.load();
    const i = all.findIndex((x) => x.id === id || x.name === id);
    if (i < 0) throw new Error(`Pianificazione non trovata: ${id}`);
    const { id: _i, history: _h, created_at: _c, ...allowed } = patch;
    const s = { ...all[i], ...allowed };
    validate(s);
    const timing = ["start_date", "every_months", "day_of_month", "end_date"] as const;
    if (timing.some((k) => k in patch) && !("next_run" in patch)) {
      s.next_run = nextOccurrence(s, s.start_date > today ? s.start_date : today);
    }
    all[i] = s;
    await this.save(all);
    return s;
  }

  async remove(id: string): Promise<Schedule> {
    const all = await this.load();
    const i = all.findIndex((x) => x.id === id || x.name === id);
    if (i < 0) throw new Error(`Pianificazione non trovata: ${id}`);
    const [removed] = all.splice(i, 1);
    await this.save(all);
    return removed;
  }

  /** Cross-process lock so cron and an MCP call never run the same schedule twice. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.lockFile, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const age = Date.now() - (await fs.stat(this.lockFile)).mtimeMs;
      if (age < 10 * 60_000) throw new Error(`Un'altra esecuzione è in corso (lock ${this.lockFile})`);
      await fs.rm(this.lockFile, { force: true });
      handle = await fs.open(this.lockFile, "wx");
    }
    try {
      await handle.writeFile(String(process.pid));
      return await fn();
    } finally {
      await handle.close();
      await fs.rm(this.lockFile, { force: true });
    }
  }
}

function validate(s: Pick<Schedule, "every_months" | "day_of_month" | "start_date" | "end_date">) {
  if (!Number.isInteger(s.every_months) || s.every_months < 1 || s.every_months > 24)
    throw new Error("every_months deve essere un intero tra 1 e 24");
  if (!Number.isInteger(s.day_of_month) || s.day_of_month < 1 || s.day_of_month > 31)
    throw new Error("day_of_month deve essere tra 1 e 31");
  parseISODate(s.start_date);
  if (s.end_date) parseISODate(s.end_date);
}

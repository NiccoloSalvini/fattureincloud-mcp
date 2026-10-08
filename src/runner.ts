/**
 * Executes due schedules. Delivery is at-most-once: next_run is advanced and
 * saved *before* the document is created, so a crash can skip a run (visible in
 * the history as an error) but can never issue the same invoice twice.
 */
import type { FicClient } from "./client.js";
import { duplicateDocument, emailDocument, sendToSdi } from "./actions.js";
import { nextOccurrence, todayISO, type Schedule, type ScheduleRun, type ScheduleStore } from "./schedules.js";

const MAX_HISTORY = 50;

export interface RunReport {
  schedule_id: string;
  name: string;
  run: ScheduleRun;
  preview?: unknown;
}

export async function executeSchedule(
  client: FicClient,
  s: Schedule,
  opts: { date: string; dry_run?: boolean },
): Promise<{ run: ScheduleRun; preview?: unknown }> {
  const c = client.withCompany(s.company_id);
  const run: ScheduleRun = { run_at: new Date().toISOString(), date: opts.date, status: "ok" };
  try {
    const dup = await duplicateDocument(c, s.source_document_id, {
      date: opts.date,
      overrides: s.overrides,
      dry_run: opts.dry_run,
    });
    if (opts.dry_run) {
      run.status = "dry_run";
      return { run, preview: dup.document };
    }
    run.document_id = dup.document.id ?? undefined;
    run.number = dup.document.number;
    const notes: string[] = [];
    if (s.action === "create_and_send_sdi" && run.document_id) {
      const sdi = await sendToSdi(c, run.document_id);
      run.sent_sdi = sdi.sent;
      if (!sdi.verified) {
        run.status = "error";
        notes.push(`Creata ma NON inviata allo SdI: verifica XML fallita: ${JSON.stringify(sdi.detail)}`);
      }
    }
    if (s.email?.enabled && run.document_id) {
      try {
        await emailDocument(c, run.document_id, s.email);
        run.emailed = true;
      } catch (e: any) {
        run.status = "error";
        notes.push(`Email non inviata: ${e.message}`);
      }
    }
    if (notes.length) run.message = notes.join(" | ");
  } catch (e: any) {
    run.status = "error";
    run.message = e?.message ?? String(e);
  }
  return { run };
}

/** Runs every enabled schedule whose next_run is on or before `today`. */
export async function runDue(
  client: FicClient,
  store: ScheduleStore,
  opts: { today?: string; dry_run?: boolean } = {},
): Promise<RunReport[]> {
  const today = opts.today ?? todayISO();
  return store.withLock(async () => {
    const reports: RunReport[] = [];
    const due = (await store.load()).filter((s) => s.enabled && s.next_run && s.next_run <= today);
    for (const s of due) {
      if (!opts.dry_run) {
        // Missed periods are not back-filled: one document per run, dated today.
        await store.update(s.id, { next_run: nextOccurrence(s, today, true) }, today);
      }
      const { run, preview } = await executeSchedule(client, s, { date: today, dry_run: opts.dry_run });
      if (!opts.dry_run) await appendHistory(store, s.id, run);
      reports.push({ schedule_id: s.id, name: s.name, run, preview });
    }
    return reports;
  });
}

/** Runs one schedule now, without touching its next_run. */
export async function runNow(
  client: FicClient,
  store: ScheduleStore,
  id: string,
  opts: { date?: string; dry_run?: boolean } = {},
): Promise<RunReport> {
  return store.withLock(async () => {
    const s = await store.get(id);
    const { run, preview } = await executeSchedule(client, s, { date: opts.date ?? todayISO(), dry_run: opts.dry_run });
    if (!opts.dry_run) await appendHistory(store, s.id, run);
    return { schedule_id: s.id, name: s.name, run, preview };
  });
}

async function appendHistory(store: ScheduleStore, id: string, run: ScheduleRun) {
  const s = await store.get(id);
  const history = [...s.history, run].slice(-MAX_HISTORY);
  // update() strips history from patches, so write it directly
  const all = await store.load();
  const i = all.findIndex((x) => x.id === id);
  all[i] = { ...s, history };
  await store.save(all);
}

/**
 * Minimal iCalendar (RFC 5545) writer for all-day reminders.
 */

export interface IcsEvent {
  uid: string;
  date: string; // YYYY-MM-DD
  summary: string;
  description?: string;
  /** Days before the event to show an alert. */
  alarms?: number[];
}

function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines longer than 75 octets, as the spec requires. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (Buffer.byteLength(current + ch, "utf8") > limit) {
      parts.push(current);
      current = "";
    }
    current += ch;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const compact = (iso: string) => iso.replace(/-/g, "");

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildIcs(events: IcsEvent[], opts: { name: string; now?: Date }): string {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fattureincloud-mcp//IT", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${escape(opts.name)}`];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.date)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(e.date))}`,
      `SUMMARY:${escape(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`);
    lines.push("TRANSP:TRANSPARENT");
    for (const days of e.alarms ?? []) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(e.summary)}`, `TRIGGER:-P${days}D`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

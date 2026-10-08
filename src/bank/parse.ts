/**
 * Parses bank statement exports (XLSX, XLS, CSV) from Italian and online banks
 * into a common transaction shape. Each bank is a declarative profile matched
 * on its header row, so a new bank is a few lines.
 */
import * as XLSX from "xlsx";

export interface BankTransaction {
  /** Booking date (YYYY-MM-DD). */
  date: string;
  value_date?: string;
  /** Positive = accredito, negative = addebito. */
  amount: number;
  description: string;
  counterparty?: string;
  bank: string;
  id?: string;
}

type Cell = string | number | boolean | null | undefined;
type Row = Record<string, Cell>;

// ---- Value parsing -----------------------------------------------------------

const MONTHS: Record<string, number> = {
  gen: 1, gennaio: 1, feb: 2, febbraio: 2, mar: 3, marzo: 3, apr: 4, aprile: 4, mag: 5, maggio: 5, giu: 6, giugno: 6,
  lug: 7, luglio: 7, ago: 8, agosto: 8, set: 9, settembre: 9, ott: 10, ottobre: 10, nov: 11, novembre: 11, dic: 12, dicembre: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

export function parseDate(v: Cell): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  const s = String(v).trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad(+m[2])}-${pad(+m[1])}`;
  }
  m = /^(\d{1,2})\s+([a-zà]+)\.?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2]]) return `${m[3]}-${pad(MONTHS[m[2]])}-${pad(+m[1])}`;
  return null;
}

/** "1.234,56" / "1,234.56" / "-14,49" / "€ 100" / numbers. */
export function parseAmount(v: Cell): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).replace(/[€\s ]|EUR/gi, "");
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^[+-]?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export function normalizeHeader(h: Cell): string {
  return String(h ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim();
}

const text = (...parts: Cell[]) =>
  parts
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter(Boolean)
    .join(" — ");

function amountFrom(row: Row, credit: string, debit: string): number | null {
  const c = parseAmount(row[credit]);
  const d = parseAmount(row[debit]);
  if (c == null && d == null) return null;
  return (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
}

// ---- Bank profiles -------------------------------------------------------------

export interface BankProfile {
  id: string;
  name: string;
  /** Normalized headers that must all be present. */
  requires: string[];
  map(row: Row): Omit<BankTransaction, "bank"> | null;
}

const isBooked = (v: Cell) => !/non contabilizzat|in lavorazione|pending|reverted|declined|failed/i.test(String(v ?? ""));

export const PROFILES: BankProfile[] = [
  {
    id: "intesa",
    name: "Intesa Sanpaolo / Isybank (XLSX «Lista movimenti»)",
    requires: ["data", "operazione", "dettagli", "importo"],
    map: (r) => {
      if ("contabilizzazione" in r && !isBooked(r["contabilizzazione"])) return null;
      const date = parseDate(r["data"]);
      const amount = parseAmount(r["importo"]);
      return date && amount != null ? { date, amount, description: text(r["operazione"], r["dettagli"]) } : null;
    },
  },
  {
    id: "intesa_csv",
    name: "Intesa Sanpaolo (CSV accrediti/addebiti)",
    requires: ["data contabile", "data valuta", "descrizione", "accrediti", "addebiti"],
    map: (r) => {
      const date = parseDate(r["data contabile"]);
      const amount = amountFrom(r, "accrediti", "addebiti");
      return date && amount != null
        ? { date, value_date: parseDate(r["data valuta"]) ?? undefined, amount, description: text(r["descrizione"], r["descrizione estesa"]) }
        : null;
    },
  },
  {
    id: "unicredit",
    name: "UniCredit (CSV)",
    requires: ["data registrazione", "descrizione", "importo (eur)"],
    map: (r) => {
      const date = parseDate(r["data registrazione"]);
      const amount = parseAmount(r["importo (eur)"]);
      return date && amount != null ? { date, value_date: parseDate(r["data valuta"]) ?? undefined, amount, description: text(r["descrizione"]) } : null;
    },
  },
  {
    id: "fineco",
    name: "Fineco (XLSX)",
    requires: ["data operazione", "entrate", "uscite", "descrizione"],
    map: (r) => {
      if ("stato" in r && !isBooked(r["stato"])) return null;
      const date = parseDate(r["data operazione"]);
      const amount = amountFrom(r, "entrate", "uscite");
      return date && amount != null
        ? { date, value_date: parseDate(r["data valuta"]) ?? undefined, amount, description: text(r["descrizione"], r["descrizione completa"]) }
        : null;
    },
  },
  {
    id: "fineco_csv",
    name: "Fineco (CSV)",
    requires: ["data", "entrate", "uscite", "descrizione", "descrizione completa"],
    map: (r) => {
      const date = parseDate(r["data"]);
      const amount = amountFrom(r, "entrate", "uscite");
      return date && amount != null ? { date, amount, description: text(r["descrizione"], r["descrizione completa"]) } : null;
    },
  },
  {
    id: "poste",
    name: "Poste Italiane / BancoPosta (XLSX)",
    requires: ["data contabile", "addebiti (euro)", "accrediti (euro)", "descrizione operazioni"],
    map: (r) => {
      if (!isBooked(Object.values(r).join(" "))) return null;
      const date = parseDate(r["data contabile"]);
      const amount = amountFrom(r, "accrediti (euro)", "addebiti (euro)");
      return date && amount != null
        ? { date, value_date: parseDate(r["data valuta"]) ?? undefined, amount, description: text(r["descrizione operazioni"]) }
        : null;
    },
  },
  {
    id: "bper",
    name: "BPER Banca (XLS «Movimenti Conto»)",
    requires: ["data operazione", "descrizione", "entrate", "uscite", "categoria"],
    map: (r) => {
      if ("stato" in r && !isBooked(r["stato"])) return null;
      const date = parseDate(r["data operazione"]);
      const amount = amountFrom(r, "entrate", "uscite");
      return date && amount != null ? { date, value_date: parseDate(r["data valuta"]) ?? undefined, amount, description: text(r["descrizione"]) } : null;
    },
  },
  {
    id: "ing",
    name: "ING Italia",
    requires: ["data contabile", "data valuta", "causale", "descrizione operazione", "importo"],
    map: (r) => {
      const date = parseDate(r["data contabile"]);
      const amount = parseAmount(r["importo"]);
      return date && amount != null
        ? { date, value_date: parseDate(r["data valuta"]) ?? undefined, amount, description: text(r["causale"], r["descrizione operazione"]) }
        : null;
    },
  },
  {
    id: "revolut",
    name: "Revolut (CSV)",
    requires: ["type", "started date", "completed date", "description", "amount", "state"],
    map: (r) => {
      if (String(r["state"]).toUpperCase() !== "COMPLETED") return null;
      const date = parseDate(r["completed date"]) ?? parseDate(r["started date"]);
      const amount = parseAmount(r["amount"]);
      const fee = parseAmount(r["fee"]) ?? 0;
      return date && amount != null ? { date, amount: amount - fee, description: text(r["description"]), counterparty: String(r["description"] ?? "") } : null;
    },
  },
  {
    id: "n26",
    name: "N26 (CSV)",
    requires: ["booking date", "partner name", "amount (eur)"],
    map: (r) => {
      const date = parseDate(r["booking date"]);
      const amount = parseAmount(r["amount (eur)"]);
      return date && amount != null
        ? {
            date,
            value_date: parseDate(r["value date"]) ?? undefined,
            amount,
            description: text(r["partner name"], r["payment reference"]),
            counterparty: String(r["partner name"] ?? ""),
          }
        : null;
    },
  },
  {
    id: "qonto",
    name: "Qonto (CSV)",
    requires: ["settlement date", "counterparty name", "amount"],
    map: (r) => {
      if ("status" in r && !/settled|completed|^$/i.test(String(r["status"] ?? ""))) return null;
      const date = parseDate(r["settlement date"]);
      let amount = parseAmount(r["amount"]);
      if (amount != null && /debit/i.test(String(r["side"] ?? r["credit/debit"] ?? ""))) amount = -Math.abs(amount);
      return date && amount != null
        ? {
            date,
            amount,
            description: text(r["counterparty name"], r["reference"], r["label"]),
            counterparty: String(r["counterparty name"] ?? ""),
            id: r["transaction id"] ? String(r["transaction id"]) : undefined,
          }
        : null;
    },
  },
];

export interface ColumnMapping {
  date: string;
  amount?: string;
  credit?: string;
  debit?: string;
  description: string[] | string;
  value_date?: string;
}

/** Profile for any bank, from an explicit column mapping or guessed from headers. */
export function genericProfile(headers: string[], mapping?: ColumnMapping): BankProfile | null {
  const norm = (s?: string) => (s ? normalizeHeader(s) : undefined);
  const find = (re: RegExp) => headers.find((h) => re.test(h));
  const m = mapping
    ? {
        date: norm(mapping.date),
        amount: norm(mapping.amount),
        credit: norm(mapping.credit),
        debit: norm(mapping.debit),
        value_date: norm(mapping.value_date),
        description: (Array.isArray(mapping.description) ? mapping.description : [mapping.description]).map((d) => norm(d)!),
      }
    : {
        date: find(/^data( contabile| operazione| registrazione)?$|^date$|booking date|^data$/) ?? find(/data|date/),
        value_date: find(/valuta|value date/),
        amount: find(/^importo|^amount|^ammontare/),
        credit: find(/accredit|entrate|avere|credit/),
        debit: find(/addebit|uscite|dare|debit/),
        description: [] as string[],
      };
  if (!mapping) {
    const used = new Set([m.date, m.value_date, m.amount, m.credit, m.debit]);
    m.description = headers.filter((h) => !used.has(h) && /descr|causale|dettagl|operazione|reference|beneficiar|ordinante|controparte/.test(h));
  }
  if (!m.date || !(m.amount || (m.credit && m.debit)) || !m.description.length) return null;
  return {
    id: "generic",
    name: mapping ? "Formato personalizzato" : "Formato generico (colonne riconosciute automaticamente)",
    requires: [m.date],
    map: (r) => {
      const date = parseDate(r[m.date!]);
      const amount = m.amount ? parseAmount(r[m.amount]) : amountFrom(r, m.credit!, m.debit!);
      return date && amount != null
        ? { date, value_date: m.value_date ? parseDate(r[m.value_date]) ?? undefined : undefined, amount, description: text(...m.description.map((d) => r[d])) }
        : null;
    },
  };
}

// ---- File reading ---------------------------------------------------------------

function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  // Fall back to Windows-1252 when the file is not valid UTF-8 (older Italian exports)
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(bytes) : utf8;
}

export function parseCsv(content: string): string[][] {
  const text = content.replace(/^﻿/, "");
  const firstLines = text.split(/\r?\n/).slice(0, 30).join("\n");
  const delimiter = [";", "\t", ","].map((d) => ({ d, n: firstLines.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readRows(bytes: Uint8Array, filename: string): Cell[][] {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "txt") return parseCsv(decodeText(bytes));
  const wb = XLSX.read(bytes, { type: "array", cellDates: false, raw: true });
  const rows: Cell[][] = [];
  for (const name of wb.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    if (sheetRows.length > rows.length) rows.splice(0, rows.length, ...sheetRows); // keep the biggest sheet
  }
  return rows;
}

export interface ParsedStatement {
  bank: string;
  bank_name: string;
  header_row: number;
  transactions: BankTransaction[];
  skipped_rows: number;
}

export function parseStatement(bytes: Uint8Array, filename: string, opts: { bank?: string; mapping?: ColumnMapping } = {}): ParsedStatement {
  const rows = readRows(bytes, filename);
  const candidates = opts.bank ? PROFILES.filter((p) => p.id === opts.bank) : PROFILES;
  if (opts.bank && !candidates.length && opts.bank !== "generic") throw new Error(`Banca sconosciuta: ${opts.bank}. Disponibili: ${PROFILES.map((p) => p.id).join(", ")}, generic`);

  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const headers = rows[i].map(normalizeHeader);
    const profile =
      (opts.mapping ? null : candidates.find((p) => p.requires.every((h) => headers.includes(h)))) ??
      ((opts.mapping || opts.bank === "generic" || (!opts.bank && i === lastHeaderGuess(rows))) ? genericProfile(headers.filter(Boolean), opts.mapping) : null);
    if (!profile) continue;
    if (opts.mapping && !headers.includes(normalizeHeader(opts.mapping.date))) continue;

    const transactions: BankTransaction[] = [];
    let skipped = 0;
    for (const raw of rows.slice(i + 1)) {
      if (raw.every((c) => c == null || c === "")) continue;
      const row: Row = {};
      headers.forEach((h, j) => h && (row[h] = raw[j]));
      const tx = profile.map(row);
      if (tx) transactions.push({ ...tx, bank: profile.id, description: tx.description || "(senza descrizione)" });
      else skipped++;
    }
    transactions.sort((a, b) => a.date.localeCompare(b.date));
    return { bank: profile.id, bank_name: profile.name, header_row: i + 1, transactions, skipped_rows: skipped };
  }
  throw new Error(
    "Formato non riconosciuto. Indica la banca (bank) oppure le colonne (mapping: { date, amount | credit+debit, description }). " +
      `Prime righe: ${JSON.stringify(rows.slice(0, 5))}`,
  );
}

/** Index of the first row that looks like a header (several text cells incl. a date-ish one). */
function lastHeaderGuess(rows: Cell[][]): number {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const h = rows[i].map(normalizeHeader).filter(Boolean);
    if (h.length >= 3 && h.some((x) => /data|date/.test(x)) && h.some((x) => /importo|amount|entrate|accredit|avere/.test(x))) return i;
  }
  return -1;
}

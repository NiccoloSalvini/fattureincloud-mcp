/**
 * Enable Banking (https://enablebanking.com) client for PSD2 account access.
 *
 * Each user brings their own application: register it in production at
 * enablebanking.com/cp, activate it by linking your own accounts ("restricted"
 * mode, free for personal use), then authorise a session through the API.
 * Requests are signed with an RS256 JWT whose kid is the application id.
 */
import { createSign, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BankTransaction } from "./parse.js";

export const EB_API = "https://api.enablebanking.com";

export interface EbConfig {
  appId: string;
  privateKey: string;
  redirectUrl: string;
}

export function ebConfigFromEnv(env = process.env): EbConfig {
  const appId = env.ENABLE_BANKING_APP_ID;
  const keyPath = env.ENABLE_BANKING_KEY_PATH;
  if (!appId || !keyPath) {
    throw new Error(
      "Collegamento bancario non configurato. Servono ENABLE_BANKING_APP_ID e ENABLE_BANKING_KEY_PATH (chiave .pem dell'app), " +
        "più ENABLE_BANKING_REDIRECT_URL uguale a quello registrato. Guida: README, sezione «Banca».",
    );
  }
  return {
    appId,
    privateKey: keyPath.replace(/^~(?=\/)/, os.homedir()),
    redirectUrl: env.ENABLE_BANKING_REDIRECT_URL ?? "https://localhost:8765/callback",
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(appId: string, pem: string, now = Math.floor(Date.now() / 1000), ttl = 3600): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const body = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + ttl }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${b64url(signer.sign(pem))}`;
}

export class EnableBanking {
  private pem?: string;

  constructor(
    private cfg: EbConfig,
    private fetchImpl: typeof fetch = fetch,
    private base = EB_API,
  ) {}

  private async key(): Promise<string> {
    if (!this.pem) this.pem = this.cfg.privateKey.includes("BEGIN") ? this.cfg.privateKey : await fs.readFile(this.cfg.privateKey, "utf8");
    return this.pem;
  }

  async request<T = any>(method: "GET" | "POST" | "DELETE", p: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.base + p);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${signJwt(this.cfg.appId, await this.key())}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`Enable Banking ${res.status} su ${method} ${p}: ${data?.message ?? data?.error ?? text}`);
    return data as T;
  }

  async listBanks(country = "IT"): Promise<{ name: string; country: string; psu_types?: string[]; maximum_consent_validity?: number }[]> {
    return (await this.request("GET", "/aspsps", { query: { country, psu_type: undefined } })).aspsps ?? [];
  }

  async startAuthorization(opts: { bank: string; country?: string; psu_type?: "personal" | "business"; days?: number }) {
    const state = randomUUID();
    const validUntil = new Date(Date.now() + (opts.days ?? 180) * 86_400_000).toISOString();
    const res = await this.request("POST", "/auth", {
      body: {
        access: { valid_until: validUntil },
        aspsp: { name: opts.bank, country: opts.country ?? "IT" },
        state,
        redirect_url: this.cfg.redirectUrl,
        psu_type: opts.psu_type ?? "personal",
      },
    });
    return { url: res.url as string, state, valid_until: validUntil };
  }

  async createSession(code: string) {
    return this.request("POST", "/sessions", { body: { code } });
  }

  async transactions(accountUid: string, from: string, to?: string): Promise<any[]> {
    const out: any[] = [];
    let continuation: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.request("GET", `/accounts/${accountUid}/transactions`, {
        query: { date_from: from, date_to: to, continuation_key: continuation },
      });
      out.push(...(res.transactions ?? []));
      continuation = res.continuation_key || undefined;
      if (!continuation) break;
    }
    return out;
  }
}

/** Maps an Enable Banking transaction to the common shape (booked only). */
export function mapEbTransaction(t: any, bank = "enable_banking"): BankTransaction | null {
  if (t.status && t.status !== "BOOK") return null;
  const amount = Number(t.transaction_amount?.amount);
  if (!Number.isFinite(amount)) return null;
  const credit = t.credit_debit_indicator !== "DBIT";
  const date = t.booking_date ?? t.value_date ?? t.transaction_date;
  if (!date) return null;
  const counterparty = (credit ? t.debtor?.name : t.creditor?.name) ?? undefined;
  const remittance = Array.isArray(t.remittance_information) ? t.remittance_information.join(" ") : (t.remittance_information ?? "");
  return {
    date,
    value_date: t.value_date ?? undefined,
    amount: credit ? Math.abs(amount) : -Math.abs(amount),
    description: [counterparty, remittance, t.note].filter(Boolean).join(" — ") || "(senza descrizione)",
    counterparty,
    bank,
    id: t.transaction_id ?? t.entry_reference ?? undefined,
  };
}

// ---- Linked sessions ---------------------------------------------------------

export interface LinkedSession {
  session_id: string;
  bank: string;
  country: string;
  valid_until: string;
  created_at: string;
  accounts: { uid: string; iban?: string; name?: string; currency?: string }[];
}

export class BankLinkStore {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, "bank-sessions.json");
  }

  async load(): Promise<{ pending: Record<string, { bank: string; country: string; valid_until: string }>; sessions: LinkedSession[] }> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return { pending: {}, sessions: [] };
      throw e;
    }
  }

  async save(data: Awaited<ReturnType<BankLinkStore["load"]>>) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  }
}

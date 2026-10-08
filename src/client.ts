/**
 * Minimal, dependency-free client for the Fatture in Cloud API v2.
 * Spec: https://github.com/fattureincloud/openapi-fattureincloud
 */

export const API_BASE = "https://api-v2.fattureincloud.it";

export const DOCUMENT_TYPES = [
  "invoice",
  "quote",
  "proforma",
  "receipt",
  "delivery_note",
  "credit_note",
  "order",
  "work_report",
  "supplier_order",
  "self_own_invoice",
  "self_supplier_invoice",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type Json = Record<string, any>;

export type IssuedDocument = Json & {
  id?: number | null;
  type?: DocumentType;
  number?: number | null;
  numeration?: string | null;
  date?: string | null;
  entity?: Json | null;
  items_list?: Json[] | null;
  payments_list?: Json[] | null;
};

export interface ListResponse<T = Json> {
  current_page?: number;
  last_page?: number;
  per_page?: number;
  total?: number;
  next_page_url?: string | null;
  data: T[];
}

export class FicApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    public method: string,
    public path: string,
  ) {
    super(`Fatture in Cloud API ${status} su ${method} ${path}: ${describeError(body)}${hint(status, body)}`);
  }
}

function describeError(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 2000);
  const b = body as any;
  if (typeof b?.error === "string") return b.error_description ? `${b.error}: ${b.error_description}` : b.error;
  const err = b?.error;
  if (err?.message) {
    const fields = err.validation_result ? ` ${JSON.stringify(err.validation_result)}` : "";
    return `${err.message}${fields}`;
  }
  return JSON.stringify(body)?.slice(0, 2000) ?? "";
}

function hint(status: number, body: unknown): string {
  const s = JSON.stringify(body ?? "");
  if (status === 401) return " (token non valido o revocato)";
  if (status === 403 || s.includes("NO_PERMISSION")) return " (il token non ha i permessi per questa risorsa: rigeneralo con gli scope necessari)";
  return "";
}

export interface FicClientOptions {
  token: string;
  companyId?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class FicClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private companyId?: number;

  constructor(opts: FicClientOptions) {
    if (!opts.token) throw new Error("Token Fatture in Cloud mancante");
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.companyId = opts.companyId;
  }

  static fromEnv(env = process.env): FicClient {
    const token = env.FIC_ACCESS_TOKEN;
    if (!token) {
      throw new Error(
        "FIC_ACCESS_TOKEN non impostato. Generalo in Fatture in Cloud → Impostazioni → Sviluppatori → Token manuale " +
          "(https://developers.fattureincloud.it/docs/authentication/manual-authentication/).",
      );
    }
    const companyId = env.FIC_COMPANY_ID ? Number(env.FIC_COMPANY_ID) : undefined;
    return new FicClient({ token, companyId, baseUrl: env.FIC_API_BASE });
  }

  /** Same credentials, different company. */
  withCompany(companyId: number | undefined): FicClient {
    if (companyId === undefined || companyId === this.companyId) return this;
    return new FicClient({ token: this.token, companyId, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl });
  }

  async request<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; form?: FormData } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { method, headers, body });
      if (res.status === 429 && attempt < 3) {
        const wait = Number(res.headers.get("Retry-After") ?? 2 ** attempt * 5);
        await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
        continue;
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw text */
      }
      if (!res.ok) throw new FicApiError(res.status, parsed, method, path);
      return parsed as T;
    }
  }

  /** Resolves the company: explicit id, FIC_COMPANY_ID, or the only company the token can see. */
  async getCompanyId(): Promise<number> {
    if (this.companyId) return this.companyId;
    const companies = await this.listCompanies();
    if (companies.length === 1) return (this.companyId = companies[0].id);
    throw new Error(
      `Il token vede ${companies.length} aziende: passa company_id o imposta FIC_COMPANY_ID. ` +
        companies.map((c) => `${c.id} = ${c.name}`).join(", "),
    );
  }

  /** Prefixes a company-scoped path: "/products" → "/c/123/products". */
  async cpath(path: string): Promise<string> {
    return `/c/${await this.getCompanyId()}${path}`;
  }

  async get<T = any>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>("GET", await this.cpath(path), { query });
  }
  async post<T = any>(path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", await this.cpath(path), { body, query });
  }
  async put<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", await this.cpath(path), { body });
  }
  async del<T = any>(path: string): Promise<T> {
    return this.request<T>("DELETE", await this.cpath(path));
  }

  /** Iterates over every page of a list endpoint, up to `limit` rows. */
  async listAll<T = Json>(path: string, query: Record<string, unknown> = {}, limit = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; out.length < limit; page++) {
      const res = await this.get<ListResponse<T>>(path, { ...query, page, per_page: 100 });
      out.push(...(res.data ?? []));
      if (!res.last_page || page >= res.last_page) break;
    }
    return out.slice(0, limit);
  }

  // ---- Account ------------------------------------------------------------

  async listCompanies(): Promise<Json[]> {
    const res = await this.request("GET", "/user/companies");
    return res?.data?.companies ?? [];
  }

  // ---- Issued documents ---------------------------------------------------

  async getDocument(id: number): Promise<IssuedDocument> {
    return (await this.get(`/issued_documents/${id}`, { fieldset: "detailed" })).data;
  }

  async createDocument(data: IssuedDocument, options: Json = { fix_payments: true }): Promise<IssuedDocument> {
    return (await this.post("/issued_documents", { data, options })).data;
  }

  async modifyDocument(id: number, data: IssuedDocument): Promise<IssuedDocument> {
    return (await this.put(`/issued_documents/${id}`, { data })).data;
  }

  async getEmailData(id: number): Promise<Json> {
    return (await this.get(`/issued_documents/${id}/email`)).data;
  }

  async scheduleEmail(id: number, data: Json) {
    return this.post(`/issued_documents/${id}/email`, { data });
  }

  async verifyEInvoiceXml(id: number): Promise<{ ok: boolean; detail: unknown }> {
    try {
      const res = await this.get(`/issued_documents/${id}/e_invoice/xml_verify`);
      return { ok: true, detail: res?.data ?? res };
    } catch (e) {
      if (e instanceof FicApiError && (e.status === 422 || e.status === 400)) return { ok: false, detail: e.body };
      throw e;
    }
  }

  async sendEInvoice(id: number, opts: { dry_run?: boolean; data?: Json } = {}) {
    const res = await this.post(`/issued_documents/${id}/e_invoice/send`, {
      data: opts.data ?? {},
      options: { dry_run: opts.dry_run ?? false },
    });
    return res?.data ?? res;
  }

  async uploadAttachment(resource: string, bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    const form = new FormData();
    form.set("filename", filename);
    form.set("attachment", new Blob([bytes as BlobPart], { type: mime }), filename);
    const res = await this.request("POST", await this.cpath(`/${resource}/attachment`), { form });
    return res?.data?.attachment_token;
  }

  /** Downloads a URL returned by the API (PDF, attachments). Signed URLs need no auth. */
  async download(url: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`Download fallito (${res.status}): ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

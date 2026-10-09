/**
 * OAuth mode for the HTTP server, so claude.ai (and any MCP client that
 * implements the MCP Authorization spec) can connect with "Accedi con Fatture
 * in Cloud" instead of a copied token.
 *
 * This server is the OAuth 2.1 authorization server for MCP clients (metadata,
 * dynamic client registration, PKCE) and delegates the user login to the
 * Fatture in Cloud Authorization Code flow:
 *
 *   client → /authorize (consent) → FIC /oauth/authorize → /oauth/callback (FIC code →
 *   FIC tokens) → client redirect_uri with our code → /token → our tokens
 *
 * Everything is stateless: client ids, the pending login, authorization codes
 * and access/refresh tokens are sealed with AES-256-GCM (see seal.ts) and carry
 * the FIC tokens inside, so the server needs no database and can scale to zero.
 */
import { randomBytes } from "node:crypto";
import type http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { API_BASE, FicClient } from "./client.js";
import { ScheduleStore } from "./schedules.js";
import { createServer } from "./server.js";
import type { Toolset } from "./tools/define.js";
import { fingerprint, safeEqual, Sealer } from "./seal.js";

/** Read and write on everything the tools touch (":a" includes read). */
export const DEFAULT_FIC_SCOPES = [
  "entity.clients:a",
  "entity.suppliers:a",
  "products:a",
  "issued_documents.invoices:a",
  "issued_documents.credit_notes:a",
  "issued_documents.receipts:a",
  "issued_documents.orders:a",
  "issued_documents.quotes:a",
  "issued_documents.proformas:a",
  "issued_documents.delivery_notes:a",
  "issued_documents.work_reports:a",
  "issued_documents.supplier_orders:a",
  "issued_documents.self_invoices:a",
  "received_documents:a",
  "receipts:a",
  "taxes:a",
  "archive:a",
  "cashbook:a",
  "emails:r",
  "settings:a",
  "situation:r",
].join(" ");

const STATE_TTL = 10 * 60; // login at Fatture in Cloud
const CODE_TTL = 5 * 60; // our authorization code
const REFRESH_TTL = 365 * 24 * 3600; // FIC refresh tokens last one year
const CALLBACK_PATH = "/oauth/callback";

export interface OAuthConfig {
  /** Public origin of the server, e.g. https://fic.example.com (no path). */
  publicUrl: string;
  ficClientId: string;
  ficClientSecret: string;
  /** Space-separated Fatture in Cloud scopes requested at login. */
  scopes: string;
  /** Encryption secrets, newest first. */
  secrets: string[];
  /** Fatture in Cloud base URL for OAuth and API calls. */
  ficBase: string;
  /** Express "trust proxy" (hops in front of the server, default 1). */
  trustProxy: number | boolean | string;
}

export function oauthConfigFromEnv(env = process.env): OAuthConfig {
  const missing = ["PUBLIC_URL", "FIC_OAUTH_CLIENT_ID", "FIC_OAUTH_CLIENT_SECRET", "OAUTH_ENCRYPTION_KEY"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Modalità OAuth: mancano ${missing.join(", ")}. PUBLIC_URL è l'indirizzo pubblico HTTPS del server, ` +
        "FIC_OAUTH_CLIENT_ID e FIC_OAUTH_CLIENT_SECRET vengono dall'app Fatture in Cloud con OAuth 2.0, " +
        "OAUTH_ENCRYPTION_KEY è una chiave casuale (`openssl rand -base64 32`).",
    );
  }
  const url = new URL(env.PUBLIC_URL!);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("PUBLIC_URL deve essere solo l'origine, es. https://fic.example.com");
  const tp = env.TRUST_PROXY ?? "1";
  return {
    publicUrl: url.origin,
    ficClientId: env.FIC_OAUTH_CLIENT_ID!,
    ficClientSecret: env.FIC_OAUTH_CLIENT_SECRET!,
    scopes: env.FIC_OAUTH_SCOPES?.trim() || DEFAULT_FIC_SCOPES,
    secrets: env.OAUTH_ENCRYPTION_KEY!.split(","),
    ficBase: env.FIC_API_BASE ?? API_BASE,
    trustProxy: /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp === "false" ? false : tp,
  };
}

type FicTokens = {
  a: string; // access token
  rt?: string; // refresh token
  e: number; // access token expiry, epoch seconds
};

class FicOAuthError extends Error {
  constructor(public status: number, error: string) {
    super(`Fatture in Cloud OAuth ${status}: ${error}`);
  }
}

/** Client metadata kept inside the sealed client_id (the rest is dropped). */
const CLIENT_FIELDS = [
  "redirect_uris",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "client_name",
  "client_uri",
  "scope",
  "client_secret",
  "client_secret_expires_at",
  "client_id_issued_at",
] as const;

function checkRedirectUri(uri: string) {
  const u = new URL(uri);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  // https everywhere, plain http only on loopback, custom schemes for native apps
  if (u.protocol === "http:" && !loopback) throw new InvalidClientMetadataError(`redirect_uri non sicuro: ${uri}`);
  if (u.hash) throw new InvalidClientMetadataError("redirect_uri non può contenere un frammento");
  if (uri.length > 2000) throw new InvalidClientMetadataError("redirect_uri troppo lungo");
}

export class FicOAuthProvider implements OAuthServerProvider {
  readonly sealer: Sealer;
  readonly resourceUrl: URL;
  readonly callbackUrl: string;
  private readonly usedCodes = new Map<string, number>();

  constructor(
    readonly config: OAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    mcpPath = "/mcp",
  ) {
    this.sealer = new Sealer(config.secrets);
    this.resourceUrl = new URL(config.publicUrl + mcpPath);
    this.callbackUrl = config.publicUrl + CALLBACK_PATH;
  }

  // ---- Dynamic client registration (stateless) ------------------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const p = this.sealer.open<{ m: Omit<OAuthClientInformationFull, "client_id"> }>("client", clientId);
        return p ? { ...p.m, client_id: clientId } : undefined;
      },
      registerClient: (client) => {
        if (!client.redirect_uris.length || client.redirect_uris.length > 10) throw new InvalidClientMetadataError("Da 1 a 10 redirect_uris");
        client.redirect_uris.forEach(checkRedirectUri);
        const m: Record<string, unknown> = {};
        for (const k of CLIENT_FIELDS) if ((client as any)[k] !== undefined) m[k] = (client as any)[k];
        return { ...client, client_id: this.sealer.seal("client", { m }) } as OAuthClientInformationFull;
      },
    };
  }

  // ---- Authorization: hand the login over to Fatture in Cloud ---------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !this.isOurResource(params.resource)) throw new InvalidTargetError("resource non valido per questo server");
    const nonce = randomBytes(18).toString("base64url");
    const state = this.sealer.seal(
      "state",
      { c: fingerprint(client.client_id), r: params.redirectUri, cc: params.codeChallenge, s: params.state, n: nonce },
      STATE_TTL,
    );
    // Binds the login to this browser: the callback must come back with the same cookie (anti-CSRF)
    res.append("Set-Cookie", this.cookie(nonce, nonce, STATE_TTL));
    const url = new URL(`${this.config.ficBase}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.ficClientId);
    url.searchParams.set("redirect_uri", this.callbackUrl);
    url.searchParams.set("scope", this.config.scopes);
    url.searchParams.set("state", state);

    // Our own consent step: Fatture in Cloud only sees one app (ours), so without it any
    // registered client could ride on a login the user already granted (confused deputy)
    const back = new URL(params.redirectUri);
    if (params.state !== undefined) back.searchParams.set("state", params.state);
    back.searchParams.set("error", "access_denied");
    const name = client.client_name?.trim() || "Un'applicazione";
    res.setHeader("X-Frame-Options", "DENY");
    page(
      res,
      200,
      `<p><strong>${escapeHtml(name)}</strong> chiede di accedere ai tuoi dati di Fatture in Cloud. ` +
        `Dopo il login tornerai su <strong>${escapeHtml(back.host || back.protocol)}</strong>.</p>` +
        `<p>Continua solo se hai avviato tu il collegamento.</p>` +
        `<p><a href="${escapeHtml(url.href)}" style="display:inline-block;padding:.6rem 1rem;background:#0d6efd;color:#fff;border-radius:.4rem;text-decoration:none">Accedi con Fatture in Cloud</a>` +
        ` &nbsp; <a href="${escapeHtml(back.href)}">Annulla</a></p>`,
    );
  }

  /** GET /oauth/callback: Fatture in Cloud sends the user back here. */
  async handleCallback(req: Request, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const q = req.query as Record<string, string | undefined>;
    const st = this.sealer.open<{ c: string; r: string; cc: string; s?: string; n: string }>("state", typeof q.state === "string" ? q.state : undefined);
    if (!st) return page(res, 400, "<p>Il link di accesso è scaduto o non è valido. Torna su Claude e ricollega Fatture in Cloud.</p>");
    const cookie = readCookie(req, cookieName(st.n));
    if (!cookie || !safeEqual(cookie, st.n)) {
      return page(res, 400, "<p>Non riesco a verificare l'accesso: completa il login nello stesso browser in cui l'hai iniziato, poi riprova.</p>");
    }
    res.append("Set-Cookie", this.cookie(st.n, "", 0));

    const back = new URL(st.r);
    if (st.s !== undefined) back.searchParams.set("state", st.s);
    if (typeof q.error === "string" || typeof q.code !== "string") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "Accesso a Fatture in Cloud negato o annullato");
      return res.redirect(302, back.href);
    }
    let fic: FicTokens;
    try {
      fic = await this.ficToken({ grant_type: "authorization_code", redirect_uri: this.callbackUrl, code: q.code });
    } catch (e) {
      console.error(`OAuth: scambio del codice con Fatture in Cloud fallito (${e instanceof FicOAuthError ? e.status : "rete"})`);
      back.searchParams.set("error", "server_error");
      back.searchParams.set("error_description", "Fatture in Cloud non ha accettato il login");
      return res.redirect(302, back.href);
    }
    back.searchParams.set("code", this.sealer.seal("code", { c: st.c, r: st.r, cc: st.cc, ...fic }, CODE_TTL));
    res.redirect(302, back.href);
  }

  // ---- Token endpoint ---------------------------------------------------------

  private openCode(client: OAuthClientInformationFull, code: string) {
    const p = this.sealer.open<FicTokens & { c: string; r: string; cc: string }>("code", code);
    if (!p || !safeEqual(p.c, fingerprint(client.client_id))) throw new InvalidGrantError("Codice di autorizzazione non valido o scaduto");
    return p;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const p = this.openCode(client, code);
    if (redirectUri !== undefined && redirectUri !== p.r) throw new InvalidGrantError("redirect_uri diverso da quello dell'autorizzazione");
    if (resource && !this.isOurResource(resource)) throw new InvalidTargetError("resource non valido per questo server");
    // Best effort single use: per instance, within the code lifetime (PKCE covers the rest)
    const now = Date.now() / 1000;
    for (const [k, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(k);
    const id = fingerprint(code);
    if (this.usedCodes.has(id)) throw new InvalidGrantError("Codice di autorizzazione già usato");
    this.usedCodes.set(id, p.exp ?? now + CODE_TTL);
    return this.issueTokens(p.c, p);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const p = this.sealer.open<{ c: string; rt: string }>("refresh", refreshToken);
    if (!p || !safeEqual(p.c, fingerprint(client.client_id))) throw new InvalidGrantError("Refresh token non valido o scaduto");
    try {
      const fic = await this.ficToken({ grant_type: "refresh_token", refresh_token: p.rt });
      return this.issueTokens(p.c, { ...fic, rt: fic.rt ?? p.rt });
    } catch (e) {
      if (e instanceof FicOAuthError && e.status >= 400 && e.status < 500) {
        throw new InvalidGrantError("Fatture in Cloud ha rifiutato il rinnovo: ricollega l'account");
      }
      console.error(`OAuth: rinnovo del token Fatture in Cloud fallito (${e instanceof FicOAuthError ? e.status : "rete"})`);
      throw new ServerError("Fatture in Cloud non risponde, riprova tra poco");
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = this.sealer.open<{ c: string; a: string }>("access", token);
    if (!p) throw new InvalidTokenError("Token non valido o scaduto");
    return { token, clientId: p.c, scopes: [], expiresAt: p.exp, resource: this.resourceUrl, extra: { ficToken: p.a } };
  }

  /** Our tokens expire with the FIC access token they wrap (24 hours, minus a margin). */
  private issueTokens(clientFp: string, fic: FicTokens): OAuthTokens {
    const ttl = Math.max(60, Math.floor(fic.e - Date.now() / 1000 - 60));
    return {
      access_token: this.sealer.seal("access", { c: clientFp, a: fic.a }, ttl),
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: fic.rt ? this.sealer.seal("refresh", { c: clientFp, rt: fic.rt }, REFRESH_TTL) : undefined,
    };
  }

  /** POST /oauth/token at Fatture in Cloud (JSON body, client credentials in the body). */
  private async ficToken(body: Record<string, string>): Promise<FicTokens> {
    const res = await this.fetchImpl(`${this.config.ficBase}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...body, client_id: this.config.ficClientId, client_secret: this.config.ficClientSecret }),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || typeof data?.access_token !== "string") {
      // only the error code: the body may echo secrets
      throw new FicOAuthError(res.status, typeof data?.error === "string" ? data.error : "risposta non valida");
    }
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 86400;
    return { a: data.access_token, rt: typeof data.refresh_token === "string" ? data.refresh_token : undefined, e: Math.floor(Date.now() / 1000) + expiresIn };
  }

  private isOurResource(resource: URL): boolean {
    const norm = (u: URL) => u.href.replace(/#.*$/, "").replace(/\/$/, "");
    return norm(resource) === norm(this.resourceUrl);
  }

  private cookie(nonce: string, value: string, maxAge: number): string {
    const secure = this.config.publicUrl.startsWith("https:") ? "; Secure" : "";
    return `${cookieName(nonce)}=${value}; Max-Age=${maxAge}; Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax${secure}`;
  }
}

// One cookie per pending login, so parallel logins in the same browser don't clash
const cookieName = (nonce: string) => `fic_oauth_${nonce.slice(0, 8)}`;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal HTML page; `html` must already be escaped. */
function page(res: Response, status: number, html: string) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fatture in Cloud MCP</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">${html}</body>`,
    );
}

function rpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/** CORS for browser-based MCP clients: auth is a Bearer header, never cookies, so "*" is safe. */
function mcpCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-FIC-Company");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }
  next();
}

export interface OAuthAppOptions {
  config: OAuthConfig;
  toolsets: Set<Toolset>;
  path?: string;
  /** Used for Fatture in Cloud OAuth and API calls (tests inject a fake). */
  fetchImpl?: typeof fetch;
  /** false disables the SDK's per-IP rate limits (tests). */
  rateLimit?: false;
}

export function createOAuthApp(opts: OAuthAppOptions) {
  const mcpPath = opts.path ?? "/mcp";
  const { config } = opts;
  const provider = new FicOAuthProvider(config, opts.fetchImpl, mcpPath);
  const limits = opts.rateLimit === false ? { rateLimit: false as const } : {};
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const docs = new URL("https://github.com/NiccoloSalvini/fattureincloud-mcp#server-remoto-claudeai");
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: provider.resourceUrl,
      resourceName: "Fatture in Cloud",
      serviceDocumentationUrl: docs,
      authorizationOptions: limits,
      tokenOptions: limits,
      // client_secret never expires: there is no store to rotate it in
      clientRegistrationOptions: { clientSecretExpirySeconds: 0, ...limits },
    }),
  );
  // The SDK serves the path-specific metadata (/.well-known/oauth-protected-resource/mcp); some clients ask at the root
  app.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({
      resource: provider.resourceUrl.href,
      authorization_servers: [new URL(config.publicUrl).href],
      resource_name: "Fatture in Cloud",
      resource_documentation: docs.href,
    }),
  );

  app.get(CALLBACK_PATH, (req, res, next) => {
    provider.handleCallback(req, res).catch(next);
  });

  const store = new ScheduleStore();
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resourceUrl),
    expectedResource: provider.resourceUrl,
  });
  app.all(mcpPath, mcpCors, bearer, express.json({ limit: "5mb" }), async (req, res) => {
    if (req.method !== "POST") return rpcError(res, 405, "Usa POST (server stateless)");
    const ficToken = req.auth?.extra?.ficToken as string;
    const company = req.get("x-fic-company");
    try {
      const client = new FicClient({
        token: ficToken,
        companyId: company ? Number(company) : undefined,
        baseUrl: config.ficBase,
        fetchImpl: opts.fetchImpl,
      });
      const mcp = createServer(client, { store, toolsets: opts.toolsets, remote: true });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) rpcError(res, 400, e instanceof Error ? e.message : String(e));
    }
  });

  // Body parser errors (too large, bad JSON) and anything unexpected, without stack traces
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(`Errore interno: ${err instanceof Error ? err.message : String(err)}`);
    rpcError(res, status, status === 413 ? "Body troppo grande" : status === 500 ? "Errore interno" : "Richiesta non valida");
  });
  app.use((_req, res) => rpcError(res, 404, "Not found"));

  return { app, provider };
}

export function startOAuthHttp(opts: OAuthAppOptions & { port: number; host: string }): http.Server {
  const { app } = createOAuthApp(opts);
  const mcpPath = opts.path ?? "/mcp";
  return app.listen(opts.port, opts.host, () => {
    console.error(
      `fattureincloud-mcp (OAuth) in ascolto su http://${opts.host}:${opts.port}${mcpPath}, pubblico su ${opts.config.publicUrl}${mcpPath}`,
    );
  });
}

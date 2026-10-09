import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOAuthApp, DEFAULT_FIC_SCOPES, type OAuthConfig } from "../src/oauth.js";
import { Sealer } from "../src/seal.js";
import { fakeApi } from "./fake-api.js";

const PUBLIC = "https://fic.example.com";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const config: OAuthConfig = {
  publicUrl: PUBLIC,
  ficClientId: "fic-app",
  ficClientSecret: "fic-secret",
  scopes: DEFAULT_FIC_SCOPES,
  secrets: ["test-key-0123456789-0123456789-0123456789"],
  ficBase: "https://api-v2.fattureincloud.it",
  trustProxy: false,
};

/** Fake Fatture in Cloud: OAuth token endpoint plus the API from fake-api.ts. */
function fakeFic() {
  const api = fakeApi();
  const tokenCalls: any[] = [];
  const apiAuth: string[] = [];
  let n = 0;
  const state = { rejectRefresh: false };
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/token") {
      const body = JSON.parse(init.body);
      tokenCalls.push({ ...body, contentType: init.headers["Content-Type"] });
      const ok = body.client_id === "fic-app" && body.client_secret === "fic-secret";
      const valid = body.grant_type === "authorization_code" ? body.code === "c/fic-code" : body.refresh_token?.startsWith("r/") && !state.rejectRefresh;
      if (!ok || !valid) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      n++;
      return new Response(JSON.stringify({ token_type: "bearer", access_token: `a/fic-${n}`, refresh_token: `r/fic-${n}`, expires_in: 86400 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    apiAuth.push(init.headers?.Authorization);
    return api.fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchImpl, tokenCalls, apiAuth, state, issued: () => n };
}

let fic: ReturnType<typeof fakeFic>;
let server: http.Server;
let base: string;

beforeAll(async () => {
  fic = fakeFic();
  const { app } = createOAuthApp({ config, toolsets: new Set(["documents", "registry", "received", "accounting", "automation", "reports", "taxes", "planning", "bank", "admin"]), fetchImpl: (...a) => fic.fetchImpl(...a), rateLimit: false });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  fic.tokenCalls.length = 0;
  fic.apiAuth.length = 0;
  fic.state.rejectRefresh = false;
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "none", client_name: "Claude", ...body }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const u = new URL(`${base}/authorize`);
  const params = { response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${PUBLIC}/mcp`, ...extra };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

/** Opens /authorize and reads the consent page: Fatture in Cloud link, cancel link, anti-CSRF cookie. */
async function consent(url: URL) {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(200);
  const html = await res.text();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1].replaceAll("&amp;", "&")));
  return { res, html, ficUrl: links[0], cancelUrl: links[1], cookie: res.headers.getSetCookie()[0].split(";")[0] };
}

/** /authorize → consent → (Fatture in Cloud login) → /oauth/callback; returns where the client is sent back. */
async function login(clientId: string, challenge: string) {
  const { ficUrl, cookie } = await consent(authorizeUrl(clientId, challenge));
  const cb = await fetch(`${base}/oauth/callback?code=c%2Ffic-code&state=${encodeURIComponent(ficUrl.searchParams.get("state")!)}`, {
    redirect: "manual",
    headers: { cookie },
  });
  expect(cb.status).toBe(302);
  return new URL(cb.headers.get("location")!);
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function fullFlow() {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const back = await login(client.client_id, challenge);
  const t = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CB });
  expect(t.status).toBe(200);
  return { client, tokens: t.body };
}

async function mcpClient(accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

describe("metadata", () => {
  it("serves protected resource metadata at the path-specific and root URLs", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [`${PUBLIC}/`] });
    }
  });

  it("serves authorization server metadata with PKCE S256 and registration", async () => {
    const m: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(m).toMatchObject({
      issuer: `${PUBLIC}/`,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      registration_endpoint: `${PUBLIC}/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  it("answers 401 with WWW-Authenticate pointing at the resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers CORS preflight on /mcp", async () => {
    const res = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("dynamic client registration", () => {
  it("registers a public client with a sealed, self-contained client_id", async () => {
    const { status, body } = await register();
    expect(status).toBe(201);
    expect(body.redirect_uris).toEqual([CLAUDE_CB]);
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id.length).toBeGreaterThan(40);
  });

  it("rejects plain http redirect URIs outside loopback", async () => {
    const { status, body } = await register({ redirect_uris: ["http://evil.example/cb"] });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("confidential clients need their secret at the token endpoint", async () => {
    const { body: client } = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_secret).toBeTruthy();
    expect(client.client_secret_expires_at).toBe(0);
    const { verifier, challenge } = pkce();
    const code = (await login(client.client_id, challenge)).searchParams.get("code")!;
    const params = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id };
    expect((await token(params)).body.error).toBe("invalid_client");
    expect((await token({ ...params, client_secret: client.client_secret })).status).toBe(200);
  });
});

describe("authorization flow", () => {
  it("shows a consent page that links to Fatture in Cloud with our callback, scopes and a sealed state", async () => {
    const { body: client } = await register({ client_name: "Claude <script>" });
    const { res, html, ficUrl: to, cancelUrl } = await consent(authorizeUrl(client.client_id, pkce().challenge));
    expect(html).toContain("<strong>Claude &lt;script&gt;</strong>");
    expect(html).toContain("claude.ai");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(Object.fromEntries(cancelUrl.searchParams)).toEqual({ state: "xyz", error: "access_denied" });
    expect(to.origin + to.pathname).toBe("https://api-v2.fattureincloud.it/oauth/authorize");
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "fic-app",
      redirect_uri: `${PUBLIC}/oauth/callback`,
      scope: DEFAULT_FIC_SCOPES,
    });
    expect(to.searchParams.get("state")).not.toContain("xyz");
    expect(res.headers.getSetCookie()[0]).toMatch(/^fic_oauth_[\w-]{8}=[\w-]+; Max-Age=600; Path=\/oauth\/callback; HttpOnly; SameSite=Lax; Secure$/);
  });

  it("refuses an unregistered redirect_uri without redirecting", async () => {
    const { body: client } = await register();
    const res = await fetch(authorizeUrl(client.client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_request");
  });

  it("refuses unknown clients and a resource that is not this server", async () => {
    const unknown = await fetch(authorizeUrl("forged", pkce().challenge), { redirect: "manual" });
    expect(unknown.status).toBe(400);
    const { body: client } = await register();
    const res = await fetch(authorizeUrl(client.client_id, pkce().challenge, { resource: "https://other.example/mcp" }), { redirect: "manual" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("requires PKCE", async () => {
    const { body: client } = await register();
    const u = authorizeUrl(client.client_id, "x");
    u.searchParams.delete("code_challenge");
    const res = await fetch(u, { redirect: "manual" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("callback exchanges the Fatture in Cloud code and returns our code with the client state", async () => {
    const { body: client } = await register();
    const back = await login(client.client_id, pkce().challenge);
    expect(back.origin + back.pathname).toBe(CLAUDE_CB);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("code")).not.toContain("fic");
    expect(fic.tokenCalls).toEqual([
      { grant_type: "authorization_code", redirect_uri: `${PUBLIC}/oauth/callback`, code: "c/fic-code", client_id: "fic-app", client_secret: "fic-secret", contentType: "application/json" },
    ]);
  });

  it("callback refuses a missing anti-CSRF cookie and a forged state", async () => {
    const { body: client } = await register();
    const state = (await consent(authorizeUrl(client.client_id, pkce().challenge))).ficUrl.searchParams.get("state")!;
    const noCookie = await fetch(`${base}/oauth/callback?code=c%2Ffic-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(noCookie.status).toBe(400);
    expect(await noCookie.text()).toContain("stesso browser");
    const forged = await fetch(`${base}/oauth/callback?code=c%2Ffic-code&state=abc`, { redirect: "manual" });
    expect(forged.status).toBe(400);
    expect(fic.tokenCalls).toHaveLength(0);
  });

  it("callback reports a denied login to the client", async () => {
    const { body: client } = await register();
    const { ficUrl, cookie } = await consent(authorizeUrl(client.client_id, pkce().challenge));
    const state = ficUrl.searchParams.get("state")!;
    const cb = await fetch(`${base}/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie } });
    const back = new URL(cb.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("xyz");
  });
});

describe("token endpoint", () => {
  it("fails on a wrong PKCE verifier, then issues tokens once", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const code = (await login(client.client_id, challenge)).searchParams.get("code")!;
    const params = { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CLAUDE_CB };

    const wrong = await token({ ...params, code_verifier: pkce().verifier });
    expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const ok = await token({ ...params, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: "Bearer", expires_in: expect.any(Number) });
    expect(ok.body.expires_in).toBeGreaterThan(86000);
    expect(ok.body.access_token).not.toContain("fic");
    expect(ok.body.refresh_token).toBeTruthy();

    const replay = await token({ ...params, code_verifier: verifier });
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("binds the code to the client and the redirect_uri", async () => {
    const { body: client } = await register();
    const { body: other } = await register();
    const { verifier, challenge } = pkce();
    const code = (await login(client.client_id, challenge)).searchParams.get("code")!;
    expect((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: other.client_id })).body.error).toBe("invalid_grant");
    expect(
      (await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: "https://claude.ai/other" })).body
        .error,
    ).toBe("invalid_grant");
  });

  it("refreshes through Fatture in Cloud and the new token works", async () => {
    const { client, tokens } = await fullFlow();
    const k = fic.issued();
    fic.tokenCalls.length = 0;
    const r = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r.status).toBe(200);
    expect(fic.tokenCalls).toEqual([
      { grant_type: "refresh_token", refresh_token: `r/fic-${k}`, client_id: "fic-app", client_secret: "fic-secret", contentType: "application/json" },
    ]);
    expect(r.body.access_token).not.toBe(tokens.access_token);

    const mcp = await mcpClient(r.body.access_token);
    await mcp.callTool({ name: "list_companies", arguments: {} });
    expect(fic.apiAuth.at(-1)).toBe(`Bearer a/fic-${k + 1}`);
    await mcp.close();
  });

  it("an access token is not a refresh token, and a revoked FIC refresh asks to reconnect", async () => {
    const { client, tokens } = await fullFlow();
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.access_token, client_id: client.client_id })).body.error).toBe("invalid_grant");
    fic.state.rejectRefresh = true;
    const r = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(r.body).toMatchObject({ error: "invalid_grant", error_description: expect.stringMatching(/ricollega/) });
  });
});

describe("MCP over OAuth", () => {
  it("lists tools with a valid token, without the local-only ones", async () => {
    const { tokens } = await fullFlow();
    const mcp = await mcpClient(tokens.access_token);
    const tools = (await mcp.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["list_companies", "duplicate_document", "bulk_duplicate", "send_einvoice", "get_document_pdf", "receivables_report", "create_client", "api_request"]) {
      expect(names).toContain(n);
    }
    for (const n of ["schedule_create", "schedule_run_due", "upload_attachment", "tax_profile_set", "tax_estimate", "cashflow_forecast", "accountant_package", "bank_reconcile", "bank_link_start"]) {
      expect(names).not.toContain(n);
    }
    const pdf = tools.find((t) => t.name === "get_document_pdf")!;
    expect(Object.keys(pdf.inputSchema.properties ?? {})).not.toContain("save_to");
    expect((await mcp.listPrompts()).prompts.map((p) => p.name)).toEqual(["chiusura_mese"]);

    const res: any = await mcp.callTool({ name: "list_companies", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(fic.apiAuth.at(-1)).toMatch(/^Bearer a\/fic-\d+$/);
    await mcp.close();
  });

  it("rejects tokens sealed with another key or for another purpose", async () => {
    const other = new Sealer(["another-key-0123456789-0123456789-0123"]).seal("access", { c: "x", a: "a/stolen" }, 3600);
    const sameKeyWrongPurpose = new Sealer(config.secrets).seal("refresh", { c: "x", a: "a/stolen" }, 3600);
    const expired = new Sealer(config.secrets).seal("access", { c: "x", a: "a/old" }, -10);
    for (const t of [other, sameKeyWrongPurpose, expired]) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
    }
    expect(fic.apiAuth).toHaveLength(0);
  });
});

describe("Sealer", () => {
  it("round-trips, rotates keys and refuses short keys", () => {
    const old = new Sealer(["old-key-0123456789-0123456789-0123456789"]);
    const token = old.seal("code", { a: 1 });
    const rotated = new Sealer(["new-key-0123456789-0123456789-0123456789", "old-key-0123456789-0123456789-0123456789"]);
    expect(rotated.open("code", token)).toEqual({ a: 1 });
    expect(rotated.open("access", token)).toBeUndefined();
    expect(() => new Sealer(["short"])).toThrow(/32 caratteri/);
  });
});

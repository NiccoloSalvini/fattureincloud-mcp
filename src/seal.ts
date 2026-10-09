/**
 * Stateless sealed tokens: AES-256-GCM over a JSON payload, with a key derived
 * per purpose (HKDF-SHA256) from the server secret. A token sealed for one
 * purpose (e.g. "code") cannot be opened as another (e.g. "access"), and any
 * tampering fails authentication. Lets the OAuth server run without storage.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type Purpose = "client" | "state" | "code" | "access" | "refresh";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class Sealer {
  /** One key list per purpose; the first key seals, all of them open (rotation). */
  private readonly keys = new Map<Purpose, Buffer[]>();

  /** `secrets`: one or more server secrets, newest first (comma-separated in OAUTH_ENCRYPTION_KEY). */
  constructor(secrets: string[]) {
    const usable = secrets.map((s) => s.trim()).filter(Boolean);
    if (!usable.length) throw new Error("Chiave di cifratura mancante");
    for (const s of usable) {
      if (s.length < 32) throw new Error("OAUTH_ENCRYPTION_KEY troppo corta: almeno 32 caratteri (es. `openssl rand -base64 32`)");
    }
    for (const purpose of ["client", "state", "code", "access", "refresh"] as const) {
      this.keys.set(
        purpose,
        usable.map((s) => Buffer.from(hkdfSync("sha256", s, "fattureincloud-mcp", `oauth:${purpose}`, 32))),
      );
    }
  }

  /** Seals `payload`; with `ttlSeconds` the token carries an expiry checked by open(). */
  seal(purpose: Purpose, payload: Record<string, unknown>, ttlSeconds?: number): string {
    const body = ttlSeconds === undefined ? payload : { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(purpose)![0], iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return Buffer.concat([iv, data, cipher.getAuthTag()]).toString("base64url");
  }

  /** Returns the payload, or undefined if the token is malformed, forged, for another purpose or expired. */
  open<T extends Record<string, unknown>>(purpose: Purpose, token: string | undefined): (T & { exp?: number }) | undefined {
    if (!token || token.length > 16_384) return undefined;
    const raw = Buffer.from(token, "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES + 2) return undefined;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const data = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    for (const key of this.keys.get(purpose)!) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const payload = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
        if (typeof payload?.exp === "number" && payload.exp < Date.now() / 1000) return undefined;
        return payload;
      } catch {
        /* wrong key or tampered: try the next one */
      }
    }
    return undefined;
  }
}

/** Short, stable fingerprint (e.g. of a client_id) to bind tokens without embedding the value. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

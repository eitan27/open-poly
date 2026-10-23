// Small WebCrypto helpers for the Drive token broker. Everything here runs the
// same in a Cloudflare Worker and in Node ≥ 20 (vitest), both of which expose
// the global `crypto.subtle`.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Import a base64 (std or url) 32-byte key for AES-256-GCM. */
export async function importAesKey(b64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(b64.trim().replace(/=+$/, ""));
  if (raw.length !== 32) throw new Error("DRIVE_TOKEN_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt to "iv.ciphertext" (both base64url). A fresh 96-bit IV per call. */
export async function encryptString(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  return `${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function decryptString(key: CryptoKey, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) throw new Error("malformed sealed value");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(iv) }, key, b64urlDecode(ct));
  return dec.decode(plain);
}

/** The claims of a JWT, WITHOUT verifying its signature. Only safe for an
 *  id_token received directly from Google's token endpoint over TLS, which is
 *  the one place the broker uses it (Google documents this as acceptable). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  return JSON.parse(dec.decode(b64urlDecode(part))) as Record<string, unknown>;
}

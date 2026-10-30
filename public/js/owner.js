// Owner mode: the owner key stays in this browser. Only the derived auth token is ever sent (to /v1/me);
// the derived encryption key is used locally to decrypt task titles of the owner's own home.
import { api } from "./api.js";

const LS_KEY = "agenttown.owner_key";
const enc = new TextEncoder();

let state = null; // { ownerKey, authToken, encKey: CryptoKey, home: {id,name} }
const listeners = new Set();
const titleCache = new Map();

export const owner = () => state;
export const onOwnerChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const notify = () => { for (const fn of listeners) fn(state); };

const lsGet = () => { try { return localStorage.getItem(LS_KEY); } catch { return null; } };
const lsSet = (v) => { try { v == null ? localStorage.removeItem(LS_KEY) : localStorage.setItem(LS_KEY, v); } catch {} };

export const looksLikeOwnerKey = (k) => /^atk_[A-Za-z0-9_-]{20,}$/.test(k);

async function hmac(ownerKey, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(ownerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export async function deriveKeys(ownerKey) {
  const auth = await hmac(ownerKey, "agenttown/auth/v1");
  const authToken = [...auth].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = await hmac(ownerKey, "agenttown/enc/v1");
  const encKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  raw.fill(0);
  return { authToken, encKey };
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function decryptTitle(encKey, titleEnc) {
  const parts = titleEnc.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("bad format");
  const iv = b64urlDecode(parts[1]);
  const ct = b64urlDecode(parts[2]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encKey, ct));
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end--;
  return new TextDecoder().decode(pt.subarray(0, end));
}

// Returns the decrypted title (string), null if not decryptable, or undefined while pending.
// `onReady` fires once the async decryption finishes.
export function titleFor(homeId, titleEnc, onReady) {
  if (!state || !titleEnc || state.home?.id !== homeId) return null;
  if (titleCache.has(titleEnc)) return titleCache.get(titleEnc);
  titleCache.set(titleEnc, undefined);
  decryptTitle(state.encKey, titleEnc)
    .then((t) => titleCache.set(titleEnc, t))
    .catch(() => titleCache.set(titleEnc, null))
    .finally(() => onReady?.());
  return undefined;
}

export async function login(ownerKey) {
  ownerKey = ownerKey.trim();
  if (!looksLikeOwnerKey(ownerKey)) throw Object.assign(new Error("bad owner key"), { code: "bad_key" });
  const { authToken, encKey } = await deriveKeys(ownerKey);
  const me = await api("/me", { token: authToken });
  state = { ownerKey, authToken, encKey, home: me.home };
  titleCache.clear();
  lsSet(ownerKey);
  notify();
  return state;
}

export function logout() {
  state = null;
  titleCache.clear();
  lsSet(null);
  notify();
}

export async function restore() {
  const k = lsGet();
  if (!k) return null;
  try {
    return await login(k);
  } catch (e) {
    // Only forget the key if the server says it is unknown; keep it across network hiccups.
    if (e?.status === 401) lsSet(null);
    return null;
  }
}

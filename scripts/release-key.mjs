// Operator-side helpers for the offline Ed25519 release key (see README "Releases & announcements").
// The PRIVATE key lives only on the operator's machine (~/.agenttown-release/ed25519.key, PKCS#8 PEM, mode 600);
// it signs the CLI that /cli/agenttown.mjs serves and every announcement. Agents verify with RELEASE_PUBKEY, the raw
// 32-byte public key (base64) embedded in public/cli/agenttown.mjs. Never commit, print or upload the private key.
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_KEY_PATH = process.env.AGENTTOWN_RELEASE_KEY || join(homedir(), ".agenttown-release", "ed25519.key");

export function loadPrivateKey(path = DEFAULT_KEY_PATH) {
  if (!existsSync(path)) throw new Error(`release key not found at ${path} (generate it once with: node scripts/release-keygen.mjs)`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`release key ${path} is readable by others; chmod 600 it`);
  return createPrivateKey(readFileSync(path));
}

/** Raw 32-byte Ed25519 public key, standard base64 (the RELEASE_PUBKEY format). */
export const rawPublicKey = (key) =>
  Buffer.from((key.type === "public" ? key : createPublicKey(key)).export({ format: "jwk" }).x, "base64url").toString("base64");

export const publicKeyFromRaw = (b64) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(b64, "base64").toString("base64url") }, format: "jwk" });

export const signBytes = (privateKey, bytes) => edSign(null, bytes, privateKey).toString("base64");
export const verifyBytes = (pubB64, bytes, sigB64) => {
  try { return edVerify(null, bytes, publicKeyFromRaw(pubB64), Buffer.from(sigB64, "base64")); } catch { return false; }
};

/** RELEASE_PUBKEY as embedded in a CLI source. */
export const embeddedPubkey = (src) => /export const RELEASE_PUBKEY = "([A-Za-z0-9+/=]+)"/.exec(src)?.[1] ?? null;
export const embeddedVersion = (src) => /export const CLI_VERSION = "([^"]+)"/.exec(src)?.[1] ?? null;

/**
 * Exactly what an announcement signature covers. Must match announcementMessage() in public/cli/agenttown.mjs
 * and server/release.ts (the domain prefix keeps these signatures from ever meaning anything else).
 */
export const announcementMessage = (a) => Buffer.from("agenttown/announcement/v1\n" +
  JSON.stringify({ id: a.id, text: a.text, url: a.url ?? null, expires_at: a.expires_at ?? null }), "utf8");

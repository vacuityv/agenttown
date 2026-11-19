// Mint a device invite code in the browser, byte-compatible with `agenttown invite` (cmdInvite in the CLI):
//   blob = v1.<iv>.<AES-256-GCM(wrapKey, {home_id, enc_key})>, wrapKey = HMAC-SHA256(secret, "agenttown/invite/v1"),
//   code = AT-<invite id>-<base32(secret)>.
// The secret never leaves the browser; the server only stores the sealed blob. No DOM here (tested from Node).
const te = new TextEncoder();
const B32 = "0123456789abcdefghjkmnpqrstvwxyz"; // the CLI's alphabet

export function b32encode(buf) {
  let bits = 0, val = 0, s = "";
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { s += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) s += B32[(val << (5 - bits)) & 31];
  return s;
}

export const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmacRaw(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(msg)));
}

/** `post(body)` must POST /v1/invites with the owner's auth token and return its JSON ({id, expires_at}). */
export async function mintInvite({ ownerKey, homeId, post, label }) {
  const encKey = await hmacRaw(te.encode(ownerKey), "agenttown/enc/v1");
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const wrap = await crypto.subtle.importKey("raw", await hmacRaw(secret, "agenttown/invite/v1"), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = te.encode(JSON.stringify({ home_id: homeId, enc_key: b64u(encKey) }));
  encKey.fill(0);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrap, pt));
  const r = await post({ blob: `v1.${b64u(iv)}.${b64u(ct)}`, kind: "join", ...(label ? { label } : {}) });
  return { code: `AT-${r.id}-${b32encode(secret)}`, expires_at: r.expires_at };
}

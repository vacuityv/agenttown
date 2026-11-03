#!/usr/bin/env node
// Make a VAPID key pair for Web Push (server/push.ts) in .env format.
//   node scripts/vapid-keys.mjs [--subject mailto:you@example.com]          prints the three lines to stdout
//   node scripts/vapid-keys.mjs --append /opt/agenttown/.env [--subject …]  appends them to that file and prints only
//                                                                          the public key (refuses if the file already
//                                                                          has VAPID_PRIVATE_KEY)
// Best run ON the server with --append, so the private key never leaves it (no terminal scrollback, no copy-paste).
// Changing the key later unsubscribes every device: owners have to tap "Notify me" again.
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg("--append");
const subject = arg("--subject");
if (subject !== undefined && !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) {
  console.error("--subject must be mailto:<address> or an https:// URL");
  process.exit(1);
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const lines = [
  "# Web Push (server/push.ts), made by scripts/vapid-keys.mjs. Keep the private key secret.",
  `VAPID_PUBLIC_KEY=${pub}`,
  `VAPID_PRIVATE_KEY=${jwk.d}`,
  ...(subject ? [`VAPID_SUBJECT=${subject}`] : []),
].join("\n") + "\n";

if (!out) {
  process.stdout.write(lines);
} else {
  const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (/^\s*VAPID_PRIVATE_KEY=\S/m.test(cur)) {
    console.error(`${out} already has VAPID_PRIVATE_KEY; remove it first if you really want a new key (every device must re-subscribe).`);
    process.exit(1);
  }
  appendFileSync(out, (cur && !cur.endsWith("\n") ? "\n" : "") + lines, { mode: 0o600 });
  console.log(`Appended a new VAPID key pair to ${out}. Public key: ${pub}`);
  console.log("Restart the server to turn notifications on.");
}

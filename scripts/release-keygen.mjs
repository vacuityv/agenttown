#!/usr/bin/env node
// One-time: generate the offline Ed25519 release key. Refuses to overwrite an existing key.
//   node scripts/release-keygen.mjs [--out <path>]      (default ~/.agenttown-release/ed25519.key)
// Prints ONLY the public key (raw 32 bytes, base64): put it in public/cli/agenttown.mjs as RELEASE_PUBKEY.
// BACK THE PRIVATE KEY UP (offline: password manager / encrypted USB). If it is lost, already-installed CLIs can
// never auto-update again: you would have to ship a CLI with a new key and ask everyone to update by hand.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_KEY_PATH, rawPublicKey } from "./release-key.mjs";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : DEFAULT_KEY_PATH;
if (!out) { console.error("usage: node scripts/release-keygen.mjs [--out <path>]"); process.exit(1); }
if (existsSync(out)) {
  console.error(`refusing to overwrite the existing release key at ${out}`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
chmodSync(out, 0o600);
const pub = rawPublicKey(publicKey);
writeFileSync(`${out}.pub`, pub + "\n", { mode: 0o644, flag: "wx" });
console.log(`private key: ${out} (mode 600; back it up offline, never commit it)`);
console.log(`public key (RELEASE_PUBKEY): ${pub}`);

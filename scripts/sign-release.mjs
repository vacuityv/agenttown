#!/usr/bin/env node
// Signs the CLI exactly as the server will serve it, with the offline release key. Run by deploy/deploy.sh.
//   node scripts/sign-release.mjs [--key <path>] [--base-url https://agenttown.xyz] [--cli public/cli/agenttown.mjs]
//                                 [--out-dir public/cli]
// The server replaces {{BASE_URL}} with its PUBLIC_URL, so the signature covers the templated bytes for --base-url
// (the production URL by default, which is also what `npm run sync:plugins` bakes into the plugin's bundled copy).
// Writes (build artifacts, git-ignored):
//   <out-dir>/agenttown.mjs.sig   base64 Ed25519 signature over the served bytes
//   <out-dir>/release.json        { version, base_url, sha256, sig, signed_at }
// Fails (exit 1) if the key is missing, does not match the RELEASE_PUBKEY embedded in the CLI, or the signature
// does not verify.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_KEY_PATH, embeddedPubkey, embeddedVersion, loadPrivateKey, rawPublicKey, signBytes, verifyBytes } from "./release-key.mjs";

export const PRODUCTION_BASE_URL = "https://agenttown.xyz";

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const die = (m) => { console.error(`sign-release: ${m}`); process.exit(1); };

const keyPath = opt("key", DEFAULT_KEY_PATH);
const baseUrl = opt("base-url", PRODUCTION_BASE_URL).replace(/\/$/, "");
const cliPath = opt("cli", new URL("../public/cli/agenttown.mjs", import.meta.url).pathname);
const outDir = opt("out-dir", new URL("../public/cli/", import.meta.url).pathname);

let key;
try { key = loadPrivateKey(keyPath); } catch (e) { die(e.message); }
const served = Buffer.from(readFileSync(cliPath, "utf8").replaceAll("{{BASE_URL}}", baseUrl), "utf8");
const src = served.toString("utf8");
const version = embeddedVersion(src);
const embedded = embeddedPubkey(src);
if (!version) die(`${cliPath} has no CLI_VERSION`);
if (!embedded) die(`${cliPath} has no RELEASE_PUBKEY`);
const pub = rawPublicKey(key);
if (pub !== embedded) die(`the key at ${keyPath} (public ${pub}) is not the RELEASE_PUBKEY embedded in the CLI (${embedded})`);

const sig = signBytes(key, served);
if (!verifyBytes(embedded, served, sig)) die("signature does not verify against the embedded RELEASE_PUBKEY");
const sha256 = createHash("sha256").update(served).digest("hex");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "agenttown.mjs.sig"), sig + "\n");
writeFileSync(join(outDir, "release.json"), JSON.stringify({ version, base_url: baseUrl, sha256, sig, signed_at: Date.now() }, null, 2) + "\n");
console.log(`signed CLI ${version} for ${baseUrl} (sha256 ${sha256.slice(0, 16)}…) -> ${join(outDir, "agenttown.mjs.sig")}`);

if (baseUrl === PRODUCTION_BASE_URL && process.argv.indexOf("--cli") < 0) {
  try {
    const bundled = readFileSync(new URL("../plugins/claude-code/bin/agenttown.mjs", import.meta.url));
    if (!bundled.equals(served)) console.error("sign-release: warning: plugins/claude-code/bin/agenttown.mjs is out of date (npm run sync:plugins)");
  } catch {}
}

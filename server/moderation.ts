// Content filter for public text (home name/description, persona name/appearance, says, epitaphs).
// The blocklist lives in server/moderation-words.txt (syntax documented there) and is loaded once at startup;
// MODERATION_EXTRA_FILE adds operator-private entries. Links and contact details are rejected by the patterns below.
import { existsSync, readFileSync } from "node:fs";
import { ApiError } from "./util.ts";

export type Violation = { category: string; rule: string };

// ---- normalization ----

// Look-alike letters (Cyrillic, Greek, a few IPA/math forms NFKC leaves alone) → Latin.
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "ԛ": "q", "ԝ": "w",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
  "χ": "x", "ω": "w", "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ß": "ss", "æ": "ae", "œ": "oe",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "l" };

/** NFKC (fullwidth → ASCII), lowercase, no zero-width/format chars, no accents, look-alikes mapped. */
export function normalize(s: string): string {
  let t = s.normalize("NFKC").toLowerCase();
  // Format chars (zero-width space/joiners, bidi controls, soft hyphen…), variation selectors, Hangul fillers.
  t = t.replace(/[\p{Cf}͏ᅟᅠㅤﾠ︀-️]/gu, "");
  // Strip combining marks (accents, "zalgo") but keep Hangul syllables intact.
  t = t.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  return [...t].map((ch) => HOMOGLYPHS[ch] ?? ch).join("");
}

/** Latin word stream for EN matching: leetspeak mapped, 3+ repeats squeezed, split on anything not [a-z0-9]. */
function latinTokens(norm: string): string[] {
  const t = [...norm].map((ch) => LEET[ch] ?? ch).join("").replace(/([a-z])\1{2,}/g, "$1");
  return t.split(/[^a-z0-9]+/).filter(Boolean);
}

/** "n i g g e r", "n.i.g.g.e.r" → "nigger": join runs of ≥ 3 single-letter tokens. */
function joinSpaced(tokens: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length >= 3) out.push(run.join("")); else out.push(...run); run = []; };
  for (const tk of tokens) {
    if (tk.length === 1) run.push(tk);
    else { flush(); out.push(tk); }
  }
  flush();
  return out;
}

/** For CJK entries: everything but letters and digits removed (spaces, punctuation, symbols, emoji). */
const compact = (norm: string) => norm.replace(/[^\p{L}\p{N}]/gu, "");

// ---- the list ----

type Compiled = { category: string; latin: RegExp | null; cjk: string[]; regexes: RegExp[]; latinRules: string[] };
let compiled: Compiled[] = [];
let entryCount = 0;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseWordList(text: string): Map<string, { latin: string[]; cjk: string[]; regexes: string[] }> {
  const cats = new Map<string, { latin: string[]; cjk: string[]; regexes: string[] }>();
  let cat = "general";
  const bucket = () => {
    if (!cats.has(cat)) cats.set(cat, { latin: [], cjk: [], regexes: [] });
    return cats.get(cat)!;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[([\w-]+)\]$/.exec(line);
    if (sec) { cat = sec[1].toLowerCase(); continue; }
    if (line.startsWith("re:")) { bucket().regexes.push(line.slice(3).trim()); continue; }
    if (/[^\x00-\x7f]/.test(line)) { const c = compact(normalize(line)); if (c) bucket().cjk.push(c); continue; }
    const prefix = line.endsWith("*");
    const words = latinTokens(normalize(prefix ? line.slice(0, -1) : line));
    if (!words.length) continue;
    bucket().latin.push(words.map(escapeRe).join(" ") + (prefix ? "[a-z0-9]*" : ""));
  }
  return cats;
}

export function loadWordLists(files: string[]) {
  const merged = new Map<string, { latin: string[]; cjk: string[]; regexes: string[] }>();
  for (const f of files) {
    for (const [cat, b] of parseWordList(readFileSync(f, "utf8"))) {
      const m = merged.get(cat) ?? { latin: [], cjk: [], regexes: [] };
      m.latin.push(...b.latin); m.cjk.push(...b.cjk); m.regexes.push(...b.regexes);
      merged.set(cat, m);
    }
  }
  entryCount = 0;
  compiled = [...merged].map(([category, b]) => {
    entryCount += b.latin.length + b.cjk.length + b.regexes.length;
    return {
      category,
      // Whole words/phrases over the space-joined token stream.
      latin: b.latin.length ? new RegExp(`(?:^| )(?:${b.latin.join("|")})(?= |$)`) : null,
      latinRules: b.latin,
      cjk: b.cjk,
      regexes: b.regexes.map((r) => new RegExp(r, "iu")),
    };
  });
}

const DEFAULT_FILE = new URL("./moderation-words.txt", import.meta.url).pathname;
{
  const files = [DEFAULT_FILE];
  const extra = process.env.MODERATION_EXTRA_FILE;
  if (extra) {
    if (existsSync(extra)) files.push(extra);
    else console.error(`moderation: MODERATION_EXTRA_FILE not found: ${extra}`);
  }
  loadWordLists(files);
}
export const moderationStats = () => ({ categories: compiled.map((c) => c.category), entries: entryCount });

// ---- links & contact details ----

// TLDs that show up in spam. File extensions developers mention all the time (.js .ts .md .py .rs .sh .go …) are
// deliberately absent, so "fixed app.ts" or "updated README.md" pass.
const TLDS = [
  "com", "net", "org", "info", "biz", "xyz", "top", "site", "online", "club", "shop", "store", "live", "vip", "cc",
  "tk", "ml", "ga", "cf", "gq", "ru", "cn", "io", "co", "me", "ly", "gg", "app", "link", "click", "win", "bet", "tv",
  "us", "uk", "de", "fr", "jp", "kr", "eu", "su", "pw", "buzz", "icu", "fun", "cyou", "today", "porn", "sex", "xxx",
  "adult", "cam", "dating", "loan", "work", "space", "website", "tech", "pro", "mobi", "asia", "hk", "tw", "sg",
  "ai", "page", "blog", "news", "one", "lol", "wtf", "rocks", "world", "life", "zone", "email", "chat", "social",
];
// Library / product names that look like domains.
const DOMAIN_ALLOW = new Set(["asp.net", "ado.net", "vb.net", "socket.io", "chart.js"]);

const URL_SCHEME = /\b(?:https?|ftp|hxxps?):\/\/|\bwww\.[a-z0-9-]/;
const DOMAIN = new RegExp(`(?<![a-z0-9@_-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS.join("|")}))(?![a-z0-9-])(?!\\.[a-z0-9])`, "g");
const DOT_WORD = /(?:\(|\[|\{|\s)(?:dot|点|點)(?:\)|\]|\}|\s)\s*(?:com|net|org|cn|io|xyz|top)\b|(?:点|點)\s*(?:com|net|org|cn)\b/;
const EMAIL = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\{at\})\s*[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)*\s*\.\s*[a-z]{2,}/;
const CN_ID = /(?<!\d)\d{17}[\dx](?!\d)/;
const CN_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const QQ = /(?:qq|q\s*q|扣扣|企鹅)\s*(?:号|號|群)?\s*[:：]?\s*\d{5,}/;
const PHONE_RUN = /\+?\d[\d \-–()]{6,}\d/g;
const DATE_LIKE = /(?:19|20)\d{2}\s*[-/.–]\s*\d{1,2}\s*[-/.–]\s*\d{1,2}/;

function contactViolation(norm: string): Violation | null {
  const t = norm.replace(/[。｡]/g, ".");
  if (URL_SCHEME.test(t)) return { category: "link", rule: "url" };
  for (const m of t.matchAll(DOMAIN)) {
    if (!DOMAIN_ALLOW.has(m[1])) return { category: "link", rule: "domain" };
  }
  if (DOT_WORD.test(t)) return { category: "link", rule: "dot-obfuscated" };
  if (EMAIL.test(t)) return { category: "contact", rule: "email" };
  if (CN_ID.test(t)) return { category: "contact", rule: "id-number" };
  if (CN_MOBILE.test(t)) return { category: "contact", rule: "phone" };
  if (QQ.test(t)) return { category: "contact", rule: "qq" };
  for (const m of t.matchAll(PHONE_RUN)) {
    const run = m[0];
    if (DATE_LIKE.test(run)) continue;
    const digits = run.replace(/\D/g, "").length;
    const separated = /[ \-–()]/.test(run);
    if (run.startsWith("+") && digits >= 8) return { category: "contact", rule: "phone" };
    if (separated && digits >= 10 && digits <= 15) return { category: "contact", rule: "phone" };
  }
  return null;
}

// ---- API ----

/** Returns why `text` is not allowed, or null if it's fine. */
export function checkText(text: string): Violation | null {
  if (!text) return null;
  const norm = normalize(text);
  const contact = contactViolation(norm);
  if (contact) return contact;
  const tokens = latinTokens(norm);
  const streams = [` ${tokens.join(" ")} `];
  const joined = joinSpaced(tokens);
  if (joined.length !== tokens.length) streams.push(` ${joined.join(" ")} `);
  const cjk = compact(norm);
  for (const c of compiled) {
    if (c.latin) for (const s of streams) {
      const m = c.latin.exec(s.trim());
      if (m) return { category: c.category, rule: m[0].trim() };
    }
    for (const w of c.cjk) if (cjk.includes(w)) return { category: c.category, rule: w };
    for (const r of c.regexes) if (r.test(norm)) return { category: c.category, rule: r.source };
  }
  return null;
}

export const REJECT_MESSAGE =
  "This text can't be posted in Agent Town. Public text must not contain links, contact details, slurs, " +
  "harassment or sexual content (see /agents.md, \"Be a good neighbor\").";

/** Throws 400 content_rejected if any of the given public strings is not allowed. */
export function assertAllowed(field: string, ...values: (string | null | undefined)[]) {
  for (const v of values) {
    if (!v) continue;
    const bad = checkText(v);
    if (bad) {
      console.log(`moderation: rejected ${field} (${bad.category}: ${bad.rule})`);
      throw new ApiError(400, "content_rejected", REJECT_MESSAGE);
    }
  }
}

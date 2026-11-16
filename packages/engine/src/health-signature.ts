import { createHash } from "node:crypto";
import { redactCredentials } from "./tool-detail";

/**
 * How a failure's text becomes an issue's title and signature (ADR 0214 §1): what varies from one occurrence of the
 * same cause to the next (ids, numbers, addresses, paths, what someone typed in quotes) is replaced, so "no layer 12"
 * and "no layer 104" are one issue, and nothing a person wrote or a secret is kept.
 */

/** The longest title an issue keeps. */
export const HEALTH_TITLE_MAX = 160;

const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Quoted values, never an apostrophe inside a word ("doesn't"). */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|`[^`\n]*`|(?<!\w)'[^'\n]*'(?!\w)/g;
/** An absolute path two parts deep or more (`/srv/x/y`, `~/x/y`, `C:\Users\x`). */
const PATH = /(?<![\w:/.~\\-])(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/:"'()<>,;]+){2,}[\\/]?/g;
/** A long hex id with at least one digit (a commit, a request id), not a hex-looking word. */
const HEX = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
const NUMBER = /\d+(?:\.\d+)*/g;

/** A failure's text as an issue's title: its first line, masked and generalized, at most 160 characters. */
export function normalizeFailure(text: string): string {
  const first =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const line = redactCredentials(first)
    .replace(URL, "<url>")
    .replace(EMAIL, "<email>")
    .replace(UUID, "<id>")
    .replace(QUOTED, "<q>")
    .replace(PATH, "<path>")
    .replace(HEX, "<hex>")
    .replace(NUMBER, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > HEALTH_TITLE_MAX ? `${line.slice(0, HEALTH_TITLE_MAX - 1).trimEnd()}…` : line;
}

/** `kind:` and 16 hex characters of the hash of the kind, the tool and the normalized text. */
export function failureSignature(kind: string, tool: string | null, normalized: string): string {
  const hash = createHash("sha256")
    .update(`${kind}\u0000${tool ?? ""}\u0000${normalized}`)
    .digest("hex");
  return `${kind}:${hash.slice(0, 16)}`;
}

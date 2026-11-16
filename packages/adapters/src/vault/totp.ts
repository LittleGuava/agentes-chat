/**
 * The current code of an authenticator seed (RFC 6238 TOTP over RFC 4226 HOTP), for a Vault source whose password
 * manager keeps the seed and doesn't compute the code itself (Bitwarden). The seed is read in the source's memory for
 * one call and never leaves it: only the code does (ADR 0144, addendum of 2026-11-15). The Vault itself keeps no seed
 * (ADR 0144 §1).
 *
 * Read: an `otpauth://totp/…` URI (Key Uri Format: `secret`, `algorithm` SHA1/SHA256/SHA512, `digits` 6 to 10,
 * `period` in seconds), or a bare base32 seed (SHA-1, 6 digits, 30 s, as authenticator apps read one). Anything else
 * (HOTP, Steam's codes, another algorithm) gives no code.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

const HASHES = { SHA1: sha1, SHA256: sha256, SHA512: sha512 } as const;
type Algorithm = keyof typeof HASHES;

interface TotpParams {
  secret: Uint8Array;
  algorithm: Algorithm;
  digits: number;
  period: number;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** A seed shorter than 80 bits isn't one any issuer gives (RFC 4226 asks for 128, recommends 160). */
const MIN_SEED_BYTES = 10;
const MAX_SEED_BYTES = 256;

/** RFC 4648 base32, in either case, spaces and padding ignored; null when it isn't base32. */
function fromBase32(text: string): Uint8Array | null {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  if (out.length < MIN_SEED_BYTES || out.length > MAX_SEED_BYTES) return null;
  return Uint8Array.from(out);
}

function paramsOf(text: string): TotpParams | null {
  const trimmed = text.trim();
  if (!/^otpauth:/i.test(trimmed)) {
    const secret = fromBase32(trimmed);
    return secret ? { secret, algorithm: "SHA1", digits: 6, period: 30 } : null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "otpauth:" || url.host.toLowerCase() !== "totp") return null;
  const secret = fromBase32(url.searchParams.get("secret") ?? "");
  if (!secret) return null;
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (!Object.hasOwn(HASHES, algorithm)) return null;
  const digits = Number(url.searchParams.get("digits") ?? "6");
  const period = Number(url.searchParams.get("period") ?? "30");
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) return null;
  if (!Number.isInteger(period) || period < 1 || period > 3600) return null;
  return { secret, algorithm: algorithm as Algorithm, digits, period };
}

/** RFC 4226 §5.3: HMAC of the 8-byte counter, dynamic truncation, the last `digits` decimal digits. */
function hotp(params: TotpParams, counter: number): string {
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = hmac(HASHES[params.algorithm], params.secret, message);
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary = new DataView(mac.buffer, mac.byteOffset + offset, 4).getUint32(0) & 0x7fffffff;
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}

/** The code `seed` (a URI or a bare base32 seed) gives at `nowMs`, or null when it isn't a TOTP seed. */
export function totpNow(seed: string, nowMs: number): string | null {
  const params = paramsOf(seed);
  if (!params) return null;
  return hotp(params, Math.floor(nowMs / 1000 / params.period));
}

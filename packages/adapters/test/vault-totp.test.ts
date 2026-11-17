import { describe, expect, test } from "bun:test";
import { totpNow } from "../src/vault/totp";

/** RFC 6238, Appendix B: the seeds are these ASCII strings, 8 digits, a 30 s step. */
const SEED = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
} as const;

const RFC_VECTORS: [seconds: number, sha1: string, sha256: string, sha512: string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

/** RFC 4648 base32, no padding: how authenticator URIs carry a seed. */
function base32(text: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of new TextEncoder().encode(text)) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

const uri = (algorithm: keyof typeof SEED) =>
  `otpauth://totp/Example:ana@example.com?secret=${base32(SEED[algorithm])}&issuer=Example&algorithm=${algorithm}&digits=8&period=30`;

describe("TOTP codes (RFC 6238)", () => {
  test("the RFC's test vectors, for SHA-1, SHA-256 and SHA-512", () => {
    for (const [seconds, sha1, sha256, sha512] of RFC_VECTORS) {
      expect(totpNow(uri("SHA1"), seconds * 1000)).toBe(sha1);
      expect(totpNow(uri("SHA256"), seconds * 1000)).toBe(sha256);
      expect(totpNow(uri("SHA512"), seconds * 1000)).toBe(sha512);
    }
  });

  test("a bare base32 seed is SHA-1, 6 digits, 30 s, as authenticator apps read it", () => {
    // The 8-digit code's last 6 digits: the same HOTP value, truncated to 6.
    expect(totpNow(base32(SEED.SHA1), 59_000)).toBe("287082");
    expect(totpNow(base32(SEED.SHA1), 1111111109_000)).toBe("081804");
  });

  test("a seed written in lower case, with spaces or padding, is the same seed", () => {
    const spaced = base32(SEED.SHA1)
      .toLowerCase()
      .replace(/(.{4})/g, "$1 ");
    expect(totpNow(spaced, 59_000)).toBe("287082");
    expect(totpNow(`${base32(SEED.SHA1)}====`, 59_000)).toBe("287082");
  });

  test("a URI's defaults: SHA-1, 6 digits and 30 s when it doesn't say", () => {
    expect(totpNow(`otpauth://totp/Acme?secret=${base32(SEED.SHA1)}`, 59_000)).toBe("287082");
  });

  test("a URI's own period moves the step", () => {
    // 59 s at a 60 s step is step 0, as 29 s is at 30 s.
    const sixty = `otpauth://totp/Acme?secret=${base32(SEED.SHA1)}&digits=8&period=60`;
    expect(totpNow(sixty, 59_000)).toBe(totpNow(`otpauth://totp/Acme?secret=${base32(SEED.SHA1)}&digits=8`, 29_000));
  });

  test("anything that isn't a TOTP seed gives no code", () => {
    for (const text of [
      "",
      "   ",
      "not base32 at all!",
      `otpauth://hotp/Acme?secret=${base32(SEED.SHA1)}&counter=1`,
      "otpauth://totp/Acme?issuer=Acme",
      `otpauth://totp/Acme?secret=${base32(SEED.SHA1)}&algorithm=MD5`,
      `otpauth://totp/Acme?secret=${base32(SEED.SHA1)}&digits=4`,
      `otpauth://totp/Acme?secret=${base32(SEED.SHA1)}&digits=11`,
      `otpauth://totp/Acme?secret=${base32(SEED.SHA1)}&period=0`,
      `steam://${base32(SEED.SHA1)}`,
      "https://example.com/?secret=GEZDGNBV",
    ]) {
      expect(totpNow(text, 59_000)).toBeNull();
    }
  });
});

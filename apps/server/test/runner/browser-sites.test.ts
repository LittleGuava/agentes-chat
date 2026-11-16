import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BROWSER_SITE_HOST } from "@agenteschat/adapters/machine-protocol";
import {
  cookiesOf,
  partsOfSite,
  quotaDatabase,
  readStorageKeys,
  signedInSites,
  storageOriginsOf,
} from "../../runner/browser-sites";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

/** What `Storage.getCookies` answered on Chrome 157, values included. */
const ANSWER = {
  cookies: [
    { name: "SID", value: "secret-1", domain: ".google.com", path: "/", session: false },
    { name: "LSID", value: "secret-2", domain: "accounts.google.com", path: "/", session: false },
    { name: "wa_ul", value: "secret-3", domain: "web.whatsapp.com", path: "/", session: false },
    {
      name: "embed",
      value: "secret-4",
      domain: ".widgets.example",
      path: "/",
      partitionKey: { topLevelSite: "https://shop.example", hasCrossSiteAncestor: true },
    },
    { name: "broken" },
  ],
};

test("a cookie's value never leaves the answer, and a cookie without its place is dropped", () => {
  const cookies = cookiesOf(ANSWER);
  expect(cookies).toHaveLength(4);
  expect(JSON.stringify(cookies)).not.toContain("secret");
  expect(cookies[3]).toEqual({
    name: "embed",
    domain: ".widgets.example",
    path: "/",
    partitionKey: { topLevelSite: "https://shop.example", hasCrossSiteAncestor: true },
  });
  expect(cookiesOf(null)).toEqual([]);
});

test("storage keys become web origins: a partitioned key is the embedded site's, extensions are left out", () => {
  expect(
    storageOriginsOf([
      "https://web.whatsapp.com/",
      "http://a.shop.test:52104/",
      "https://widgets.example/^0https://shop.example",
      "chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/",
      "https://web.whatsapp.com/",
      "not a key",
    ]),
  ).toEqual(["https://web.whatsapp.com", "http://a.shop.test:52104", "https://widgets.example"]);
});

test("a site is as wide as a domain cookie that covers it, never wider; ports and schemes don't split it", () => {
  const cookies = cookiesOf(ANSWER);
  const origins = [
    "https://mail.google.com",
    "https://web.whatsapp.com",
    "http://web.whatsapp.com:8080",
    "https://docs.example.org",
  ];
  expect(signedInSites(cookies, origins)).toEqual([
    { site: "docs.example.org", cookies: 0, storage: 1 },
    // accounts.google.com's own cookie and mail.google.com's storage, under the `.google.com` cookie.
    { site: "google.com", cookies: 2, storage: 1 },
    { site: "web.whatsapp.com", cookies: 1, storage: 2 },
    { site: "widgets.example", cookies: 1, storage: 0 },
  ]);
  // A host-only cookie widens nothing: whatsapp.com's subdomains stay their own sites.
  expect(
    signedInSites(cookiesOf({ cookies: [{ name: "a", domain: "whatsapp.com", path: "/" }] }), [
      "https://web.whatsapp.com",
    ]),
  ).toEqual([
    { site: "web.whatsapp.com", cookies: 0, storage: 1 },
    { site: "whatsapp.com", cookies: 1, storage: 0 },
  ]);
});

test("signing out of a site takes exactly what the list shows under it", () => {
  const cookies = cookiesOf(ANSWER);
  const origins = ["https://mail.google.com", "https://web.whatsapp.com"];
  const google = partsOfSite(cookies, origins, "google.com");
  expect(google.cookies.map((c) => c.name).sort()).toEqual(["LSID", "SID"]);
  expect(google.origins).toEqual(["https://mail.google.com"]);
  // A host inside a site is not a site of its own.
  expect(partsOfSite(cookies, origins, "accounts.google.com")).toEqual({ cookies: [], origins: [] });
  expect(partsOfSite(cookies, origins, "nowhere.example")).toEqual({ cookies: [], origins: [] });
});

test("the profile's quota database lists the storage keys; none before Chrome wrote one", () => {
  const profile = tempDir("profile-");
  dirs.push(profile);
  expect(readStorageKeys(profile)).toEqual([]);
  mkdirSync(path.dirname(quotaDatabase(profile)), { recursive: true });
  const db = new Database(quotaDatabase(profile));
  db.run("CREATE TABLE buckets (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL, host TEXT NOT NULL, name TEXT)");
  db.run(
    "INSERT INTO buckets (storage_key, host, name) VALUES ('https://web.whatsapp.com/', 'web.whatsapp.com', '_default'), ('chrome-extension://x/', 'x', '_default')",
  );
  db.close();
  expect(readStorageKeys(profile)).toEqual(["https://web.whatsapp.com/", "chrome-extension://x/"]);
});

test("a site the runner takes is a lowercase host name", () => {
  for (const ok of ["google.com", "web.whatsapp.com", "localhost", "a-b.c_d.example", "127.0.0.1"]) {
    expect(BROWSER_SITE_HOST.test(ok)).toBe(true);
  }
  for (const bad of ["", "Google.com", "https://google.com", "google.com/", "a..b", ".google.com", "-a.com", "a b"]) {
    expect(BROWSER_SITE_HOST.test(bad)).toBe(false);
  }
});

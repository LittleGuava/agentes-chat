import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserSite, isObject } from "@agenteschat/adapters/machine-protocol";

/**
 * A browser profile's signed-in sites (ADR 0110, addendum 2026-11-15): which sites hold cookies or stored data in
 * it, and what signing out of one removes. Only hosts and counts leave here: a cookie's value is dropped as it is
 * read, and what a site stored is never read at all.
 */

/** A cookie as Chrome lists it (`Storage.getCookies`), without its value: what deleting it takes. */
export interface SiteCookie {
  name: string;
  domain: string;
  path: string;
  partitionKey?: unknown;
}

/** The cookies of `Storage.getCookies`' answer, values dropped. */
export function cookiesOf(answer: unknown): SiteCookie[] {
  const list = isObject(answer) && Array.isArray(answer.cookies) ? answer.cookies : [];
  return list.flatMap((c): SiteCookie[] => {
    if (!isObject(c) || typeof c.name !== "string" || typeof c.domain !== "string" || typeof c.path !== "string") {
      return [];
    }
    return [
      { name: c.name, domain: c.domain, path: c.path, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) },
    ];
  });
}

/** A domain cookie (`Domain=` set: Chrome writes it with a leading dot) is sent to the hosts under it too. */
const isDomainCookie = (c: SiteCookie) => c.domain.startsWith(".");
const cookieHost = (c: SiteCookie) => c.domain.replace(/^\./, "").toLowerCase();
const within = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/**
 * The web origins (`https://host:port`) of the storage keys in Chrome's quota database. A partitioned key
 * (`https://a.example/^0https://top.example`) is the embedded site's own; extensions and other schemes are left out.
 */
export function storageOriginsOf(keys: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const key of keys) {
    try {
      const url = new URL(key.split("^")[0] ?? "");
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // not a web origin
    }
  }
  return [...origins];
}

const originHost = (origin: string) => new URL(origin).hostname.toLowerCase();

/** The site of `host`: the widest domain cookie that covers it, else the host itself. */
function siteOf(host: string, domains: readonly string[]): string {
  let site = host;
  for (const d of domains) if (within(host, d) && d.length < site.length) site = d;
  return site;
}

function grouped(cookies: readonly SiteCookie[], origins: readonly string[]) {
  const domains = [...new Set(cookies.filter(isDomainCookie).map(cookieHost))];
  const sites = new Map<string, { cookies: SiteCookie[]; origins: string[] }>();
  const of = (host: string) => {
    const site = siteOf(host, domains);
    let entry = sites.get(site);
    if (!entry) {
      entry = { cookies: [], origins: [] };
      sites.set(site, entry);
    }
    return entry;
  };
  for (const c of cookies) of(cookieHost(c)).cookies.push(c);
  for (const o of origins) of(originHost(o)).origins.push(o);
  return sites;
}

/** The sites, sorted, each with how many cookies it has and how many of its origins keep data. */
export function signedInSites(cookies: readonly SiteCookie[], origins: readonly string[]): BrowserSite[] {
  return [...grouped(cookies, origins)]
    .map(([site, e]) => ({ site, cookies: e.cookies.length, storage: e.origins.length }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

/** What signing out of `site` removes: its cookies and its origins with stored data, as the list groups them. */
export function partsOfSite(cookies: readonly SiteCookie[], origins: readonly string[], site: string) {
  return grouped(cookies, origins).get(site) ?? { cookies: [], origins: [] };
}

/** Chrome's quota database in a profile: every origin that keeps data (local storage, IndexedDB, caches) has a row. */
export const quotaDatabase = (profile: string) => path.join(profile, "Default", "WebStorage", "QuotaManager");

/**
 * The storage keys in the profile's quota database. Chrome keeps its databases locked while it runs (measured on
 * Chrome 157: "database is locked" right after it started), but the locks don't stop reading the bytes, so a copy of
 * the file, with its journal when one is there, is read instead and removed at once. None when Chrome never wrote one.
 */
export function readStorageKeys(profile: string): string[] {
  const file = quotaDatabase(profile);
  if (!existsSync(file)) return [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentes-quota-"));
  try {
    const copy = path.join(dir, "QuotaManager");
    copyFileSync(file, copy);
    if (existsSync(`${file}-journal`)) copyFileSync(`${file}-journal`, `${copy}-journal`);
    const db = new Database(copy);
    try {
      return db
        .query<{ storage_key: unknown }, []>("SELECT storage_key FROM buckets")
        .all()
        .flatMap((r) => (typeof r.storage_key === "string" ? [r.storage_key] : []));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

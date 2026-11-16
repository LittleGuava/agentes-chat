import { PAGE_CSP, PAGE_SANDBOX } from "@agenteschat/client/lib/isolated-page";
import { type ArtifactDeps, publishedPageHtml } from "@agenteschat/engine";
import type { Context, MiddlewareHandler } from "hono";

/**
 * A public page's policy (ADR 0211 §2), as a header so nothing in the page removes it: the sandbox without
 * `allow-same-origin` gives it an opaque origin (every workspace's pages share one host, and none reads another's
 * storage), the policy pages have inside the app cuts it off from the network, and no site frames it.
 */
export const PUBLISHED_PAGE_CSP = `sandbox ${PAGE_SANDBOX}; ${PAGE_CSP}; frame-ancestors 'none'`;

const PAGE_PATH = /^\/p\/([A-Za-z0-9_-]{43})\/?$/;

const PAGE_HEADERS = {
  "content-security-policy": PUBLISHED_PAGE_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex",
  // A page taken down stops at once: no browser or proxy keeps it.
  "cache-control": "no-store",
};

/** The pages host (`PUBLISHED_PAGES_URL`'s, lowercase), or null while pages are off. */
export const pagesHostOf = (baseUrl: string | undefined) => (baseUrl ? new URL(baseUrl).host.toLowerCase() : null);

/** Whether a request is addressed to the pages host: Bun builds `req.url` from the request's own `Host`. */
export const onPagesHost = (pagesHost: string | null, req: Request) =>
  pagesHost !== null && new URL(req.url).host.toLowerCase() === pagesHost;

const notFound = (c: Context) =>
  c.body("Not found", 404, { ...PAGE_HEADERS, "content-type": "text/plain; charset=utf-8" });

/**
 * Splits requests by host (ADR 0211 §1), before every other route: the pages host (`PUBLISHED_PAGES_URL`, checked
 * apart from `PUBLIC_URL`'s at boot) answers a page's address and nothing else, the API included, and the app's host
 * never answers one. The host is the request's own (`Host`, which the proxy keeps). Off without a pages host.
 */
export function publishedPages(
  baseUrl: string | undefined,
  artifacts: () => ArtifactDeps | undefined,
): MiddlewareHandler {
  const pagesHost = pagesHostOf(baseUrl);
  return async (c, next) => {
    if (!pagesHost) return next();
    const path = c.req.path;
    if (!onPagesHost(pagesHost, c.req.raw)) {
      return path === "/p" || path.startsWith("/p/") ? notFound(c) : next();
    }
    const token = PAGE_PATH.exec(path)?.[1];
    const deps = artifacts();
    if (!token || !deps || (c.req.method !== "GET" && c.req.method !== "HEAD")) return notFound(c);
    const html = await publishedPageHtml(deps, token);
    if (html === null) return notFound(c);
    const headers = { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" };
    return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(html, 200, headers);
  };
}

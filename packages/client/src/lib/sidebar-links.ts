/**
 * A person's own links in their sidebar (ADR 0083, amendment of 2026-11-15). The limits and the address rule mirror
 * packages/engine/src/sidebar-links.ts, so a form can say what's wrong before it sends (a test holds them together).
 */
export const SIDEBAR_LINK_LIMIT = 10;
export const SIDEBAR_LINK_TITLE_MAX = 60;
const SIDEBAR_LINK_URL_MAX = 2048;

/** `new URL` throws on what isn't an address: that is the answer, not a failure. */
function parsed(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** The address as the server keeps it, or null when it can't be one: `https:` with a host and no user or password. */
export function sidebarLinkUrl(raw: string): string | null {
  const url = parsed(raw.trim());
  if (url?.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.href.length <= SIDEBAR_LINK_URL_MAX ? url.href : null;
}

/**
 * What a person typed, as an address to check: `crm.example.com` reads as `https://crm.example.com`. A colon before a
 * digit is a port (`grafana.example.com:8443`), not a scheme; a scheme typed stays, for `sidebarLinkUrl` to refuse.
 */
export const sidebarLinkInput = (typed: string) => {
  const text = typed.trim();
  return text && !/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? `https://${text}` : text;
};

/** The address without its scheme, as the sidebar says it on hover and the setup lists it. */
export const sidebarLinkShown = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

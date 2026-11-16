/** Every spelling of this computer's own address a browser would reach (`127.x`, `localhost`, `[::1]`, `0.0.0.0`). */
const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[::1\]|0\.0\.0\.0|\[::\])$/;

/**
 * Whether `url` reaches a lent Chrome's debugging endpoint (`ports`) on this computer: its `/json` pages list the
 * person's tabs, and its sockets drive the whole browser. Every agent's own browser is kept off it while it is lent.
 */
export function reachesLentChrome(url: string, ports: ReadonlySet<number>): boolean {
  if (ports.size === 0) return false;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const port = Number(u.port || (u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80));
  return LOOPBACK.test(host) && ports.has(port);
}

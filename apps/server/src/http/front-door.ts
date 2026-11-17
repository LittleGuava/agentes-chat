import { onPagesHost, pagesHostOf } from "./published-pages";

export interface FrontDoorOptions {
  /** This server's own names when it answers only them (native mode, `ownHostsOnly`), else null: every name. */
  ownHosts: Set<string> | null;
  publicUrl: URL;
  /** `PUBLISHED_PAGES_URL`: the host that serves public pages alone (ADR 0211 §1), or unset. */
  pagesUrl: string | undefined;
}

type Answer = Response | Promise<Response>;
type Sockets<S> = (
  req: Request,
  server: S,
  next: (req: Request) => Answer,
) => Response | Promise<Response | undefined> | undefined;

/**
 * `Bun.serve`'s fetch: the name a request is addressed to first, then the socket upgrades, then the HTTP app.
 * The pages host goes straight to the HTTP app, whose first middleware answers it (ADR 0211 §1): no socket is
 * ever opened there, and native mode neither refuses it nor sends it to `PUBLIC_URL`.
 */
export function frontDoor<S>(options: FrontDoorOptions, sockets: Sockets<S>, app: (req: Request) => Answer) {
  const { ownHosts, publicUrl } = options;
  const pagesHost = pagesHostOf(options.pagesUrl);
  /**
   * A 421 for a name not its own; and a page opened at another of its own names goes to `PUBLIC_URL`,
   * the only origin that sign-in and saving accept. Temporary: `PUBLIC_URL` changes with Tailscale.
   */
  const ownHostAnswer = (req: Request) => {
    const host = req.headers.get("host") ?? "";
    if (!ownHosts || host === publicUrl.host) return null;
    if (!ownHosts.has(host)) return new Response("This server answers only at its own address.\n", { status: 421 });
    if (req.method !== "GET" || !req.headers.get("accept")?.includes("text/html")) return null;
    const { pathname, search } = new URL(req.url);
    return Response.redirect(new URL(pathname + search, publicUrl).href, 302);
  };
  return (req: Request, server: S) =>
    onPagesHost(pagesHost, req) ? app(req) : (ownHostAnswer(req) ?? sockets(req, server, app));
}

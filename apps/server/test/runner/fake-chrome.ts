/**
 * A fake Chrome speaking the DevTools protocol on a loopback port the test picks (port 0), with one tab of the
 * person's already open (ADR 0202). Never a real Chrome, never a fixed port.
 */

export interface Logged {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface Page {
  title: string;
  text: string;
}

export class FakeChrome {
  readonly log: Logged[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  /** What `/json/version` says the browser endpoint is (a test may point it elsewhere). */
  wsUrl: string;
  /** Where a navigation ends up (a redirect). */
  readonly redirects = new Map<string, string>();
  readonly pages = new Map<string, Page>();
  /** targetId → its address. The person's tab is here from the start. */
  readonly targets = new Map<string, string>([["person-tab", "https://mail.example/inbox"]]);
  /** sessionId → targetId. */
  readonly sessions = new Map<string, string>();
  private socket: { send(text: string): void; close(): void } | null = null;
  private next = 1;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") {
          return Response.json({ Browser: "Chrome/150.0.0.0", webSocketDebuggerUrl: this.wsUrl });
        }
        if (url.pathname.startsWith("/devtools/browser/") && server.upgrade(req, { data: undefined })) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.socket = ws;
        },
        message: (ws, raw) => this.answer(ws, String(raw)),
        close: () => {
          this.socket = null;
        },
      },
    });
    this.wsUrl = `ws://127.0.0.1:${this.port}/devtools/browser/fake-browser`;
  }

  get port(): number {
    return this.server.port ?? 0;
  }

  private answer(ws: { send(text: string): void }, raw: string) {
    const msg = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
    const params = msg.params ?? {};
    this.log.push({ method: msg.method, params, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result, ...sessionOf(msg) }));
    const fail = (message: string) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message } }));
    let target: string | undefined;
    if (msg.sessionId) {
      target = this.sessions.get(msg.sessionId);
      if (!target) return fail("Session with given id not found.");
    }
    switch (msg.method) {
      case "Browser.getVersion":
        return reply({ product: "Chrome/150.0.0.0", protocolVersion: "1.3" });
      case "Target.createTarget": {
        const id = `agent-tab-${this.next++}`;
        this.targets.set(id, String(params.url));
        return reply({ targetId: id });
      }
      case "Target.attachToTarget": {
        if (!this.targets.has(String(params.targetId))) return fail("No target with given id found");
        const sessionId = `session-${this.next++}`;
        this.sessions.set(sessionId, String(params.targetId));
        return reply({ sessionId });
      }
      case "Page.navigate": {
        const url = String(params.url);
        this.targets.set(target ?? "", this.redirects.get(url) ?? url);
        return reply({ frameId: "frame" });
      }
      case "Runtime.evaluate": {
        const url = this.targets.get(target ?? "") ?? "about:blank";
        const page = this.pages.get(url) ?? { title: "", text: "" };
        return reply({ result: { type: "object", value: { ready: "complete", url, ...page } } });
      }
      default:
        return fail(`'${msg.method}' wasn't found`);
    }
  }

  /** The person closes a tab: Chrome detaches whoever was attached to it. */
  closeTab(targetId: string) {
    this.targets.delete(targetId);
    for (const [sessionId, t] of this.sessions) {
      if (t !== targetId) continue;
      this.sessions.delete(sessionId);
      this.socket?.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId, targetId } }));
    }
  }

  /** The person quits Chrome. */
  quit() {
    this.socket?.close();
  }

  stop() {
    this.server.stop(true);
  }
}

const sessionOf = (msg: { sessionId?: string }) => (msg.sessionId ? { sessionId: msg.sessionId } : {});

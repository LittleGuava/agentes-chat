import {
  type AgentScope,
  type MachineReplies,
  MY_CHROME_MAX_MINUTES,
  MY_CHROME_TEXT_MAX,
  type MyChromeAction,
  type MyChromeLent,
  type MyChromeSession,
  type MyChromeTab,
} from "@agenteschat/adapters/machine-protocol";
import { domainAllowed, isWebPage } from "./browser";
import { RunnerError } from "./errors";

export { reachesLentChrome } from "./lent-chrome-port";

/**
 * The person's own Chrome (protocol 82, ADR 0202): a Chrome the person started with remote debugging on a loopback
 * port, lent to one agent for a limited time, through the desktop app's control channel only.
 *
 * The runner speaks the DevTools protocol to it itself, with a closed vocabulary, never `agent-browser` (which
 * attaches to the first tab it finds) and never a method or script the server sends. It opens one tab of its own
 * for the agent, in a window of its own (`Target.createTarget`), attaches to that tab alone, and sends every page
 * command on that attachment: the person's tabs, cookies and storage are never listed, attached or read. A page
 * that tab opens (`window.open`) is the person's: the runner never attaches to it. A tab the person closes is
 * forgotten (`Target.detachedFromTarget`). Disconnecting closes the connection and leaves the tabs, which are in
 * the person's browser.
 *
 * Only `127.0.0.1`: the browser endpoint's path is read from Chrome's answer (or given), and the address is always
 * built on the loopback and the port the person named. A Chrome this runner started for an agent is refused (that
 * would hand one agent another's browser). Nothing is written to disk: a restart of the runner ends every consent.
 */

/** How long a DevTools command may take. */
const COMMAND_MS = 30_000;
/** How long a page may take to finish loading before it is read anyway. */
const LOAD_MS = 15_000;
const LOAD_POLL_MS = 100;
const BROWSER_PATH = /^\/devtools\/browser\/[\w-]+$/;

/** What the page says of itself: a fixed expression, so the agent never runs a script of its own here. */
const pageExpression = (withText: boolean) =>
  `(() => ({ ready: document.readyState, url: location.href, title: document.title${
    withText ? `, text: document.body ? document.body.innerText.slice(0, ${MY_CHROME_TEXT_MAX + 1}) : ""` : ""
  } }))()`;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One open DevTools connection to the person's Chrome (the browser endpoint, flat sessions). */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly onEvent: (method: string, params: Json) => void,
    private readonly onClose: () => void,
  ) {
    socket.addEventListener("message", (ev) => this.receive(String(ev.data)));
    socket.addEventListener("close", () => this.closedNow());
    socket.addEventListener("error", () => this.closedNow());
  }

  static open(dial: (url: string) => WebSocket, url: string, onEvent: Cdp["onEvent"], onClose: () => void) {
    return new Promise<Cdp>((resolve, reject) => {
      const socket = dial(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Chrome didn't answer"));
      }, COMMAND_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(socket, onEvent, onClose));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Chrome refused the connection"));
      });
    });
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("Chrome closed"));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome didn't answer ${method}`));
      }, COMMAND_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
    this.closedNow();
  }

  private receive(raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    if (typeof msg.id === "number") {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (isRecord(msg.error)) waiter.reject(new Error(str(msg.error.message) || "Chrome refused the command"));
      else waiter.resolve(isRecord(msg.result) ? msg.result : {});
      return;
    }
    if (typeof msg.method === "string") this.onEvent(msg.method, isRecord(msg.params) ? msg.params : {});
  }

  private closedNow() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("Chrome closed"));
    this.pending.clear();
    this.onClose();
  }
}

interface Tab extends MyChromeTab {
  targetId: string;
  sessionId: string;
}

interface Lent {
  agent: AgentScope;
  port: number;
  browser: string;
  connectedAt: number;
  expiresAt: number;
  cdp: Cdp;
  /** The agent's own tab, while it is open. */
  tab: Tab | null;
  timer: ReturnType<typeof setTimeout>;
  /** Actions run one at a time. */
  queue: Promise<unknown>;
}

export interface MyChromesOptions {
  /** The debugging ports of the Chromes this runner started for agents and profiles: never lent. */
  ownPorts: () => ReadonlySet<number>;
  /** System mode: the computer's agents are users of their own, so nobody's Chrome is lent there. */
  systemMode: () => boolean;
  /** A line for the computer's activity log, which the person reads in the desktop app. */
  record: (agent: AgentScope, line: string) => void;
  log: (line: string) => void;
  now?: () => number;
  /** Tests: how the browser endpoint is dialed. */
  dial?: (url: string) => WebSocket;
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /**
   * Why lending is refused now, or null: an agent here may run programs of its own as the person (commands, a coding
   * CLI), and any such program reaches the debugging port with no tab of its own and no closed vocabulary.
   */
  guard?: () => string | null;
  /** Who holds a lent Chrome changed (lent, replaced, ended): the whole list, for the server. */
  onChange?: (lent: MyChromeLent[]) => void;
}

export class MyChromes {
  private readonly held = new Map<string, Lent>();
  private readonly now: () => number;

  constructor(private readonly opts: MyChromesOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The person lends `agent` the Chrome on `port` for `minutes` (control channel only, never the server). */
  async connect(input: {
    agent: AgentScope;
    port: number;
    minutes: number;
    wsPath?: string;
  }): Promise<MyChromeSession> {
    const { agent, port, minutes } = input;
    if (this.opts.systemMode()) {
      throw new RunnerError(
        "not_allowed",
        "This computer runs each agent as its own user: a person's own Chrome can't be lent here.",
      );
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new RunnerError("bad_request", "The port is a number from 1 to 65535.");
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MY_CHROME_MAX_MINUTES) {
      throw new RunnerError("bad_request", `Lend it for 1 to ${MY_CHROME_MAX_MINUTES} minutes.`);
    }
    if (this.opts.ownPorts().has(port)) {
      throw new RunnerError("not_allowed", "That port is an agent's own browser, not yours.");
    }
    this.refuseNow(agent, port);
    const wsPath = input.wsPath ?? (await this.browserPath(port));
    if (!BROWSER_PATH.test(wsPath)) {
      throw new RunnerError("browser_unavailable", "That port isn't a Chrome's debugging endpoint.");
    }
    let cdp: Cdp;
    try {
      cdp = await Cdp.open(
        this.opts.dial ?? ((u) => new WebSocket(u)),
        `ws://127.0.0.1:${port}${wsPath}`,
        (method, params) => this.event(agent.id, method, params),
        () => this.end(agent.id, "Chrome closed", cdp),
      );
    } catch {
      throw new RunnerError("browser_unavailable", "Chrome didn't answer on that port.");
    }
    let browser = "";
    try {
      browser = str((await cdp.send("Browser.getVersion")).product);
    } catch {
      // Answered on the socket but not as Chrome: refused below.
    }
    if (!/^(Headless)?Chrom(e|ium)\//.test(browser)) {
      cdp.close();
      throw new RunnerError("browser_unavailable", "That port isn't a Chrome's debugging endpoint.");
    }
    // Checked again: another agent may have been lent this Chrome while this one was dialing.
    try {
      this.refuseNow(agent, port);
    } catch (err) {
      cdp.close();
      throw err;
    }
    // Only now does a session this agent already had end: a wrong port leaves it as it was.
    this.end(agent.id, "replaced by a new connection");
    const connectedAt = this.now();
    const expiresAt = connectedAt + minutes * 60_000;
    const timer = setTimeout(() => this.end(agent.id, "ended: the time you gave ran out"), minutes * 60_000);
    timer.unref?.();
    const lent: Lent = {
      agent,
      port,
      browser,
      connectedAt,
      expiresAt,
      cdp,
      tab: null,
      timer,
      queue: Promise.resolve(),
    };
    this.held.set(agent.id, lent);
    this.opts.record(agent, `Your Chrome: connected on port ${port} for ${minutes} min`);
    this.changed();
    return this.info(lent);
  }

  /**
   * Refused while an agent here may run programs of its own as the person (`guard`), and while another agent holds
   * the Chrome on `port` (one agent per Chrome).
   */
  private refuseNow(agent: AgentScope, port: number) {
    const why = this.opts.guard?.();
    if (why) throw new RunnerError("not_allowed", why);
    if ([...this.sessions()].some((s) => s.port === port && s.agent.id !== agent.id)) {
      throw new RunnerError("not_allowed", "Another agent uses this Chrome now. Disconnect it first.");
    }
  }

  /** `mychrome.act`: one action in the agent's own tab, after the ones before it. */
  async act(
    agent: AgentScope,
    action: MyChromeAction,
    allowedDomains: readonly string[] = [],
  ): Promise<MachineReplies["mychrome.act"]> {
    const lent = this.live(agent.id);
    const run = lent.queue.catch(() => undefined).then(() => this.run(lent, action, allowedDomains));
    lent.queue = run.catch(() => undefined);
    return run;
  }

  /** `mychrome.list`: every agent's use of a person's Chrome, with its own tabs only. */
  list(): MyChromeSession[] {
    return [...this.sessions()].map((l) => this.info(l));
  }

  /** Who holds a lent Chrome and until when (`hello.myChrome`, `mychrome.changed`). */
  lent(): MyChromeLent[] {
    return [...this.sessions()].map((l) => ({ agentId: l.agent.id, expiresAt: new Date(l.expiresAt).toISOString() }));
  }

  /** The debugging ports of the lent Chromes: off limits to every agent's own browser while lent. */
  lentPorts(): Set<number> {
    return new Set([...this.sessions()].map((l) => l.port));
  }

  private changed() {
    this.opts.onChange?.(this.lent());
  }

  /** `mychrome.disconnect`: ends one agent's use (or every one); the tabs stay in the person's browser. */
  disconnect(agentId?: string, why = "disconnected"): number {
    const ids = agentId === undefined ? [...this.held.keys()] : [agentId];
    let ended = 0;
    for (const id of ids) if (this.end(id, why)) ended++;
    return ended;
  }

  /** The live sessions, after ending those whose time ran out. */
  private *sessions(): Generator<Lent> {
    for (const l of [...this.held.values()]) {
      if (this.now() >= l.expiresAt) this.end(l.agent.id, "ended: the time you gave ran out");
      else yield l;
    }
  }

  private live(agentId: string): Lent {
    const found = [...this.sessions()].find((l) => l.agent.id === agentId);
    if (!found) throw new RunnerError("not_allowed", "The person hasn't lent this agent their Chrome, or it ended.");
    return found;
  }

  private info(l: Lent): MyChromeSession {
    return {
      agentId: l.agent.id,
      port: l.port,
      browser: l.browser,
      connectedAt: new Date(l.connectedAt).toISOString(),
      expiresAt: new Date(l.expiresAt).toISOString(),
      tabs: l.tab ? [{ url: l.tab.url, title: l.tab.title }] : [],
    };
  }

  private end(agentId: string, why: string, only?: Cdp): boolean {
    const l = this.held.get(agentId);
    if (!l || (only && l.cdp !== only)) return false;
    this.held.delete(agentId);
    clearTimeout(l.timer);
    l.cdp.close();
    this.opts.record(l.agent, `Your Chrome: ${why}`);
    this.changed();
    return true;
  }

  private event(agentId: string, method: string, params: Json) {
    if (method !== "Target.detachedFromTarget") return;
    const l = this.held.get(agentId);
    if (l?.tab && str(params.sessionId) === l.tab.sessionId) l.tab = null;
  }

  /** The browser endpoint's path from `/json/version`: only its path, the host is ours. */
  private async browserPath(port: number): Promise<string> {
    const get = this.opts.fetch ?? ((url: string, init: { signal: AbortSignal }) => fetch(url, init));
    try {
      const reply = await get(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (!reply.ok) return "";
      const body: unknown = await reply.json();
      if (!isRecord(body) || typeof body.webSocketDebuggerUrl !== "string") return "";
      return new URL(body.webSocketDebuggerUrl).pathname;
    } catch {
      throw new RunnerError("browser_unavailable", "Chrome didn't answer on that port.");
    }
  }

  private async run(
    lent: Lent,
    action: MyChromeAction,
    allowed: readonly string[],
  ): Promise<MachineReplies["mychrome.act"]> {
    const { agent } = lent;
    try {
      if (action.kind === "open") return await this.open(lent, action.url, allowed);
      const tab = lent.tab;
      if (!tab)
        throw new RunnerError("not_allowed", "No page is open in your tab of the person's Chrome: open one first.");
      const page = await this.page(lent.cdp, tab, true);
      if (!domainAllowed(page.url, allowed)) {
        this.opts.record(agent, `Your Chrome: didn't read ${hostOf(page.url)} (not one of its sites)`);
        throw new RunnerError("not_allowed", "The tab is on a site this agent may not use, so it wasn't read.");
      }
      this.opts.record(agent, `Your Chrome: read ${hostOf(page.url)}`);
      const truncated = page.text.length > MY_CHROME_TEXT_MAX;
      return { url: page.url, title: page.title, text: page.text.slice(0, MY_CHROME_TEXT_MAX), truncated };
    } catch (err) {
      if (err instanceof RunnerError) throw err;
      this.opts.log(`my chrome (${agent.handle}): ${err instanceof Error ? err.message : String(err)}`);
      throw new RunnerError("browser_unavailable", "The person's Chrome didn't answer.");
    }
  }

  private async open(lent: Lent, url: string, allowed: readonly string[]): Promise<MachineReplies["mychrome.act"]> {
    const { agent, cdp } = lent;
    const target = url.trim();
    if (!isWebPage(target) || target === "about:blank") {
      throw new RunnerError("not_allowed", "Only web pages (http or https) open in the person's Chrome.");
    }
    if (!domainAllowed(target, allowed)) {
      this.opts.record(agent, `Your Chrome: didn't open ${hostOf(target)} (not one of its sites)`);
      throw new RunnerError("not_allowed", "That site isn't one this agent may use.");
    }
    const tab = lent.tab ?? (await this.newTab(lent));
    const nav = await cdp.send("Page.navigate", { url: target }, tab.sessionId);
    if (str(nav.errorText)) throw new RunnerError("bad_request", `The page didn't open: ${str(nav.errorText)}`);
    const page = await this.page(cdp, tab, false);
    if (!domainAllowed(page.url, allowed)) {
      await cdp.send("Page.navigate", { url: "about:blank" }, tab.sessionId).catch(() => undefined);
      tab.url = "about:blank";
      tab.title = "";
      this.opts.record(agent, `Your Chrome: ${hostOf(target)} went to ${hostOf(page.url)}, not one of its sites`);
      throw new RunnerError("not_allowed", "The page moved to a site this agent may not use, so it was closed.");
    }
    this.opts.record(agent, `Your Chrome: opened ${hostOf(page.url)}`);
    return { url: page.url, title: page.title };
  }

  /** The agent's tab: a new one in a window of its own, so the person's windows never change under them. */
  private async newTab(lent: Lent): Promise<Tab> {
    const created = await lent.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const targetId = str(created.targetId);
    const attached = await lent.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab: Tab = { targetId, sessionId: str(attached.sessionId), url: "about:blank", title: "" };
    lent.tab = tab;
    return tab;
  }

  /** The tab's page once it finished loading (or `LOAD_MS` passed): its address, title and maybe text. */
  private async page(cdp: Cdp, tab: Tab, withText: boolean) {
    const deadline = this.now() + LOAD_MS;
    for (;;) {
      const out = await cdp.send(
        "Runtime.evaluate",
        { expression: pageExpression(withText), returnByValue: true },
        tab.sessionId,
      );
      const value = isRecord(out.result) && isRecord(out.result.value) ? out.result.value : {};
      const page = { url: str(value.url), title: str(value.title).slice(0, 300), text: str(value.text) };
      if (value.ready === "complete" || this.now() >= deadline) {
        tab.url = page.url;
        tab.title = page.title;
        return page;
      }
      await Bun.sleep(LOAD_POLL_MS);
    }
  }
}

/** A page's host for the activity log (never its path: it may carry a token). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 40);
  } catch {
    return "a page";
  }
}

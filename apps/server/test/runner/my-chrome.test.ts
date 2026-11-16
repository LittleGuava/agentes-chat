import { afterEach, expect, test } from "bun:test";
import type { AgentScope, MachineRequest, MyChromeLent } from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "../../runner/errors";
import { type HandlerContext, handleRequest } from "../../runner/handlers";
import { MyChromes, reachesLentChrome } from "../../runner/my-chrome";
import { FakeChrome } from "./fake-chrome";

const ada: AgentScope = { id: "agent-ada", handle: "ada", name: "Ada" };
const bea: AgentScope = { id: "agent-bea", handle: "bea", name: "Bea" };

const started: Array<{ chrome: FakeChrome; chromes: MyChromes }> = [];

function setup(opts: { ownPorts?: number[]; system?: boolean; guard?: () => string | null } = {}) {
  const chrome = new FakeChrome();
  chrome.pages.set("https://shop.example/orders", { title: "Your orders", text: "Order 42: shipped" });
  let now = Date.parse("2026-11-15T12:00:00Z");
  const lines: string[] = [];
  const changes: MyChromeLent[][] = [];
  const chromes = new MyChromes({
    ...(opts.guard ? { guard: opts.guard } : {}),
    onChange: (lent) => changes.push(lent),
    ownPorts: () => new Set(opts.ownPorts ?? []),
    systemMode: () => opts.system === true,
    now: () => now,
    record: (_agent, line) => lines.push(line),
    log: () => {},
  });
  started.push({ chrome, chromes });
  return {
    chrome,
    chromes,
    lines,
    changes,
    later: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  for (const { chrome, chromes } of started.splice(0)) {
    chromes.disconnect();
    chrome.stop();
  }
});

async function refusal(p: Promise<unknown>): Promise<RunnerError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RunnerError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

/** Every command the runner sent, as the fake saw it: none touches what the runner didn't open. */
function onlyItsOwnTabs(chrome: FakeChrome) {
  const allowed = new Set([
    "Browser.getVersion",
    "Target.createTarget",
    "Target.attachToTarget",
    "Page.navigate",
    "Runtime.evaluate",
  ]);
  const created = new Set<string>();
  const attached = new Set<string>();
  let n = 0;
  for (const entry of chrome.log) {
    expect(allowed.has(entry.method)).toBe(true);
    expect(JSON.stringify(entry.params)).not.toContain("person-tab");
    if (entry.method === "Target.attachToTarget") expect(created.has(String(entry.params.targetId))).toBe(true);
    if (entry.sessionId) expect(attached.has(entry.sessionId)).toBe(true);
    if (entry.method === "Target.createTarget") {
      expect(entry.params.newWindow).toBe(true);
      created.add(`agent-tab-${++n}`);
    }
    // The fake numbers tabs and sessions from one counter: the session follows its tab.
    if (entry.method === "Target.attachToTarget") attached.add(`session-${++n}`);
  }
}

test("the person connects their Chrome for one agent; it opens a page in a tab of its own and reads it", async () => {
  const { chrome, chromes, lines } = setup();
  const session = await chromes.connect({ agent: ada, port: chrome.port, minutes: 30 });
  expect(session).toMatchObject({ agentId: "agent-ada", port: chrome.port, browser: "Chrome/150.0.0.0", tabs: [] });
  expect(session.expiresAt).toBe("2026-11-15T12:30:00.000Z");

  const opened = await chromes.act(ada, { kind: "open", url: "https://shop.example/orders" });
  expect(opened).toEqual({ url: "https://shop.example/orders", title: "Your orders" });
  const read = await chromes.act(ada, { kind: "read" });
  expect(read).toEqual({
    url: "https://shop.example/orders",
    title: "Your orders",
    text: "Order 42: shipped",
    truncated: false,
  });

  // The list shows the agent's own tab, never the person's.
  expect(chromes.list()).toEqual([
    expect.objectContaining({
      agentId: "agent-ada",
      tabs: [{ url: "https://shop.example/orders", title: "Your orders" }],
    }),
  ]);
  onlyItsOwnTabs(chrome);
  expect(chrome.log.filter((e) => e.method === "Target.createTarget")).toHaveLength(1);
  expect(lines.join("\n")).toContain("connected");
  expect(lines.join("\n")).toContain("shop.example");
});

test("a second page goes in the same tab of its own", async () => {
  const { chrome, chromes } = setup();
  chrome.pages.set("https://shop.example/cart", { title: "Cart", text: "2 items" });
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 30 });
  await chromes.act(ada, { kind: "open", url: "https://shop.example/orders" });
  await chromes.act(ada, { kind: "open", url: "https://shop.example/cart" });
  expect(chrome.log.filter((e) => e.method === "Target.createTarget")).toHaveLength(1);
  expect(await chromes.act(ada, { kind: "read" })).toMatchObject({ title: "Cart", text: "2 items" });
  onlyItsOwnTabs(chrome);
});

test("the browser endpoint is always dialed on the loopback, whatever host Chrome's answer names", async () => {
  const { chrome, chromes } = setup();
  chrome.wsUrl = "ws://attacker.example:9/devtools/browser/fake-browser";
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  expect(chrome.log[0]?.method).toBe("Browser.getVersion");
});

test("an endpoint path that isn't a browser's is refused", async () => {
  const { chrome, chromes } = setup();
  chrome.wsUrl = `ws://127.0.0.1:${chrome.port}/devtools/page/person-tab`;
  const err = await refusal(chromes.connect({ agent: ada, port: chrome.port, minutes: 5 }));
  expect(err.code).toBe("browser_unavailable");
  expect(chrome.log).toHaveLength(0);
});

test("the port of a Chrome the runner started for an agent is refused", async () => {
  const { chrome, chromes } = setup({ ownPorts: [] });
  const own = setup({ ownPorts: [chrome.port] });
  const err = await refusal(own.chromes.connect({ agent: ada, port: chrome.port, minutes: 5 }));
  expect(err.code).toBe("not_allowed");
  expect(chrome.log).toHaveLength(0);
  expect(chromes.list()).toEqual([]);
});

test("ports outside 1-65535 are refused before anything is dialed", async () => {
  const { chromes } = setup();
  for (const port of [0, -1, 70000, 1.5, Number.NaN]) {
    expect((await refusal(chromes.connect({ agent: ada, port, minutes: 5 }))).code).toBe("bad_request");
  }
});

test("never in system mode: the computer's agents are users of their own there", async () => {
  const { chrome, chromes } = setup({ system: true });
  const err = await refusal(chromes.connect({ agent: ada, port: chrome.port, minutes: 5 }));
  expect(err.code).toBe("not_allowed");
  expect(chrome.log).toHaveLength(0);
});

test("one agent at a time on a Chrome, and another agent has no session to act in", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  expect((await refusal(chromes.connect({ agent: bea, port: chrome.port, minutes: 5 }))).code).toBe("not_allowed");
  const err = await refusal(chromes.act(bea, { kind: "open", url: "https://shop.example/orders" }));
  expect(err.code).toBe("not_allowed");
  expect(chrome.log.filter((e) => e.method === "Target.createTarget")).toHaveLength(0);
});

test("only web pages, and only on the agent's sites", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
    "view-source:https://a.example",
  ]) {
    expect((await refusal(chromes.act(ada, { kind: "open", url }))).code).toBe("not_allowed");
  }
  const off = await refusal(chromes.act(ada, { kind: "open", url: "https://bank.example/" }, ["shop.example"]));
  expect(off.code).toBe("not_allowed");
  expect(chrome.log.filter((e) => e.method === "Page.navigate")).toHaveLength(0);
});

test("a redirect off the agent's sites is caught after the page loads: the tab goes blank and nothing is read", async () => {
  const { chrome, chromes } = setup();
  chrome.redirects.set("https://shop.example/login", "https://bank.example/account");
  chrome.pages.set("https://bank.example/account", { title: "Bank", text: "Balance 1000" });
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  const err = await refusal(chromes.act(ada, { kind: "open", url: "https://shop.example/login" }, ["shop.example"]));
  expect(err.code).toBe("not_allowed");
  expect(err.message).not.toContain("Balance");
  const navigations = chrome.log.filter((e) => e.method === "Page.navigate").map((e) => e.params.url);
  expect(navigations).toEqual(["https://shop.example/login", "about:blank"]);
  onlyItsOwnTabs(chrome);
});

test("a page that moved off the agent's sites on its own isn't read", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  await chromes.act(ada, { kind: "open", url: "https://shop.example/orders" }, ["shop.example"]);
  chrome.targets.set("agent-tab-1", "https://bank.example/account");
  chrome.pages.set("https://bank.example/account", { title: "Bank", text: "Balance 1000" });
  const err = await refusal(chromes.act(ada, { kind: "read" }, ["shop.example"]));
  expect(err.code).toBe("not_allowed");
  expect(err.message).not.toContain("Balance");
});

test("a tab the person closes leaves the list, and the next page opens a new tab of the agent's", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  await chromes.act(ada, { kind: "open", url: "https://shop.example/orders" });
  chrome.closeTab("agent-tab-1");
  await Bun.sleep(20);
  expect(chromes.list()[0]?.tabs).toEqual([]);
  expect((await refusal(chromes.act(ada, { kind: "read" }))).code).toBe("not_allowed");
  await chromes.act(ada, { kind: "open", url: "https://shop.example/orders" });
  expect(chrome.log.filter((e) => e.method === "Target.createTarget")).toHaveLength(2);
  onlyItsOwnTabs(chrome);
});

test("the consent ends at its time: the agent is refused and the session is gone", async () => {
  const { chrome, chromes, later, lines } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 10 });
  later(10 * 60_000 + 1);
  const err = await refusal(chromes.act(ada, { kind: "open", url: "https://shop.example/orders" }));
  expect(err.code).toBe("not_allowed");
  expect(chromes.list()).toEqual([]);
  expect(chrome.log.filter((e) => e.method === "Target.createTarget")).toHaveLength(0);
  expect(lines.at(-1)).toContain("ended");
});

test("consent is at most 8 hours long", async () => {
  const { chrome, chromes } = setup();
  const err = await refusal(chromes.connect({ agent: ada, port: chrome.port, minutes: 8 * 60 + 1 }));
  expect(err.code).toBe("bad_request");
});

test("quitting Chrome ends the session", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  chrome.quit();
  await Bun.sleep(50);
  expect(chromes.list()).toEqual([]);
});

test("disconnect ends one agent's session and leaves its tabs to the person", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  await chromes.act(ada, { kind: "open", url: "https://shop.example/orders" });
  expect(chromes.disconnect("agent-ada")).toBe(1);
  expect(chromes.list()).toEqual([]);
  expect(chrome.targets.has("agent-tab-1")).toBe(true);
  expect(chromes.disconnect("agent-ada")).toBe(0);
});

// ── Through the runner's request handler (protocol 82) ───────────────────────────────────────────────────────────

const scope = { signal: new AbortController().signal, output: () => {} };

function context(chromes: MyChromes, extra: Partial<HandlerContext> = {}): HandlerContext {
  return { workspaceReal: "/nowhere", exec: false, token: "t", myChrome: chromes, ...extra };
}

test("the server lists, acts and disconnects; it has no way to connect", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  const act: MachineRequest = {
    op: "mychrome.act",
    agent: ada,
    action: { kind: "open", url: "https://shop.example/orders" },
    allowedDomains: ["shop.example"],
  };
  expect(await handleRequest(context(chromes), act, scope)).toEqual({
    url: "https://shop.example/orders",
    title: "Your orders",
  });
  expect(await handleRequest(context(chromes), { op: "mychrome.list" }, scope)).toEqual({
    sessions: [expect.objectContaining({ agentId: "agent-ada" })],
  });
  expect(await handleRequest(context(chromes), { op: "mychrome.disconnect", agentId: "agent-ada" }, scope)).toEqual({
    disconnected: 1,
  });
  const connect = { op: "mychrome.connect", agent: ada, port: chrome.port } as unknown as MachineRequest;
  await expect(handleRequest(context(chromes), connect, scope)).rejects.toThrow();
});

test("a paused computer refuses the agent's actions but still lets it be disconnected", async () => {
  const { chrome, chromes } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  const ctx = context(chromes, { paused: () => true });
  const act: MachineRequest = { op: "mychrome.act", agent: ada, action: { kind: "read" } };
  await expect(handleRequest(ctx, act, scope)).rejects.toMatchObject({ code: "paused" });
  expect(await handleRequest(ctx, { op: "mychrome.disconnect" }, scope)).toEqual({ disconnected: 1 });
});

test("a system-mode runner refuses every op of the person's Chrome", async () => {
  const { chromes } = setup();
  const ctx = context(chromes, { systemMode: () => true });
  for (const req of [
    { op: "mychrome.list" },
    { op: "mychrome.disconnect" },
    { op: "mychrome.act", agent: ada, action: { kind: "read" } },
  ] satisfies MachineRequest[]) {
    await expect(handleRequest(ctx, req, scope)).rejects.toMatchObject({ code: "not_allowed" });
  }
});

test("a runner without the person's Chrome answers unsupported", async () => {
  const ctx: HandlerContext = { workspaceReal: "/nowhere", exec: false, token: "t" };
  await expect(handleRequest(ctx, { op: "mychrome.list" }, scope)).rejects.toMatchObject({ code: "unsupported" });
});

test("a wrong port leaves the agent's good session as it was", async () => {
  const { chrome, chromes, lines } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  const other = new FakeChrome();
  other.wsUrl = `ws://127.0.0.1:${other.port}/devtools/page/person-tab`;
  try {
    expect((await refusal(chromes.connect({ agent: ada, port: other.port, minutes: 5 }))).code).toBe(
      "browser_unavailable",
    );
  } finally {
    other.stop();
  }
  expect(chromes.list()).toEqual([expect.objectContaining({ agentId: "agent-ada", port: chrome.port })]);
  expect(lines).toEqual([`Your Chrome: connected on port ${chrome.port} for 5 min`]);
});

test("two agents lent the same Chrome at once: one gets it, the other is refused", async () => {
  const { chrome, chromes } = setup();
  const both = await Promise.allSettled([
    chromes.connect({ agent: ada, port: chrome.port, minutes: 5 }),
    chromes.connect({ agent: bea, port: chrome.port, minutes: 5 }),
  ]);
  expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(both.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(chromes.list()).toHaveLength(1);
});

// ── The guard (ADR 0202 addendum): no agent runs its own programs as the person while their Chrome is lent ────

test("lending is refused while an agent may run its own programs here, and nothing is dialed", async () => {
  let why: string | null = "Commands are on";
  const { chrome, chromes, changes } = setup({ guard: () => why });
  const err = await refusal(chromes.connect({ agent: ada, port: chrome.port, minutes: 5 }));
  expect(err.code).toBe("not_allowed");
  expect(err.message).toBe("Commands are on");
  expect(chrome.log).toHaveLength(0);
  expect(changes).toEqual([]);
  why = null;
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  expect(chromes.list()).toHaveLength(1);
});

test("who holds it is told on every change: lent, replaced, ended", async () => {
  const { chrome, chromes, changes, later } = setup();
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 10 });
  expect(changes.at(-1)).toEqual([{ agentId: "agent-ada", expiresAt: "2026-11-15T12:10:00.000Z" }]);
  chromes.disconnect("agent-ada");
  expect(changes.at(-1)).toEqual([]);
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 10 });
  later(10 * 60_000 + 1);
  expect(chromes.lent()).toEqual([]);
  expect(changes.at(-1)).toEqual([]);
});

test("the lent Chrome's debugging port is off limits to the agents' own browsers, on every loopback spelling", async () => {
  const { chrome, chromes } = setup();
  expect(chromes.lentPorts()).toEqual(new Set());
  await chromes.connect({ agent: ada, port: chrome.port, minutes: 5 });
  const ports = chromes.lentPorts();
  expect(ports).toEqual(new Set([chrome.port]));
  for (const url of [
    `http://127.0.0.1:${chrome.port}/json/list`,
    `http://localhost:${chrome.port}/json`,
    `http://127.1.2.3:${chrome.port}/`,
    `http://[::1]:${chrome.port}/json/version`,
    `http://0.0.0.0:${chrome.port}/json`,
    `ws://127.0.0.1:${chrome.port}/devtools/browser/x`,
    `http://LOCALHOST.:${chrome.port}/json`,
  ]) {
    expect(reachesLentChrome(url, ports)).toBe(true);
  }
  for (const url of [
    `http://127.0.0.1:${chrome.port + 1}/json`,
    `https://example.com:${chrome.port}/`,
    "https://shop.example/orders",
    "about:blank",
    "not a url",
  ]) {
    expect(reachesLentChrome(url, ports)).toBe(false);
  }
});

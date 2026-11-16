import { expect, test } from "bun:test";
import type { ActivityEntry, ControlEvent } from "@agenteschat/adapters/runner-control";
import { HostConsent, windowsHost } from "../../runner/host-desktop";
import { errorCode, waitFor } from "./helpers";

const DEV = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev", name: "Dev" };
const OPS = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001", handle: "ops", name: "Ops" };

function consent(over: { listening?: boolean; askMs?: number; sessionMs?: number } = {}) {
  const events: ControlEvent[] = [];
  const lines: Omit<ActivityEntry, "at">[] = [];
  const released: (string | undefined)[] = [];
  let clock = 1_000_000;
  const c = new HostConsent({
    emit: (e) => events.push(e),
    listening: () => over.listening ?? true,
    record: (e) => lines.push(e),
    release: (id) => released.push(id),
    now: () => clock,
    ...(over.askMs !== undefined ? { askMs: over.askMs } : {}),
    ...(over.sessionMs !== undefined ? { sessionMs: over.sessionMs } : {}),
  });
  const asked = () => events.flatMap((e) => (e.kind === "screen.requested" ? [e.request] : []));
  return {
    c,
    events,
    lines,
    released,
    asked,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

test("an agent holds the person's screen only after their yes here, for one session, and Stop ends it", async () => {
  const t = consent();
  const first = t.c.require(DEV);
  await waitFor(() => t.asked().length === 1);
  const request = t.asked()[0];
  expect(request).toMatchObject({ agent: { id: DEV.id, name: "Dev" } });
  // Asking again while the person decides is the same ask, not a second card.
  const again = t.c.require(DEV);
  expect(t.asked()).toHaveLength(1);
  expect(t.c.screen().requests).toHaveLength(1);

  const screen = t.c.answer(request?.requestId ?? "", "granted");
  expect(screen.session).toMatchObject({ agent: { id: DEV.id, name: "Dev" } });
  // Both waiters go on; the yes is new, so the helper forgets the click on Allow.
  expect(await first).toBe(true);
  expect(await again).toBe(true);
  // Inside the session: no ask, and nothing to forget.
  expect(await t.c.require(DEV)).toBe(false);
  expect(t.asked()).toHaveLength(1);

  // Another agent can't take the screen while one holds it.
  expect(await errorCode(() => t.c.require(OPS))).toBe("not_allowed");

  t.c.stop("person");
  expect(t.c.screen()).toEqual({ session: null, requests: [] });
  expect(t.released).toEqual([DEV.id]);
  expect(t.lines.map((l) => [l.kind, l.said?.key, l.result])).toEqual([
    ["screen", "screenAsked", "running"],
    ["screen", "screenOn", "ok"],
    ["screen", "screenStopped", "ok"],
  ]);
  // After Stop the next use asks again.
  void t.c.require(DEV).catch(() => undefined);
  await waitFor(() => t.asked().length === 2);
});

test("no, no answer in time, or nobody at the computer: refused, and the agent is told not to insist", async () => {
  const t = consent();
  const denied = errorCode(() => t.c.require(DEV));
  await waitFor(() => t.asked().length === 1);
  t.c.answer(t.asked()[0]?.requestId ?? "", "denied");
  expect(await denied).toBe("not_allowed");
  expect(t.events.find((e) => e.kind === "screen.resolved")).toMatchObject({ decision: "denied" });
  expect(t.c.screen().session).toBeNull();

  const slow = consent({ askMs: 20 });
  expect(await errorCode(() => slow.c.require(DEV))).toBe("not_allowed");
  expect(slow.events.find((e) => e.kind === "screen.resolved")).toMatchObject({ decision: "expired" });
  expect(slow.lines.at(-1)).toMatchObject({ said: { key: "screenExpired" }, result: "refused" });

  // A runner without the app (started from a terminal) has nobody to ask: refused at once, no ask kept.
  const alone = consent({ listening: false });
  expect(await errorCode(() => alone.c.require(DEV))).toBe("not_allowed");
  expect(alone.asked()).toHaveLength(0);

  // An answer to an ask that is gone, or that isn't yes or no, changes nothing.
  expect(await errorCode(() => t.c.answer("nope", "granted"))).toBe("not_found");
  expect(await errorCode(() => t.c.answer("nope", "maybe" as "granted"))).toBe("bad_request");
});

test("a session ends by itself after its time, and the switch going off ends it and any ask", async () => {
  const t = consent({ sessionMs: 60_000 });
  const p = t.c.require(DEV);
  await waitFor(() => t.asked().length === 1);
  t.c.answer(t.asked()[0]?.requestId ?? "", "granted");
  await p;
  t.tick(60_001);
  expect(t.c.screen().session).toBeNull();
  expect(t.released).toEqual([DEV.id]);
  expect(t.lines.at(-1)).toMatchObject({ said: { key: "screenEnded" } });

  const asking = errorCode(() => t.c.require(OPS));
  await waitFor(() => t.asked().length === 2);
  t.c.stop("switch");
  expect(await asking).toBe("not_allowed");
  expect(t.c.screen().requests).toEqual([]);
});

test("the Windows helper's dialect: Windows only, never in system mode, and a dry helper must say it is dry", () => {
  expect(windowsHost({ platform: "linux" }).info()).toMatchObject({ available: false, code: "host_desktop_windows" });
  expect(windowsHost({ platform: "win32", system: true }).info()).toMatchObject({
    available: false,
    code: "host_desktop_system",
  });
  expect(windowsHost({ platform: "win32" }).info()).toEqual({ available: true });
  const dry = windowsHost({ platform: "win32", dry: true });
  expect(() => dry.reply("hello", { dry: false, a11y: true, screen: [10, 10], missing: [] })).toThrow();
  // The lock screen reads as a desktop that can't be read.
  expect(dry.reply("hello", { dry: true, locked: true, a11y: true, screen: [10, 10], missing: [] })).toMatchObject({
    a11y: false,
    problem: "the screen is locked",
  });
  // A helper that can't see the person's own mouse and keys (its hooks refused, by an antivirus or a policy) serves
  // nothing: the stop on their input is a guard, not a nicety.
  const real = windowsHost({ platform: "win32" });
  const blind = real.reply("hello", { dry: false, watching: false, a11y: true, screen: [10, 10], missing: [] });
  expect(blind).toMatchObject({ screen: null, a11y: false });
  expect((blind as { problem: string }).problem).toMatch(/mouse or keyboard/);
  expect(real.reply("hello", { dry: false, watching: true, a11y: true, screen: [10, 10], missing: [] })).toMatchObject({
    screen: [10, 10],
    a11y: true,
  });
  // Key names become virtual-key chords; one Windows has no key for is refused before anything is sent.
  expect(dry.request("input", { steps: [{ key: "ctrl+s" }] })).toEqual({ steps: [{ keys: [0x11, 0x53] }] });
  expect(() => dry.request("input", { steps: [{ key: "ctrl+XF86Eject" }] })).toThrow();
  // The helper's environment keeps Windows' own folders, never the runner's secrets.
  process.env.AGENTES_TEST_SECRET = "s3cr3t";
  expect(Object.values(dry.env())).not.toContain("s3cr3t");
  delete process.env.AGENTES_TEST_SECRET;
});

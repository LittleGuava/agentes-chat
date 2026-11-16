import { afterEach, beforeEach, expect, test } from "bun:test";
import { createLogger } from "../src/logger";
import { createRealtime, type SocketData } from "../src/realtime/ws";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

/** Who has a conversation open (ADR 0084 addendum 2026-11-15): the people subscribed to it, hidden ones left out. */

let t: TestServer;
let server: ReturnType<typeof listen>;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  server = listen(t);
});
afterEach(async () => {
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
});

type Frame = Record<string, unknown>;

/** A person's realtime socket that collects frames. */
async function open(b: Browser, orgId: string, port = server.port) {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?orgId=${orgId}`, {
    headers: { origin: ORIGIN, cookie: b.cookie() },
  } as unknown as string[]);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Frame);
  const next = async (pred: (f: Frame) => boolean, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const i = frames.findIndex(pred);
      if (i >= 0) return frames.splice(i, 1)[0] as Frame;
      await Bun.sleep(10);
    }
    throw new Error(`timeout; frames: ${JSON.stringify(frames)}`);
  };
  await next((f) => f.type === "ready");
  const subscribe = async (channelId: string) => {
    ws.send(JSON.stringify({ type: "subscribe", channelId }));
    await next((f) => f.type === "subscribed" && f.channelId === channelId);
  };
  const closed = () =>
    new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
      ws.close();
    });
  return { ws, frames, next, subscribe, closed, send: (f: unknown) => ws.send(JSON.stringify(f)) };
}

const viewersEvent = (channelId: string) => (f: Frame) =>
  f.type === "event" && f.channelId === channelId && (f.event as Frame).type === "channel.viewers";

async function viewers(b: Browser, orgId: string, channelId: string) {
  const res = await b(`/api/app/organizations/${orgId}/channels/${channelId}/viewers`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { viewers: string[] }).viewers;
}

async function meId(b: Browser) {
  return ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
}

async function setup() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  return { owner, ana, orgId, channelId, anaId: await meId(ana), ownerId: await meId(owner) };
}

test("opening a conversation shows the person to the others there, live, and closing it takes them off", async () => {
  const { owner, ana, orgId, channelId, anaId, ownerId } = await setup();
  const o = await open(owner, orgId);
  await o.subscribe(channelId);
  // Nobody else is there yet, and you never see yourself.
  expect(await viewers(owner, orgId, channelId)).toEqual([]);

  const a = await open(ana, orgId);
  await a.subscribe(channelId);
  // Ids only: who is there is read over HTTP, where the hidden are left out.
  expect((await o.next(viewersEvent(channelId))).event).toEqual({ type: "channel.viewers", channelId, userId: anaId });
  expect(await viewers(owner, orgId, channelId)).toEqual([anaId]);
  expect(await viewers(ana, orgId, channelId)).toEqual([ownerId]);
  // Nobody hears news of themselves: Ana's own socket got none for her opening it, nor for the owner's before her.
  await Bun.sleep(100);
  expect(a.frames.filter(viewersEvent(channelId))).toEqual([]);

  // A second tab of Ana's changes nothing; closing one of two keeps her there.
  const a2 = await open(ana, orgId);
  await a2.subscribe(channelId);
  await a2.closed();
  expect(await viewers(owner, orgId, channelId)).toEqual([anaId]);

  a.send({ type: "unsubscribe", channelId });
  await o.next(viewersEvent(channelId));
  expect(await viewers(owner, orgId, channelId)).toEqual([]);

  await a.subscribe(channelId);
  await o.next(viewersEvent(channelId));
  await a.closed();
  await o.next(viewersEvent(channelId));
  expect(await viewers(owner, orgId, channelId)).toEqual([]);
  await o.closed();
});

test("a hidden person never shows as having it open, and their coming and going is no news", async () => {
  const { owner, ana, orgId, channelId, anaId } = await setup();
  const hide = await ana(`/api/app/organizations/${orgId}/me/status`, {
    method: "PUT",
    json: { availability: "hidden" },
  });
  expect(hide.status).toBe(200);
  const o = await open(owner, orgId);
  await o.subscribe(channelId);

  const a = await open(ana, orgId);
  await a.subscribe(channelId);
  expect(await viewers(owner, orgId, channelId)).toEqual([]);

  // Back to auto while it is open: the list shows her (the apps read it again on `member.status`).
  const shown = await ana(`/api/app/organizations/${orgId}/me/status`, {
    method: "PUT",
    json: { availability: "auto" },
  });
  expect(shown.status).toBe(200);
  expect(await viewers(owner, orgId, channelId)).toEqual([anaId]);
  // Her subscription while hidden sent nothing.
  await Bun.sleep(100);
  expect(o.frames.filter(viewersEvent(channelId))).toEqual([]);
  await a.closed();
  await o.closed();
});

/** `db` whose queries settle `ms` later while `slow()` says so, as over a network (PGlite answers at once). */
function slowWhen<T extends object>(target: T, slow: () => boolean, ms: number): T {
  return new Proxy(target, {
    get(obj, key) {
      const value = Reflect.get(obj, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "then") {
        return (ok: (v: unknown) => void, fail: (e: unknown) => void) =>
          (slow() ? Bun.sleep(ms) : Promise.resolve()).then(() => value.call(obj, ok, fail));
      }
      return (...args: unknown[]) => {
        const out = value.apply(obj, args) as unknown;
        return out !== null && typeof out === "object" ? slowWhen(out, slow, ms) : out;
      };
    },
  });
}

test("a socket closed while its subscription is being checked leaves nobody behind", async () => {
  const { ana, orgId, channelId } = await setup();
  let slow = false;
  const realtime = createRealtime({
    db: slowWhen(t.db, () => slow, 150),
    auth: t.auth,
    config: t.config,
    log: createLogger("error"),
    ...t.adapters,
  });
  const lagging = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => realtime.fetch(req, srv, (r) => t.app.fetch(r)),
    websocket: realtime.websocket,
  });
  try {
    const a = await open(ana, orgId, lagging.port);
    // The subscription's check takes a while; the tab closes meanwhile.
    slow = true;
    a.send({ type: "subscribe", channelId });
    await Bun.sleep(20);
    await a.closed();
    await Bun.sleep(800);
    expect(await t.adapters.presence.viewers(orgId, channelId)).toEqual([]);
  } finally {
    slow = false;
    await Promise.race([lagging.stop(true), Bun.sleep(500)]);
  }
});

test("only who reads the conversation may ask who has it open", async () => {
  const { owner, ana, orgId } = await setup();
  const priv = (await (
    await owner(`/api/app/organizations/${orgId}/channels`, { json: { name: "secret", visibility: "private" } })
  ).json()) as { id: string };
  const res = await ana(`/api/app/organizations/${orgId}/channels/${priv.id}/viewers`);
  expect(res.status).toBe(403);
  const outsider = browser(t);
  await signUp(outsider, "eve@example.com");
  expect((await outsider(`/api/app/organizations/${orgId}/channels/${priv.id}/viewers`)).status).toBe(403);
});

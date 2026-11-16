import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeMeetingPiece,
  type MachineRequest,
  MEETING_PROTOCOL,
  type SpeechEngine,
  type SpeechFileInput,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  agentMeetingAudioStatus,
  createChannel,
  createMeetingAudio,
  createMeetingToolSource,
  createToolGateway,
  grantScopes,
  JOIN_MEETING_TOOL,
  LEAVE_MEETING_TOOL,
  type MachineCaller,
  type ToolContext,
} from "../src";
import { noticeText } from "../src/notices";
import { fakeHub } from "./desktop-fixtures";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { IN_CALL, IN_CALL_NO_CHAT, LOBBY, meetPage, PREJOIN, personRun, planner } from "./meeting-fixtures";

/**
 * ADR 0199 §4–§6: the workspace's switch, a computer that can hear the call and a speech engine before the tool is
 * offered; the people in the call told before anything is captured (no line, no capture); what the computer hears
 * made into words on the server, in order; and leaving, by a person or by the agent, always ends in the notes.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const STREAM = "S".repeat(43);

/** A speech engine that says what it was given to say, piece by piece, the first answer slower than the second. */
function fakeSpeech(words: string[]) {
  const heard: SpeechFileInput[] = [];
  const engine: SpeechEngine = {
    id: "openai",
    model: "fake",
    nanoUsdPerHour: 360_000_000_000,
    minBilledSeconds: 1,
    async file(input) {
      const i = heard.length;
      heard.push(input);
      if (i === 0) await new Promise((r) => setTimeout(r, 30));
      return { text: words[i] ?? "" };
    },
  };
  return { engine, heard };
}

async function meetingSetup(
  opts: { notes?: boolean; engines?: SpeechEngine[]; page?: ReturnType<typeof meetPage>; log?: string[] } = {},
) {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Box" });
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  const fake = fakeHub({ machineId: paired.machineId, orgId: f.org.id });
  fake.s.status = {
    protocol: MEETING_PROTOCOL,
    executors: { meetingAudio: { available: true } },
    access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true } },
  };
  const log = opts.log ?? [];
  fake.s.respond = (r: MachineRequest) => {
    log.push(r.op);
    if (r.op === "meeting.listen") return { listening: true };
    if (r.op === "meeting.stop") return { stopped: true };
    if (r.op === "browser.stop") return { stopped: true };
    return undefined;
  };
  if (opts.notes !== false) {
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, meetingNotes: true })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { meetingNotes: true } });
  }
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "browser:use" }]);
  const speech = fakeSpeech(["Ship it on Friday.", "I'll write the changelog."]);
  const engines = opts.engines ?? [speech.engine];
  const page = opts.page ?? meetPage(PREJOIN, LOBBY, IN_CALL, log);
  const browser = planner(page);
  const hub: MachineCaller = fake.hub;
  const audio = createMeetingAudio({
    db: f.db,
    pubsub: f.pubsub,
    hub,
    speech: () => engines,
    browser: browser.plan,
    newStreamId: () => STREAM,
    drainMs: 50,
  });
  const gateway = createToolGateway({
    sources: [createMeetingToolSource({ browser: browser.plan, listener: audio.listener, leave: audio.leave })],
  });
  const invoke = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
    const r = await gateway.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
    if (r.type !== "result") throw new Error(`expected a result, got ${r.type}`);
    return r.output;
  };
  const join = (ctx: ToolContext) => invoke(ctx, JOIN_MEETING_TOOL, { url: "https://meet.google.com/abc-defg-hij" });
  return { fake, paired, audio, gateway, join, invoke, page, browser, speech, log };
}

const meetings = (fx: Fixture) =>
  fx.db.select().from(schema.agentMeetings).where(eq(schema.agentMeetings.orgId, fx.org.id));
const piece = (seq: number, startMs: number) =>
  encodeMeetingPiece({ seq, startMs, ms: 4000 }, new Uint8Array([82, 73, 70, 70, seq]));
const socket = { send: () => undefined, close: () => undefined, buffered: () => 0 };

async function noticesOf(fx: Fixture, kind: string) {
  const rows = await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id));
  return rows.filter((m) => (m.meta as { notice?: { kind?: string } } | null)?.notice?.kind === kind);
}

describe("when the tool is offered", () => {
  test("only with the workspace's switch on, a computer that can hear the call and a speech engine", async () => {
    const names = async (gateway: ReturnType<typeof createToolGateway>, ctx: ToolContext) =>
      (await gateway.list(ctx)).map((t) => t.name).filter((n) => n.includes("meeting"));

    const on = await meetingSetup();
    expect(await names(on.gateway, await personRun(f))).toEqual([JOIN_MEETING_TOOL, "leave_meeting"]);
    await f.close();

    const off = await meetingSetup({ notes: false });
    expect(await names(off.gateway, await personRun(f))).toEqual([]);
    await f.close();

    const mute = await meetingSetup({ engines: [] });
    expect(await names(mute.gateway, await personRun(f))).toEqual([]);
    await f.close();

    const old = await meetingSetup();
    old.fake.s.status = { ...old.fake.s.status, protocol: MEETING_PROTOCOL - 1 };
    expect(await names(old.gateway, await personRun(f))).toEqual([]);
    expect(await agentMeetingAudioStatus(f.db, old.fake.hub, f.org.id, f.agent.id)).toMatchObject({
      available: false,
      code: "outdated",
    });
    old.fake.s.status = {
      ...old.fake.s.status,
      protocol: MEETING_PROTOCOL,
      executors: { meetingAudio: { available: false, reason: "Install pactl" } },
    };
    expect(await names(old.gateway, await personRun(f))).toEqual([]);
    expect(await agentMeetingAudioStatus(f.db, old.fake.hub, f.org.id, f.agent.id)).toMatchObject({
      code: "not_ready",
      detail: "Install pactl",
    });
  });

  test("an agent still in a meeting keeps its way out after the switch goes off", async () => {
    const t = await meetingSetup();
    const run = await personRun(f);
    expect((await t.join(run)).isError).toBeUndefined();
    await f.db
      .update(schema.organizationSettings)
      .set({ meetingNotes: false })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    const listed = (await t.gateway.list(run)).map((x) => x.name).filter((n) => n.includes("meeting"));
    expect(listed).toEqual(["leave_meeting"]);
    const out = await t.invoke(run, "leave_meeting", {});
    expect(out.isError).toBeUndefined();
    expect((await meetings(f))[0]?.status).toBe("ended");
  });
});

describe("joining and telling the people", () => {
  test("let in from the lobby, it tells the meeting's chat first and only then starts hearing", async () => {
    const t = await meetingSetup();
    const out = await t.join(await personRun(f));
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("You are in the Google Meet meeting");
    // The line went to the chat before the computer was asked to hear anything.
    expect(t.log.filter((x) => x === "chat" || x === "meeting.listen")).toEqual(["chat", "meeting.listen"]);
    const [line] = t.page.sent;
    expect(line).toContain(`${f.agent.name} (notes)`);
    expect(line).toContain("agentes.chat");
    expect(line).toContain(f.owner.name);
    const listen = t.fake.calls.find((c) => c.op === "meeting.listen");
    expect(listen).toMatchObject({ op: "meeting.listen", streamId: STREAM });
    const [row] = await meetings(f);
    expect(row).toMatchObject({ status: "in_call", machineId: t.paired.machineId });
    expect(listen && "meetingId" in listen ? listen.meetingId : null).toBe(row?.id ?? "?");
    // The conversation gets a line with the way out, which wakes nobody.
    const [joined] = await noticesOf(f, "meeting_joined");
    expect(joined?.meta).toMatchObject({ notice: { refs: { meetingId: row?.id } } });
    const woke = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.triggerMessageId, joined?.id ?? ""));
    expect(woke).toEqual([]);
  });

  test("a chat it can't write in: it leaves without hearing anything", async () => {
    const log: string[] = [];
    const t = await meetingSetup({ page: meetPage(PREJOIN, LOBBY, IN_CALL_NO_CHAT, log), log });
    const out = await t.join(await personRun(f));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("couldn't tell the people in the call");
    expect(t.fake.calls.some((c) => c.op === "meeting.listen")).toBe(false);
    expect(t.fake.calls.some((c) => c.op === "browser.stop")).toBe(true);
    expect((await meetings(f)).map((m) => [m.status, m.error])).toEqual([["failed", "not_announced"]]);
  });

  test("never let in: it leaves after the wait, without hearing anything", async () => {
    const log: string[] = [];
    const t = await meetingSetup({ page: meetPage(PREJOIN, LOBBY, null, log), log });
    const audio = createMeetingAudio({
      db: f.db,
      pubsub: f.pubsub,
      hub: t.fake.hub,
      speech: () => [t.speech.engine],
      browser: t.browser.plan,
      newStreamId: () => STREAM,
      lobbySeconds: 1,
    });
    const gateway = createToolGateway({
      sources: [createMeetingToolSource({ browser: t.browser.plan, listener: audio.listener, leave: audio.leave })],
    });
    const r = await gateway.invoke(await personRun(f), {
      toolUseId: "tu_lobby",
      name: JOIN_MEETING_TOOL,
      input: { url: "https://meet.google.com/abc-defg-hij" },
    });
    const out = r.type === "result" ? r.output : null;
    expect(out?.isError).toBe(true);
    expect(out?.content).toContain("nobody let you in");
    expect(t.page.sent).toEqual([]);
    expect(t.fake.calls.some((c) => c.op === "meeting.listen")).toBe(false);
    expect((await meetings(f)).map((m) => m.error)).toEqual(["not_admitted"]);
  });
});

describe("what the computer hears", () => {
  test("its pieces become words in order; the end delivers the transcript and the bot leaves the call", async () => {
    const t = await meetingSetup();
    await t.join(await personRun(f));
    expect(t.audio.claim(STREAM, crypto.randomUUID(), socket)).toBeNull();
    const claimed = t.audio.claim(STREAM, t.paired.machineId, socket);
    expect(claimed).not.toBeNull();
    // Served once.
    expect(t.audio.claim(STREAM, t.paired.machineId, socket)).toBeNull();
    claimed?.data(piece(0, 0));
    claimed?.data(piece(1, 30_000));
    claimed?.data(JSON.stringify({ type: "meeting.end", reason: "silence" }));
    claimed?.closed(1000);
    await t.audio.settled();

    expect(t.speech.heard.map((h) => h.contentType)).toEqual(["audio/wav", "audio/wav"]);
    const [row] = await meetings(f);
    expect(row?.status).toBe("ended");
    expect(row?.transcript.map((l) => l.text)).toEqual(["Ship it on Friday.", "I'll write the changelog."]);
    expect(row?.costNanoUsd).toBeGreaterThan(0);
    const [ended] = await noticesOf(f, "meeting_ended");
    // Nobody is named: the computer hears the call, not who speaks.
    expect(ended?.body).toBe("Meeting ended (Google Meet, 1 min). Notes follow.");
    const read = noticeText(ended?.meta as Record<string, unknown>, true) ?? "";
    expect(read).toContain("[00:00] Ship it on Friday.");
    expect(read).toContain("[00:30] I'll write the changelog.");
    expect(read).toContain("ended early");
    // It doesn't sit silent in the call it no longer hears.
    expect(t.fake.calls.at(-1)?.op).toBe("browser.stop");
  });

  test("a socket that drops without its last word still ends in the notes", async () => {
    const t = await meetingSetup();
    await t.join(await personRun(f));
    const claimed = t.audio.claim(STREAM, t.paired.machineId, socket);
    claimed?.data(piece(0, 0));
    claimed?.closed();
    await t.audio.settled();
    const [row] = await meetings(f);
    expect(row?.status).toBe("ended");
    expect((await noticesOf(f, "meeting_ended")).length).toBe(1);
  });
});

describe("leaving", () => {
  test("a person's Leave stops the capture, closes the browser and delivers what was heard; once", async () => {
    const t = await meetingSetup();
    await t.join(await personRun(f));
    const claimed = t.audio.claim(STREAM, t.paired.machineId, socket);
    claimed?.data(piece(0, 0));
    await t.audio.settled();
    const [live] = await meetings(f);
    expect(await t.audio.leave({ orgId: f.org.id, meetingId: live?.id ?? "" })).toEqual({ left: true });
    const ops = t.fake.calls.map((c) => c.op);
    expect(ops.indexOf("meeting.stop")).toBeGreaterThan(-1);
    expect(ops.indexOf("browser.stop")).toBeGreaterThan(ops.indexOf("meeting.stop"));
    const [row] = await meetings(f);
    expect(row?.status).toBe("ended");
    const [ended] = await noticesOf(f, "meeting_ended");
    expect(noticeText(ended?.meta as Record<string, unknown>, true)).toContain("Ship it on Friday.");
    expect(await t.audio.leave({ orgId: f.org.id, meetingId: live?.id ?? "" })).toEqual({ left: false });
  });

  test("leave_meeting: the agent leaves its own meeting, and says so when it is in none", async () => {
    const t = await meetingSetup();
    const ctx = await personRun(f);
    await t.join(ctx);
    const out = await t.invoke(ctx, LEAVE_MEETING_TOOL, {});
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("You left");
    expect((await meetings(f)).map((m) => m.status)).toEqual(["ended"]);
    const again = await t.invoke(ctx, LEAVE_MEETING_TOOL, {});
    expect(again.isError).toBe(true);
    expect(again.content).toContain("not in a meeting");
  });

  test("another workspace's meeting is none of its business", async () => {
    const t = await meetingSetup();
    await t.join(await personRun(f));
    const [live] = await meetings(f);
    expect(await t.audio.leave({ orgId: crypto.randomUUID(), meetingId: live?.id ?? "" })).toEqual({ left: false });
    const [row] = await f.db
      .select()
      .from(schema.agentMeetings)
      .where(and(eq(schema.agentMeetings.id, live?.id ?? "")));
    expect(row?.status).toBe("in_call");
  });
});

describe("Leave from the conversation", () => {
  test("anyone who reads the conversation may make it leave; an ended meeting says so; another's never", async () => {
    const t = await meetingSetup();
    await t.join(await personRun(f));
    const [live] = await meetings(f);
    const meetingId = live?.id ?? "";
    const stranger = await addMember(f.db, f.org.id, "member", "Stranger");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "segredo", visibility: "private" });
    await f.db.update(schema.agentMeetings).set({ channelId: secret.id }).where(eq(schema.agentMeetings.id, meetingId));
    await expect(t.audio.leaveAs(stranger.id, f.org.id, meetingId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await meetings(f))[0]?.status).toBe("in_call");
    await f.db
      .update(schema.agentMeetings)
      .set({ channelId: f.general.id })
      .where(eq(schema.agentMeetings.id, meetingId));
    // Someone in the conversation who didn't send it.
    const member = await addMember(f.db, f.org.id, "member", "Member");
    await f.db.insert(schema.channelMembers).values({ channelId: f.general.id, userId: member.id, orgId: f.org.id });
    await t.audio.leaveAs(member.id, f.org.id, meetingId);
    expect((await meetings(f))[0]?.status).toBe("ended");
    await expect(t.audio.leaveAs(member.id, f.org.id, meetingId)).rejects.toMatchObject({
      code: "meeting.ended",
    });
    await expect(t.audio.leaveAs(f.owner.id, crypto.randomUUID(), meetingId)).rejects.toBeDefined();
  });
});

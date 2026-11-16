import {
  decodeMeetingPiece,
  firstWords,
  MEETING_PROTOCOL,
  type MeetingEndReason,
  type PubSub,
  parseMeetingEnd,
  type SpeechEngine,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import type { BrowserPlanner } from "../browser/tools";
import { requireChannelAccess } from "../channels";
import { deliverNotice, publishDelivery } from "../delivery";
import { ConflictError, NotFoundError } from "../errors";
import type { MachineCaller } from "../machine-hub";
import { REMOVED_COMPUTER_MESSAGE } from "../machines";
import { machineScope, toolMachineId } from "../right-hand-seats";
import type { PlanReport } from "../screen";
import type { ClaimedStream, StreamSocket } from "../streams";
import type { ToolContext } from "../tools/types";
import { hedgeAfterMs, speechCostNanoUsd } from "../voice";
import {
  MEETING_PLATFORM_NAMES,
  type MeetingPlatform,
  meetingAnnouncement,
  meetingAnnounceSteps,
  meetingInCallText,
} from "./links";
import { finishMeeting, LIVE_MEETING, type MeetingLine } from "./notes";
import type { MeetingListener } from "./tool";

type MeetingRow = typeof schema.agentMeetings.$inferSelect;

/** Why an agent's computer can't hear a meeting, as a code (for the app) and a sentence (for the agent). */
export type MeetingAudioUnavailable =
  | "no_machine"
  | "machine_removed"
  | "outdated"
  | "browser_off"
  | "not_ready"
  | "not_reported";

export type AgentMeetingAudioStatus =
  | { available: true; machineId: string; machineName: string; online: boolean }
  | {
      available: false;
      code: MeetingAudioUnavailable;
      machineId: string | null;
      machineName: string | null;
      /** The runner's own reason ("Hearing meetings needs a Linux computer."). */
      detail: string | null;
    };

/**
 * Whether the agent's own computer can hear a meeting its browser is in (ADR 0199 §4): a connected machine on
 * `MEETING_PROTOCOL` or later, its browser switch on, and its runner saying it can (`hello.meetingAudio`: Linux, a
 * pulse server with `pactl` and `parecord`, a single-user runner). Offline machines still count, as for the browser.
 */
export async function agentMeetingAudioStatus(
  db: Database,
  hub: Pick<MachineCaller, "status"> | undefined,
  orgId: string,
  agentId: string,
): Promise<AgentMeetingAudioStatus> {
  const none = (code: MeetingAudioUnavailable, machineId: string | null = null, machineName: string | null = null) => ({
    available: false as const,
    code,
    machineId,
    machineName,
    detail: null,
  });
  const agent = await getAgentCached(db, orgId, agentId);
  const machineId = await toolMachineId(db, agent);
  if (!machineId || !hub) return none("no_machine");
  const status = await hub.status(machineId);
  if (!status || status.orgId !== orgId) return none("machine_removed", machineId);
  if (status.protocol < MEETING_PROTOCOL) return none("outdated", machineId, status.name);
  if (!status.access?.tools.browser) return none("browser_off", machineId, status.name);
  const info = status.executors.meetingAudio;
  if (!info) return none("not_reported", machineId, status.name);
  if (!info.available) {
    return { ...none("not_ready", machineId, status.name), detail: info.reason?.slice(0, 500) ?? null };
  }
  return { available: true, machineId, machineName: status.name, online: status.online };
}

/** One sentence for the agent about a computer that can't hear a meeting. */
export function meetingAudioUnavailableText(s: Extract<AgentMeetingAudioStatus, { available: false }>) {
  const on = s.machineName ? `the computer ${s.machineName}` : "your computer";
  switch (s.code) {
    case "no_machine":
      return "Meetings are heard on a connected computer, and you don't use one.";
    case "machine_removed":
      return REMOVED_COMPUTER_MESSAGE;
    case "outdated":
      return `The runner on ${on} is too old to hear meetings: its owner should update it.`;
    case "browser_off":
      return `The browser is turned off on ${on}.`;
    case "not_ready":
      return `${on.charAt(0).toUpperCase()}${on.slice(1)} can't hear meetings${s.detail ? `: ${s.detail}` : ""}.`;
    default:
      return `${on.charAt(0).toUpperCase()}${on.slice(1)} hasn't said whether it can hear meetings yet.`;
  }
}

/** Whether the workspace turned meeting notes on (ADR 0199 §6): off by default. */
export async function meetingNotesOn(db: Database, orgId: string): Promise<boolean> {
  const [s] = await db
    .select({ on: schema.organizationSettings.meetingNotes })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  return s?.on === true;
}

export interface MeetingAudioDeps {
  db: Database;
  pubsub?: PubSub;
  hub?: Pick<MachineCaller, "status" | "call" | "agentsChanged">;
  /** The speech chain of ADR 0100 (`SpeechSettings.chain`). */
  speech: () => SpeechEngine[];
  /** The browser source's plan: waiting in the lobby and the line in the meeting's chat. */
  browser?: BrowserPlanner;
  /** How long the host has to let the bot in (the plan's longest wait). */
  lobbySeconds?: number;
  newStreamId?: () => string;
  /** How long a Leave waits for the computer's last pieces (tests: shorter). */
  drainMs?: number;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface MeetingAudio {
  listener: MeetingListener;
  /** The broker's `claim` (ADR 0040 §7.1's precedent): the data socket of a meeting this process asked to hear. */
  claim(streamId: string, machineId: string, socket: StreamSocket): ClaimedStream | null;
  /** Ends a live meeting now: the capture stops, the browser closes, the notes come with what was heard. */
  leave(input: { orgId: string; meetingId: string }): Promise<{ left: boolean }>;
  /**
   * A person's "Leave meeting" from the conversation: anyone who reads it may make the agent leave (stopping a
   * recording is never riskier than letting it run). 409 `meeting.ended` once it is over.
   */
  leaveAs(userId: string, orgId: string, meetingId: string): Promise<void>;
  /** Tests: every piece in hand has its words, and every ending finished. */
  settled(): Promise<void>;
}

const LOBBY_SECONDS = 120;
/** How long a Leave waits for the computer's last pieces to come and get their words. */
const DRAIN_MS = 20_000;

const END_WORDS: Record<MeetingEndReason | "lost", string | undefined> = {
  stopped: undefined,
  silence: "no sound for ten minutes",
  max: "four hours, the longest a meeting is heard",
  failed: "the computer stopped hearing it",
  lost: "the computer's connection dropped",
};

interface Capture {
  orgId: string;
  meetingId: string;
  agentId: string;
  machineId: string;
  claimed: boolean;
  /** Pieces get their words one at a time, in order. */
  queue: Promise<void>;
  reason: MeetingEndReason | null;
  done: Promise<void> | null;
  /** Settles once it ended (`end` finished): what a Leave waits on. */
  ended: Promise<void>;
  markEnded: () => void;
}

const randomStreamId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/**
 * Meeting audio on the server (ADR 0199 §4–§5): the listener `join_meeting` hands the meeting to once its steps went
 * through, the data socket the computer sends its pieces on, and leaving. In this process's memory, as a browser's
 * live view is: the computer's socket comes to the replica that asked it; a restart loses the capture, never what
 * was heard (each piece's words are on the row as they come, and Leave delivers them).
 */
export function createMeetingAudio(deps: MeetingAudioDeps): MeetingAudio {
  const { db, hub } = deps;
  const captures = new Map<string, Capture>();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => undefined);
    return p;
  };
  const t = schema.agentMeetings;

  async function scopeOf(meeting: Pick<MeetingRow, "orgId" | "agentId" | "channelId" | "runId">, machineId: string) {
    if (!hub) return null;
    return machineScope(
      hub,
      {
        db,
        orgId: meeting.orgId,
        agentId: meeting.agentId,
        channelId: meeting.channelId,
        ...(meeting.runId ? { runId: meeting.runId } : {}),
      },
      machineId,
    ).catch(() => null);
  }

  /** Closes the agent's browser: the surest way out of a call, whatever page it shows. */
  async function closeBrowser(meeting: MeetingRow, machineId: string | null) {
    if (!hub || !machineId) return;
    const agent = await scopeOf(meeting, machineId);
    if (!agent) return;
    await hub.call<"browser.stop">(machineId, { op: "browser.stop", agent }, { timeoutMs: 30_000 }).catch((e) => {
      deps.log?.warn("meeting: the browser didn't close", { meetingId: meeting.id, error: String(e) });
    });
  }

  async function machineOf(meeting: MeetingRow) {
    if (meeting.machineId) return meeting.machineId;
    return toolMachineId(db, await getAgentCached(db, meeting.orgId, meeting.agentId));
  }

  async function failMeeting(meeting: MeetingRow, error: string) {
    await db
      .update(t)
      .set({ status: "failed", error, endedAt: new Date() })
      .where(and(eq(t.id, meeting.id), inArray(t.status, [...LIVE_MEETING])));
  }

  async function personName(userId: string | null) {
    if (!userId) return null;
    const [u] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
    return u?.name ?? null;
  }

  const ran = (report: PlanReport | null) =>
    !!report && report.stopped === undefined && report.steps.every((s) => s.status === "done");

  async function runSteps(ctx: ToolContext, steps: Parameters<BrowserPlanner>[1]) {
    let report: PlanReport | null = null;
    const out = await deps.browser?.(ctx, steps, {
      own: true,
      onReport: (r) => {
        report = r;
      },
    });
    return !!out && !out.isError && ran(report);
  }

  const listener: MeetingListener = {
    async available(ctx) {
      if (!deps.browser || !hub) return false;
      if (deps.speech().length === 0) return false;
      if (!(await meetingNotesOn(db, ctx.orgId))) return false;
      return (await agentMeetingAudioStatus(db, hub, ctx.orgId, ctx.agentId)).available;
    },

    async listen(meeting, ctx) {
      const status = await agentMeetingAudioStatus(db, hub, meeting.orgId, meeting.agentId);
      if (!status.available || !hub) {
        await closeBrowser(meeting, status.machineId);
        await failMeeting(meeting, "not_heard");
        return { ok: false, text: `you left: ${status.available ? "" : meetingAudioUnavailableText(status)}` };
      }
      const platform = meeting.platform as MeetingPlatform;
      // Let in first: the lobby has no chat to tell anyone in.
      if (meeting.status !== "in_call") {
        const seconds = deps.lobbySeconds ?? LOBBY_SECONDS;
        const admitted = await runSteps(ctx, [{ do: "wait", text: meetingInCallText(platform), seconds }]);
        if (!admitted) {
          await closeBrowser(meeting, status.machineId);
          await failMeeting(meeting, "not_admitted");
          return {
            ok: false,
            text: `nobody let you in within ${Math.round(seconds / 60) || 1} min, so you left. Tell them: they can send you again once the host is there.`,
          };
        }
        await db.update(t).set({ status: "in_call", joinedAt: new Date() }).where(eq(t.id, meeting.id));
      }
      // ADR 0199 §5: the people in the call are told before anything is heard; a line that can't be posted (the chat
      // off, the host blocking it) or that doesn't show means no capture at all.
      const line = meetingAnnouncement(meeting.displayName, await personName(meeting.requestedByUserId));
      const told = await runSteps(ctx, meetingAnnounceSteps(platform, line));
      if (!told) {
        await closeBrowser(meeting, status.machineId);
        await failMeeting(meeting, "not_announced");
        return {
          ok: false,
          text: "you couldn't tell the people in the call that you take notes (its chat is off, or didn't take your line), so you left without hearing anything. Tell them why.",
        };
      }
      const agent = await scopeOf(meeting, status.machineId);
      const streamId = (deps.newStreamId ?? randomStreamId)();
      const capture: Capture = {
        orgId: meeting.orgId,
        meetingId: meeting.id,
        agentId: meeting.agentId,
        machineId: status.machineId,
        claimed: false,
        queue: Promise.resolve(),
        reason: null,
        done: null,
        ended: Promise.resolve(),
        markEnded: () => undefined,
      };
      capture.ended = new Promise<void>((resolve) => {
        capture.markEnded = resolve;
      });
      // Before asking: the computer's socket may come before its answer does.
      captures.set(streamId, capture);
      try {
        if (!agent) throw new Error("no agent on that computer");
        await hub.call<"meeting.listen">(
          status.machineId,
          { op: "meeting.listen", meetingId: meeting.id, streamId, agent },
          { timeoutMs: 30_000 },
        );
      } catch (error) {
        captures.delete(streamId);
        await closeBrowser(meeting, status.machineId);
        await failMeeting(meeting, "not_heard");
        return {
          ok: false,
          text: `your computer couldn't start hearing the call (${error instanceof Error ? error.message : String(error)}), so you left. Tell them.`,
        };
      }
      await db.update(t).set({ machineId: status.machineId }).where(eq(t.id, meeting.id));
      // The conversation's line with the way out ("Leave meeting"); it wakes nobody.
      const delivered = await deliverNotice(db, {
        orgId: meeting.orgId,
        agentId: meeting.agentId,
        channelId: meeting.channelId,
        threadId: meeting.threadId,
        hop: 0,
        stretchId: null,
        wake: false,
        notice: {
          kind: "meeting_joined",
          text: `You are in the ${MEETING_PLATFORM_NAMES[platform]} meeting (${meeting.url}) taking notes; you told its chat. People here can make you leave.`,
          from: MEETING_PLATFORM_NAMES[platform],
          refs: { meetingId: meeting.id, platform, url: meeting.url },
        },
        body: `Taking notes in a ${MEETING_PLATFORM_NAMES[platform]} meeting.`,
      });
      await publishDelivery(deps.pubsub, delivered).catch(() => undefined);
      return { ok: true };
    },
  };

  async function wordsOf(capture: Capture, bytes: Uint8Array) {
    const piece = decodeMeetingPiece(bytes);
    if (!piece) return;
    let words: Awaited<ReturnType<typeof firstWords>> = null;
    try {
      words = await firstWords(
        deps.speech(),
        {
          audio: piece.wav,
          contentType: "audio/wav",
          // Whoever speaks, in whatever language: an engine told the app's language would take it as an order.
          language: null,
          terms: [],
          orgId: capture.orgId,
          durationMs: piece.ms,
        },
        hedgeAfterMs(piece.ms),
      );
    } catch (error) {
      deps.log?.warn("meeting: a piece got no words", { meetingId: capture.meetingId, error: String(error) });
      return;
    }
    const text = words?.text.trim();
    if (!words || !text) return;
    const line: MeetingLine = { speaker: "", atMs: piece.startMs, text };
    await db
      .update(t)
      .set({
        transcript: sql`${t.transcript} || ${JSON.stringify([line])}::jsonb`,
        costNanoUsd: sql`${t.costNanoUsd} + ${speechCostNanoUsd(words.engine, piece.ms)}`,
      })
      .where(and(eq(t.id, capture.meetingId), inArray(t.status, [...LIVE_MEETING])));
  }

  async function transcriptOf(meetingId: string): Promise<MeetingLine[]> {
    const [row] = await db.select({ transcript: t.transcript }).from(t).where(eq(t.id, meetingId));
    return row?.transcript ?? [];
  }

  /** The capture ended: the last words in, the notes delivered, and the bot out of a call it no longer hears. */
  function end(capture: Capture, reason: MeetingEndReason | "lost") {
    capture.done ??= track(
      (async () => {
        await capture.queue.catch(() => undefined);
        for (const [id, c] of captures) if (c === capture) captures.delete(id);
        const [meeting] = await db.select().from(t).where(eq(t.id, capture.meetingId));
        if (!meeting) return;
        const why = END_WORDS[reason];
        await finishMeeting(db, deps.pubsub, {
          orgId: capture.orgId,
          meetingId: capture.meetingId,
          transcript: meeting.transcript,
          ...(why ? { reason: why } : {}),
        });
        if (reason !== "stopped") await closeBrowser(meeting, capture.machineId);
      })().finally(() => capture.markEnded()),
    );
    return capture.done;
  }

  function claim(streamId: string, machineId: string, _socket: StreamSocket): ClaimedStream | null {
    const capture = captures.get(streamId);
    if (!capture || capture.claimed || capture.machineId !== machineId) return null;
    capture.claimed = true;
    return {
      data(data) {
        if (capture.done) return;
        if (typeof data === "string") {
          const said = parseMeetingEnd(data);
          if (said) capture.reason = said.reason;
          return;
        }
        capture.queue = track(capture.queue.then(() => wordsOf(capture, data)));
      },
      closed() {
        void end(capture, capture.reason ?? "lost");
      },
    };
  }

  async function leave(input: { orgId: string; meetingId: string }) {
    const [meeting] = await db
      .select()
      .from(t)
      .where(and(eq(t.orgId, input.orgId), eq(t.id, input.meetingId), inArray(t.status, [...LIVE_MEETING])));
    if (!meeting) return { left: false };
    const machineId = await machineOf(meeting);
    const capture = [...captures.values()].find((c) => c.meetingId === meeting.id);
    let stopped = false;
    if (hub && machineId) {
      const agent = await scopeOf(meeting, machineId);
      // The computer sends what it has left, then its last word: the capture ends here as it does on its own.
      if (agent) {
        const reply = await hub
          .call<"meeting.stop">(machineId, { op: "meeting.stop", meetingId: meeting.id, agent }, { timeoutMs: 30_000 })
          .catch(() => null);
        stopped = reply?.stopped === true;
      }
      await closeBrowser(meeting, machineId);
    }
    if (capture?.claimed && stopped) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        capture.ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deps.drainMs ?? DRAIN_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    await capture?.queue.catch(() => undefined);
    // Whatever happened to the capture (another replica's, lost in a restart, never started), the notes come.
    await finishMeeting(db, deps.pubsub, {
      orgId: meeting.orgId,
      meetingId: meeting.id,
      transcript: await transcriptOf(meeting.id),
    });
    for (const [id, c] of captures) if (c.meetingId === meeting.id) captures.delete(id);
    return { left: true };
  }

  async function leaveAs(userId: string, orgId: string, meetingId: string) {
    const [meeting] = await db
      .select({ channelId: t.channelId, status: t.status })
      .from(t)
      .where(and(eq(t.orgId, orgId), eq(t.id, meetingId)));
    if (!meeting) throw new NotFoundError("Meeting not found", "meeting.not_found");
    await requireChannelAccess(db, userId, orgId, meeting.channelId);
    const { left } = await leave({ orgId, meetingId });
    if (!left) throw new ConflictError("This meeting already ended", "meeting.ended");
  }

  return {
    listener,
    claim,
    leave,
    leaveAs,
    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

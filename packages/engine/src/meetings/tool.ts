import { and, eq, inArray, lt, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import type { BrowserPlanner } from "../browser/tools";
import { BROWSER_SCOPE } from "../browser/types";
import { personBehindCall } from "../requester";
import { replyThreadOf } from "../runs";
import type { PlanReport } from "../screen";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import {
  MEETING_PLATFORM_NAMES,
  meetingDisplayName,
  meetingJoinSteps,
  meetingLinkRefusal,
  meetingStateOf,
  parseMeetingLink,
} from "./links";
import { LIVE_MEETING } from "./notes";

export const JOIN_MEETING_TOOL = "join_meeting";

/** A meeting live longer than this is over: it no longer keeps the agent from another (ADR 0199 §2). */
export const MEETING_MAX_MS = 4 * 60 * 60_000;

type MeetingRow = typeof schema.agentMeetings.$inferSelect;

/**
 * Hears a meeting the agent joined, on its computer (ADR 0199 §4): asked once the bot is waiting or in the call. Its
 * first step tells the meeting's chat a bot takes notes. Without one, `join_meeting` isn't offered: an agent in a
 * call it can't hear would never bring notes.
 */
export interface MeetingListener {
  listen(meeting: MeetingRow, ctx: ToolContext): Promise<{ ok: true } | { ok: false; text: string }>;
}

export interface MeetingToolDeps {
  /** The browser source's plan (`browser_do`'s), run on the agent's own browser. */
  browser?: BrowserPlanner;
  listener?: MeetingListener;
  now?: () => number;
}

const fail = (content: string): ToolOutput => ({ content, isError: true });

/**
 * `join_meeting` (ADR 0199): sends the agent into a Google Meet or Jitsi Meet call from its own browser, as
 * "<name> (notes)" with microphone and camera off, for the person behind the run only. The notes come back to this
 * conversation when the meeting ends (`finishMeeting`).
 */
export function createMeetingToolSource(deps: MeetingToolDeps): ToolSource {
  const now = deps.now ?? Date.now;
  const { browser, listener } = deps;

  async function join(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    if (!browser || !listener) return fail("Joining meetings isn't available on this server.");
    const person = await personBehindCall(ctx);
    if (!person) {
      return fail(
        "Only a person can send you into a meeting, and nobody is behind this run: you didn't join. Say so where you report.",
      );
    }
    const parsed = parseMeetingLink(typeof input.url === "string" ? input.url : "");
    if (!parsed.ok) return fail(meetingLinkRefusal(parsed));
    const { link } = parsed;
    const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
    const displayName = meetingDisplayName(agent?.name ?? "");
    const t = schema.agentMeetings;
    // A meeting left live past the longest one is over: it doesn't keep the agent out of this one.
    await ctx.db
      .update(t)
      .set({ status: "failed", error: "timed_out", endedAt: new Date(now()) })
      .where(
        and(
          eq(t.orgId, ctx.orgId),
          eq(t.agentId, ctx.agentId),
          inArray(t.status, [...LIVE_MEETING]),
          lt(t.createdAt, new Date(now() - MEETING_MAX_MS)),
        ),
      );
    const [meeting] = await ctx.db
      .insert(t)
      .values({
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        channelId: ctx.channelId,
        threadId: replyThreadOf({ threadRootId: ctx.threadRootId, triggerMessageId: ctx.triggerMessageId }),
        runId: ctx.runId || null,
        requestedByUserId: person,
        platform: link.platform,
        url: link.url,
        displayName,
      })
      .onConflictDoNothing()
      .returning();
    if (!meeting) {
      const [live] = await ctx.db
        .select({ url: t.url })
        .from(t)
        .where(and(eq(t.orgId, ctx.orgId), eq(t.agentId, ctx.agentId), inArray(t.status, [...LIVE_MEETING])));
      return fail(
        `You are already in a meeting${live ? ` (${live.url})` : ""}: one at a time. Its notes come here when it ends.`,
      );
    }
    const failed = async (error: string, content: string) => {
      await ctx.db
        .update(t)
        .set({ status: "failed", error, endedAt: new Date(now()) })
        .where(eq(t.id, meeting.id));
      return { content, isError: true, data: { meetingId: meeting.id, status: "failed" } };
    };

    let report: PlanReport | null = null;
    const opened = await browser(ctx, meetingJoinSteps(link, displayName), {
      own: true,
      onReport: (r) => {
        report = r;
      },
    });
    const done = report as PlanReport | null;
    const stopped = !done || done.stopped !== undefined || done.steps.some((s) => s.status !== "done");
    if (opened.isError || stopped) {
      return failed(
        "join_failed",
        `You didn't join: a step on the meeting's page didn't go through, so you stopped before asking to join (never with the microphone on, never under another name).\n${opened.content}`,
      );
    }
    const state = meetingStateOf(done.after ?? null);
    const platform = MEETING_PLATFORM_NAMES[link.platform];
    if (state === "refused") {
      return failed(
        "refused",
        `${platform} refused to let you in ("You can't join this video call"): it often refuses guests from data-centre networks. Tell them; the host can't change it from the call.`,
      );
    }
    await ctx.db
      .update(t)
      .set({ status: state, ...(state === "in_call" ? { joinedAt: new Date(now()) } : {}) })
      .where(eq(t.id, meeting.id));
    const heard = await listener.listen({ ...meeting, status: state }, ctx);
    if (!heard.ok) {
      return failed(
        "not_heard",
        `You joined but can't hear the meeting, so no notes would come: leave it (close its page in your browser) and tell them why: ${heard.text}`,
      );
    }
    const where =
      state === "in_call"
        ? `You are in the ${platform} meeting`
        : `You asked to join the ${platform} meeting; the host must let you in`;
    return {
      content: `${where} as «${displayName}», microphone and camera off. The notes come to this conversation when it ends: tell them in a line, nothing more.`,
      data: { meetingId: meeting.id, status: state, platform: link.platform },
    };
  }

  const tool: ToolDefinition = {
    name: JOIN_MEETING_TOOL,
    description:
      "Join an online meeting to take notes, when a person here asks you to (Google Meet or Jitsi Meet links only; Zoom and Teams aren't supported yet). You join from your own browser as «<your name> (notes)», microphone and camera off, and wait for the host to let you in; the person who asks answers for having you in the call. When it ends, its transcript comes back here and you write the notes.",
    scope: BROWSER_SCOPE,
    // Its answer carries the meeting page's text when a step fails (ADR 0117), as `browser_do`'s does.
    readsOutside: true,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The meeting's link, as the person gave it." } },
      required: ["url"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Join a meeting to take notes" }),
    execute: join,
  };

  return {
    name: "meetings",
    tools: async () => (browser && listener ? [tool] : []),
  };
}

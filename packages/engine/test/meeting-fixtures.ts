import { schema } from "@agenteschat/db";
import {
  type BrowserPlanner,
  createFakeJudge,
  formatPlanReport,
  observeSnapshot,
  postPersonMessage,
  runPlan,
  type ScreenAction,
  type ScreenActOutcome,
  type ScreenStep,
  type ScreenSurface,
  type ToolContext,
} from "../src";
import type { Fixture } from "./fixtures";

/** Google Meet's pages as text (ADR 0199 §3, §5): before joining, the lobby, refused, in the call, its chat. */
export const PREJOIN = `- main
  - heading "Ready to join?" [level=1, ref=e1]
  - textbox "Your name" [ref=e2]
  - button "Turn off microphone" [ref=e3]
  - button "Turn off camera" [ref=e4]
  - button "Ask to join" [ref=e5]`;
export const LOBBY = `- main
  - heading "Asking to be let in…" [level=1, ref=e1]
  - button "Cancel" [ref=e6]`;
export const REFUSED = `- main
  - heading "You can't join this video call" [level=1, ref=e1]
  - button "Return to home screen" [ref=e7]`;
export const IN_CALL = `- main
  - button "Leave call" [ref=e9]
  - button "Chat with everyone" [ref=e10]`;
/** In the call with the chat turned off by the host: no way to tell the people. */
export const IN_CALL_NO_CHAT = `- main
  - button "Leave call" [ref=e9]`;

/** The element an action landed on, by its number. */
export const refOf = (a: ScreenAction) => ("at" in a && "ref" in a.at ? a.at.ref : null);

/**
 * Google Meet's page as text: what each action does to it, every action recorded. "Ask to join" goes to `afterJoin`;
 * a wait in the lobby is let in (`admitted`, or stays in the lobby when null); the chat opens, takes a line and shows
 * it once Enter is pressed.
 */
export function meetPage(start = PREJOIN, afterJoin = LOBBY, admitted: string | null = IN_CALL, log: string[] = []) {
  let text = start;
  let typed = "";
  const sent: string[] = [];
  const actions: ScreenAction[] = [];
  const look = () => observeSnapshot({ text, url: "https://meet.google.com/abc-defg-hij" });
  const surface: ScreenSurface & { actions: ScreenAction[]; sent: string[] } = {
    actions,
    sent,
    async observe() {
      return look();
    },
    async perform(action): Promise<ScreenActOutcome> {
      actions.push(action);
      const ref = refOf(action);
      if (action.kind === "click" && ref === "e5") text = afterJoin;
      else if (action.kind === "pause" && text === LOBBY && admitted) text = admitted;
      else if (action.kind === "click" && ref === "e10") text = `${text}\n  - textbox "Send a message" [ref=e11]`;
      else if (action.kind === "fill" && ref === "e11") typed = action.text;
      else if (action.kind === "press" && action.key === "Enter" && typed) {
        sent.push(typed);
        log.push("chat");
        text = `${text}\n  - listitem: "${typed}"`;
        typed = "";
      }
      return { ok: true, observation: look() };
    },
  };
  return surface;
}

/** `browser_do`'s plan on a fake page: the real plan runner, a judge that is never needed for exact names. */
export function planner(surface: ScreenSurface) {
  const calls: { steps: ScreenStep[]; own: boolean | undefined }[] = [];
  const plan: BrowserPlanner = async (ctx, steps, options) => {
    calls.push({ steps, own: options?.own });
    const report = await runPlan(
      { judge: createFakeJudge(), orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId, surface, scope: "t" },
      steps,
    );
    options?.onReport?.(report);
    const out = formatPlanReport(report);
    return { content: out.summary, ...(out.failed ? { isError: true } : {}) };
  };
  return { plan, calls };
}

export async function personRun(fx: Fixture, body = "entra nessa reunião e anota") {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
  });
  return runFor(fx, msg.id);
}

export async function runFor(fx: Fixture, messageId: string): Promise<ToolContext> {
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: messageId,
      triggerMessageId: messageId,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: messageId,
    triggerMessageId: messageId,
  };
}

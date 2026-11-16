import { MY_CHROME_PROTOCOL, MY_CHROME_TEXT_MAX, type MyChromeAction } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { runAuthorityById } from "../authority";
import { callWhenBack, type MachineCaller, MachineRequestError } from "../machine-hub";
import { MachineOfflineError, MachinePausedError } from "../machines";
import { toolMachineId } from "../right-hand-seats";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { untrustedBlock } from "../untrusted";
import { BROWSER_SCOPE, MY_CHROME_TOOL_INFO } from "./types";

export interface MyChromeToolDeps {
  /** Connected machines (ADR 0025); without them the source offers nothing. */
  machines?: { hub: MachineCaller };
  now?: () => number;
}

/** A page can take a while to load on a person's own network; the runner gives up on its own before this. */
const ACT_MS = 60_000;

/** The agent's lending, as the server knows it: the computer, whose Chrome it is, until when. */
export type MyChromeLending =
  | { ok: true; machineId: string; machineName: string; personId: string; expiresAt: string }
  | { ok: false; text: string };

/**
 * Whether this run's agent may use a person's lent Chrome now (ADR 0202 §7): its computer, on protocol 82 or later and
 * not in system mode, says the person lent it this agent until a time still ahead, and the run is that person's own:
 * the person who connected the computer, and so whose Chrome it is. Never a routine's run, an unattended one, or one
 * another person started: whatever the agent does there carries the lender's name.
 */
export async function myChromeLending(
  db: Database,
  hub: Pick<MachineCaller, "status"> | undefined,
  ctx: Pick<ToolContext, "orgId" | "agentId" | "runId">,
  now = Date.now(),
): Promise<MyChromeLending> {
  const no = (text: string) => ({ ok: false as const, text });
  if (!hub) return no("Connected computers are not available on this server.");
  const agent = await getAgentCached(db, ctx.orgId, ctx.agentId);
  const machineId = await toolMachineId(db, agent);
  if (!machineId) return no("Nobody lent you their Chrome: it's lent on the computer you use, and you use none.");
  const status = await hub.status(machineId);
  if (!status || status.orgId !== ctx.orgId) return no("Nobody lent you their Chrome on your computer.");
  if (status.protocol < MY_CHROME_PROTOCOL || status.mode === "system" || !status.pairedByUserId) {
    return no(`A person's own Chrome can't be lent on the computer ${status.name}.`);
  }
  const lent = (status.executors.myChrome ?? []).find((l) => l.agentId === ctx.agentId);
  if (!lent || Date.parse(lent.expiresAt) <= now) {
    return no(
      `Nobody lent you their Chrome on the computer ${status.name}, or the time they gave ended. Only its owner lends it, from the agentes.chat app there.`,
    );
  }
  const authority = await runAuthorityById(db, ctx.orgId, ctx.runId);
  if (authority.kind !== "person" || authority.personId !== status.pairedByUserId) {
    return no(
      "The Chrome you were lent is its owner's, signed in as them: you use it only when they asked you, in their own conversation with you. Not here.",
    );
  }
  return {
    ok: true,
    machineId,
    machineName: status.name,
    personId: status.pairedByUserId,
    expiresAt: lent.expiresAt,
  };
}

/** Runner refusals → what the agent reads. */
function explain(error: unknown, machineName: string): string {
  if (error instanceof MachineOfflineError || error instanceof MachinePausedError) return error.message;
  if (!(error instanceof MachineRequestError)) return error instanceof Error ? error.message : String(error);
  switch (error.code) {
    case "browser_unavailable":
      return `The lent Chrome on the computer ${machineName} didn't answer (closed, or its debugging port changed). Tell its owner.`;
    case "unsupported":
      return `The runner on the computer ${machineName} is too old for a lent Chrome.`;
    case "paused":
      return `The owner paused the computer ${machineName}: nothing new can start there until they resume it.`;
    default:
      // The runner's own refusals (a site off the agent's list, a page that moved, the lending ended) say why.
      return error.message;
  }
}

/**
 * A person's own Chrome, lent to an agent from the desktop app (ADR 0202): `my_chrome_open` and `my_chrome_read`
 * under `browser:use`, on the runner's tab of its own in that Chrome. Offered, and allowed on each call, only while
 * the computer says the person lent it this agent and only in that person's own run; the page's text reaches the
 * model as untrusted content. The Tool Gateway writes each call's `tool.call` audit row (area `browser`).
 */
export function createMyChromeToolSource(deps: MyChromeToolDeps): ToolSource {
  const hub = deps.machines?.hub;
  const now = deps.now ?? Date.now;

  async function act(ctx: ToolContext, action: MyChromeAction): Promise<ToolOutput> {
    const lending = await myChromeLending(ctx.db, hub, ctx, now());
    if (!lending.ok || !hub) return { content: lending.ok ? "" : lending.text, isError: true };
    const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
    const domains = agent?.browserAllowedDomains ?? null;
    const caller = hub;
    try {
      const reply = await callWhenBack(
        caller,
        lending.machineId,
        () =>
          caller.call<"mychrome.act">(
            lending.machineId,
            {
              op: "mychrome.act",
              agent: {
                id: ctx.agentId,
                handle: agent?.handle ?? "agent",
                ...(agent?.name ? { name: agent.name } : {}),
              },
              action,
              ...(domains ? { allowedDomains: domains } : {}),
            },
            { signal: ctx.signal, timeoutMs: ACT_MS },
          ),
        ctx.signal,
      );
      const data = { machineId: lending.machineId, host: hostOf(reply.url) };
      // The address (a redirect moves it) and the title are the site's words like its text: inside the envelope.
      const page = [reply.url, reply.title].filter(Boolean).join("\n");
      const block = (text: string) => untrustedBlock(`my_chrome:${data.host}`, text);
      if (action.kind === "open") {
        return {
          content: `Opened a page on ${data.host || "the web"} in your own tab of the Chrome you were lent (until ${lending.expiresAt}); my_chrome_read reads it. Its address and title:\n${block(page)}`,
          data,
        };
      }
      const cut = reply.truncated
        ? `\n[the page goes on: only its first ${MY_CHROME_TEXT_MAX} characters were read]`
        : "";
      return {
        content: `Your tab of the Chrome you were lent, on ${data.host || "the web"}: its address, title and text.\n${block(`${page}\n\n${reply.text ?? ""}`)}${cut}`,
        data,
      };
    } catch (error) {
      return { content: explain(error, lending.machineName), isError: true };
    }
  }

  const definitions: ToolDefinition[] = [
    {
      name: "my_chrome_open",
      description: `${MY_CHROME_TOOL_INFO.my_chrome_open.description} Only when the person who lent it asks you to use their own Chrome, signed in as them (their bank, an internal tool, a site you can't sign in to). The page opens in a tab of your own; you never see their other tabs. Only your sites, as in your own browser.`,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "The page's address (http or https).", maxLength: 2048 } },
        required: ["url"],
        additionalProperties: false,
      },
      scope: BROWSER_SCOPE,
      readsOutside: true,
      execute: async (input, ctx) => {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!url) return { content: "Give the page's `url`.", isError: true };
        return act(ctx, { kind: "open", url });
      },
    },
    {
      name: "my_chrome_read",
      description: `${MY_CHROME_TOOL_INFO.my_chrome_read.description} The page's address, title and visible text, from the tab my_chrome_open opened.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      scope: BROWSER_SCOPE,
      readsOutside: true,
      execute: (_input, ctx) => act(ctx, { kind: "read" }),
    },
  ];

  return {
    name: "my_chrome",
    async tools(ctx) {
      // Most runs have no lent Chrome: offered only while this one may use it, so no other agent or run sees them.
      return (await myChromeLending(ctx.db, hub, ctx, now())).ok ? definitions : [];
    },
  };
}

/** Only the host goes into what's kept (an address can carry a token). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

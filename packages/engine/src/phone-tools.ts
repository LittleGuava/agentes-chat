import { type PubSub, phoneJobTopic, userTopic } from "@agenteschat/adapters";
import { and, asc, count, type Database, type Executor, eq, gt, lt, schema } from "@agenteschat/db";
import { runPerson } from "./authority";
import { getChannelCached } from "./context";
import { personAgentDmKey } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { getMembership } from "./organizations";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import { untrustedBlock } from "./untrusted";

const { agents, phoneJobs, phoneToolGrants } = schema;

/**
 * The phone's own apps as an agent's tools (ADR 0205). The person turns them on in the phone app, for one workspace;
 * a run reaches only the phone of the person behind it, in that person's own conversation with the agent. A request
 * is a `phone_jobs` row: the phone app hears of it on its person's realtime topic (ids only), lists what is pending,
 * runs it with the phone's own API and answers; the tool waits for that answer, at most `PHONE_JOB_TIMEOUT_MS`.
 */

/** What the phone app can be asked to do, by name of its switch. */
export const PHONE_TOOLS = ["contacts"] as const satisfies readonly schema.PhoneTool[];
export type PhoneTool = (typeof PHONE_TOOLS)[number];
export const PHONE_JOB_KINDS = ["find_contact"] as const;
export type PhoneJobKind = (typeof PHONE_JOB_KINDS)[number];

export const PHONE_FIND_CONTACT_TOOL = "phone_find_contact";
/** How long a call waits for the phone: long enough to unlock it and open the app, short enough for a turn. */
export const PHONE_JOB_TIMEOUT_MS = 60_000;
/** The row is read this often anyway: the phone's answer may reach another replica. */
const PHONE_JOB_POLL_MS = 1_000;
/** Contacts one answer may carry, and phone numbers and addresses per contact. */
export const PHONE_CONTACTS_MAX = 5;
export const PHONE_CONTACT_VALUES_MAX = 5;
/** A search is a name or part of one: two characters at least, so a call can't list the whole address book. */
export const PHONE_QUERY_MIN = 2;
export const PHONE_QUERY_MAX = 100;
/** Searches one run may send to the phone. */
export const PHONE_SEARCHES_PER_RUN = 5;
/** Finished jobs (their search, never their contacts) are kept this long, then pruned when the person's next starts. */
const PHONE_JOB_KEEP_MS = 24 * 3600_000;

/** One contact as the phone sends it: only these fields leave the phone. */
export interface PhoneContact {
  name: string;
  phones: string[];
  emails: string[];
}

/** The phone's answer to a job (validated by the route that takes it). */
export type PhoneJobAnswer =
  | { outcome: "done"; contacts: PhoneContact[] }
  | { outcome: "declined" }
  | { outcome: "failed"; error: string };

/** A pending job as the phone app lists it. */
export interface PhoneJobView {
  id: string;
  kind: PhoneJobKind;
  input: { query: string };
  agent: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
}

/** What the waiting tool got. `expired`: no answer in time, or the run stopped waiting. */
export type PhoneJobOutcome =
  | { status: "done"; contacts: PhoneContact[] }
  | { status: "declined" }
  | { status: "failed"; error: string }
  | { status: "expired" };

/** What the person turned on, as the phone app shows it back. */
export interface PhoneToolsView {
  tools: PhoneTool[];
  deviceName: string | null;
  updatedAt: string | null;
}

/** The realtime event an open phone app re-lists its jobs on: a job was added or closed. */
export const PHONE_JOB_EVENT = "phone.job";

async function requireMember(db: Executor, userId: string, orgId: string) {
  if (!(await getMembership(db, userId, orgId))) throw new ForbiddenError();
}

/** The person's switches in this workspace; none turned on reads as an empty list. */
export async function phoneToolsOf(db: Executor, orgId: string, userId: string): Promise<PhoneToolsView> {
  const [row] = await db
    .select()
    .from(phoneToolGrants)
    .where(and(eq(phoneToolGrants.orgId, orgId), eq(phoneToolGrants.userId, userId)));
  return row
    ? { tools: row.tools, deviceName: row.deviceName, updatedAt: row.updatedAt.toISOString() }
    : { tools: [], deviceName: null, updatedAt: null };
}

/** The person's own switches, as their phone app reads them back. */
export async function myPhoneTools(db: Executor, orgId: string, userId: string): Promise<PhoneToolsView> {
  await requireMember(db, userId, orgId);
  return phoneToolsOf(db, orgId, userId);
}

/** The phone app's switches (the route takes them only from the phone app): no tool left deletes the row. */
export async function setPhoneTools(
  db: Database,
  input: { orgId: string; userId: string; tools: PhoneTool[]; deviceName: string },
): Promise<PhoneToolsView> {
  await requireMember(db, input.userId, input.orgId);
  const tools = PHONE_TOOLS.filter((t) => input.tools.includes(t));
  const mine = and(eq(phoneToolGrants.orgId, input.orgId), eq(phoneToolGrants.userId, input.userId));
  if (tools.length === 0) {
    await db.delete(phoneToolGrants).where(mine);
    return { tools: [], deviceName: null, updatedAt: null };
  }
  const updatedAt = new Date();
  await db
    .insert(phoneToolGrants)
    .values({ orgId: input.orgId, userId: input.userId, tools, deviceName: input.deviceName, updatedAt })
    .onConflictDoUpdate({
      target: [phoneToolGrants.orgId, phoneToolGrants.userId],
      set: { tools, deviceName: input.deviceName, updatedAt },
    });
  return { tools, deviceName: input.deviceName, updatedAt: updatedAt.toISOString() };
}

/** Tells the person's open apps to list their jobs again. */
const announce = (pubsub: PubSub | undefined, orgId: string, userId: string, jobId: string) =>
  pubsub?.publish(userTopic(orgId, userId), { type: PHONE_JOB_EVENT, jobId }).catch(() => undefined);

/** The jobs the person's phone has to answer now, oldest first. */
export async function listPhoneJobs(db: Database, orgId: string, userId: string): Promise<PhoneJobView[]> {
  await requireMember(db, userId, orgId);
  const rows = await db
    .select({
      id: phoneJobs.id,
      kind: phoneJobs.kind,
      input: phoneJobs.input,
      agentId: agents.id,
      agentName: agents.name,
      createdAt: phoneJobs.createdAt,
      expiresAt: phoneJobs.expiresAt,
    })
    .from(phoneJobs)
    .innerJoin(agents, and(eq(agents.orgId, phoneJobs.orgId), eq(agents.id, phoneJobs.agentId)))
    .where(
      and(
        eq(phoneJobs.orgId, orgId),
        eq(phoneJobs.userId, userId),
        eq(phoneJobs.status, "pending"),
        gt(phoneJobs.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(phoneJobs.createdAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    input: { query: typeof r.input.query === "string" ? r.input.query : "" },
    agent: { id: r.agentId, name: r.agentName },
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * The phone answers one of its person's jobs. The first answer wins; a job already answered, run out or stopped takes
 * none (`phone.job_closed`), and another person's or another workspace's isn't found.
 */
export async function answerPhoneJob(
  deps: { db: Database; pubsub?: PubSub },
  input: { orgId: string; userId: string; jobId: string; answer: PhoneJobAnswer },
): Promise<void> {
  const { db } = deps;
  await requireMember(db, input.userId, input.orgId);
  const { answer } = input;
  const mine = and(eq(phoneJobs.orgId, input.orgId), eq(phoneJobs.userId, input.userId), eq(phoneJobs.id, input.jobId));
  const [answered] = await db
    .update(phoneJobs)
    .set({
      status: answer.outcome,
      result: answer.outcome === "done" ? { contacts: answer.contacts } : null,
      error: answer.outcome === "failed" ? answer.error : null,
      finishedAt: new Date(),
    })
    .where(and(mine, eq(phoneJobs.status, "pending"), gt(phoneJobs.expiresAt, new Date())))
    .returning({ id: phoneJobs.id });
  if (!answered) {
    const [found] = await db.select({ id: phoneJobs.id }).from(phoneJobs).where(mine);
    if (!found) throw new NotFoundError("Request not found", "phone.job_not_found");
    throw new ConflictError("This request was already answered or ran out of time", "phone.job_closed");
  }
  await deps.pubsub?.publish(phoneJobTopic(answered.id), { type: "phone.job.answered" }).catch(() => undefined);
  await announce(deps.pubsub, input.orgId, input.userId, answered.id);
}

/** Starts a job for the person's phone, after pruning their old finished ones. */
async function startPhoneJob(
  deps: { db: Database; pubsub?: PubSub },
  input: { orgId: string; userId: string; agentId: string; runId: string; query: string; timeoutMs: number },
) {
  const now = Date.now();
  const mine = and(eq(phoneJobs.orgId, input.orgId), eq(phoneJobs.userId, input.userId));
  await deps.db.delete(phoneJobs).where(and(mine, lt(phoneJobs.createdAt, new Date(now - PHONE_JOB_KEEP_MS))));
  const [job] = await deps.db
    .insert(phoneJobs)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "find_contact",
      input: { query: input.query },
      expiresAt: new Date(now + input.timeoutMs),
    })
    .returning({ id: phoneJobs.id });
  if (!job) throw new Error("could not start the phone request");
  await announce(deps.pubsub, input.orgId, input.userId, job.id);
  return job.id;
}

const contactsOf = (result: Record<string, unknown> | null): PhoneContact[] =>
  Array.isArray(result?.contacts) ? (result.contacts as PhoneContact[]) : [];

/**
 * Waits for the phone's answer: woken by the pub/sub signal, and reading the row every `pollMs` anyway. Past the
 * deadline, or when the run stops (`signal`), the job is closed as `expired` so the phone no longer lists it. The
 * contacts are wiped from the row once read: the tool's result is where they live from then on.
 */
export async function waitForPhoneJob(
  deps: { db: Database; pubsub?: PubSub },
  jobId: string,
  options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<PhoneJobOutcome> {
  const { db } = deps;
  const pollMs = options.pollMs ?? PHONE_JOB_POLL_MS;
  const deadline = Date.now() + options.timeoutMs;
  let wake: (() => void) | null = null;
  const unsubscribe = deps.pubsub?.subscribe(phoneJobTopic(jobId), () => wake?.());
  const onAbort = () => wake?.();
  options.signal?.addEventListener("abort", onAbort);
  const read = async (): Promise<PhoneJobOutcome | null> => {
    const [row] = await db.select().from(phoneJobs).where(eq(phoneJobs.id, jobId));
    if (!row || row.status === "expired") return { status: "expired" };
    if (row.status === "pending") return null;
    if (row.result) await db.update(phoneJobs).set({ result: null }).where(eq(phoneJobs.id, jobId));
    if (row.status === "done") return { status: "done", contacts: contactsOf(row.result) };
    if (row.status === "failed") return { status: "failed", error: row.error ?? "" };
    return { status: "declined" };
  };
  try {
    for (;;) {
      const outcome = await read();
      if (outcome) return outcome;
      if (Date.now() >= deadline || options.signal?.aborted) {
        const [closed] = await db
          .update(phoneJobs)
          .set({ status: "expired", finishedAt: new Date() })
          .where(and(eq(phoneJobs.id, jobId), eq(phoneJobs.status, "pending")))
          .returning({ orgId: phoneJobs.orgId, userId: phoneJobs.userId });
        if (closed) {
          await announce(deps.pubsub, closed.orgId, closed.userId, jobId);
          return { status: "expired" };
        }
        // Answered in between.
        return (await read()) ?? { status: "expired" };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(pollMs, Math.max(0, deadline - Date.now())));
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }
  } finally {
    unsubscribe?.();
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The person whose phone this run may use, or why none: a person behind the run (never a routine's or an agent's own
 * work), in their own conversation with this agent (what comes back is theirs alone to read), with contacts on.
 */
async function phoneOwner(ctx: ToolContext): Promise<{ userId: string } | { refused: string }> {
  // A mission task's call through the bridge has no conversation of a person's.
  if (!ctx.runId || ctx.bridge?.taskId) return { refused: REFUSED.noPerson };
  // The channel first, from the cache: a run in a shared channel never pays for the authority lookup.
  const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
  if (channel?.kind !== "dm") return { refused: REFUSED.notTheirDm };
  const person = await runPerson(ctx.db, ctx.orgId, ctx.runId);
  if (!person) return { refused: REFUSED.noPerson };
  if (channel.dmKey !== personAgentDmKey(person, ctx.agentId)) return { refused: REFUSED.notTheirDm };
  const { tools } = await phoneToolsOf(ctx.db, ctx.orgId, person);
  return tools.includes("contacts") ? { userId: person } : { refused: REFUSED.off };
}

const REFUSED = {
  noPerson: "Only a person's own request reaches their phone, and nobody is behind this run.",
  notTheirDm:
    "Their phone's contacts are searched only in their own conversation with you: ask them there, or ask them for the contact here.",
  off: "They haven't turned on contacts in the agentes.chat phone app for this workspace: ask them for the contact.",
} as const;

/** The search as the phone gets it: one line, spaces collapsed. */
export const phoneQueryOf = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

const contactLine = (c: PhoneContact) =>
  [
    c.name,
    c.phones.length > 0 ? `phones: ${c.phones.join(", ")}` : null,
    c.emails.length > 0 ? `emails: ${c.emails.join(", ")}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");

/** The tool's answer for each outcome. */
function outputOf(outcome: PhoneJobOutcome, query: string, timeoutMs: number): ToolOutput {
  const data = { phoneJob: outcome.status };
  switch (outcome.status) {
    case "done":
      if (outcome.contacts.length === 0) {
        return { content: `No contact on their phone matches "${query}".`, data: { ...data, contacts: 0 } };
      }
      return {
        content: `Contacts on their phone matching "${query}":\n${untrustedBlock(
          "phone contacts",
          outcome.contacts.map(contactLine).join("\n"),
        )}`,
        data: { ...data, contacts: outcome.contacts.length },
      };
    case "declined":
      return {
        content: "They declined this search on their phone. Don't search it again for this; ask them in the chat.",
        data,
      };
    case "failed":
      return {
        content: `Their phone couldn't search its contacts:\n${untrustedBlock("phone", outcome.error)}`,
        isError: true,
        data,
      };
    case "expired":
      return {
        content: `Their phone didn't answer within ${Math.round(timeoutMs / 1000)} s: the agentes.chat app must be open on it. Ask them to open it and say when, or to give you the contact here.`,
        isError: true,
        data,
      };
  }
}

function findContactTool(deps: PhoneToolDeps, timeoutMs: number): ToolDefinition {
  return {
    name: PHONE_FIND_CONTACT_TOOL,
    description: `Search the contacts on the phone of the person you are talking to, through the agentes.chat app on it (not a phone connected to a computer). Give a name or part of one; you get at most ${PHONE_CONTACTS_MAX} matches with their phone numbers and email addresses. Their phone answers within ${Math.round(timeoutMs / 1000)} s while the app is open; they may decline.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: PHONE_QUERY_MIN,
          maxLength: PHONE_QUERY_MAX,
          description: "A name or part of one, as the person said it.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readsOutside: true,
    describe: (input) => ({ title: "Search phone contacts", detail: phoneQueryOf(input.query) }),
    async execute(input, ctx) {
      const query = phoneQueryOf(input.query);
      if (query.length < PHONE_QUERY_MIN || query.length > PHONE_QUERY_MAX) {
        return {
          content: `Give a name or part of one, ${PHONE_QUERY_MIN} to ${PHONE_QUERY_MAX} characters.`,
          isError: true,
        };
      }
      const owner = await phoneOwner(ctx);
      if ("refused" in owner) return { content: owner.refused, isError: true };
      const [sent] = await ctx.db
        .select({ n: count() })
        .from(phoneJobs)
        .where(and(eq(phoneJobs.orgId, ctx.orgId), eq(phoneJobs.runId, ctx.runId)));
      if ((sent?.n ?? 0) >= PHONE_SEARCHES_PER_RUN) {
        return {
          content: `You already searched their phone ${PHONE_SEARCHES_PER_RUN} times in this turn: ask them for the contact.`,
          isError: true,
        };
      }
      const jobDeps = { db: ctx.db, pubsub: deps.pubsub };
      const jobId = await startPhoneJob(jobDeps, {
        orgId: ctx.orgId,
        userId: owner.userId,
        agentId: ctx.agentId,
        runId: ctx.runId,
        query,
        timeoutMs,
      });
      const outcome = await waitForPhoneJob(jobDeps, jobId, { timeoutMs, pollMs: deps.pollMs, signal: ctx.signal });
      return outputOf(outcome, query, timeoutMs);
    },
  };
}

export interface PhoneToolDeps {
  pubsub?: PubSub;
  /** Tests wait less. */
  timeoutMs?: number;
  pollMs?: number;
}

/** `phone_find_contact`, listed only where `phoneOwner` finds the person's phone (checked again on every call). */
export function createPhoneToolSource(deps: PhoneToolDeps): ToolSource {
  const timeoutMs = deps.timeoutMs ?? PHONE_JOB_TIMEOUT_MS;
  return {
    name: "phone",
    async tools(ctx) {
      return "userId" in (await phoneOwner(ctx)) ? [findContactTool(deps, timeoutMs)] : [];
    },
  };
}

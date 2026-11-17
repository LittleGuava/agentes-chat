import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, isNull, lt, ne, schema, sql } from "@agenteschat/db";
import { runAuthorityById } from "./authority";
import { readableChannelIds, requireChannelAccess } from "./channels";
import { findMember, plainName } from "./chat-tools";
import { consultedFor, NO_PERSON_READS } from "./consultations";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { hasQuestionMark } from "./format";
import type { ResourcefulDeps } from "./hand-off";
import { notifyQuestion, resolveQuestionNotifications } from "./notification-producers";
import { enqueue } from "./outbox";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentQuestions, channelMembers, messages, notifications, organizationMembers, users } = schema;

export type AgentQuestionRow = typeof agentQuestions.$inferSelect;
export type QuestionItem = schema.QuestionItem;
export type QuestionItemAnswer = schema.QuestionItemAnswer;

/** How long a question waits for an answer before the run goes on without one. */
export const QUESTION_TTL_MS = 24 * 3600_000;
export const ASK_USER_TOOL = "ask_user";
/** A question card holds one short question: never a whole reply, and never one cut to fit. */
export const QUESTION_MAX_CHARS = 300;
export const questionTooLong = (length: number) =>
  `Not asked: this question is ${length} characters, and a card holds one short question (at most ${QUESTION_MAX_CHARS}). Write what you found and your plan in your text first (it is posted above the card), then call ask_user again with one short question, with choices when they fit (e.g. "Can I start filling in the form?" with Yes and Not yet, in the people's language).`;
/** How many questions one card holds (ADR 0008 addendum 2026-11-15), and the choices each offers. */
export const QUESTION_MAX_ITEMS = 6;
export const QUESTION_MAX_CHOICES = 4;
export const QUESTION_CHOICE_MAX_CHARS = 200;
export const QUESTION_OR_QUESTIONS =
  "Not asked: pass either `question` or `questions`, not both and not neither: one question with its `choices` and `multiSelect`, or several, each with its own.";
/** What the run reads when its card would ask nothing: no question mark (`hasQuestionMark`) and no choices. */
export const NOT_A_QUESTION =
  "Not asked: this asks nothing, with no question mark and no choices to pick from. Put it in your reply, or end your turn if your reply already says it: nobody waits on a note. If you need an answer to go on, call ask_user again with one direct question.";

/** The shape the app renders (`meta.question`, `question.asked` / `question.answered`). */
export interface AgentQuestion {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string | null;
  /** The run that asked: the app's receipt finds the message it answers (a channel question has no thread). */
  runId: string;
  text: string;
  choices: string[] | null;
  /** The one person it is for: only they answer it. Null: anyone in the conversation. */
  requestedForUserId: string | null;
  /** Several questions, or one where several may be picked: the card asks each and sends `answers` together. */
  items?: QuestionItem[];
  /** The answer to each of `items`, in order, when it came from the card. */
  answers?: QuestionItemAnswer[];
  status: "open" | "answered";
  answer: string | null;
  answeredByUserId: string | null;
  /** When a person answered or skipped it. */
  answeredAt: string | null;
  /** The agent took it back (`withdraw_request`): it no longer needs an answer. Kept on the card by later syncs. */
  withdrawn?: true;
  /** A person skipped it (`answeredByUserId`): the agent went on without an answer. */
  dismissed?: true;
}

export function questionView(q: AgentQuestionRow): AgentQuestion {
  return {
    id: q.id,
    agentId: q.agentId,
    channelId: q.channelId,
    threadId: q.threadId,
    messageId: q.messageId,
    runId: q.runId,
    text: q.text,
    choices: q.choices && q.choices.length > 0 ? q.choices : null,
    requestedForUserId: q.requestedForUserId,
    ...(q.items && q.items.length > 0 ? { items: q.items } : {}),
    ...(q.answers && q.answers.length > 0 ? { answers: q.answers } : {}),
    // An expired question is closed for the app; it shows as answered without an answer.
    status: q.status === "open" ? "open" : "answered",
    answer: q.answer,
    answeredByUserId: q.answeredByUserId,
    answeredAt: q.answeredAt?.toISOString() ?? null,
    ...(q.status === "dismissed" ? { dismissed: true as const } : {}),
  };
}

/**
 * A question card's meta: the question as the app renders it, and the agent's required reason
 * (`why`, ADR 0053), which the gateway took out of the call. `syncQuestionMessage` only rewrites
 * `meta.question`, so the reason stays on the card.
 */
export const questionCardMeta = (q: AgentQuestionRow, why: string) => ({
  questionId: q.id,
  question: questionView(q),
  ...(why ? { why } : {}),
});

/**
 * The built-in `ask_user` tool: no scope needed (every agent may ask). It
 * doesn't run anything; the Tool Gateway hands the question (and its `why`)
 * to the executor, which posts it in the thread and suspends the run
 * (`waiting_input`). A consulted agent asks from the agents' DM, which no
 * person reads: its card goes where the person behind it asked (ADR 0034).
 * Text that asks nothing (no question mark, no choices) is refused with no judgment (`NOT_A_QUESTION`). With a
 * judge, a question for something the run could find, a secret asked in the chat, or one that asks for nothing the
 * run needs, is held first (`holdAsk`, ADR 0109 addendum).
 */
export function createAskUserToolSource(deps: ResourcefulDeps = {}): ToolSource {
  const tool: ToolDefinition = {
    name: ASK_USER_TOOL,
    description:
      "Ask the person one short question and wait for the answer, only when you can't go on without it: the request is still ambiguous after you looked with your tools, or a decision is really theirs. Never to approve an action whose own card asks: call it. Never a status note or an offer of optional extra work: those go in your reply, nobody waits on them. A way to do what was asked is never optional: do it, handing the person their step with its own request. Don't ask before what you can just do and undo: issues, memories, routines, a form you fill and save before submitting. Not for choosing between fixes: recommend one. `question` is the question alone, at most 300 characters: anything longer goes in your text before the call, posted above the card. The card shows the question, its choices and your `why`: never write any of them in your text too; after calling, write nothing else and end your turn. Offer 2 to 4 short choices when the answer is one of a few options, with `multiSelect` when more than one may apply. Several answers you need before going on go on one card (`questions`, up to 6, each with its own choices and `multiSelect`), answered all at once: the answers come back in order, one per question.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        // No maxLength: a longer question gets `questionTooLong`, which says what to do instead.
        question: { type: "string", minLength: 1 },
        choices: CHOICES_SCHEMA,
        multiSelect: MULTI_SELECT_SCHEMA,
        questions: {
          type: "array",
          minItems: 1,
          maxItems: QUESTION_MAX_ITEMS,
          description: "Instead of `question`: several questions on one card, each answered before you go on.",
          items: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1 },
              choices: CHOICES_SCHEMA,
              multiSelect: MULTI_SELECT_SCHEMA,
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
        person: {
          type: "string",
          maxLength: 200,
          description: "Name or @handle of the one person it is for. Leave it out when anyone here can answer.",
        },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const asked = askedItems(input);
      if (typeof asked === "string") return { content: asked, isError: true };
      const [channel] = await ctx.db
        .select({ kind: schema.channels.kind, dmKey: schema.channels.dmKey })
        .from(schema.channels)
        .where(and(eq(schema.channels.id, ctx.channelId), eq(schema.channels.orgId, ctx.orgId)));
      // In an agents' DM only a run answering a question or note for a person it answers may ask (`consultedFor`).
      if (channel && isAgentOnlyDm(channel) && !(await consultedFor(ctx))) {
        return { content: NO_PERSON_READS, isError: true };
      }
      const named = typeof input.person === "string" ? input.person.trim() : "";
      const matches = named ? await findMember(ctx, named) : [];
      if (named && matches.length !== 1) {
        return {
          content:
            matches.length === 0
              ? `No one called "${named}" in this organization.`
              : `Several people match: ${matches.map((m) => m.name).join(", ")}. Say which one.`,
          isError: true,
        };
      }
      const requestedForUserId = matches[0]?.userId ?? null;
      // A consulted or background run's card goes elsewhere: `postPauseCards` checks that place.
      if (
        requestedForUserId &&
        !ctx.background &&
        !(channel && isAgentOnlyDm(channel)) &&
        !(await readableChannelIds(ctx.db, ctx.orgId, requestedForUserId, [ctx.channelId])).size
      ) {
        return { content: `${named} isn't in this conversation, so they wouldn't see the question.`, isError: true };
      }
      const text = asked.map((item) => item.question).join("\n");
      // Loaded here: the check pulls in the controller, which imports most of the engine.
      const held = await (await import("./hand-off")).holdAsk(deps, ctx, text);
      if (held) return { content: held, data: { held: true } };
      const [only] = asked;
      return {
        content: "",
        waitForAnswer: {
          text,
          choices: asked.length === 1 ? (only?.choices ?? null) : null,
          requestedForUserId,
          // One question with one pick is the card it always was: nothing new is stored for it, nor said of it.
          ...(asked.length === 1 && !only?.multiSelect ? {} : { items: asked }),
        },
      };
    },
  };
  return { name: "questions", tools: async () => [tool] };
}

const CHOICES_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: QUESTION_CHOICE_MAX_CHARS },
  minItems: 2,
  maxItems: QUESTION_MAX_CHOICES,
};
const MULTI_SELECT_SCHEMA = { type: "boolean", description: "The person may pick more than one of the choices." };

/**
 * The questions an `ask_user` call asks, each held to a single question's rules, or what the run reads instead: one
 * `question` (with its `choices` and `multiSelect`) or a `questions` list, never both.
 */
function askedItems(input: Record<string, unknown>): QuestionItem[] | string {
  const many = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : null;
  const one = typeof input.question === "string" ? input : null;
  if (Boolean(many) === Boolean(one)) return QUESTION_OR_QUESTIONS;
  const items: QuestionItem[] = [];
  for (const entry of (many ?? [input]).slice(0, QUESTION_MAX_ITEMS)) {
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    if (question.length > QUESTION_MAX_CHARS) return questionTooLong(question.length);
    const choices = Array.isArray(entry.choices)
      ? [...new Set((entry.choices as unknown[]).map((c) => String(c).trim()).filter(Boolean))]
      : [];
    if (!hasQuestionMark(question) && choices.length < 2) return NOT_A_QUESTION;
    const offered = choices.length >= 2 ? choices.slice(0, QUESTION_MAX_CHOICES) : null;
    // The same question twice asks it once: the apps tell a card's questions apart by their words.
    if (items.some((item) => item.question === question)) continue;
    items.push({ question, choices: offered, ...(offered && entry.multiSelect === true ? { multiSelect: true } : {}) });
  }
  return items.length > 0 ? items : QUESTION_OR_QUESTIONS;
}

/** The people of a conversation a question's text names: by @handle, full name or first name, as whole words. */
async function peopleNamedIn(db: Executor, orgId: string, channelId: string, text: string) {
  const people = await db
    .select({ userId: channelMembers.userId, name: users.name, handle: organizationMembers.handle })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, channelMembers.userId), eq(organizationMembers.orgId, orgId)),
    )
    .where(eq(channelMembers.channelId, channelId));
  const spaced = (v: string) =>
    ` ${plainName(v)
      .replace(/[^\p{L}\p{N}_]+/gu, " ")
      .trim()} `;
  const words = spaced(text);
  return people.filter(({ name, handle }) =>
    [name, name.split(/\s+/)[0] ?? "", handle ?? ""].some((n) => words.includes(spaced(n))),
  );
}

/**
 * Who a question that didn't say is for: the person behind the run, or the last to write here since it started
 * (who it is replying to), when its text names them and nobody else here. A name alone proves nothing ("Ana disse
 * que sim, confirmam?" asks the room), so anyone else it names stays a question for the room.
 */
export async function impliedAddressee(
  db: Executor,
  run: { id: string; orgId: string; createdAt: Date },
  place: { channelId: string; threadId: string | null },
  text: string,
): Promise<string | null> {
  const [{ personId }, [last]] = await Promise.all([
    runAuthorityById(db, run.orgId, run.id),
    db
      .select({ userId: messages.authorUserId })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, run.orgId),
          eq(messages.channelId, place.channelId),
          place.threadId ? eq(messages.threadId, place.threadId) : isNull(messages.threadId),
          eq(messages.authorType, "person"),
          gte(messages.createdAt, run.createdAt),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1),
  ]);
  const named = await peopleNamedIn(db, run.orgId, place.channelId, text);
  const [one] = named;
  return named.length === 1 && one && (one.userId === personId || one.userId === last?.userId) ? one.userId : null;
}

/** What the model hears back once the question is closed. */
export function questionResult(q: AgentQuestionRow | undefined): { content: string; isError?: boolean } {
  if (q?.status === "answered" && q.items && q.answers) {
    const each = q.items.map((item, i) => {
      const said = q.answers?.[i];
      return { question: item.question, picked: said?.choices ?? [], ...(said?.text ? { wrote: said.text } : {}) };
    });
    return {
      content: `The person answered the card, one entry per question in the order you asked (picked: the choices they picked; wrote: what they wrote): ${JSON.stringify(each)}`,
    };
  }
  if (q?.status === "answered" && q.answer !== null) return { content: `The person answered: ${q.answer}` };
  if (q?.status === "canceled") return { content: "You withdrew this question: nobody will answer it." };
  if (q?.status === "dismissed")
    return {
      content:
        "The person skipped this question: go on without an answer, with your best judgement if it is safe, or say what you still need.",
    };
  return {
    content:
      "No one answered within 24 hours. Go on with your best judgement if it is safe, or say what you still need.",
  };
}

/** Writes the current state of the question into its chat message (`meta.question`), keeping `withdrawn`. */
export async function syncQuestionMessage(db: Executor, q: AgentQuestionRow, view: AgentQuestion = questionView(q)) {
  if (!q.messageId) return;
  await db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{question}', coalesce(${messages.meta}->'question', '{}'::jsonb) || ${JSON.stringify(view)}::jsonb)`,
    })
    .where(and(eq(messages.id, q.messageId), eq(messages.orgId, q.orgId)));
}

const resumeJob = (q: AgentQuestionRow) => ({
  orgId: q.orgId,
  kind: "agent_run.execute",
  payload: { runId: q.runId },
  dedupeKey: `agent_run.execute:${q.runId}:question:${q.id}`,
  maxAttempts: 4,
});

export async function publishQuestion(
  pubsub: PubSub | undefined,
  q: AgentQuestionRow,
  type: "question.asked" | "question.answered",
  view: AgentQuestion = questionView(q),
) {
  await publishChannelEvent(pubsub, { type, channelId: q.channelId, threadId: q.threadId, question: view });
}

/**
 * Only the person a question is for closes it, and admins are no exception: it asks what they alone know, as a
 * secret request does, and it closes by itself at `QUESTION_TTL_MS`.
 */
function requireAddressee(q: AgentQuestionRow, actorId: string) {
  if (q.requestedForUserId && q.requestedForUserId !== actorId) {
    throw new ForbiddenError("This question is for someone else");
  }
}

/**
 * A person answers a question from the card (`choice`) or with text; both
 * can come together. Anyone who can read the channel may answer, unless it is for
 * one person. The run resumes with the answer as the tool result.
 */
export async function answerQuestion(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  questionId: string,
  input: AnswerInput,
): Promise<AgentQuestion> {
  const { db } = deps;
  const [current] = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!current) throw new NotFoundError("Question not found");
  await requireChannelAccess(db, actorId, orgId, current.channelId);
  requireAddressee(current, actorId);
  const items = current.items && current.items.length > 0 ? current.items : null;
  if (input.answers && items) {
    const answers = checkedAnswers(items, input.answers);
    return closeByPerson(deps, current, {
      status: "answered",
      answer: answerSummary(items, answers),
      answers,
      answeredByUserId: actorId,
    });
  }
  // A card of one question with one pick keeps the old answer: a choice, words, or both.
  const [said] = input.answers
    ? checkedAnswers([{ question: current.text, choices: current.choices }], input.answers)
    : [];
  const choice = said ? (said.choices[0] ?? null) : input.choice?.trim() || null;
  const text = said ? said.text : input.text?.trim() || null;
  if (!choice && !text) throw new ValidationError("Send a choice or a text answer");
  if (choice && !(current.choices ?? []).includes(choice)) throw new ValidationError("That is not one of the choices");
  const answer = choice && text ? `${choice} (${text})` : (choice ?? text ?? "");
  // One question where several may be picked, answered by an app that picks one: still the card's answer.
  const answers = items?.length === 1 && choice ? [{ choices: [choice], text }] : undefined;
  return closeByPerson(deps, current, { status: "answered", answer, answers, answeredByUserId: actorId });
}

/** A person's answer: one question's `choice` and/or `text`, or `answers`, one per question of the card, in order. */
export interface AnswerInput {
  choice?: string;
  text?: string;
  answers?: { choices?: string[]; text?: string }[];
}

/** Each question's answer, checked against the card: every one answered, picks among its choices, one unless `multiSelect`. */
function checkedAnswers(
  items: readonly QuestionItem[],
  input: NonNullable<AnswerInput["answers"]>,
): QuestionItemAnswer[] {
  if (input.length !== items.length) throw new ValidationError("Answer every question on the card, in order");
  return items.map((item, i) => {
    const said = input[i];
    const choices = [...new Set((said?.choices ?? []).map((c) => c.trim()).filter(Boolean))];
    const text = said?.text?.trim() || null;
    if (choices.length === 0 && !text) throw new ValidationError(`Answer question ${i + 1}`);
    if (choices.some((c) => !(item.choices ?? []).includes(c)))
      throw new ValidationError(`That is not one of question ${i + 1}'s choices`);
    if (choices.length > 1 && !item.multiSelect) throw new ValidationError(`Question ${i + 1} takes one choice`);
    return { choices, text };
  });
}

/** The answer in words (previews, notifications, the card in an older app): one line per question. */
function answerSummary(items: readonly QuestionItem[], answers: readonly QuestionItemAnswer[]) {
  const said = (a: QuestionItemAnswer | undefined) => {
    const picked = a?.choices.join(", ") ?? "";
    return picked && a?.text ? `${picked} (${a.text})` : picked || a?.text || "";
  };
  if (items.length === 1) return said(answers[0]);
  return items.map((item, i) => `${item.question} ${said(answers[i])}`).join("\n");
}

/** A person closes an open question (answer or skip): the card changes, the run resumes, the inbox clears. */
async function closeByPerson(
  deps: { db: Database; pubsub?: PubSub },
  current: AgentQuestionRow,
  set: { status: "answered" | "dismissed"; answer?: string; answers?: QuestionItemAnswer[]; answeredByUserId: string },
): Promise<AgentQuestion> {
  const closed = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentQuestions)
      .set({ ...set, answeredAt: new Date() })
      .where(
        and(
          eq(agentQuestions.id, current.id),
          eq(agentQuestions.status, "open"),
          sql`${agentQuestions.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!row) return null;
    await syncQuestionMessage(tx, row);
    await enqueue(tx, resumeJob(row));
    return row;
  });
  if (!closed) throw new ConflictError("This question was already answered or expired");
  await publishQuestion(deps.pubsub, closed, "question.answered");
  await resolveQuestionNotifications(deps, closed.orgId, closed.id).catch(() => {});
  return questionView(closed);
}

/** A person skips a question: it closes without an answer and the run goes on. Whoever may answer it may skip it. */
export async function dismissQuestion(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  questionId: string,
): Promise<AgentQuestion> {
  const { db } = deps;
  const [current] = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!current) throw new NotFoundError("Question not found");
  await requireChannelAccess(db, actorId, orgId, current.channelId);
  requireAddressee(current, actorId);
  return closeByPerson(deps, current, { status: "dismissed", answeredByUserId: actorId });
}

/**
 * After a person's message that answered a question in the same statement
 * (see `insertMessageWithRuns`): sync the card and tell the channel.
 */
export async function afterReplyAnswered(deps: { db: Database; pubsub?: PubSub }, orgId: string, questionId: string) {
  const [row] = await deps.db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!row) return;
  await syncQuestionMessage(deps.db, row);
  await publishQuestion(deps.pubsub, row, "question.answered");
  await resolveQuestionNotifications(deps, orgId, row.id).catch(() => {});
}

/** The agent withdraws its own open question (`withdraw_request`): the card closes and a run waiting on it goes on. */
export async function withdrawQuestion(deps: { db: Database; pubsub?: PubSub }, agentId: string, questionId: string) {
  const withdrawn = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentQuestions)
      .set({ status: "canceled" })
      .where(
        and(eq(agentQuestions.id, questionId), eq(agentQuestions.agentId, agentId), eq(agentQuestions.status, "open")),
      )
      .returning();
    if (!row) return null;
    await syncQuestionMessage(tx, row, { ...questionView(row), withdrawn: true });
    await enqueue(tx, resumeJob(row));
    return row;
  });
  if (withdrawn) {
    await publishQuestion(deps.pubsub, withdrawn, "question.answered", { ...questionView(withdrawn), withdrawn: true });
    await resolveQuestionNotifications(deps, withdrawn.orgId, withdrawn.id).catch(() => {});
  }
  return withdrawn;
}

/**
 * The person open questions wait on left (`channelId`, or the whole workspace): each goes back to the room, or
 * nobody could answer it until it expires.
 */
export async function releaseQuestionsOf(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  userId: string,
  channelId?: string,
) {
  const released = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(agentQuestions)
      .set({ requestedForUserId: null })
      .where(
        and(
          eq(agentQuestions.orgId, orgId),
          eq(agentQuestions.requestedForUserId, userId),
          eq(agentQuestions.status, "open"),
          channelId ? eq(agentQuestions.channelId, channelId) : undefined,
        ),
      )
      .returning();
    for (const row of rows) await syncQuestionMessage(tx, row);
    return rows;
  });
  for (const row of released) {
    await publishQuestion(deps.pubsub, row, "question.asked");
    await resolveQuestionNotifications(deps, orgId, row.id).catch(() => {});
    await notifyQuestion(deps, row).catch(() => {});
  }
}

/**
 * The questions waiting on a person who can no longer read where they were asked, though they never left it: an
 * administrator demoted reads a channel only as a member (ADR 0151). Each goes back to the room.
 */
export async function releaseQuestionsOutOfReach(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  userId: string,
) {
  const open = await deps.db
    .selectDistinct({ channelId: agentQuestions.channelId })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.orgId, orgId),
        eq(agentQuestions.requestedForUserId, userId),
        eq(agentQuestions.status, "open"),
      ),
    );
  if (open.length === 0) return;
  const readable = await readableChannelIds(
    deps.db,
    orgId,
    userId,
    open.map((q) => q.channelId),
  );
  for (const { channelId } of open) {
    if (!readable.has(channelId)) await releaseQuestionsOf(deps, orgId, userId, channelId);
  }
}

/** Closes questions past their deadline and resumes their runs (worker, every minute). */
export async function expireQuestions(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(agentQuestions)
      .set({ status: "expired" })
      .where(and(eq(agentQuestions.status, "open"), lt(agentQuestions.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await syncQuestionMessage(tx, row);
      await enqueue(tx, resumeJob(row));
    }
    return rows;
  });
  for (const row of expired) {
    await publishQuestion(deps.pubsub, row, "question.answered");
    await resolveQuestionNotifications(deps, row.orgId, row.id).catch(() => {});
  }
  await resolveStaleQuestionNotifications(deps).catch(() => {});
  return expired.length;
}

/**
 * A question's notification left waiting after the question closed (a run stopped before this release resolved
 * them, a crash between the close and the inbox): done, so nothing waits on a person for an answer nobody can give.
 */
export async function resolveStaleQuestionNotifications(deps: { db: Database; pubsub?: PubSub }) {
  const stale = await deps.db
    .select({ orgId: notifications.orgId, questionId: agentQuestions.id })
    .from(notifications)
    .innerJoin(
      agentQuestions,
      and(
        eq(agentQuestions.orgId, notifications.orgId),
        sql`${notifications.groupKey} = 'agent_question:' || ${agentQuestions.id}`,
      ),
    )
    .where(
      and(eq(notifications.kind, "agent_question"), isNull(notifications.doneAt), ne(agentQuestions.status, "open")),
    )
    .groupBy(notifications.orgId, agentQuestions.id);
  for (const row of stale) await resolveQuestionNotifications(deps, row.orgId, row.questionId);
  return stale.length;
}

export async function getQuestion(db: Database, actorId: string, orgId: string, questionId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!row) throw new NotFoundError("Question not found");
  await requireChannelAccess(db, actorId, orgId, row.channelId);
  return questionView(row);
}

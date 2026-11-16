import { afterEach, expect, test } from "bun:test";
import type { MailSummary } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  createFakeJudge,
  createRoutine,
  drainOutbox,
  getMailAccountView,
  ingestMail,
  markNotificationDone,
  type NotificationLatest,
  type NotificationSource,
  type RoutineDeps,
  renderPush,
  updateMailAccount,
} from "../src";
import { giveMail, imapAccount, type MailFixture, mailSetup, runContext } from "./mail-fixtures";

let m: MailFixture;
afterEach(async () => {
  await m?.f.close();
  m = undefined as never;
});

const mail = (id: string, from: string, subject: string, snippet = ""): MailSummary => ({
  id,
  from: { address: from },
  to: [],
  cc: [],
  subject,
  date: new Date().toISOString(),
  snippet,
  unread: true,
  hasAttachments: false,
});

/** The judge sorts by subject: deals are ignored, questions need a reply, the rest is important. */
const sortingJudge = () =>
  createFakeJudge((kind, _id, state) => {
    if (kind !== "mail_triage") return undefined;
    const subject = String(state.subject ?? "");
    if (subject.includes("deals")) return "ignore";
    if (subject.endsWith("?")) return "needs_reply";
    return "important";
  });

async function watchedMailbox(x: MailFixture) {
  const account = await imapAccount(x);
  await giveMail(x, account.id, "read");
  const deps: RoutineDeps = { db: x.f.db, pubsub: x.f.pubsub, mail: x.mail };
  const routine = await createRoutine(deps, x.f.owner.id, x.f.org.id, {
    agentId: x.f.agent.id,
    prompt: "Answer support mail",
    target: { type: "dm" },
    trigger: { type: "email", accountId: account.id, folder: "INBOX", filter: {} },
  });
  const [watch] = await x.f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, routine.id));
  if (!watch) throw new Error("no watch");
  return { account, routine, watch };
}

const runsOf = (x: MailFixture, routineId: string) =>
  x.f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));

test("with triage on, mail sorted as ignore wakes no routine; the rest reaches the run with its label", async () => {
  m = await mailSetup();
  const judge = sortingJudge();
  m.deps.judge = judge;
  const { account, routine, watch } = await watchedMailbox(m);
  const updated = await updateMailAccount(m.deps, m.f.owner.id, m.f.org.id, account.id, { triage: true });
  expect(updated.ok && updated.account.triage).toBe(true);

  // A newsletter alone: judged, kept out of the routine, never judged twice.
  expect(await ingestMail(m.deps, watch.id, [mail("n1", "news@shop.com", "Weekly deals")])).toEqual({
    added: 0,
    fired: false,
  });
  expect(await runsOf(m, routine.id)).toHaveLength(0);
  expect(await ingestMail(m.deps, watch.id, [mail("n1", "news@shop.com", "Weekly deals")])).toEqual({
    added: 0,
    fired: false,
  });
  expect(judge.calls).toHaveLength(1);

  expect(
    await ingestMail(m.deps, watch.id, [
      mail("q1", "ana@acme.com", "Can you send the invoice?", "We need it by Friday"),
      mail("n2", "news@shop.com", "More deals"),
      mail("i1", "ops@acme.com", "Server down in São Paulo"),
    ]),
  ).toEqual({ added: 2, fired: true });
  const [run] = await runsOf(m, routine.id);
  const event = run?.event as { summary: string; messages: { id: string; triage?: string }[] };
  expect(event.messages.map((x) => [x.id, x.triage])).toEqual([
    ["q1", "needs_reply"],
    ["i1", "important"],
  ]);
  expect(event.summary).toContain('[needs reply] · ana@acme.com · "Can you send the invoice?" · id q1');
  expect(event.summary).toContain('[important] · ops@acme.com · "Server down in São Paulo" · id i1');
  expect(event.summary).not.toContain("More deals");

  // The judge read the message's sender, subject and snippet, for the routine's agent.
  const asked = judge.calls.find((c) => c.state.subject === "Can you send the invoice?");
  expect(asked).toMatchObject({
    orgId: m.f.org.id,
    agentId: m.f.agent.id,
    kind: "mail_triage",
    state: { mailbox: "support@example.com", from: "ana@acme.com", snippet: "We need it by Friday" },
  });

  // The agent sees the label when it searches or reads the mailbox, ignored mail included.
  m.box.add({ id: "q1", from: { address: "ana@acme.com" }, subject: "Can you send the invoice?" });
  m.box.add({ id: "n2", from: { address: "news@shop.com" }, subject: "More deals" });
  m.box.add({ id: "x9", from: { address: "bob@acme.com" }, subject: "Never triaged" });
  const ctx = await runContext(m.f);
  const call = (name: string, input: Record<string, unknown>) =>
    m.tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
  const found = await call("mail_support_search", {});
  if (found.type !== "result") throw new Error("expected a result");
  const blocks = found.output.content.split("\n\n");
  expect(blocks.find((b) => b.includes("id: q1"))).toContain("triage: needs_reply");
  expect(blocks.find((b) => b.includes("id: n2"))).toContain("triage: ignore");
  expect(blocks.find((b) => b.includes("id: x9"))).not.toContain("triage:");
  const read = await call("mail_support_read", { message_id: "q1" });
  if (read.type !== "result") throw new Error("expected a result");
  expect(read.output.content).toContain("triage: needs_reply");
});

test("triage is off by default: no judgment, every message reaches the routine unlabelled", async () => {
  m = await mailSetup();
  const judge = sortingJudge();
  m.deps.judge = judge;
  const { account, routine, watch } = await watchedMailbox(m);
  expect((await getMailAccountView(m.f.db, m.f.org.id, account.id)).triage).toBe(false);

  expect(await ingestMail(m.deps, watch.id, [mail("n1", "news@shop.com", "Weekly deals")])).toEqual({
    added: 1,
    fired: true,
  });
  expect(judge.calls).toHaveLength(0);
  const [run] = await runsOf(m, routine.id);
  const event = run?.event as { summary: string; messages: { triage?: string }[] };
  expect(event.messages[0]?.triage).toBeUndefined();
  expect(event.summary).not.toContain("[ignore]");
});

test("a judge that fails, or none at all, lets the mail through unlabelled", async () => {
  m = await mailSetup();
  m.deps.judge = {
    name: "down",
    ask: async () => {
      throw new Error("judge unavailable");
    },
  };
  const { account, routine, watch } = await watchedMailbox(m);
  await updateMailAccount(m.deps, m.f.owner.id, m.f.org.id, account.id, { triage: true });
  expect(await ingestMail(m.deps, watch.id, [mail("n1", "news@shop.com", "Weekly deals")])).toEqual({
    added: 1,
    fired: true,
  });
  m.deps.judge = null;
  expect(await ingestMail(m.deps, watch.id, [mail("n2", "news@shop.com", "More deals")])).toEqual({
    added: 1,
    fired: false,
  });
  const [run] = await runsOf(m, routine.id);
  const event = run?.event as { messages: { id: string; triage?: string }[] };
  expect(event.messages.map((x) => [x.id, x.triage])).toEqual([
    ["n1", undefined],
    ["n2", undefined],
  ]);
  expect(await m.f.db.select().from(schema.mailTriage)).toEqual([]);
});

test("an unsure judge never drops mail: ignore needs a clear call", async () => {
  m = await mailSetup();
  m.deps.judge = createFakeJudge((kind) =>
    kind === "mail_triage"
      ? { choice: "ignore", probabilities: { ignore: 0.5, important: 0.3, needs_reply: 0.2 } }
      : undefined,
  );
  const { account, routine, watch } = await watchedMailbox(m);
  await updateMailAccount(m.deps, m.f.owner.id, m.f.org.id, account.id, { triage: true });
  expect(await ingestMail(m.deps, watch.id, [mail("u1", "x@acme.com", "Hmm")])).toEqual({ added: 1, fired: true });
  const [run] = await runsOf(m, routine.id);
  const event = run?.event as { messages: { triage?: string }[] } | undefined;
  expect(event?.messages[0]?.triage).toBe("important");
});

/** The jobs waiting their time (an unclaimed email's check waits ten minutes) are due now. */
async function runDueLater(x: MailFixture) {
  await x.f.db.update(schema.outbox).set({ nextAttemptAt: new Date(0) });
  await drainOutbox(x.f.db, x.f.handlers);
}

const ownerNotices = (x: MailFixture) =>
  x.f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, x.f.owner.id), eq(schema.notifications.kind, "mail_important")))
    .then((rows) =>
      rows.map((r) => ({
        id: r.id,
        count: r.count,
        doneAt: r.doneAt,
        source: r.source as Partial<NotificationSource>,
        latest: r.latest as NotificationLatest,
      })),
    );

test("important mail no routine takes is told to the mailbox's owner, once, after other watches had their turn", async () => {
  m = await mailSetup();
  const judge = sortingJudge();
  m.deps.judge = judge;
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");
  const deps: RoutineDeps = { db: m.f.db, pubsub: m.f.pubsub, mail: m.mail };
  const routine = await createRoutine(deps, m.f.owner.id, m.f.org.id, {
    agentId: m.f.agent.id,
    prompt: "Answer Acme's mail",
    target: { type: "dm" },
    trigger: { type: "email", accountId: account.id, folder: "INBOX", filter: { from: ["@acme.com"] } },
  });
  const [watch] = await m.f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, routine.id));
  if (!watch) throw new Error("no watch");
  await updateMailAccount(m.deps, m.f.owner.id, m.f.org.id, account.id, { triage: true });

  // Outside the routine's filter: a contract (important), a promotion (ignore), and one another routine will take.
  expect(
    await ingestMail(m.deps, watch.id, [
      mail("c1", "legal@bank.com", "Contract renewal due Friday", "Sign by Friday"),
      mail("p1", "news@shop.com", "Weekly deals"),
      mail("t1", "boss@other.com", "Board meeting moved"),
    ]),
  ).toEqual({ added: 0, fired: false });
  expect(judge.calls.map((c) => c.state.subject).sort()).toEqual([
    "Board meeting moved",
    "Contract renewal due Friday",
    "Weekly deals",
  ]);
  // Another watch of the mailbox took one of them meanwhile.
  const other = await createRoutine(deps, m.f.owner.id, m.f.org.id, {
    agentId: m.f.agent.id,
    prompt: "Everything else",
    target: { type: "dm" },
    trigger: { type: "email", accountId: account.id, folder: "INBOX", filter: {} },
  });
  const [otherWatch] = await m.f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, other.id));
  if (!otherWatch) throw new Error("no watch");
  expect(await ingestMail(m.deps, otherWatch.id, [mail("t1", "boss@other.com", "Board meeting moved")])).toEqual({
    added: 1,
    fired: true,
  });
  expect(await ownerNotices(m)).toHaveLength(0);

  await runDueLater(m);
  const notices = await ownerNotices(m);
  expect(notices.map((n) => [n.source.label, n.latest.title, n.latest.text])).toEqual([
    ["support@example.com", "Contract renewal due Friday", "legal@bank.com · Contract renewal due Friday"],
  ]);
  // On the phone, in the person's language: the mailbox, then who sent what.
  expect(
    renderPush("pt-BR", {
      kind: "mail_important",
      waiting: false,
      label: notices[0]?.source.label,
      text: notices[0]?.latest.text,
    }),
  ).toEqual({
    title: "E-mail importante em support@example.com",
    body: "legal@bank.com · Contract renewal due Friday",
  });
  // The same email again (a retried delivery): judged once, told once.
  await ingestMail(m.deps, watch.id, [mail("c1", "legal@bank.com", "Contract renewal due Friday", "Sign by Friday")]);
  await runDueLater(m);
  expect(await ownerNotices(m)).toHaveLength(1);
  // Done by its owner, then delivered once more: it stays done, and nothing new comes.
  const [told] = await ownerNotices(m);
  if (!told) throw new Error("no notice");
  await markNotificationDone({ db: m.f.db, pubsub: m.f.pubsub }, m.f.owner.id, m.f.org.id, told.id, true);
  await ingestMail(m.deps, watch.id, [mail("c1", "legal@bank.com", "Contract renewal due Friday", "Sign by Friday")]);
  await runDueLater(m);
  const after = await ownerNotices(m);
  expect(after.map((n) => [n.id, n.count, n.doneAt !== null])).toEqual([[told.id, 1, true]]);
  expect(judge.calls).toHaveLength(3);
});

test("with triage off, mail outside the routine's filter is neither judged nor told", async () => {
  m = await mailSetup();
  const judge = sortingJudge();
  m.deps.judge = judge;
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");
  const routine = await createRoutine({ db: m.f.db, pubsub: m.f.pubsub, mail: m.mail }, m.f.owner.id, m.f.org.id, {
    agentId: m.f.agent.id,
    prompt: "Answer Acme's mail",
    target: { type: "dm" },
    trigger: { type: "email", accountId: account.id, folder: "INBOX", filter: { from: ["@acme.com"] } },
  });
  const [watch] = await m.f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, routine.id));
  if (!watch) throw new Error("no watch");
  await ingestMail(m.deps, watch.id, [mail("c1", "legal@bank.com", "Contract renewal due Friday")]);
  await runDueLater(m);
  expect(judge.calls).toHaveLength(0);
  expect(await ownerNotices(m)).toHaveLength(0);
});

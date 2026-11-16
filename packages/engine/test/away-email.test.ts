import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  AWAY_EMAIL_DEFAULT_MINUTES,
  addChannelMember,
  drainOutbox,
  listMembers,
  listNotifications,
  markActive,
  markNotificationDone,
  markNotificationRead,
  noticePrefsView,
  notify,
  postPersonMessage,
  queueAwayEmails,
  setAwayEmail,
  setMyStatus,
  snoozeNotification,
  touchLastSeen,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const URL_ = "https://x.test";
const MIN = 60_000;

/** Bia in #general with her handle, so `@` mentions reach the owner. */
async function bia() {
  const u = await addMember(f.db, f.org.id, "member", "bia");
  await listMembers(f.db, f.org.id);
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  return u;
}

const ownerHandle = async () => {
  const [m] = await f.db
    .select({ handle: schema.organizationMembers.handle })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
  return m?.handle ?? "";
};

const post = async (userId: string, body: string) => {
  const m = await postPersonMessage(deps(), userId, f.org.id, f.general.id, { body });
  await drainOutbox(f.db, f.handlers);
  return m;
};

/** When the owner last had the workspace open. */
const activeAt = (at: Date | null) =>
  f.db
    .update(schema.organizationMembers)
    .set({ activeAt: at })
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));

const sent = async () =>
  (await f.db.select().from(schema.outbox)).filter(
    (j) => j.kind === "email.send" && (j.payload as { template?: { kind?: string } }).template?.kind === "away_digest",
  );

const templateOf = (job: { payload: unknown }) =>
  (job.payload as { to: string[]; template: Record<string, unknown> & { items: Record<string, unknown>[] } }).template;

test("away past their wait: one email of the mentions they haven't read, and none again for the same things", async () => {
  f = await setup();
  const b = await bia();
  await activeAt(new Date(Date.now() - MIN));
  await post(b.id, `@${await ownerHandle()} can you look at the October invoices?`);
  const later = new Date(Date.now() + 2 * 3600_000);

  expect(await queueAwayEmails(f.db, URL_, later)).toBe(1);
  expect(await queueAwayEmails(f.db, URL_, later)).toBe(0);
  expect(await queueAwayEmails(f.db, URL_, new Date(later.getTime() + 3 * 3600_000))).toBe(0);
  const jobs = await sent();
  expect(jobs).toHaveLength(1);
  const job = jobs[0];
  expect(job?.payload).toMatchObject({ to: [f.owner.email] });
  const t = templateOf(job as { payload: unknown });
  expect(t).toMatchObject({
    kind: "away_digest",
    orgName: f.org.name,
    minutes: AWAY_EMAIL_DEFAULT_MINUTES,
    url: `${URL_}/org/${f.org.id}/notifications`,
  });
  expect(t.items).toEqual([
    { group: "mentions", name: "bia", place: "#general", text: expect.stringContaining("October invoices") },
  ]);
});

test("DMs and an agent's finished work go in, each in its group; reactions and approvals stay in the app", async () => {
  f = await setup();
  const b = await bia();
  await activeAt(new Date(Date.now() - MIN));
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [f.owner.id],
    kind: "dm",
    groupKey: "dm:1",
    actor: { type: "user", id: b.id },
    source: { channelId: f.general.id },
    latest: { text: "Lunch at noon?" },
  });
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [f.owner.id],
    kind: "agent_reply",
    groupKey: "agent_reply:1",
    actor: { type: "agent", id: f.agent.id },
    source: { channelId: f.general.id, label: "general" },
    latest: { text: "The report is in the Drive." },
  });
  for (const kind of ["reaction", "approval"] as const)
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [f.owner.id],
      kind,
      groupKey: `${kind}:1`,
      actor: { type: "user", id: b.id },
      source: { channelId: f.general.id },
      latest: { text: "not in the email" },
    });

  expect(await queueAwayEmails(f.db, URL_, new Date(Date.now() + 2 * 3600_000))).toBe(1);
  const t = templateOf((await sent())[0] as { payload: unknown });
  expect(t.items.map((i) => [i.group, i.name, i.text])).toEqual(
    expect.arrayContaining([
      ["dms", "bia", "Lunch at noon?"],
      ["done", f.agent.name, "The report is in the Drive."],
    ]),
  );
  expect(t.items).toHaveLength(2);
  expect(JSON.stringify(t)).not.toContain("not in the email");
});

test("nobody who had the workspace open within their wait, or never seen, or who turned it off", async () => {
  f = await setup();
  const b = await bia();
  await post(b.id, `@${await ownerHandle()} ping`);
  const later = new Date(Date.now() + 2 * 3600_000);

  // Never seen: not known to be away.
  await activeAt(null);
  expect(await queueAwayEmails(f.db, URL_, later)).toBe(0);
  // Here 30 minutes before, with a wait of an hour.
  await activeAt(new Date(later.getTime() - 30 * MIN));
  expect(await queueAwayEmails(f.db, URL_, later)).toBe(0);
  // Away long enough, but off.
  await activeAt(new Date(Date.now() - MIN));
  await setAwayEmail(f.db, f.org.id, f.owner.id, 0);
  expect(await queueAwayEmails(f.db, URL_, later)).toBe(0);
  expect(await sent()).toHaveLength(0);
});

test("what they read, marked done or snoozed in the app is no news", async () => {
  f = await setup();
  const b = await bia();
  await activeAt(new Date(Date.now() - MIN));
  const later = new Date(Date.now() + 2 * 3600_000);
  const handle = await ownerHandle();
  for (const word of ["one", "two", "three"]) await post(b.id, `@${handle} ${word}`);
  const { items } = await listNotifications(deps(), f.owner.id, f.org.id, {});
  const [first, second, third] = items;
  await markNotificationRead(deps(), f.owner.id, f.org.id, first?.id ?? "", true);
  await markNotificationDone(deps(), f.owner.id, f.org.id, second?.id ?? "", true);
  await snoozeNotification(deps(), f.owner.id, f.org.id, third?.id ?? "", new Date(later.getTime() + 3600_000));

  expect(await queueAwayEmails(f.db, URL_, later)).toBe(0);
});

test("news after an email waits out the wait again, and the next email has only the new things", async () => {
  f = await setup();
  const b = await bia();
  await activeAt(new Date(Date.now() - MIN));
  const handle = await ownerHandle();
  await post(b.id, `@${handle} first`);
  const t0 = new Date(Date.now() + 2 * 3600_000);
  expect(await queueAwayEmails(f.db, URL_, t0)).toBe(1);

  // As if that email had gone just now: what comes next waits out the hour from it.
  await f.db
    .update(schema.organizationMembers)
    .set({ awayEmailAt: new Date() })
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
  await post(b.id, `@${handle} second`);
  expect(await queueAwayEmails(f.db, URL_, new Date(Date.now() + 15 * MIN))).toBe(0);
  expect(await queueAwayEmails(f.db, URL_, new Date(Date.now() + 61 * MIN))).toBe(1);
  const jobs = await sent();
  expect(jobs).toHaveLength(2);
  // The second email has the new thing alone.
  expect(jobs.map((j) => templateOf(j).items.map((i) => i.text))).toContainEqual([expect.stringContaining("second")]);
});

test("two ticks at once queue one email", async () => {
  f = await setup();
  const b = await bia();
  await activeAt(new Date(Date.now() - MIN));
  await post(b.id, `@${await ownerHandle()} ping`);
  const later = new Date(Date.now() + 2 * 3600_000);

  const counts = await Promise.all([queueAwayEmails(f.db, URL_, later), queueAwayEmails(f.db, URL_, later)]);
  expect(counts[0] + counts[1]).toBe(1);
  expect(await sent()).toHaveLength(1);
});

test("a workspace being deleted emails nobody", async () => {
  f = await setup();
  const b = await bia();
  await activeAt(new Date(Date.now() - MIN));
  await post(b.id, `@${await ownerHandle()} ping`);
  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 7 * 24 * 3600_000) })
    .where(eq(schema.organizations.id, f.org.id));

  expect(await queueAwayEmails(f.db, URL_, new Date(Date.now() + 2 * 3600_000))).toBe(0);
});

test("a suspended workspace, a blocked account or one waiting for its deletion gets no email of what was said", async () => {
  const later = () => new Date(Date.now() + 2 * 3600_000);
  const ready = async () => {
    f = await setup();
    const b = await bia();
    await activeAt(new Date(Date.now() - MIN));
    await post(b.id, `@${await ownerHandle()} the payroll file`);
  };

  await ready();
  await f.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, f.org.id));
  expect(await queueAwayEmails(f.db, URL_, later())).toBe(0);
  await f.close();

  await ready();
  await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, f.owner.id));
  expect(await queueAwayEmails(f.db, URL_, later())).toBe(0);
  await f.close();

  await ready();
  await f.db
    .update(schema.users)
    .set({ deletionDueAt: new Date(Date.now() + 7 * 24 * 3600_000) })
    .where(eq(schema.users.id, f.owner.id));
  expect(await queueAwayEmails(f.db, URL_, later())).toBe(0);
  expect(await sent()).toHaveLength(0);
});

test("having the workspace open moves when they were active, hidden too, without giving a hidden person away", async () => {
  f = await setup();
  const member = async () => {
    const [m] = await f.db
      .select()
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
    return m;
  };
  const t1 = new Date("2026-11-01T10:00:00Z");
  await touchLastSeen(f.db, f.org.id, f.owner.id, t1);
  expect(await member()).toMatchObject({ lastSeenAt: t1, activeAt: t1 });

  await setMyStatus(deps(), f.owner.id, f.org.id, { availability: "hidden" });
  const t2 = new Date("2026-11-01T11:00:00Z");
  await touchLastSeen(f.db, f.org.id, f.owner.id, t2);
  expect(await member()).toMatchObject({ lastSeenAt: t1, activeAt: t2 });

  // While the socket stays open: only the private mark moves.
  const t3 = new Date("2026-11-01T11:05:00Z");
  await markActive(f.db, f.org.id, f.owner.id, t3);
  expect(await member()).toMatchObject({ lastSeenAt: t1, activeAt: t3 });
});

test("each person picks their wait in this workspace, off included, from the offered choices", async () => {
  f = await setup();
  expect((await noticePrefsView(f.db, f.org.id, f.owner.id)).awayEmail).toBe(AWAY_EMAIL_DEFAULT_MINUTES);
  expect((await setAwayEmail(f.db, f.org.id, f.owner.id, 15)).awayEmail).toBe(15);
  expect((await noticePrefsView(f.db, f.org.id, f.owner.id)).awayEmail).toBe(15);
  expect((await setAwayEmail(f.db, f.org.id, f.owner.id, 0)).awayEmail).toBe(0);
  await expect(setAwayEmail(f.db, f.org.id, f.owner.id, 7)).rejects.toBeInstanceOf(ValidationError);
  // Someone not in the workspace has nothing to change there.
  const outsider = await addUser(f.db, "zed");
  await expect(setAwayEmail(f.db, f.org.id, outsider.id, 15)).rejects.toThrow();
});

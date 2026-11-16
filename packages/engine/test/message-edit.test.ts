import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  drainOutbox,
  editMessage,
  listMessages,
  MESSAGE_EDIT_WINDOW_MS,
  postPersonMessage,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const post = (body: string, options: { userId?: string; threadId?: string } = {}) =>
  postPersonMessage(deps(), options.userId ?? f.owner.id, f.org.id, f.general.id, {
    body,
    threadId: options.threadId,
  });
const edit = (messageId: string, body: string, options: { userId?: string; redo?: boolean } = {}) =>
  editMessage(deps(), options.userId ?? f.owner.id, f.org.id, messageId, {
    body,
    ...(options.redo ? { redo: true } : {}),
  });
const runs = async () =>
  (await f.db.select().from(schema.agentRuns)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const row = async (id: string) => (await f.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0];
const listed = (id: string) =>
  listMessages(f.db, f.owner.id, f.org.id, f.general.id).then((all) => all.find((m) => m.id === id));

describe("editing a message", () => {
  test("its author fixes a message nobody answered: the text changes in place, marked edited, for everyone", async () => {
    f = await setup();
    const sent = await post("reunião às 10h");
    const events = f.listen(f.general.id);

    const result = await edit(sent.id, "reunião às 11h");

    expect(result.message.id).toBe(sent.id);
    expect(result.message.body).toBe("reunião às 11h");
    expect(result.runs).toEqual([]);
    const shown = await listed(sent.id);
    expect(shown?.body).toBe("reunião às 11h");
    expect(typeof shown?.editedAt).toBe("string");
    // Everyone's apps change it in place; nothing new is posted, so nobody gets an unread.
    expect(events.map((e) => e.type)).toEqual(["message.edited"]);
    expect(events[0]).toMatchObject({ messageId: sent.id, body: "reunião às 11h", threadId: null });
    // Found by its new words.
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "search.index"));
    expect(jobs.filter((j) => (j.payload as { sourceId?: string }).sourceId === sent.id).length).toBeGreaterThan(1);
    // Audited without the words (an admin reads the log, not every conversation).
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "message.edited")));
    expect(audit?.targetId).toBe(sent.id);
    expect(JSON.stringify(audit?.details)).not.toContain("11h");
    expect(audit?.details).toMatchObject({ before: 14, after: 14, redo: false });
  });

  test("the same text again changes nothing", async () => {
    f = await setup();
    const sent = await post("oi");
    const events = f.listen(f.general.id);
    await edit(sent.id, "  oi ");
    expect((await row(sent.id))?.editedAt).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("only its author edits it, and only for a day", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const sent = await post("texto");
    await expect(edit(sent.id, "outro", { userId: bia.id })).rejects.toMatchObject({ code: "message.edit_not_yours" });

    await f.db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() - MESSAGE_EDIT_WINDOW_MS - 60_000) })
      .where(eq(schema.messages.id, sent.id));
    await expect(edit(sent.id, "outro")).rejects.toMatchObject({ code: "message.edit_expired" });
    expect((await row(sent.id))?.body).toBe("texto");
  });

  test("an empty or too long text is refused like a new message", async () => {
    f = await setup();
    const sent = await post("texto");
    await expect(edit(sent.id, "   ")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(edit(sent.id, "a".repeat(100_001))).rejects.toMatchObject({ code: "message.too_long" });
  });

  test("a voice message's words aren't edited", async () => {
    f = await setup();
    const sent = await post("o que eu disse");
    await f.db
      .update(schema.messages)
      .set({ meta: { voice: { clipId: Bun.randomUUIDv7() } } })
      .where(eq(schema.messages.id, sent.id));
    await expect(edit(sent.id, "outra coisa")).rejects.toMatchObject({ code: "message.not_editable" });
  });

  test("a message an agent answered isn't changed under its answer: only Edit and redo", async () => {
    f = await setup();
    const sent = await post("@dev resume o relatório de março");
    await drainOutbox(f.db, f.handlers);
    await expect(edit(sent.id, "@dev resume o relatório de abril")).rejects.toMatchObject({
      code: "message.edit_answered",
    });
    expect((await row(sent.id))?.body).toBe("@dev resume o relatório de março");
    expect((await row(sent.id))?.editedAt).toBeNull();
  });
});

describe("edit and redo the answer", () => {
  test("the agent answers the new text, told it was edited, and its earlier answer stays", async () => {
    const requests: ModelRequest[] = [];
    f = await setup({
      reply: (req: ModelRequest) => {
        requests.push(req);
        return { chunks: [requests.length === 1 ? "Resumo de março." : "Resumo de abril."] };
      },
    });
    const sent = await post("@dev resume o relatório de março");
    await drainOutbox(f.db, f.handlers);
    const [first] = await runs();
    expect(first?.status).toBe("done");
    const events = f.listen(f.general.id);

    const result = await edit(sent.id, "@dev resume o relatório de abril", { redo: true });

    expect(result.message.body).toBe("@dev resume o relatório de abril");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.agentId).toBe(f.agent.id);
    expect(events.map((e) => e.type)).toContain("message.edited");
    await drainOutbox(f.db, f.handlers);

    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["done", "done"]);
    // The new run is woken by the notice of the edit, never a second run on the same message.
    const notice = await row(all[1]?.triggerMessageId ?? "");
    expect((notice?.meta.notice as { kind?: string } | undefined)?.kind).toBe("message_edited");
    // What the agent read: the message as it is now and the edit, with what it said before.
    const read = JSON.stringify(requests[1]?.messages);
    expect(read).toContain("relatório de abril");
    expect(read).toContain("edited");
    expect(read).toContain("relatório de março");
    // Its first answer is still in the conversation; the new one comes after it.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const bodies = timeline.map((m) => m.body);
    expect(bodies).toContain("Resumo de março.");
    expect(bodies.indexOf("Resumo de abril.")).toBeGreaterThan(bodies.indexOf("Resumo de março."));
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "message.edited")));
    expect(audit?.details).toMatchObject({ redo: true, agentIds: [f.agent.id] });
  });

  test("a run still on it stops, and the new one starts on the edited text", async () => {
    f = await setup();
    const sent = await post("@dev compila a branch main");
    const [first] = await runs();
    expect(first?.status).toBe("queued");
    // Its receipts already name the run, so the apps offer only "Edit and redo" while it is still at work.
    expect((await listed(sent.id))?.receipts?.handled).toMatchObject([{ agentId: f.agent.id, status: "queued" }]);

    const result = await edit(sent.id, "@dev compila a branch dev", { redo: true });

    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["canceled", "queued"]);
    expect(result.runs).toEqual([{ agentId: f.agent.id, runId: all[1]?.id ?? "" }]);
  });

  test("only the last thing its author said in that conversation can be redone", async () => {
    f = await setup();
    const sent = await post("@dev compila");
    await drainOutbox(f.db, f.handlers);
    await post("e roda os testes");
    await expect(edit(sent.id, "@dev compila a dev", { redo: true })).rejects.toMatchObject({
      code: "message.redo_not_latest",
    });
    expect((await row(sent.id))?.body).toBe("@dev compila");
  });
});

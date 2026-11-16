import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { getMessage, type Message, readTaskTree, readTreeCursor, treeChanges, treeCursor, treeVerdict } from "../src";
import { closeWorlds, type Script, type World, world } from "./autonomy/harness";

// A task's whole job, as an app waiting on it through MCP reads it (ADR 0119 addendum 2026-11-15).

afterEach(closeWorlds);

/** A person's message in the world's conversation, as stored (the task an app sent). */
async function sendTask(w: World, body: string) {
  const view = await w.say(body);
  const task = await getMessage(w.db, w.org.id, view.id);
  if (!task) throw new Error("no message");
  return task;
}

async function job(w: World, task: Message) {
  const roots = await w.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, task.id));
  const tree = await readTaskTree(w.db, task, roots);
  const parentOf = (id: string | null) => {
    const parent = tree.nodes.find((n) => n.id === id);
    return parent ? `${parent.via}:${w.handleOf(parent.agentId)}` : null;
  };
  return {
    tree,
    verdict: treeVerdict(tree, task.channelId),
    rows: tree.nodes.map((n) => [n.via, w.handleOf(n.agentId), n.state, parentOf(n.parentId)]),
  };
}

const replyOf = async (w: World, runId: string) =>
  (await w.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, runId))).map((m) => m.body);

describe("the job of a task", () => {
  test("a note handed to a colleague holds it until the result is read back; then the follow-up is its answer", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = await world({
      agents: ["ada", "rui"],
      script: {
        ada: [
          { calls: [{ name: "tell_agent", input: { agent: "@rui", message: "Roda a migração 0141, por favor." } }] },
          { text: "Pedi ao Rui para rodar a migração." },
          { text: "Ana, o Rui rodou a migração 0141." },
        ],
        rui: [{ text: "Rodei a migração 0141.", hold: gate }],
      },
    });
    const task = await sendTask(w, "@ada pede pro rui rodar a migração");
    const draining = w.settle();
    for (let i = 0; i < 500 && w.prompts("rui").length === 0; i++) await Bun.sleep(10);
    expect(w.prompts("rui")).toHaveLength(1);

    const during = await job(w, task);
    expect(during.verdict.kind).toBe("working");
    expect(during.rows).toEqual([
      ["task", "ada", "done", null],
      ["note", "rui", "working", "task:ada"],
    ]);
    const cursor = treeCursor(task.id, during.tree.nodes);

    release();
    await draining;
    await w.settle();
    const after = await job(w, task);
    expect(after.rows).toEqual([
      ["task", "ada", "done", null],
      ["note", "rui", "done", "task:ada"],
      ["result", "ada", "done", "task:ada"],
    ]);
    if (after.verdict.kind !== "settled") throw new Error(`not settled: ${after.verdict.kind}`);
    expect(await replyOf(w, after.verdict.last.id)).toEqual(["Ana, o Rui rodou a migração 0141."]);
    // A message of the job still being routed may wake another agent: the job waits for it.
    const [reply] = await w.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.agentRunId, after.verdict.last.id));
    const [routing] = await w.db
      .insert(schema.outbox)
      .values({ orgId: w.org.id, kind: "message.posted", payload: { messageId: reply?.id } })
      .returning();
    expect((await job(w, task)).verdict.kind).toBe("working");
    await w.db.delete(schema.outbox).where(eq(schema.outbox.id, routing?.id as string));
    expect((await job(w, task)).verdict.kind).toBe("settled");
    // Both moves since the cursor, none lost.
    expect(treeChanges(readTreeCursor(cursor, task.id), after.tree.nodes)).toEqual([
      { id: after.tree.nodes[1]?.id as string, state: "done", previous: "working" },
      { id: after.tree.nodes[2]?.id as string, state: "done", previous: null },
    ]);
  });

  test("a three-deep chain of questions is one job, settled with the answer that rolled up", async () => {
    const relay =
      (next: string | null, part: string): Script =>
      ({ n, last }) => {
        const answer = /\[Reply to your question to [^\]]*\]: (.*)/s.exec(last)?.[1];
        if (answer) return { text: `${part}; ${answer.trim()}` };
        if (!next) return n === 1 ? { text: part } : undefined;
        if (n === 1)
          return { calls: [{ name: "ask_agent", input: { agent: `@${next}`, question: "Prepara o release." } }] };
        if (n === 2) return { text: `Pedi a @${next}; já volto.` };
        return undefined;
      };
    const w = await world({
      agents: ["chefe", "rita", "igor", "eva"],
      judge: {
        mention: Object.fromEntries(
          ["chefe", "rita", "igor", "eva"].map((h) => [h, { handoff: 0.05, needsNothing: 0.95 }]),
        ),
      },
      script: {
        chefe: relay("rita", "Release"),
        rita: relay("igor", "changelog pronto"),
        igor: relay("eva", "testes ok"),
        eva: relay(null, "notas da versão 2.3 prontas"),
      },
    });
    const task = await sendTask(w, "@chefe prepara o release");
    await w.settle();
    const { rows, verdict } = await job(w, task);
    expect(rows).toEqual([
      ["task", "chefe", "done", null],
      ["question", "rita", "done", "task:chefe"],
      ["result", "chefe", "done", "task:chefe"],
      ["question", "igor", "done", "question:rita"],
      ["question", "eva", "done", "question:igor"],
    ]);
    if (verdict.kind !== "settled") throw new Error(`not settled: ${verdict.kind}`);
    expect((await replyOf(w, verdict.last.id)).join(" ")).toContain("2.3");
  });

  test("a heads-up's colleague still at work holds nothing", async () => {
    const w = await world({
      agents: ["ada", "rui", "eva"],
      script: {
        ada: [
          { calls: [{ name: "tell_agent", input: { agent: "@rui", message: "Fecha a versão 2.3." } }] },
          { text: "Pedi ao Rui." },
          { text: "Ana, o Rui fechou a 2.3." },
        ],
        rui: [
          {
            calls: [{ name: "tell_agent", input: { agent: "@eva", message: "A 2.3 está fechada.", heads_up: true } }],
          },
          { text: "Fechei a 2.3 e avisei a Eva." },
        ],
        eva: [{ text: "Anotado." }],
      },
    });
    const task = await sendTask(w, "@ada pede pro rui fechar a versão");
    await w.settle();
    const [evaRun] = await w.runs("eva");
    if (!evaRun) throw new Error("eva never ran");
    await w.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, evaRun.id));
    const { rows, verdict } = await job(w, task);
    // The heads-up closed as it was sent; Eva's run, still at work, joins the job by no other way.
    expect(rows).toEqual([
      ["task", "ada", "done", null],
      ["note", "rui", "done", "task:ada"],
      ["result", "ada", "done", "task:ada"],
      ["heads_up", "eva", "done", "note:rui"],
    ]);
    expect(verdict.kind).toBe("settled");
  });

  test("a cursor is tied to its task", () => {
    const taskId = Bun.randomUUIDv7();
    const cursor = treeCursor(taskId, [{ id: taskId, state: "working" }]);
    expect([...readTreeCursor(cursor, taskId).values()]).toEqual(["working"]);
    expect(() => readTreeCursor(cursor, Bun.randomUUIDv7())).toThrow("another task");
    expect(() => readTreeCursor("not a cursor", taskId)).toThrow("another task");
  });
});

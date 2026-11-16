import { afterEach, expect, test } from "bun:test";
import {
  CHECKPOINTS_PROTOCOL,
  type CheckpointRestoreReply,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  createJobHandlers,
  drainOutbox,
  FILES_UNDO_WINDOW_MS,
  listMessages,
  type MachineCaller,
  type MachineStatus,
  postPersonMessage,
  redoAgentAction,
  undoAgentAction,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** ADR 0193: a computer turn that changed files leaves a receipt on its reply; Desfazer runs on that computer. */

let f: Fixture;
afterEach(() => f?.close());

const CHECKPOINT = { id: "ab".repeat(16), count: 2, paths: ["src/a.ts", "README.md"] };

async function turnWithFiles() {
  f = await setup();
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    os: "linux",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/home/w/agentes",
    exec: true,
  });
  await f.db.update(schema.agents).set({ machineId, brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
  const status = (id: string): MachineStatus => ({
    id,
    orgId: f.org.id,
    name: "Box",
    online: true,
    execAllowed: true,
    os: "linux",
    protocol: MACHINE_PROTOCOL_VERSION,
    executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  });
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "usage", input: 40, output: 5, source: "plan", model: "claude-sonnet-5-5" };
      yield { type: "done", text: "Arrumei os dois arquivos.", checkpoint: CHECKPOINT };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => status(id) },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev arruma isso",
  });
  await drainOutbox(f.db, handlers);
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  const reply = timeline.find((m) => m.author.type === "agent");
  return { machineId, reply };
}

/** The computer's side of `checkpoint.restore`: what it was asked, answering `answer`, on a runner of `protocol`. */
function fakeHub(answer: () => CheckpointRestoreReply, protocol: number | null = MACHINE_PROTOCOL_VERSION) {
  const asked: { machineId: string; request: MachineRequest }[] = [];
  const hub = {
    call: async (machineId: string, request: MachineRequest) => {
      asked.push({ machineId, request });
      return answer();
    },
    status: async (id: string) => (protocol === null ? null : { id, online: true, protocol }),
  } as unknown as MachineCaller;
  return { hub, asked };
}

test("the turn's reply carries a files.changed receipt that undoes and redoes on its computer", async () => {
  const { machineId, reply } = await turnWithFiles();
  expect(reply?.body).toBe("Arrumei os dois arquivos.");
  const [receipt] = reply?.actions ?? [];
  expect(receipt).toMatchObject({
    kind: "files.changed",
    target: { type: "files", id: CHECKPOINT.id },
    params: { count: 2, paths: ["src/a.ts", "README.md"] },
  });
  if (!receipt) throw new Error("no receipt");
  const window = Date.parse(receipt.undoableUntil) - Date.parse(receipt.createdAt);
  expect(window).toBe(FILES_UNDO_WINDOW_MS);

  const { hub, asked } = fakeHub(() => ({ status: "restored", paths: CHECKPOINT.paths }));
  const deps = { db: f.db, pubsub: f.pubsub, hub };
  const undone = await undoAgentAction(deps, f.owner.id, f.org.id, receipt.id);
  expect(undone.undoneAt).not.toBeNull();
  expect(asked[0]).toMatchObject({
    machineId,
    request: { op: "checkpoint.restore", id: CHECKPOINT.id, direction: "undo", agent: { id: f.agent.id } },
  });
  const redone = await redoAgentAction(deps, f.owner.id, f.org.id, receipt.id);
  expect(redone.undoneAt).toBeNull();
  expect(asked[1]?.request).toMatchObject({ op: "checkpoint.restore", direction: "redo" });
});

test("a file changed since, a turn running there or a checkpoint the computer lost: nothing is marked undone", async () => {
  const { reply } = await turnWithFiles();
  const id = reply?.actions?.[0]?.id ?? "";
  let answer: CheckpointRestoreReply = { status: "conflict", paths: ["README.md"] };
  const { hub } = fakeHub(() => answer);
  const deps = { db: f.db, pubsub: f.pubsub, hub };

  await expect(undoAgentAction(deps, f.owner.id, f.org.id, id)).rejects.toMatchObject({
    code: "action.changed_since",
    message: expect.stringContaining("README.md"),
  });
  answer = { status: "busy", paths: [] };
  await expect(undoAgentAction(deps, f.owner.id, f.org.id, id)).rejects.toMatchObject({ code: "action.busy" });
  answer = { status: "gone", paths: [] };
  await expect(undoAgentAction(deps, f.owner.id, f.org.id, id)).rejects.toMatchObject({ code: "action.expired" });

  const [row] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.id, id));
  expect(row?.undoneAt).toBeNull();
  // A server without connected computers can't reach it.
  await expect(undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id)).rejects.toMatchObject({
    code: "action.not_undoable",
  });
});

test("a computer whose runner went back to before checkpoints, or that is gone, is never asked", async () => {
  const { reply } = await turnWithFiles();
  const id = reply?.actions?.[0]?.id ?? "";
  const older = fakeHub(() => ({ status: "restored", paths: [] }), CHECKPOINTS_PROTOCOL - 1);
  await expect(
    undoAgentAction({ db: f.db, pubsub: f.pubsub, hub: older.hub }, f.owner.id, f.org.id, id),
  ).rejects.toMatchObject({
    code: "action.expired",
  });
  const gone = fakeHub(() => ({ status: "restored", paths: [] }), null);
  await expect(
    undoAgentAction({ db: f.db, pubsub: f.pubsub, hub: gone.hub }, f.owner.id, f.org.id, id),
  ).rejects.toMatchObject({
    code: "action.target_gone",
  });
  expect([...older.asked, ...gone.asked]).toEqual([]);
});

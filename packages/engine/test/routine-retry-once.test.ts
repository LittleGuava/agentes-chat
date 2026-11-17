import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { closeRoutineRun, executeRoutineRun, routineFailureEnd, runRoutineNow, updateRoutine } from "../src";
import { ROUTINE_OWN_RETRY_AFTER_MS, reapRoutineRuns } from "../src/routine-ledger";
import { type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  channelRoutine,
  fire,
  minutesFromNow,
  notificationsOf,
  routineDeps,
  routineRow,
  routineRunRow,
} from "./routine-fixtures";

/** A routine's own "Tentar de novo uma vez se falhar" (ADR 0177 addendum 2026-11-16), with no right hand. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const MIN = 60_000;
const DOWN = "provider_error: down@Claude: 529 overloaded";
const REFUSED = "provider_error: invalid_key@Claude: refused";
const ledger = () => ({ db: f.db, pubsub: f.pubsub });

/** One run of the routine that fails with `error`, as a failed run leaves it. */
const failRun = async (routineRunId: string, error: string) => {
  const rr = await routineRunRow(f, routineRunId);
  const run = await agentRunRow(f, rr.agentRunId);
  await f.db.update(schema.agentRuns).set({ status: "failed", error }).where(eq(schema.agentRuns.id, run.id));
  await closeRoutineRun(ledger(), run, { status: "failed", ...routineFailureEnd(error) });
};
const failOnce = async (routineId: string, minutesAgo: number, error: string) => {
  const rr = await fire(f, routineId, minutesFromNow(-minutesAgo));
  await failRun(rr.id, error);
  return rr;
};
const runsOf = async (routineId: string) =>
  (await f.db.select().from(schema.routineRuns)).filter((r) => r.routineId === routineId);
const queuedOf = async (routineId: string) => (await runsOf(routineId)).filter((r) => r.status === "queued");
/** A routine with the switch on, its next slot hours away (so the clock never puts it inside the retry's room). */
const onRoutine = async (name?: string) => {
  const routine = await channelRoutine(f, { retryOnce: true, ...(name ? { name } : {}) });
  await f.db
    .update(schema.routines)
    .set({ nextRunAt: minutesFromNow(5 * 60) })
    .where(eq(schema.routines.id, routine.id));
  return routine;
};

describe("off, the default", () => {
  test("a new routine has it off, and its outside failure is told at once with nothing retried", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    expect(routine.retryOnce).toBe(false);
    expect((await routineRow(f, routine.id)).retryOnce).toBe(false);
    await failOnce(routine.id, 30, DOWN);
    expect(await queuedOf(routine.id)).toHaveLength(0);
    const [told] = await notificationsOf(f, "routine_failed");
    expect(told?.latest.retried).toBeUndefined();
  });
});

describe("on", () => {
  test("an outside failure is tried once more shortly, without the right hand, and told once if it fails too", async () => {
    f = await setup();
    const routine = await onRoutine();
    expect(routine.retryOnce).toBe(true);
    await failOnce(routine.id, 30, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(0);
    const [retry] = await queuedOf(routine.id);
    const wait = (retry?.at.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(ROUTINE_OWN_RETRY_AFTER_MS - MIN);
    expect(wait).toBeLessThanOrEqual(ROUTINE_OWN_RETRY_AFTER_MS);
    const [job] = await f.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.dedupeKey, `routine.run:${retry?.id}`));
    expect(job?.nextAttemptAt.getTime()).toBe(retry?.at.getTime());

    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    await failRun(retry?.id ?? "", DOWN);
    // Never a retry of a retry.
    expect(await queuedOf(routine.id)).toHaveLength(0);
    expect((await routineRow(f, routine.id)).failuresInRow).toBe(1);
    const told = await notificationsOf(f, "routine_failed");
    expect(told).toHaveLength(1);
    expect(told[0]?.latest).toMatchObject({ reason: "provider_error", retried: true });
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a retry that works leaves nothing to tell and no failure in a row", async () => {
    f = await setup();
    const routine = await onRoutine();
    await failOnce(routine.id, 30, DOWN);
    const [retry] = await queuedOf(routine.id);
    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    const run = await agentRunRow(f, (await routineRunRow(f, retry?.id ?? "")).agentRunId);
    await closeRoutineRun(ledger(), run, { status: "done", text: "Nada novo." });
    expect((await routineRow(f, routine.id)).failuresInRow).toBe(0);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(0);
  });

  test("every firing gets its one retry, each counted once, and the streak is told once", async () => {
    f = await setup();
    const routine = await onRoutine();
    for (const minutesAgo of [50, 30]) {
      await failOnce(routine.id, minutesAgo, DOWN);
      const [retry] = await queuedOf(routine.id);
      expect(retry).toBeDefined();
      await executeRoutineRun(routineDeps(f), retry?.id ?? "");
      await failRun(retry?.id ?? "", DOWN);
      expect(await queuedOf(routine.id)).toHaveLength(0);
    }
    expect((await routineRow(f, routine.id)).failuresInRow).toBe(2);
    expect(await runsOf(routine.id)).toHaveLength(4);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
  });

  test("a failure ended twice, or reaped after, queues one retry", async () => {
    f = await setup();
    const routine = await onRoutine();
    const first = await failOnce(routine.id, 30, DOWN);
    await failRun(first.id, DOWN);
    await reapRoutineRuns(ledger(), new Date(Date.now() + 60 * MIN));
    expect(await runsOf(routine.id)).toHaveLength(2);
  });

  test("a failure of the routine's own, or a slot too close, is told at once with no retry", async () => {
    f = await setup();
    const own = await onRoutine("Própria");
    await failOnce(own.id, 30, REFUSED);
    const close = await onRoutine("Perto");
    await f.db
      .update(schema.routines)
      .set({ nextRunAt: minutesFromNow(5) })
      .where(eq(schema.routines.id, close.id));
    await failOnce(close.id, 30, DOWN);
    expect(await queuedOf(own.id)).toHaveLength(0);
    expect(await queuedOf(close.id)).toHaveLength(0);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(2);
  });

  test("the failure that pauses the routine is not retried", async () => {
    f = await setup();
    const routine = await onRoutine();
    await f.db.update(schema.routines).set({ failuresInRow: 4 }).where(eq(schema.routines.id, routine.id));
    await failOnce(routine.id, 30, DOWN);
    expect(await routineRow(f, routine.id)).toMatchObject({ active: false, pausedReason: "failing" });
    expect(await queuedOf(routine.id)).toHaveLength(0);
  });

  test("with the right hand watching too, the switch's retry is the only one", async () => {
    f = await setup({ rightHand: true });
    const routine = await onRoutine();
    await f.db
      .update(schema.routines)
      .set({ nextRunAt: minutesFromNow(5 * 60) })
      .where(eq(schema.routines.id, routine.id));
    await failOnce(routine.id, 30, DOWN);
    const queued = await queuedOf(routine.id);
    expect(queued).toHaveLength(1);
    expect((queued[0]?.at.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(ROUTINE_OWN_RETRY_AFTER_MS);
    await executeRoutineRun(routineDeps(f), queued[0]?.id ?? "");
    await failRun(queued[0]?.id ?? "", DOWN);
    expect(await queuedOf(routine.id)).toHaveLength(0);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
  });

  test("a person's run in the retry's place that fails tells the held failure, once, as no retry", async () => {
    f = await setup();
    const routine = await onRoutine();
    await failOnce(routine.id, 30, DOWN);
    const [retry] = await queuedOf(routine.id);
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    expect((await routineRunRow(f, retry?.id ?? "")).status).toBe("superseded");
    const [manual] = (await queuedOf(routine.id)).filter((r) => r.trigger === "manual");
    await executeRoutineRun(routineDeps(f), manual?.id ?? "");
    await failRun(manual?.id ?? "", DOWN);
    const told = await notificationsOf(f, "routine_failed");
    expect(told).toHaveLength(1);
    expect(told[0]?.latest.retried).toBeUndefined();
  });

  test("a held failure whose retry never ran is told at the streak's next failure, once", async () => {
    f = await setup();
    const routine = await onRoutine();
    await failOnce(routine.id, 30, DOWN);
    const [retry] = await queuedOf(routine.id);
    const standing = (to: "active" | "hold") =>
      f.db.update(schema.organizations).set({ standing: to }).where(eq(schema.organizations.id, f.org.id));
    await standing("hold");
    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    expect((await routineRunRow(f, retry?.id ?? "")).status).toBe("skipped");
    await standing("active");
    await failOnce(routine.id, 5, DOWN);
    const told = await notificationsOf(f, "routine_failed");
    expect(told).toHaveLength(1);
    expect(told[0]?.latest.retried).toBeUndefined();
    // That firing has its own retry: its failure tells nothing more.
    const [again] = await queuedOf(routine.id);
    await executeRoutineRun(routineDeps(f), again?.id ?? "");
    await failRun(again?.id ?? "", DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
  });

  test("its editors turn it on and off", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const on = await updateRoutine(routineDeps(f), f.owner.id, f.org.id, routine.id, { retryOnce: true });
    expect(on.retryOnce).toBe(true);
    const off = await updateRoutine(routineDeps(f), f.owner.id, f.org.id, routine.id, { retryOnce: false });
    expect(off.retryOnce).toBe(false);
    const audit = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "routine.updated");
    expect(audit).toHaveLength(2);
  });
});

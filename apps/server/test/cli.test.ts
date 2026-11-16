import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "@agenteschat/cli";
import { and, eq, schema } from "@agenteschat/db";
import { browser, createTestServer, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

/**
 * The `agentes` command (ADR 0219) against the app in memory, through `/mcp` with a personal token, as a script in
 * CI would run it: what it prints and the exit code. Once more as a process over real HTTP at the end.
 */

let t: TestServer;
let replyText = "Here is the launch copy.";
beforeEach(async () => {
  replyText = "Here is the launch copy.";
  t = await createTestServer({ reply: () => ({ chunks: [replyText] }) });
});
afterEach(() => t.close());

async function setup(access: "read" | "write" = "write") {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const created = await b(`/api/app/organizations/${seeded.orgId}/tokens`, {
    json: { name: "Nightly CI", access, expiresInDays: 30 },
  });
  expect(created.status).toBe(201);
  const { secret, token } = (await created.json()) as { secret: string; token: { id: string } };
  return { b, secret, tokenId: token.id, ...seeded };
}

/** The command with the app in memory as its server; `drain` runs the agents' queued work after each answer. */
function agentes(secret: string, options: { drain?: boolean; stdin?: string } = {}) {
  return async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      env: { AGENTES_URL: ORIGIN, AGENTES_TOKEN: secret },
      fetch: async (url, init) => {
        const res = await t.app.request(url, init);
        if (options.drain) await t.drain();
        return res;
      },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: async () => options.stdin ?? "",
    });
    return { code, out: out.join(""), err: err.join("") };
  };
}

const jsonOf = (r: { out: string }) => JSON.parse(r.out) as Record<string, unknown>;

describe("send, wait and run", () => {
  test("send returns the task at once; wait times out with 4 while the agent hasn't run, then prints its reply", async () => {
    const { secret, orgId } = await setup();
    const cli = agentes(secret);
    const sent = await cli("send", "@dev", "Write the launch copy");
    expect(sent.code).toBe(0);
    const taskId = sent.out.trim();
    const [message] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, taskId));
    expect(message?.body).toBe("Write the launch copy");
    expect(message?.meta.via).toMatchObject({ kind: "app", name: "Nightly CI" });
    const [audit] = await t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, "apps.message_sent")));
    expect(audit?.details).toMatchObject({ client: "Nightly CI" });

    const early = await cli("wait", taskId, "--timeout", "1s");
    expect(early.code).toBe(4);
    expect(early.err).toContain(`agentes wait ${taskId}`);

    await t.drain();
    const done = await cli("wait", taskId, "--json");
    expect(done.code).toBe(0);
    expect(jsonOf(done)).toMatchObject({
      ok: true,
      exitCode: 0,
      command: "wait",
      task_id: taskId,
      status: "done",
      agent: { handle: "dev" },
      reply: { untrusted_text: "Here is the launch copy." },
    });
    expect((await cli("wait", taskId)).out).toBe("Here is the launch copy.\n");
  });

  test("the same --key sends once", async () => {
    const { secret } = await setup();
    const cli = agentes(secret);
    const first = await cli("send", "@dev", "Deploy staging", "--key", "build-41");
    const again = await cli("send", "@dev", "Deploy staging", "--key", "build-41");
    expect(again.out).toBe(first.out);
    const sent = await t.db.select().from(schema.appSends);
    expect(sent).toHaveLength(1);
  });

  test("run sends the message from standard input and waits for the reply", async () => {
    const { secret } = await setup();
    const r = await agentes(secret, { drain: true, stdin: "Summarize the week\n" })("run", "dev", "-", "--quiet");
    expect(r).toEqual({ code: 0, out: "Here is the launch copy.\n", err: "" });
  });

  test("a failed run exits 1, an approval waiting on a person exits 3", async () => {
    const { secret } = await setup();
    const cli = agentes(secret);
    const taskId = (await cli("send", "@dev", "Merge the release branch")).out.trim();
    await t.drain();
    const setStatus = (status: "failed" | "waiting_approval") =>
      t.db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.triggerMessageId, taskId));
    await setStatus("waiting_approval");
    const asked = await cli("wait", taskId, "--json");
    expect(asked.code).toBe(3);
    expect(jsonOf(asked)).toMatchObject({ ok: false, exitCode: 3, status: "waiting_approval" });
    await setStatus("failed");
    expect((await cli("wait", taskId)).code).toBe(1);
  });

  test("a read-only token can't send: exit 5, and nothing is posted", async () => {
    const { secret } = await setup("read");
    const r = await agentes(secret)("send", "@dev", "hi", "--json");
    expect(jsonOf(r)).toMatchObject({ ok: false, exitCode: 5 });
    expect(await t.db.select().from(schema.appSends)).toEqual([]);
  });

  test("a revoked or unknown token exits 5 and is never printed", async () => {
    const { b, secret, tokenId, orgId } = await setup();
    const cli = agentes(secret);
    const taskId = (await cli("send", "@dev", "hi")).out.trim();
    expect((await b(`/api/app/organizations/${orgId}/tokens/${tokenId}`, { method: "DELETE" })).status).toBe(204);
    const revoked = await cli("wait", taskId, "--json");
    expect(jsonOf(revoked)).toMatchObject({ ok: false, exitCode: 5 });
    expect(revoked.out + revoked.err).not.toContain(secret);
    const unknown = await agentes("agp_notarealtoken0000000000000000000000000000")("wait", taskId, "--json");
    expect(jsonOf(unknown)).toMatchObject({ ok: false, exitCode: 5 });
    expect(unknown.out + unknown.err).not.toContain("agp_notarealtoken");
  });

  test("an id that isn't one (an empty $TASK) is the command line's fault: exit 2, and no request", async () => {
    const { secret } = await setup();
    let requests = 0;
    const counting = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await main(argv, {
        env: { AGENTES_URL: ORIGIN, AGENTES_TOKEN: secret },
        fetch: async (url, init) => {
          requests++;
          return t.app.request(url, init);
        },
        stdout: (text) => {
          out.push(text);
        },
        stderr: () => {},
        readStdin: async () => "",
      });
      return { code, out: out.join("") };
    };
    expect((await counting("wait", "", "--json")).code).toBe(2);
    expect((await counting("export", "--channel", "general")).code).toBe(2);
    expect((await counting("send", "@dev", "hi", "--thread", "latest")).code).toBe(2);
    expect(requests).toBe(0);
  });

  test("an agent that isn't there is the tool's refusal: exit 1 with its words", async () => {
    const { secret } = await setup();
    const r = await agentes(secret)("send", "@ghost", "hi");
    expect(r.code).toBe(1);
    expect(r.err).toContain('No agent "@ghost"');
  });
});

describe("export", () => {
  test("the whole conversation, oldest first, an older long message whole; to a file only once without --force", async () => {
    const { secret } = await setup();
    const long = `Brief: ${"the launch copy needs care. ".repeat(150)}`.trim();
    expect(long.length).toBeGreaterThan(2000);
    const cli = agentes(secret, { drain: true });
    const run = await cli("run", "@dev", long, "--quiet");
    expect(run.code).toBe(0);
    const taskId = ((await t.db.select().from(schema.appSends))[0] as { messageId: string }).messageId;

    const exported = await cli("export", taskId, "--json");
    expect(exported.code).toBe(0);
    const doc = jsonOf(exported) as { count: number; truncated: number; messages: Record<string, unknown>[] };
    expect(doc.truncated).toBe(0);
    expect(doc.messages.map((m) => [(m.author as { kind: string }).kind, m.untrusted_text, m.truncated])).toEqual([
      ["person", long, false],
      ["agent", "Here is the launch copy.", false],
    ]);

    const dir = mkdtempSync(join(tmpdir(), "agentes-cli-"));
    try {
      const file = join(dir, "task.md");
      const written = await cli("export", "--task", taskId, "--format", "md", "--out", file);
      expect([written.code, written.out]).toEqual([0, `${file}\n`]);
      const md = readFileSync(file, "utf8");
      expect(md).toContain("## owner (person)");
      expect(md).toContain("_Sent through Nightly CI._");
      expect(md).toContain(long);
      expect(md).toContain("## Dev (agent)");
      expect((await cli("export", taskId, "--out", file)).code).toBe(2);
      expect(readFileSync(file, "utf8")).toBe(md);
      writeFileSync(file, "old");
      expect((await cli("export", taskId, "--out", file, "--force")).code).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8")).count).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a channel's messages page back past fifty", async () => {
    const { b, secret, orgId, channelId } = await setup();
    const userId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
    // Straight into the table: sixty posts through the API would meet its rate limit.
    const start = Date.now() - 3_600_000;
    await t.db.insert(schema.messages).values(
      Array.from({ length: 60 }, (_, i) => ({
        orgId,
        channelId,
        authorType: "person" as const,
        authorUserId: userId,
        body: `note ${i + 1}`,
        createdAt: new Date(start + i * 1000),
      })),
    );
    const r = await agentes(secret)("export", "--channel", channelId, "--limit", "55", "--json");
    const doc = jsonOf(r) as { count: number; messages: { untrusted_text: string }[] };
    expect(doc.count).toBe(55);
    expect(doc.messages.at(0)?.untrusted_text).toBe("note 6");
    expect(doc.messages.at(-1)?.untrusted_text).toBe("note 60");
  });
});

describe("events", () => {
  test("--task --until-done prints the task, the reply and the status as JSON lines, and ends with the task", async () => {
    const { secret } = await setup();
    const taskId = (await agentes(secret)("send", "@dev", "Write the launch copy")).out.trim();
    const r = await agentes(secret, { drain: true })("events", "--task", taskId, "--until-done");
    expect(r.code).toBe(0);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.type, l.untrusted_text ?? l.status])).toEqual([
      ["message", "Write the launch copy"],
      ["message", "Here is the launch copy."],
      ["status", "done"],
    ]);
    expect(lines[0]?.id).toBe(taskId);
  });
});

test("as a process over HTTP: send, then wait --json, with the address and token from the environment", async () => {
  const { secret } = await setup();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => t.app.fetch(req) });
  try {
    const entry = join(import.meta.dir, "../../../packages/cli/src/index.ts");
    const spawn = async (...argv: string[]) => {
      const child = Bun.spawn([process.execPath, entry, ...argv], {
        env: { PATH: process.env.PATH ?? "", AGENTES_URL: `http://127.0.0.1:${server.port}`, AGENTES_TOKEN: secret },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, err, code };
    };
    const sent = await spawn("send", "@dev", "Write the launch copy", "--quiet");
    expect(sent.code).toBe(0);
    await t.drain();
    const waited = await spawn("wait", sent.out.trim(), "--json");
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.out)).toMatchObject({ ok: true, status: "done", reply: { untrusted_text: replyText } });
    const none = await spawn("wait", sent.out.trim(), "--url", `http://127.0.0.1:${server.port}/nowhere/mcp`);
    expect(none.code).toBe(5);
  } finally {
    server.stop(true);
  }
});

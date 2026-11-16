import { describe, expect, test } from "bun:test";
import { EXIT, type Io, main } from "../src/cli";
import { CliError } from "../src/exit";

/**
 * The command against a fake `/mcp`: what a script sees (stdout, stderr, the exit code) for each kind of answer.
 * The real server's answers are covered in apps/server/test/cli.test.ts.
 */

const TOKEN = "agp_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const T1 = "0195f3a0-1b2c-7d4e-8f60-0123456789ab";
const C1 = "0195f3a0-1b2c-7d4e-8f60-0123456789cd";

type Call = { name: string; args: Record<string, unknown>; auth: string | null };
/** Above a day of `events` (about 3,840 calls). */
const MAX_CALLS = 6000;
type Answer = Response | Record<string, unknown> | Error;

/** A fake server: `answer` gets each tool call and returns a tool's data, a raw Response, or throws as the network. */
function fake(answer: (call: Call, clock: { now: number }) => Answer) {
  const clock = { now: 0 };
  const calls: Call[] = [];
  const slept: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { AGENTES_URL: "https://chat.example.com", AGENTES_TOKEN: TOKEN } as Record<string, string | undefined>,
    fetch: async (url: string, init: RequestInit) => {
      expect(url).toBe("https://chat.example.com/mcp");
      const body = JSON.parse(String(init.body)) as {
        id: number;
        params: { name: string; arguments: Record<string, unknown> };
      };
      const headers = new Headers(init.headers);
      const call = { name: body.params.name, args: body.params.arguments, auth: headers.get("authorization") };
      // The fake answers in microtasks on a fake clock, so a test timeout never fires: a command that keeps asking
      // (a broken wait loop) meets a dead network here, and its retries run out, instead of filling memory.
      if (calls.length >= MAX_CALLS) throw new Error("the fake server stopped answering");
      calls.push(call);
      const a = answer(call, clock);
      if (a instanceof Error) throw a;
      if (a instanceof Response) return a;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: a } });
    },
    stdout: (t: string) => {
      out.push(t);
    },
    stderr: (t: string) => {
      err.push(t);
    },
    readStdin: async () => "from stdin",
    now: () => clock.now,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock.now += ms;
    },
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(argv, io);
    return { code, out: out.join(""), err: err.join("") };
  };
  return { run, calls, slept, clock, io };
}

const toolError = (text: string) =>
  Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text }] } });

test("the exit codes scripts read stay what ADR 0219 says", () => {
  expect(EXIT).toEqual({
    done: 0,
    failed: 1,
    usage: 2,
    needsPerson: 3,
    timedOut: 4,
    unreachable: 5,
    limited: 6,
    interrupted: 130,
  });
});

describe("the command line", () => {
  test("no command prints the help on stderr with exit 2; help and --help print it on stdout", async () => {
    const { run } = fake(() => ({}));
    const none = await run();
    expect([none.code, none.err]).toEqual([2, expect.stringContaining("agentes <command>")]);
    expect((await run("help")).code).toBe(0);
    const one = await run("help", "export");
    expect(one.out).toContain("--format F");
    expect((await run("wait", "--help")).out).toContain("agentes wait TASK_ID");
  });

  test("a wrong command line exits 2 before any request, and --json says so as JSON", async () => {
    const { run, calls, io } = fake(() => ({}));
    expect((await run("deploy")).code).toBe(2);
    // No --token flag: other programs can read a command line.
    const flag = await run("send", "@dev", "hi", "--token", TOKEN, "--json");
    expect(flag.code).toBe(2);
    expect(JSON.parse(flag.out)).toEqual({ ok: false, error: "Unknown option --token.", exitCode: 2 });
    expect((await run("send", "@dev", "two", "words")).code).toBe(2);
    expect((await run("send", "@dev")).code).toBe(2);
    expect((await run("wait", T1, "--timeout", "soon")).code).toBe(2);
    expect((await run("wait", T1, "--format", "md")).err).toContain("wait doesn't take --format");
    expect((await run("events", "--channel", C1, "--interval", "5s")).code).toBe(2);
    expect((await run("export", T1, "--channel", C1)).code).toBe(2);
    // An id that isn't one (an empty or mistyped $TASK) is the command line's fault, not a failed task.
    expect((await run("wait", "")).code).toBe(2);
    expect((await run("wait", "abc")).err).toContain('not "abc"');
    expect((await run("send", "@dev", "hi", "--thread", "x")).code).toBe(2);
    expect((await run("export", "--channel", "general")).code).toBe(2);
    io.env.AGENTES_URL = "ftp://chat.example.com";
    expect((await run("wait", T1)).code).toBe(2);
    io.env.AGENTES_URL = undefined;
    expect((await run("wait", T1)).err).toContain("AGENTES_URL");
    io.env.AGENTES_URL = "https://chat.example.com";
    io.env.AGENTES_TOKEN = undefined;
    expect((await run("wait", T1)).err).toContain("AGENTES_TOKEN");
    expect(calls).toEqual([]);
  });
});

describe("answers and exit codes", () => {
  test("send prints the task id alone on stdout, sends the bearer and a key, and never prints the token", async () => {
    const { run, calls } = fake(() => ({
      task_id: T1,
      status: "still_running",
      agent: { handle: "dev" },
      message_url: "https://chat.example.com/org/o/c/c?m=t1",
    }));
    const sent = await run("send", "@dev", "Ship it");
    expect(sent).toEqual({ code: 0, out: `${T1}\n`, err: "Sent to @dev: https://chat.example.com/org/o/c/c?m=t1\n" });
    expect(calls[0]).toMatchObject({
      name: "send_to_agent",
      args: { agent: "@dev", message: "Ship it", wait_seconds: 0 },
      auth: `Bearer ${TOKEN}`,
    });
    expect(String(calls[0]?.args.idempotency_key)).toMatch(/^[0-9a-f]{24}$/);
    const piped = await run("send", "dev", "-", "--key", "build-41", "--json", "--quiet");
    expect(calls[1]?.args).toMatchObject({ message: "from stdin", idempotency_key: "build-41" });
    expect(JSON.parse(piped.out)).toMatchObject({ ok: true, exitCode: 0, command: "send", task_id: T1 });
    expect(piped.err).toBe("");
    expect(sent.out + sent.err + piped.out).not.toContain(TOKEN);
  });

  test("a dropped connection is retried with the same key, so the task is sent once", async () => {
    let tries = 0;
    const { run, calls } = fake(() =>
      ++tries === 1 ? new Error("socket hang up") : { task_id: T1, status: "still_running" },
    );
    expect((await run("send", "@dev", "hi")).code).toBe(0);
    expect(calls.map((c) => c.args.idempotency_key)).toEqual([
      calls[0]?.args.idempotency_key,
      calls[0]?.args.idempotency_key,
    ]);
  });

  test("a refused token exits 5; an unreachable server exits 5 once the retries run out", async () => {
    const refused = fake(() => new Response("", { status: 401 }));
    const r = await refused.run("wait", T1, "--json");
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, exitCode: 5 });
    expect(refused.calls).toHaveLength(1);
    const down = fake(() => new Error("ECONNREFUSED"));
    expect((await down.run("send", "@dev", "hi")).code).toBe(5);
    expect(down.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  test("a page that isn't JSON-RPC is not an agentes.chat server (5); a JSON-RPC refusal of the call is 5 too", async () => {
    expect((await fake(() => new Response("<html>", { status: 200 })).run("wait", T1)).code).toBe(5);
    const noTool = fake(() =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool send_to_agent not found" } }),
    );
    const r = await noTool.run("send", "@dev", "hi");
    expect([r.code, r.err]).toEqual([5, expect.stringContaining("may lack the access")]);
  });

  test("limits exit 6 with when to try again", async () => {
    const limited = fake(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32013, message: "Too many requests", data: { retry_after: 120 } },
          }),
          { status: 429, headers: { "retry-after": "120" } },
        ),
    );
    const r = await limited.run("send", "@dev", "hi", "--json");
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, exitCode: 6, retry_after: 120 });
    const sends = fake(() => toolError('Too many messages sent from apps. Try again later. {"retry_after":42}'));
    expect(JSON.parse((await sends.run("send", "@dev", "hi", "--json")).out)).toMatchObject({
      exitCode: 6,
      retry_after: 42,
    });
  });

  test("a tool's refusal exits 1 with its words", async () => {
    const { run } = fake(() =>
      toolError('No agent "@ghost" in this workspace. list_agents returns the valid ids and handles.'),
    );
    const r = await run("send", "@ghost", "hi");
    expect(r.code).toBe(1);
    expect(r.err).toContain('No agent "@ghost"');
  });
});

describe("waiting", () => {
  test("done prints the reply; a person to act is 3; failed, canceled and no run are 1", async () => {
    const statuses: Record<string, unknown>[] = [
      { task_id: T1, status: "done", agent: { handle: "dev" }, reply: { untrusted_text: "Shipped 1.4." } },
      { task_id: T1, status: "waiting_approval", approval_url: "https://chat.example.com/x" },
      { task_id: T1, status: "waiting_input", reply: { untrusted_text: "Which branch?" } },
      { task_id: T1, status: "failed", error: "budget" },
      { task_id: T1, status: "canceled" },
      { task_id: T1, status: "no_run" },
    ];
    let i = 0;
    const { run } = fake(() => statuses[i++] ?? {});
    const done = await run("wait", T1);
    expect([done.code, done.out]).toEqual([0, "Shipped 1.4.\n"]);
    const approval = await run("wait", T1);
    expect([approval.code, approval.err]).toEqual([3, expect.stringContaining("https://chat.example.com/x")]);
    expect((await run("wait", T1)).code).toBe(3);
    expect((await run("wait", T1)).code).toBe(1);
    expect((await run("wait", T1)).code).toBe(1);
    expect((await run("wait", T1)).code).toBe(1);
  });

  test("the server holds each wait; when its waits are taken the command pauses as told instead of asking again", async () => {
    let i = 0;
    const { run, calls, slept } = fake((call, clock) => {
      i++;
      if (i === 1) return { task_id: T1, status: "still_running", retry_after_seconds: 5 };
      if (i === 2) {
        clock.now += Number(call.args.timeout_seconds) * 1000;
        return { task_id: T1, status: "still_running", poll_after_seconds: 5 };
      }
      return { task_id: T1, status: "done", reply: { untrusted_text: "ok" } };
    });
    expect((await run("wait", T1, "--timeout", "5m")).code).toBe(0);
    expect(calls.map((c) => c.args.timeout_seconds)).toEqual([45, 45, 45]);
    // Paused once, after the answer that came back at once; the held wait was asked again straight away.
    expect(slept).toEqual([5000]);
  });

  test("past the timeout it exits 4 and says how to wait again; the task isn't touched", async () => {
    const { run, calls } = fake((call, clock) => {
      clock.now += Number(call.args.timeout_seconds) * 1000;
      return { task_id: T1, status: "still_running", poll_after_seconds: 5 };
    });
    const r = await run("wait", T1, "--timeout", "100s");
    expect(r.code).toBe(4);
    expect(r.err).toContain(`agentes wait ${T1}`);
    expect(calls.map((c) => c.args.timeout_seconds)).toEqual([45, 45, 10]);
    expect(calls.every((c) => c.name === "wait_for_reply")).toBe(true);
  });

  test("Ctrl-C while waiting exits 130 and names the task", async () => {
    const stop = new AbortController();
    const { run, io } = fake(() => {
      stop.abort();
      return { task_id: T1, status: "still_running", retry_after_seconds: 5 };
    });
    io.signal = stop.signal;
    io.sleep = async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new CliError("Interrupted.", EXIT.interrupted);
    };
    const r = await run("wait", T1);
    expect([r.code, r.err]).toEqual([130, expect.stringContaining(`The task keeps running: agentes wait ${T1}`)]);
  });
});

describe("events", () => {
  const message = (id: string, text: string) => ({ id, author: { kind: "person", name: "Ana" }, untrusted_text: text });
  const linesOf = (out: string) =>
    out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  test("following a running task for a day stays within the token's 5,000 requests", async () => {
    const { run, calls } = fake((call, clock) => {
      if (call.name === "read_conversation") return { messages: [message(T1, "Ship it")] };
      clock.now += Number(call.args.timeout_seconds) * 1000;
      return { task_id: T1, status: "still_running" };
    });
    const r = await run("events", "--task", T1, "--timeout", "24h");
    expect(r.code).toBe(0);
    expect(calls.length).toBeLessThan(5000);
    expect(calls.filter((c) => c.name === "wait_for_reply").every((c) => c.args.timeout_seconds === 45)).toBe(true);
    expect(linesOf(r.out).map((l) => l.type)).toEqual(["message", "status"]);
  });

  test("once the task has settled it only reads, every interval", async () => {
    const { run, calls } = fake((call) =>
      call.name === "read_conversation" ? { messages: [message(T1, "Ship it")] } : { task_id: T1, status: "done" },
    );
    expect((await run("events", "--task", T1, "--timeout", "1h")).code).toBe(0);
    expect(calls.filter((c) => c.name === "wait_for_reply")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "read_conversation").length).toBe(122);
  });

  test("a channel starts from now: what was there is not printed, what comes after is", async () => {
    let reads = 0;
    const { run } = fake((call) => {
      if (call.name !== "read_conversation") return {};
      reads++;
      return { messages: reads === 1 ? [message("m1", "old")] : [message("m1", "old"), message("m2", "new")] };
    });
    const r = await run("events", "--channel", C1, "--timeout", "30s");
    expect(linesOf(r.out).map((l) => l.untrusted_text)).toEqual(["new"]);
  });
});

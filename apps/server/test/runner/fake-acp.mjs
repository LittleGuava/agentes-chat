// A fake ACP agent for runner tests (ADR 0216): any agent that speaks the Agent Client Protocol on its standard input
// and output, as a computer's owner would declare it. Its start (argv, cwd, the env that matters) and each request are
// appended to $FAKE_ACP_LOG, one JSON line each.
//
// $FAKE_ACP_MODELS says how its sessions offer models: "config" (default, a `model` config option), "models" (the
// unstable `models.availableModels`) or "none". Sessions are kept in $FAKE_ACP_STORE so `session/load` finds one a
// turn before started. What the prompt says decides the turn: by default a paragraph, a tool of its own, a call to our
// bridge and the answer, with tokens. "ASK": a permission request first; "LIMIT": a provider's limit; "AUTH": a refused
// sign-in; "SILENT": no answer at all. "CRASH" in $FAKE_ACP_MODE: it exits at once.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const log = (entry) => {
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
};
if (env.FAKE_ACP_MODE === "CRASH") process.exit(3);

log({
  start: true,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  anthropicKey: env.ANTHROPIC_API_KEY ?? null,
  engineVar: env.FAKE_ENGINE_VAR ?? null,
  secret: env.AGENT_SECRET ?? null,
});

const MODELS = [
  { id: "vibe/devstral-3", name: "Devstral 3" },
  { id: "vibe/mistral-large-4", name: "Mistral Large 4" },
];
const way = env.FAKE_ACP_MODELS ?? "config";
const store = env.FAKE_ACP_STORE ?? "";
const sessions = () => (store && existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {});
const keep = (id, model) => {
  if (store) writeFileSync(store, JSON.stringify({ ...sessions(), [id]: model }));
};

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
let askId = 0;
const asked = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `ask${++askId}`;
    asked.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

function offered(model) {
  if (way === "config") {
    return {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: MODELS.map((m) => ({ value: m.id, name: m.name })),
        },
      ],
    };
  }
  if (way === "models") {
    return { models: { currentModelId: model, availableModels: MODELS.map((m) => ({ modelId: m.id, name: m.name })) } };
  }
  return {};
}

const text = (t) => [{ type: "content", content: { type: "text", text: t } }];
const USAGE = { inputTokens: 500, outputTokens: 20, cachedReadTokens: 50, totalTokens: 570 };

async function prompt(id, params) {
  const sid = params.sessionId;
  const said = params.prompt.map((b) => b.text ?? "").join("");
  log({ method: "session/prompt", sessionId: sid, text: said });
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  if (said.includes("LIMIT")) return fail(-32603, "Internal error: rate limit exceeded (429)");
  if (said.includes("AUTH")) return fail(-32000, "Authentication required");
  if (said.includes("SILENT")) return;
  if (said.includes("ASK")) {
    const answer = await ask("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "call_ask", title: "rm build/", kind: "delete" },
      options: [
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "no", kind: "reject_once", name: "Reject" },
      ],
    });
    log({ permissionAnswer: answer });
  }
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking." } });
  update(sid, { sessionUpdate: "tool_call", toolCallId: "own1", title: "read_file", kind: "read", status: "pending" });
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: "own1",
    status: "completed",
    rawInput: { path: "README.md" },
    content: text("# Readme"),
  });
  update(sid, {
    sessionUpdate: "tool_call",
    toolCallId: "ours1",
    title: "mcp__agenteschat_agentes__post_message",
    kind: "other",
    status: "pending",
  });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "ours1", status: "completed", content: text("ok") });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All good." } });
  reply({ stopReason: "end_turn", usage: USAGE });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(m) {
  if (m.method === undefined && asked.has(m.id)) {
    asked.get(m.id)(m.result);
    asked.delete(m.id);
    return;
  }
  const { id, method, params } = m;
  if (method !== "session/prompt") log({ method, params });
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake-acp" } });
    case "session/new": {
      const sid = `sess-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      keep(sid, MODELS[0].id);
      return reply({ sessionId: sid, ...offered(MODELS[0].id) });
    }
    case "session/load": {
      const model = sessions()[params.sessionId];
      if (!model) return fail(-32602, "Session not found");
      return reply(offered(model));
    }
    case "session/set_config_option":
    case "session/set_model": {
      const value = method === "session/set_model" ? params.modelId : params.value;
      if (!MODELS.some((x) => x.id === value)) return fail(-32602, `Unknown model ${value}`);
      keep(params.sessionId, value);
      return reply(method === "session/set_model" ? {} : offered(value));
    }
    case "session/prompt":
      return void prompt(id, params);
    case "session/cancel":
      return;
    default:
      if (id !== undefined) fail(-32601, `Method not found: ${method}`);
  }
}

import { afterEach, beforeEach, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { TRANSCRIPT_LIMITS } from "@agenteschat/engine";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type Line = {
  id: string;
  threadId: string | null;
  at: string;
  author: { type: string; name: string | null };
  text: string;
};
type Transcript = {
  conversation: { id: string; kind: string; name: string };
  thread: { id: string } | null;
  truncated: boolean;
  messages: (Line & { files: { id: string; title: string; path?: string; leftOut?: string }[] })[];
};

/** The owner (in #general with the agent Dev), two members and an administrator, with the workspace's API for each. */
async function team() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const adm = await joinByInvitation(t, owner, orgId, "adm@example.com", { role: "admin" });
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const { members } = (await (await api(owner, "/members")).json()) as { members: { userId: string; email: string }[] };
  const id = (email: string) => members.find((m) => m.email === email)?.userId ?? "";
  return { orgId, general: channelId, owner, ana, bia, adm, api, biaId: id("bia@example.com") };
}

/** The entries of a zip the server made (local headers, deflated), by name. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    out.set(name, new Uint8Array(inflateRawSync(bytes.subarray(start, start + size))));
    at = start + size;
  }
  return out;
}

test("a member exports a channel as Markdown and JSON: names, times and the words people read, nothing else", async () => {
  const { general, owner, api } = await team();
  await api(owner, `/channels/${general}/messages`, { json: { body: "@dev pode revisar o deploy?" } });
  await t.drain();

  const md = await api(owner, `/channels/${general}/export?format=markdown`);
  expect(md.status).toBe(200);
  expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(md.headers.get("content-disposition")).toStartWith('attachment; filename="general-');
  expect(md.headers.get("cache-control")).toBe("private, no-store, no-transform");
  const text = await md.text();
  expect(text).toStartWith("# #general\n");
  expect(text).toContain("**owner**");
  expect(text).toContain("@dev pode revisar o deploy?");
  expect(text).toContain("**Dev**");
  expect(text).toContain("Feito.");

  const json = await api(owner, `/channels/${general}/export?format=json`);
  expect(json.status).toBe(200);
  expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const body = await json.text();
  const transcript = JSON.parse(body) as Transcript;
  expect(transcript.conversation).toMatchObject({ id: general, kind: "channel", name: "general" });
  expect(transcript.truncated).toBe(false);
  const said = transcript.messages.map((m) => [m.author.type, m.author.name, m.text]);
  expect(said).toContainEqual(["person", "owner", "@dev pode revisar o deploy?"]);
  expect(said).toContainEqual(["agent", "Dev", "Feito."]);
  // No meta, runs or usage: only what the transcript names.
  expect(body).not.toContain('"meta"');
  expect(body).not.toContain("agentRunId");
  expect(body).not.toContain("inputTokens");
  expect(transcript.messages.every((m) => !Number.isNaN(Date.parse(m.at)))).toBe(true);
});

test("who reads it exports it: a private channel's outsider is refused, an administrator reads it, a DM only its two", async () => {
  const { ana, bia, adm, api, biaId } = await team();
  const room = (await (await api(ana, "/channels", { json: { name: "secreto", visibility: "private" } })).json()) as {
    id: string;
  };
  await api(ana, `/channels/${room.id}/messages`, { json: { body: "Fusão" } });
  const { channelId: dm } = (await (await api(ana, "/dms", { json: { userId: biaId } })).json()) as {
    channelId: string;
  };
  await api(ana, `/channels/${dm}/messages`, { json: { body: "Reservado" } });

  const outsider = await api(bia, `/channels/${room.id}/export?format=json`);
  expect(outsider.status).toBe(403);
  expect(await outsider.text()).not.toContain("Fusão");
  expect((await api(adm, `/channels/${room.id}/export?format=json`)).status).toBe(200);

  const admDm = await api(adm, `/channels/${dm}/export?format=markdown`);
  expect(admDm.status).toBe(403);
  expect(await admDm.text()).not.toContain("Reservado");
  for (const b of [ana, bia]) {
    const res = await api(b, `/channels/${dm}/export?format=json`);
    expect(res.status).toBe(200);
    const transcript = (await res.json()) as Transcript;
    expect(transcript.conversation.kind).toBe("dm");
    expect(transcript.messages.map((m) => m.text)).toEqual(["Reservado"]);
  }
});

test("a thread exports alone; a thread of a conversation one doesn't read stays closed behind one that one does", async () => {
  const { general, owner, ana, api } = await team();
  const root = (await (await api(owner, `/channels/${general}/messages`, { json: { body: "Pergunta" } })).json()) as {
    id: string;
  };
  await api(owner, `/channels/${general}/messages`, { json: { body: "Resposta", threadId: root.id } });
  await api(owner, `/channels/${general}/messages`, { json: { body: "Outra coisa" } });

  const res = await api(owner, `/channels/${general}/export?format=json&threadId=${root.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("thread");
  const transcript = (await res.json()) as Transcript;
  expect(transcript.thread).toEqual({ id: root.id });
  expect(transcript.messages.map((m) => [m.text, m.threadId])).toEqual([
    ["Pergunta", null],
    ["Resposta", root.id],
  ]);

  // The whole channel keeps each reply under its root.
  const all = (await (await api(owner, `/channels/${general}/export?format=json`)).json()) as Transcript;
  const texts = all.messages.map((m) => m.text);
  expect(texts.indexOf("Resposta")).toBe(texts.indexOf("Pergunta") + 1);
  const md = await (await api(owner, `/channels/${general}/export?format=markdown`)).text();
  expect(md).toMatch(/> \*\*owner\*\*[^\n]*\n> Resposta/);

  const room = (await (await api(ana, "/channels", { json: { name: "secreto", visibility: "private" } })).json()) as {
    id: string;
  };
  const hidden = (await (await api(ana, `/channels/${room.id}/messages`, { json: { body: "Fusão" } })).json()) as {
    id: string;
  };
  const crossed = await api(owner, `/channels/${general}/export?format=json&threadId=${hidden.id}`);
  expect(crossed.status).toBe(404);
  expect(await crossed.text()).not.toContain("Fusão");
  expect((await api(owner, `/channels/${general}/export?format=pdf`)).status).toBe(400);
});

test("with files: a zip of the transcript and what the exporter may read, the rest named as left out", async () => {
  const { orgId, general, owner, api } = await team();
  const base = `/api/app/organizations/${orgId}`;
  const upload = async (name: string, bytes: Uint8Array) => {
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: "text/plain" }));
    form.set("channelId", general);
    const res = await t.app.request(`${base}/artifacts/files`, {
      method: "POST",
      headers: { cookie: owner.cookie(), origin: ORIGIN },
      body: form,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const kept = await upload("notas.txt", new TextEncoder().encode("linha um"));
  const gone = await upload("apagado.txt", new TextEncoder().encode("sumiu"));
  const big = await upload("grande.txt", new Uint8Array(4096).fill(65));
  const posted = await api(owner, `/channels/${general}/messages`, {
    json: { body: "Segue", attachments: [kept, gone, big] },
  });
  expect(posted.status).toBe(201);
  expect((await api(owner, `/artifacts/${gone}`, { method: "DELETE" })).status).toBe(204);

  const before = TRANSCRIPT_LIMITS.fileBytes;
  TRANSCRIPT_LIMITS.fileBytes = 1024;
  let res: Response;
  try {
    res = await api(owner, `/channels/${general}/export?format=json&files=true`);
  } finally {
    TRANSCRIPT_LIMITS.fileBytes = before;
  }
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toContain(".zip");
  const entries = unzip(new Uint8Array(await res.arrayBuffer()));
  const transcript = JSON.parse(new TextDecoder().decode(entries.get("transcript.json"))) as Transcript;
  const files = transcript.messages.find((m) => m.text === "Segue")?.files ?? [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const keptPath = byId.get(kept)?.path ?? "";
  expect(keptPath).toEndWith("notas.txt");
  expect(new TextDecoder().decode(entries.get(keptPath))).toBe("linha um");
  expect(byId.get(gone)).toMatchObject({ leftOut: "unreadable" });
  expect(byId.get(big)).toMatchObject({ leftOut: "too_large" });
  expect([...entries.keys()].sort()).toEqual([keptPath, "transcript.json"].sort());
});

test("each export is in the audit log with ids and counts, never the conversation's words or name", async () => {
  const { general, owner, ana, api } = await team();
  await api(owner, `/channels/${general}/messages`, { json: { body: "Plano secreto" } });
  const room = (await (await api(ana, "/channels", { json: { name: "fusao-xyz", visibility: "private" } })).json()) as {
    id: string;
  };
  expect((await api(owner, `/channels/${general}/export?format=markdown`)).status).toBe(200);
  expect((await api(ana, `/channels/${room.id}/export?format=json`)).status).toBe(200);

  const page = (await (await api(owner, "/audit")).json()) as {
    rows: { action: string; target: { type: string; id: string | null }; details: Record<string, unknown> }[];
  };
  const rows = page.rows.filter((r) => r.action === "conversation.exported");
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.target.id === general)?.details).toMatchObject({
    format: "markdown",
    files: false,
    threadId: null,
  });
  // What the row stores. The log's reader adds the conversation by its id, as for every row that has one.
  const details = JSON.stringify(rows.map((r) => r.details));
  expect(details).not.toContain("Plano secreto");
  expect(details).not.toContain("fusao-xyz");
  expect(details).not.toContain("general");
});

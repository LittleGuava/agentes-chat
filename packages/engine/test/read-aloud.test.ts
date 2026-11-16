import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryBlobStore, type ReadAloudEngine, singleStoreResolver } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  createChannel,
  dropChannelReadAloud,
  ForbiddenError,
  NotFoundError,
  type ReadAloudDeps,
  readAloud,
  readAloudAudio,
  spokenText,
  sweepReadAloud,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

const { messages, agents, channelMembers, readAloudClips } = schema;

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const DAY = 24 * 3600_000;

/** A fake engine that remembers what it was asked to say, and answers with those words as bytes. */
function engine(): ReadAloudEngine & { said: { text: string; voice: string }[] } {
  const said: { text: string; voice: string }[] = [];
  return {
    id: "elevenlabs",
    model: "fake",
    defaultVoice: "default-voice",
    maxChars: 40_000,
    said,
    async speak(input) {
      said.push({ text: input.text, voice: input.voice });
      return { audio: new TextEncoder().encode(`audio:${input.text}`), contentType: "audio/mpeg" };
    },
  };
}

const deps = (e: ReadAloudEngine | null, over: Partial<ReadAloudDeps> = {}): ReadAloudDeps => ({
  db: f.db,
  blobs: f.artifactDeps.blobs,
  engine: e,
  limits: null,
  cacheDays: 7,
  ...over,
});

async function agentReply(body: string, meta: Record<string, unknown> = {}, channelId = f.general.id) {
  const [m] = await f.db
    .insert(messages)
    .values({ orgId: f.org.id, channelId, authorType: "agent", authorAgentId: f.agent.id, body, meta })
    .returning();
  if (!m) throw new Error("no message");
  return m;
}

/** What a person who may play the clip hears: the bytes served, or those behind the signed link. */
const bytes = async (d: ReadAloudDeps, userId: string, clipId: string) => {
  const audio = await readAloudAudio(d, userId, f.org.id, clipId);
  if ("body" in audio) return new TextDecoder().decode(audio.body);
  const [clip] = await f.db.select().from(readAloudClips).where(eq(readAloudClips.id, clipId));
  const place = await f.artifactDeps.blobs.forConfig(f.org.id, clip?.storageConfigId ?? null);
  const stored = await place.get(clip?.blobKey ?? "");
  return stored ? new TextDecoder().decode(stored.body) : null;
};

describe("spokenText", () => {
  test("reads prose, leaves code, tables and headings out", () => {
    const text = spokenText(
      "# Resumo\n\nO deploy **passou**.\n\n- primeiro item\n- segundo\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      {},
    );
    expect(text).toBe("O deploy passou.\nprimeiro item\nsegundo");
  });

  test("a voice message and a notice for the agent have nothing to read", () => {
    expect(spokenText("transcribed words", { voice: { clipId: "c", durationMs: 1000, peaks: [] } })).toBe("");
    expect(spokenText("for the agent", { notice: { kind: "run_stopped" } })).toBe("");
    // The server's own lines show in the reader's language (`bodyCode`): their English body isn't what they read.
    expect(spokenText("I can't answer yet: I have no AI connected.", { bodyCode: "noAi", bodyParams: {} })).toBe("");
  });

  test("a long reply stops at the end of a sentence within the limit", () => {
    const sentence = "Uma frase curta. ";
    const text = spokenText(sentence.repeat(400), {});
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(text.endsWith(".")).toBe(true);
  });
});

describe("readAloud", () => {
  test("a member hears an agent's reply, and the second time no engine is called", async () => {
    f = await setup();
    const e = engine();
    const d = deps(e);
    const reply = await agentReply("Pronto, o relatório está no Drive.");
    const member = await addMember(f.db, f.org.id, "member", "ana");
    await f.db.insert(channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: member.id });
    const first = await readAloud(d, f.owner.id, f.org.id, reply.id);
    const again = await readAloud(d, member.id, f.org.id, reply.id);
    expect(again.clipId).toBe(first.clipId);
    expect(e.said).toEqual([{ text: "Pronto, o relatório está no Drive.", voice: "default-voice" }]);
    expect(await bytes(d, member.id, first.clipId)).toBe("audio:Pronto, o relatório está no Drive.");
  });

  test("the agent's own voice reaches the engine", async () => {
    f = await setup();
    const e = engine();
    await f.db.update(agents).set({ readAloudVoice: "JBFqnCBsd6RMkjVDRZzb" }).where(eq(agents.id, f.agent.id));
    const reply = await agentReply("Oi!");
    await readAloud(deps(e), f.owner.id, f.org.id, reply.id);
    expect(e.said[0]?.voice).toBe("JBFqnCBsd6RMkjVDRZzb");
  });

  test("an edited reply is read again", async () => {
    f = await setup();
    const e = engine();
    const d = deps(e);
    const reply = await agentReply("Primeira versão.");
    const first = await readAloud(d, f.owner.id, f.org.id, reply.id);
    await f.db
      .update(messages)
      .set({ body: "Versão corrigida.", editedAt: new Date() })
      .where(and(eq(messages.orgId, f.org.id), eq(messages.id, reply.id)));
    const second = await readAloud(d, f.owner.id, f.org.id, reply.id);
    expect(second.clipId).not.toBe(first.clipId);
    expect(e.said.map((s) => s.text)).toEqual(["Primeira versão.", "Versão corrigida."]);
  });

  test("someone who can't read the channel is refused, and nothing is said", async () => {
    f = await setup();
    const e = engine();
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    const reply = await agentReply("Segredo.", {}, room.id);
    const member = await addMember(f.db, f.org.id, "member", "rui");
    await expect(readAloud(deps(e), member.id, f.org.id, reply.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(e.said).toEqual([]);
  });

  test("the audio is refused to whoever can't read the channel", async () => {
    f = await setup();
    const d = deps(engine());
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    const reply = await agentReply("Segredo.", {}, room.id);
    const { clipId } = await readAloud(d, f.owner.id, f.org.id, reply.id);
    const member = await addMember(f.db, f.org.id, "member", "rui");
    await expect(readAloudAudio(d, member.id, f.org.id, clipId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a deleted reply's audio no longer plays, and it isn't read again", async () => {
    f = await setup();
    const e = engine();
    const d = deps(e);
    const reply = await agentReply("Apagada depois.");
    const { clipId } = await readAloud(d, f.owner.id, f.org.id, reply.id);
    await f.db
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(and(eq(messages.orgId, f.org.id), eq(messages.id, reply.id)));
    await expect(readAloudAudio(d, f.owner.id, f.org.id, clipId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readAloud(d, f.owner.id, f.org.id, reply.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(e.said).toHaveLength(1);
  });

  test("a person's message, or one with nothing to read, calls no engine", async () => {
    f = await setup();
    const e = engine();
    const [mine] = await f.db
      .insert(messages)
      .values({ orgId: f.org.id, channelId: f.general.id, authorType: "person", authorUserId: f.owner.id, body: "oi" })
      .returning();
    if (!mine) throw new Error("no message");
    await expect(readAloud(deps(e), f.owner.id, f.org.id, mine.id)).rejects.toMatchObject({
      code: "read_aloud.not_agent",
    });
    const code = await agentReply("```sh\nls\n```");
    await expect(readAloud(deps(e), f.owner.id, f.org.id, code.id)).rejects.toMatchObject({
      code: "read_aloud.no_words",
    });
    expect(e.said).toEqual([]);
  });

  test("with no engine it is off", async () => {
    f = await setup();
    const reply = await agentReply("Oi!");
    await expect(readAloud(deps(null), f.owner.id, f.org.id, reply.id)).rejects.toMatchObject({
      code: "read_aloud.unavailable",
    });
  });

  test("past the day's characters a new reply is refused, and one already made still plays", async () => {
    f = await setup();
    const e = engine();
    const d = deps(e, { limits: { personCharsPerDay: 10 } });
    const made = await agentReply("Doze letras");
    const { clipId } = await readAloud(d, f.owner.id, f.org.id, made.id);
    const next = await agentReply("Outra resposta.");
    const refused = readAloud(d, f.owner.id, f.org.id, next.id);
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toMatchObject({ code: "read_aloud.limit" });
    expect((await readAloud(d, f.owner.id, f.org.id, made.id)).clipId).toBe(clipId);
    expect(e.said).toHaveLength(1);
  });
});

describe("a clip that can't play is made again", () => {
  test("left on the workspace's former storage: the next listen makes it anew", async () => {
    f = await setup();
    const e = engine();
    const d = deps(e);
    const reply = await agentReply("Oi!");
    const first = await readAloud(d, f.owner.id, f.org.id, reply.id);
    await f.db
      .update(readAloudClips)
      .set({ storageConfigId: crypto.randomUUID() })
      .where(eq(readAloudClips.id, first.clipId));
    const again = await readAloud(d, f.owner.id, f.org.id, reply.id);
    expect(again.clipId).not.toBe(first.clipId);
    expect(e.said).toHaveLength(2);
    expect(await bytes(d, f.owner.id, again.clipId)).toBe("audio:Oi!");
  });

  test("its file gone: playing it says so and the next listen makes it anew", async () => {
    f = await setup();
    const e = engine();
    // A store that serves the bytes itself (no signed links), so the server can tell the file is gone.
    const store = createMemoryBlobStore({ sign: false });
    const d = deps(e, { blobs: singleStoreResolver(store) });
    const reply = await agentReply("Oi!");
    const first = await readAloud(d, f.owner.id, f.org.id, reply.id);
    store.objects.clear();
    await expect(readAloudAudio(d, f.owner.id, f.org.id, first.clipId)).rejects.toBeInstanceOf(NotFoundError);
    const again = await readAloud(d, f.owner.id, f.org.id, reply.id);
    expect(again.clipId).not.toBe(first.clipId);
    expect(e.said).toHaveLength(2);
    const audio = await readAloudAudio(d, f.owner.id, f.org.id, again.clipId);
    expect("body" in audio && new TextDecoder().decode(audio.body)).toBe("audio:Oi!");
  });

  test("the sweep passes a clip whose storage was removed, and goes on", async () => {
    f = await setup();
    const d = deps(engine());
    const gone = await readAloud(d, f.owner.id, f.org.id, (await agentReply("Um.")).id);
    const kept = await readAloud(d, f.owner.id, f.org.id, (await agentReply("Dois.")).id);
    const old = new Date(Date.now() - 8 * DAY);
    await f.db
      .update(readAloudClips)
      .set({ storageConfigId: crypto.randomUUID(), createdAt: old })
      .where(eq(readAloudClips.id, gone.clipId));
    await f.db.update(readAloudClips).set({ createdAt: old }).where(eq(readAloudClips.id, kept.clipId));
    expect(await sweepReadAloud(d)).toBe(2);
    expect(await f.db.select().from(readAloudClips)).toHaveLength(0);
  });
});

describe("the cache goes", () => {
  test("past its days, the row and the file go", async () => {
    f = await setup();
    const d = deps(engine());
    const reply = await agentReply("Oi!");
    const { clipId } = await readAloud(d, f.owner.id, f.org.id, reply.id);
    const kept = await sweepReadAloud(d);
    expect(kept).toBe(0);
    await f.db
      .update(readAloudClips)
      .set({ createdAt: new Date(Date.now() - 8 * DAY) })
      .where(eq(readAloudClips.id, clipId));
    expect(await sweepReadAloud(d)).toBe(1);
    expect(await f.db.select().from(readAloudClips)).toHaveLength(0);
  });

  test("with a deleted channel", async () => {
    f = await setup();
    const d = deps(engine());
    const reply = await agentReply("Oi!");
    const { clipId } = await readAloud(d, f.owner.id, f.org.id, reply.id);
    const [clip] = await f.db.select().from(readAloudClips).where(eq(readAloudClips.id, clipId));
    await dropChannelReadAloud(d, f.org.id, f.general.id);
    expect(await f.db.select().from(readAloudClips)).toHaveLength(0);
    const place = await f.artifactDeps.blobs.forConfig(f.org.id, clip?.storageConfigId ?? null);
    expect(await place.get(clip?.blobKey ?? "")).toBeNull();
  });
});

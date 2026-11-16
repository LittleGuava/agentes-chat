import { afterEach, expect, test } from "bun:test";
import { type CallVoice, SpeechError } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { NotFoundError, speakReply, spokenWords, ValidationError } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/** A voice call's half on the server (ADR 0198): an agent's reply as audio, for who can read it. */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

function fakeVoice(fail?: Error): CallVoice & { said: { text: string; voice: string; orgId?: string }[] } {
  const said: { text: string; voice: string; orgId?: string }[] = [];
  return {
    id: "fake",
    defaultVoice: "alloy",
    maxChars: 4096,
    said,
    async speak(input) {
      said.push(input);
      if (fail) throw fail;
      return { audio: new TextEncoder().encode(`audio:${input.text}`), contentType: "audio/mpeg" };
    },
  };
}

async function post(m: { body: string; agent?: boolean; meta?: Record<string, unknown>; channelId?: string }) {
  const [row] = await f.db
    .insert(schema.messages)
    .values({
      orgId: f.org.id,
      channelId: m.channelId ?? f.general.id,
      authorType: m.agent === false ? "person" : "agent",
      authorUserId: m.agent === false ? f.owner.id : null,
      authorAgentId: m.agent === false ? null : f.agent.id,
      body: m.body,
      mentionedAgentIds: [],
      meta: m.meta ?? {},
      hop: m.agent === false ? 0 : 1,
    })
    .returning();
  if (!row) throw new Error("no message");
  return row;
}

test("an agent's reply is read as a person reads it: prose, no code, no table, no heading", async () => {
  f = await setup();
  const voice = fakeVoice();
  const reply = await post({
    body: "## Resumo\n\nO deploy **terminou** bem.\n\n- Testes ok\n- Build ok\n\n```sh\nbun test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  });
  const out = await speakReply({ db: f.db, voice }, f.owner.id, f.org.id, reply.id);
  expect(new TextDecoder().decode(out.audio)).toBe("audio:O deploy terminou bem.\nTestes ok\nBuild ok");
  expect(out.contentType).toBe("audio/mpeg");
  expect(voice.said).toEqual([
    { text: "O deploy terminou bem.\nTestes ok\nBuild ok", voice: "alloy", orgId: f.org.id },
  ]);
});

test("a long reply stops at the last sentence that fits", () => {
  const text = `${"Uma frase curta. ".repeat(10)}Fim`;
  expect(spokenWords(text, {}, 60)).toBe("Uma frase curta. Uma frase curta. Uma frase curta.");
});

test("a person's message, a voice message, a server's line or a notice for the agent have nothing to read", async () => {
  f = await setup();
  const voice = fakeVoice();
  const person = await post({ body: "oi", agent: false });
  const refused = await speakReply({ db: f.db, voice }, f.owner.id, f.org.id, person.id).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(ValidationError);
  expect((refused as ValidationError).code).toBe("voice_call.not_agent");
  for (const meta of [
    { bodyCode: "no_ai" },
    { notice: { kind: "run_stopped" } },
    { voice: { clipId: crypto.randomUUID(), durationMs: 2000 } },
  ]) {
    const quiet = await post({ body: "words for the agent", meta });
    const error = await speakReply({ db: f.db, voice }, f.owner.id, f.org.id, quiet.id).catch((e: unknown) => e);
    expect((error as ValidationError).code).toBe("voice_call.no_words");
  }
  expect(voice.said).toEqual([]);
});

test("someone who can't read the channel gets nothing, and an unknown message is not found", async () => {
  f = await setup();
  const voice = fakeVoice();
  const [secret] = await f.db
    .insert(schema.channels)
    .values({ orgId: f.org.id, name: "secret", visibility: "private", createdByUserId: f.owner.id })
    .returning();
  if (!secret) throw new Error("no channel");
  const reply = await post({ body: "Só para quem está aqui.", channelId: secret.id });
  const outsider = await addMember(f.db, f.org.id, "member", "rui");
  const error = await speakReply({ db: f.db, voice }, outsider.id, f.org.id, reply.id).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ValidationError);
  const missing = await speakReply({ db: f.db, voice }, f.owner.id, f.org.id, crypto.randomUUID()).catch(
    (e: unknown) => e,
  );
  expect(missing).toBeInstanceOf(NotFoundError);
  expect(voice.said).toEqual([]);
});

test("with no engine calls are off, and an engine's error goes up as it is", async () => {
  f = await setup();
  const reply = await post({ body: "Pronto." });
  const off = await speakReply({ db: f.db, voice: null }, f.owner.id, f.org.id, reply.id).catch((e: unknown) => e);
  expect((off as ValidationError).code).toBe("voice_call.unavailable");
  const busy = new SpeechError("busy", "later");
  const error = await speakReply({ db: f.db, voice: fakeVoice(busy) }, f.owner.id, f.org.id, reply.id).catch(
    (e: unknown) => e,
  );
  expect(error).toBe(busy);
});

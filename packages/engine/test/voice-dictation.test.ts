import { afterEach, describe, expect, test } from "bun:test";
import {
  createMemoryBlobStore,
  type SpeechEngine,
  SpeechError,
  type SpeechProviderId,
  singleStoreResolver,
} from "@agenteschat/adapters";
import { count, eq, schema } from "@agenteschat/db";
import { acceptVoiceClip, dictateVoice, type VoiceDeps, type VoiceLimits, voiceAllowed } from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

/** Dictation (ADR 0100 addendum): a recording's words go back to the box, never posted, and the audio is never kept. */

const { voiceClips, messages } = schema;

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

function engine(...answers: (string | Error)[]): SpeechEngine & { heard: string[][] } {
  const heard: string[][] = [];
  return {
    id: "groq" as SpeechProviderId,
    model: "fake",
    nanoUsdPerHour: 3_600_000_000,
    minBilledSeconds: 0,
    heard,
    async file(input) {
      heard.push(input.terms);
      const next = answers.shift() ?? "";
      if (next instanceof Error) throw next;
      return { text: next };
    },
  };
}

const voiceDeps = (engines: SpeechEngine[], over: Partial<VoiceDeps> = {}): VoiceDeps => ({
  db: f.db,
  pubsub: f.pubsub,
  blobs: f.artifactDeps.blobs,
  engines: () => engines,
  limits: null,
  retentionDays: 90,
  ...over,
});

const take = (over: Partial<Parameters<typeof dictateVoice>[4]> = {}) => ({
  audio: new Uint8Array([1, 2, 3, 4]),
  contentType: "audio/webm",
  durationMs: 3000,
  language: "pt",
  ...over,
});

const dictate = (deps: VoiceDeps, over: Parameters<typeof take>[0] = {}, userId = f.owner.id) =>
  dictateVoice(deps, userId, f.org.id, f.general.id, take(over));

const messageCount = async () =>
  (await f.db.select({ n: count() }).from(messages).where(eq(messages.orgId, f.org.id)))[0]?.n ?? 0;

describe("dictation", () => {
  test("gives back the words and posts nothing", async () => {
    f = await setup();
    const before = await messageCount();
    const out = await dictate(voiceDeps([engine("  Ada, puxa as vendas  ")]));
    expect(out).toEqual({ text: "Ada, puxa as vendas" });
    expect(await messageCount()).toBe(before);
  });

  test("keeps no audio: the row counts the minutes, nothing is stored", async () => {
    f = await setup();
    const store = createMemoryBlobStore();
    await dictate(voiceDeps([engine("oi")], { blobs: singleStoreResolver(store) }), { durationMs: 4000 });
    const rows = await f.db.select().from(voiceClips).where(eq(voiceClips.orgId, f.org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "dictated", durationMs: 4000, size: 0, messageId: null, engine: "groq" });
    expect(rows[0]?.audioDeletedAt).not.toBeNull();
    expect(store.objects.size).toBe(0);
  });

  test("nothing said is an empty text, not an error", async () => {
    f = await setup();
    expect(await dictate(voiceDeps([engine("   ")]))).toEqual({ text: "" });
  });

  test("the next engine takes over from one that fails, with the workspace's names as hints", async () => {
    f = await setup();
    const second = engine("oi");
    expect(await dictate(voiceDeps([engine(new SpeechError("busy", "down")), second]))).toEqual({ text: "oi" });
    expect(second.heard[0]?.length).toBeGreaterThan(0);
  });

  test("every engine refusing and every engine down are told apart", async () => {
    f = await setup();
    await expect(dictate(voiceDeps([engine(new SpeechError("refused", "no"))]))).rejects.toMatchObject({
      code: "voice.no_words",
    });
    await expect(dictate(voiceDeps([engine(new SpeechError("busy", "down"))]))).rejects.toMatchObject({
      code: "voice.busy",
    });
  });

  test("only audio, within its limits, only with an engine, and only where the person may write", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")]);
    await expect(dictate(deps, { contentType: "text/html" })).rejects.toMatchObject({ code: "voice.bad_type" });
    await expect(dictate(deps, { durationMs: 6 * 60_000 })).rejects.toMatchObject({ code: "voice.bad_duration" });
    await expect(dictate(deps, { audio: new Uint8Array() })).rejects.toMatchObject({ code: "voice.too_large" });
    await expect(dictate(voiceDeps([]))).rejects.toMatchObject({ code: "voice.unavailable" });
    const outsider = await addUser(f.db, "outsider");
    await expect(dictate(deps, {}, outsider.id)).rejects.toThrow();
  });
});

describe("fair use is one budget for voice messages and dictation", () => {
  const limits: VoiceLimits = { personMinutesPerDay: 1, orgMinutesPerMember: 0, orgMinMinutesPerDay: 0 };

  test("dictated minutes stop the next recording of either kind", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi", "oi")], { limits });
    await dictate(deps, { durationMs: 90_000 });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(false);
    await expect(dictate(deps)).rejects.toMatchObject({ code: "voice.limit" });
    await expect(
      acceptVoiceClip(deps, f.owner.id, f.org.id, f.general.id, {
        audio: new Uint8Array([1]),
        contentType: "audio/mp4",
        durationMs: 3000,
        peaks: [],
        clientId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "voice.limit" });
  });

  test("a voice message's minutes stop dictation too", async () => {
    f = await setup();
    const deps = voiceDeps([engine("oi")], { limits });
    await acceptVoiceClip(deps, f.owner.id, f.org.id, f.general.id, {
      audio: new Uint8Array([1]),
      contentType: "audio/mp4",
      durationMs: 90_000,
      peaks: [],
      clientId: crypto.randomUUID(),
    });
    await expect(dictate(deps)).rejects.toMatchObject({ code: "voice.limit" });
  });

  test("a try every engine was down for costs no minutes", async () => {
    f = await setup();
    const deps = voiceDeps([engine(new SpeechError("busy", "down"), "oi")], { limits });
    await expect(dictate(deps, { durationMs: 90_000 })).rejects.toMatchObject({ code: "voice.busy" });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(true);
  });

  test("minutes count from the moment the words are asked for, so a second one meanwhile is stopped", async () => {
    f = await setup();
    let answer: (text: string) => void = () => {};
    let asked: () => void = () => {};
    const heard = new Promise<void>((resolve) => (asked = resolve));
    const slow: SpeechEngine = {
      ...engine(),
      file: () => {
        asked();
        return new Promise((resolve) => (answer = (text) => resolve({ text })));
      },
    };
    const deps = voiceDeps([slow], { limits });
    const first = dictate(deps, { durationMs: 90_000 });
    await heard;
    await expect(dictate(deps)).rejects.toMatchObject({ code: "voice.limit" });
    answer("oi");
    expect(await first).toEqual({ text: "oi" });
  });

  test("an engine failing in a way a retry can't fix is not hidden as busy, and costs no minutes", async () => {
    f = await setup();
    const deps = voiceDeps([engine(new SpeechError("auth", "key refused"))], { limits });
    await expect(dictate(deps, { durationMs: 90_000 })).rejects.toMatchObject({ reason: "auth" });
    expect(await voiceAllowed(deps, f.owner.id, f.org.id)).toBe(true);
  });
});

import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { fakeMicrophone } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Dictation in a conversation (ADR 0100 addendum): the words come back into the box, nothing is sent. */

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
});

async function open(dictated?: string) {
  restore = fakeMicrophone();
  const state = seedState({ media: { voiceAvailable: true } });
  if (dictated !== undefined) state.dictated = dictated;
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  return state;
}

const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;

async function dictate() {
  await act(async () => {
    fireEvent.pointerDown(screen().getByRole("button", { name: "Gravar áudio" }), { button: 0 });
    fireEvent.pointerUp(window);
  });
  await act(() => Bun.sleep(800));
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Transformar em texto" })));
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Pôr o texto na caixa" })));
  await settle(3);
}

test("the words land in the box to edit, and no voice message goes out", async () => {
  const state = await open("Ada, puxa as vendas de ontem");
  await dictate();
  expect(composer().value).toBe("Ada, puxa as vendas de ontem");
  const methods = state.calls.map((c) => c.method);
  expect(methods).toContain("voice.dictate");
  expect(methods).not.toContain("voice.send");
  expect(methods).not.toContain("chat.post");
}, 15_000);

test("nothing heard says so and leaves the box empty", async () => {
  await open("");
  await dictate();
  expect(composer().value).toBe("");
  expect(screen().getByText("Não ouvi nada. Nada foi enviado.")).toBeTruthy();
}, 15_000);

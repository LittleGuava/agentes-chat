import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer, type ComposerVoice } from "../src/components/Composer";
import type { VoiceTake } from "../src/components/voice-recorder";
import { fakeMicrophone } from "../testing/microphone";

/**
 * Dictation in the message box (ADR 0100 addendum): a recording's words land in the box to be edited, never sent.
 * "Transformar em texto" during a recording picks it, and every way a recording ends follows that choice.
 */

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
});

const labels: ComposerVoice["labels"] = {
  record: "Gravar áudio",
  recording: "Gravando áudio",
  pause: "Pausar",
  resume: "Continuar gravando",
  discard: "Apagar gravação",
  send: "Enviar áudio",
  listen: "Ouvir o que gravou",
  stopListening: "Parar de ouvir",
  keys: "Enter envia · Esc apaga",
  keysHold: "Solte para enviar · Esc apaga",
  keysPaused: "Pausado · Espaço ouve · Enter envia · Esc apaga",
  left: (s) => `faltam ${s} s`,
  askDiscard: "Apagar o áudio? O texto fica.",
  askDelete: "Apagar",
  askKeep: "Manter",
};

const dictationLabels = {
  toggle: "Transformar em texto",
  send: "Pôr o texto na caixa",
  transcribing: "Transcrevendo…",
  keys: "Enter vira texto · Esc apaga",
  keysHold: "Solte para virar texto · Esc apaga",
  keysPaused: "Pausado · Espaço ouve · Enter vira texto · Esc apaga",
};

interface Harness {
  sent: VoiceTake[];
  dictated: VoiceTake[];
  answer: (text: string) => void;
  fail: () => void;
  /** Seconds told to the others as "gravando áudio…". */
  told: number;
}

function setup(options: { dictation?: boolean; initial?: string } = {}) {
  const h: Harness = { sent: [], dictated: [], answer: () => {}, fail: () => {}, told: 0 };
  let moveTo: (scope: string) => void = () => {};
  function Box() {
    const [value, setValue] = useState(options.initial ?? "");
    const [scope, setScope] = useState("ch-1");
    moveTo = setScope;
    const voice: ComposerVoice = {
      scope,
      onTake: (take) => h.sent.push(take),
      onNotice: () => {},
      onRecording: () => h.told++,
      labels,
      ...(options.dictation === false
        ? {}
        : {
            dictation: {
              run: (take) => {
                h.dictated.push(take);
                return new Promise<string>((resolve, reject) => {
                  h.answer = resolve;
                  h.fail = () => reject(new Error("down"));
                });
              },
              labels: dictationLabels,
            },
          }),
    };
    return (
      <Composer value={value} onChange={setValue} onSend={() => {}} label="Mensagem" sendLabel="Enviar" voice={voice} />
    );
  }
  restore = fakeMicrophone();
  render(<Box />);
  return { h, moveTo: (scope: string) => act(async () => moveTo(scope)) };
}

const box = () => screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
const button = (name: string) => screen.getByRole("button", { name });

async function record() {
  await act(async () => {
    fireEvent.pointerDown(button("Gravar áudio"), { button: 0 });
    fireEvent.pointerUp(window);
  });
  await act(() => Bun.sleep(800));
}

describe("dictation in the message box", () => {
  test("“Transformar em texto” turns the recording's end into words in the box, never a voice message", async () => {
    const { h } = setup();
    await record();
    const toggle = button("Transformar em texto");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Enter vira texto · Esc apaga")).toBeTruthy();
    await act(async () => fireEvent.click(button("Pôr o texto na caixa")));
    expect(h.sent).toHaveLength(0);
    expect(h.dictated).toHaveLength(1);
    // Transcribing: the microphone says so and takes no new recording.
    const mic = button("Transcrevendo…");
    expect(mic.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0 });
      fireEvent.pointerUp(window);
    });
    await act(() => Bun.sleep(50));
    expect(screen.queryByRole("group", { name: "Gravando áudio" })?.closest("[data-voice]")).toBeNull();
    await act(async () => h.answer("Ada, puxa as vendas"));
    expect(box().value).toBe("Ada, puxa as vendas");
    expect(button("Gravar áudio")).toBeTruthy();
  });

  test("Enter follows the choice too, and the words go where the caret is now, in what the box holds now", async () => {
    const { h } = setup({ initial: "Oi" });
    await record();
    await act(async () => fireEvent.click(button("Transformar em texto")));
    await act(async () => fireEvent.keyDown(window, { key: "Enter" }));
    expect(h.dictated).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    // Typed while the words were on their way: they go in at the caret, a space before them.
    await act(async () => fireEvent.change(box(), { target: { value: "Oi, Ada." } }));
    box().setSelectionRange(9, 9);
    await act(async () => h.answer("Puxa as vendas"));
    expect(box().value).toBe("Oi, Ada. Puxa as vendas");
  });

  test("the choice stays for the next recording, and turned off a recording is a voice message again", async () => {
    const { h } = setup();
    await record();
    await act(async () => fireEvent.click(button("Transformar em texto")));
    await act(async () => fireEvent.click(button("Pôr o texto na caixa")));
    await act(async () => h.answer("um"));
    await record();
    expect(button("Transformar em texto").getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(button("Transformar em texto")));
    await act(async () => fireEvent.click(button("Enviar áudio")));
    expect(h.sent).toHaveLength(1);
    expect(h.dictated).toHaveLength(1);
  });

  test("words that come after the box moved to another conversation are dropped", async () => {
    const { h, moveTo } = setup();
    await record();
    await act(async () => fireEvent.click(button("Transformar em texto")));
    await act(async () => fireEvent.click(button("Pôr o texto na caixa")));
    await moveTo("ch-2");
    await act(async () => h.answer("não é daqui"));
    expect(box().value).toBe("");
    expect(button("Gravar áudio")).toBeTruthy();
  });

  test("a failure leaves the box as it was and the microphone ready", async () => {
    const { h } = setup({ initial: "rascunho" });
    await record();
    await act(async () => fireEvent.click(button("Transformar em texto")));
    await act(async () => fireEvent.click(button("Pôr o texto na caixa")));
    await act(async () => h.fail());
    expect(box().value).toBe("rascunho");
    expect(button("Gravar áudio").getAttribute("aria-busy")).toBeNull();
  });

  test("a recording for text tells nobody it records, and a held microphone let go puts the words in the box", async () => {
    const { h } = setup();
    await record();
    expect(h.told).toBeGreaterThan(0);
    await act(async () => fireEvent.click(button("Transformar em texto")));
    // Off the recording that was a voice message, then a held one with the choice still on.
    await act(async () => fireEvent.click(button("Apagar gravação")));
    const before = h.told;
    await act(async () => fireEvent.pointerDown(button("Gravar áudio"), { button: 0 }));
    await act(() => Bun.sleep(1500));
    expect(h.told).toBe(before);
    await act(async () => fireEvent.pointerUp(window));
    expect(h.dictated).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    await act(async () => h.answer("segurado"));
    expect(box().value).toBe("segurado");
  });

  test("without dictation there is no choice to make", async () => {
    setup({ dictation: false });
    await record();
    expect(screen.queryByRole("button", { name: "Transformar em texto" })).toBeNull();
  });
});

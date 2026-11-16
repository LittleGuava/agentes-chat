import { describe, expect, test } from "bun:test";
import { en, ptBR } from "@agenteschat/i18n";
import type { ServerUpdateRun, ServerUpdaterStatus } from "../src/api/types";
import { serverUpdateBusy, serverUpdateLine } from "../src/lib/server-updater";

const run = (state: ServerUpdateRun["state"]): ServerUpdateRun => ({
  state,
  step: state === "running" ? "backing_up" : null,
  reason: null,
  startedAt: "2026-11-15T12:00:00Z",
  finishedAt: state === "running" ? null : "2026-11-15T12:03:00Z",
  from: "sha256:0123456789ab",
  to: "sha256:ba9876543210",
});
const view = (over: Partial<ServerUpdaterStatus> = {}): ServerUpdaterStatus => ({
  helper: "ready",
  requested: false,
  canUpdate: true,
  run: null,
  ...over,
});

describe("the server update card (ADR 0200)", () => {
  test("asks again only while a request waits or a run goes on", () => {
    expect(serverUpdateBusy(null)).toBe(false);
    expect(serverUpdateBusy(view())).toBe(false);
    expect(serverUpdateBusy(view({ run: run("updated") }))).toBe(false);
    expect(serverUpdateBusy(view({ requested: true }))).toBe(true);
    expect(serverUpdateBusy(view({ run: run("running") }))).toBe(true);
  });

  test("says what happened last, and an absent updater first", () => {
    expect(serverUpdateLine(view())).toBeNull();
    expect(serverUpdateLine(view({ helper: "absent", run: run("updated") }))).toBe("settings.serverUpdater.absent");
    expect(serverUpdateLine(view({ requested: true, run: run("updated") }))).toBe("settings.serverUpdater.requested");
    expect(serverUpdateLine(view({ requested: true, run: run("running") }))).toBe("settings.serverUpdater.running");
    expect(serverUpdateLine(view({ run: run("rolled_back") }))).toBe("settings.serverUpdater.rolledBack");
    expect(serverUpdateLine(view({ run: run("current") }))).toBe("settings.serverUpdater.current");
  });

  test("every line has words in English and Portuguese", () => {
    const states: ServerUpdateRun["state"][] = [
      "running",
      "updated",
      "current",
      "pinned",
      "rolled_back",
      "failed",
      "interrupted",
    ];
    const lines = [
      ...states.map((state) => serverUpdateLine(view({ run: run(state) }))),
      serverUpdateLine(view({ helper: "absent" })),
      serverUpdateLine(view({ requested: true })),
    ];
    for (const [lang, strings] of [
      ["en", en],
      ["pt-BR", ptBR],
    ] as const) {
      const words: Record<string, unknown> = strings.settings.serverUpdater;
      for (const line of lines) {
        const leaf = line?.split(".").at(-1) ?? "";
        expect({ lang, leaf, words: typeof words[leaf] }).toEqual({
          lang,
          leaf,
          words: "string",
        });
      }
    }
  });
});

import { expect, test } from "bun:test";
import { newestServerRelease, serverUpdate, updateChecks } from "../src/server-update";

const REPO = "agentes-chat/agentes-chat";
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: "2026-11-10T12:00:00Z",
  ...extra,
});

test("the newest server release is the highest v<x.y.z> published, whatever else the repository releases", () => {
  const list = [
    release("desktop-v0.9.0"),
    release("setup-v2.0.0"),
    release("v1.10.0-rc.1", { prerelease: true }),
    release("v9.9.9", { draft: true }),
    release("v1.2.0"),
    release("v1.10.0", { published_at: "2026-11-12T08:00:00Z" }),
    release("v1.9.3"),
  ];
  expect(newestServerRelease(list, REPO)).toEqual({
    version: "1.10.0",
    publishedAt: "2026-11-12T08:00:00Z",
    notesUrl: `https://github.com/${REPO}/releases/tag/v1.10.0`,
  });
});

test("anything that isn't a release list is no release", () => {
  expect(newestServerRelease({ message: "API rate limit exceeded" }, REPO)).toBeNull();
  expect(newestServerRelease([null, 3, { tag_name: 7 }, release("desktop-v1.0.0")], REPO)).toBeNull();
  expect(newestServerRelease([], REPO)).toBeNull();
});

test("an update is a newer release, its notes and the command that installs it", () => {
  const latest = { version: "1.10.0", publishedAt: null, notesUrl: `https://github.com/${REPO}/releases/tag/v1.10.0` };
  expect(serverUpdate({ current: "1.9.3", latest, install: "docker", repo: REPO })).toEqual({
    version: "1.9.3",
    latest,
    updateAvailable: true,
    install: "docker",
    command: [
      `curl -fsSLO https://raw.githubusercontent.com/${REPO}/v1.10.0/docker-compose.yml`,
      "docker compose pull",
      "docker compose up -d",
    ].join("\n"),
  });
  expect(serverUpdate({ current: "1.9.3", latest, install: "native", repo: REPO }).command).toBe(
    "~/.agentes/app/1.10.0/bin/agentes-server service install --data ~/.agentes",
  );
  // The same version, a newer one here (a build from main), or a version that isn't x.y.z: nothing to install.
  for (const current of ["1.10.0", "1.10.1", "2.0.0", "2026.10.31.4", "0.0.0-dev"]) {
    expect(serverUpdate({ current, latest, install: "docker", repo: REPO })).toMatchObject({
      updateAvailable: false,
      command: null,
    });
  }
  expect(serverUpdate({ current: "1.9.3", latest: null, install: "docker", repo: REPO })).toMatchObject({
    updateAvailable: false,
    command: null,
  });
});

test("the check is on by default, never on agentes.chat itself nor in the desktop app's server", () => {
  const selfhost = { UPDATE_CHECK: "on" as const, PUBLIC_URL: "https://chat.example.com" };
  expect(updateChecks(selfhost, "docker")).toBe(true);
  expect(updateChecks(selfhost, "native")).toBe(true);
  expect(updateChecks(selfhost, "desktop")).toBe(false);
  expect(updateChecks({ ...selfhost, UPDATE_CHECK: "off" }, "docker")).toBe(false);
  expect(updateChecks({ ...selfhost, PUBLIC_URL: "https://app.agentes.chat" }, "docker")).toBe(false);
});

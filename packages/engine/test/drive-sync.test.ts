import { afterEach, expect, test } from "bun:test";
import {
  addChannelMember,
  createArtifact,
  createChannel,
  createFileArtifact,
  driveSyncList,
  updateArtifact,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const person = (userId: string) => ({ type: "person" as const, userId });

test("the agents' files in the chosen conversations, with names that don't change between versions (ADR 0204)", async () => {
  f = await setup();
  const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  const report = await createArtifact(f.artifactDeps, agent, f.org.id, {
    title: "Relatório de março",
    content: { kind: "document", markdown: "# Março" },
  });
  await updateArtifact(f.artifactDeps, agent, f.org.id, report.id, {
    content: { kind: "document", markdown: "# Março\nVendas: 12" },
  });
  await createArtifact(f.artifactDeps, agent, f.org.id, {
    title: "Vendas",
    content: { kind: "table", columns: ["mês"], rows: [["março"]] },
  });
  await createFileArtifact(f.artifactDeps, agent, f.org.id, {
    title: "Contrato",
    name: "contrato.pdf",
    bytes: new TextEncoder().encode("%PDF-1.4"),
  });
  // A person's own file and a poll-like block are not the agents' work in the Drive.
  await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, {
    title: "Notas da Ana",
    content: { kind: "document", markdown: "x" },
    channelId: f.general.id,
  });

  const { files, truncated } = await driveSyncList(f.db, f.owner.id, f.org.id, [f.general.id]);

  expect(truncated).toBe(false);
  const byName = Object.fromEntries(files.map((file) => [file.name, file]));
  expect(Object.keys(byName).sort()).toEqual(["Relatório de março.md", "Vendas.csv", "contrato.pdf"]);
  expect(byName["Relatório de março.md"]).toMatchObject({
    id: report.id,
    kind: "document",
    version: 2,
    format: null,
    agent: { id: f.agent.id, name: f.agent.name },
    conversation: { id: f.general.id, name: f.general.name, dm: false },
  });
  expect(byName["Vendas.csv"]?.format).toBe("csv");
  expect(byName["contrato.pdf"]).toMatchObject({ kind: "file", format: null });
});

test("a conversation the person can't read lists nothing, even when asked for", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
  await createArtifact(f.artifactDeps, { type: "agent", agentId: f.agent.id, channelId: secret.id }, f.org.id, {
    title: "Plano",
    content: { kind: "document", markdown: "x" },
  });

  expect((await driveSyncList(f.db, bia.id, f.org.id, [secret.id])).files).toEqual([]);
  expect((await driveSyncList(f.db, f.owner.id, f.org.id, [secret.id])).files.map((x) => x.name)).toEqual(["Plano.md"]);
});

import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument, type YAMLMap } from "yaml";
import type { MigrationBundle } from "../../api/types";
import { AGENT_HANDLE } from "../new-agent";
import { slug } from "./shared";

/**
 * A team file (`team.yaml`): the workspace's agents, skills, channels, routines and notes written by hand and kept in
 * git, read into the bundle every import plans (ADR 0055, addendum 2026-11-15). It maps one to one onto the bundle;
 * every problem is reported at once, each at its line and column. Pure: `{ file: PATH }` texts come from `read`.
 */

/** `source.app` of what a team file brings: with its `id`, the package a later apply updates and prunes. */
export const TEAM_FILE_APP = "team-file";

export interface TeamFileProblem {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  message: string;
}

export class TeamFileError extends Error {
  constructor(readonly problems: TeamFileProblem[]) {
    super(problems.map((p) => `${p.line}:${p.column}: ${p.message}`).join("\n"));
    this.name = "TeamFileError";
  }
}

/** `team.yaml:12:5: unknown field "rol" …`, one line each, as editors and CI logs link them. */
export const formatProblems = (file: string, problems: TeamFileProblem[]) =>
  problems.map((p) => `${file}:${p.line}:${p.column}: ${p.message}`).join("\n");

export interface TeamFileOptions {
  /** The file's name, kept in `source.files`. */
  name?: string;
  /**
   * The text of a path relative to the team file (`/` separators, never `..`), or null when it isn't there. Left out
   * (the file came from standard input): a `{ file }` can't be read.
   */
  read?: (path: string) => string | null;
}

/** The server's channel names (`CHANNEL_NAME_PATTERN` in packages/engine/src/channels.ts). */
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NOTE_KINDS = ["fact", "preference", "decision", "note", "lesson"] as const;
type NoteKind = (typeof NOTE_KINDS)[number];

/** BOM dropped and line ends made LF, so a Windows checkout and a Linux CI hash the same text. */
const normalized = (text: string) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

const FIELDS = {
  root: ["version", "id", "name", "agents", "skills", "channels", "routines", "notes"],
  agent: ["handle", "name", "role", "instructions", "model", "look", "skills"],
  look: ["color", "eyes", "accessory"],
  skill: ["key", "file", "markdown"],
  channel: ["name", "topic", "agents"],
  member: ["handle", "autoReply"],
  routine: ["key", "name", "agent", "channel", "cron", "timezone", "prompt"],
  note: ["key", "agent", "kind", "title", "content"],
  file: ["file"],
};

/** Reads a team file into a bundle. Throws `TeamFileError` with every problem found. */
export function parseTeamFile(text: string, options: TeamFileOptions = {}): MigrationBundle {
  const lines = new LineCounter();
  const doc = parseDocument(normalized(text), { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const problems: TeamFileProblem[] = [];
  const fail = (offset: number, message: string) => {
    const { line, col } = lines.linePos(offset);
    problems.push({ line, column: col, message });
  };
  const at = (node: Node | null | undefined, message: string) => fail(node?.range?.[0] ?? 0, message);
  const done = () => {
    if (problems.length === 0) return;
    problems.sort((a, b) => a.line - b.line || a.column - b.column);
    throw new TeamFileError(problems);
  };

  for (const error of doc.errors) fail(error.pos[0], error.message.split("\n")[0] ?? error.message);
  done();
  const root = doc.contents;
  if (!isMap(root)) {
    at(root, "a team file is a map (version, name, agents, …)");
    done();
    throw new TeamFileError(problems);
  }

  /** The fields of a map, an unknown one reported where it is written. */
  const fieldsOf = (map: YAMLMap, where: string, allowed: string[]) => {
    const found = new Map<string, Node | null>();
    for (const pair of map.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      if (!allowed.includes(key)) {
        at(pair.key as Node, `unknown field "${key}" in ${where} (${allowed.join(", ")})`);
        continue;
      }
      const value = pair.value as Node | null;
      // `name:` with nothing after it is the same as leaving it out.
      found.set(key, isScalar(value) && value.value === null ? null : (value ?? null));
    }
    return found;
  };
  const textOf = (node: Node, where: string): string | undefined => {
    if (isScalar(node) && typeof node.value === "string") return node.value;
    at(node, `${where} must be text`);
    return undefined;
  };
  /** The text at a path beside the team file: relative, never leaving its folder. */
  const readPath = (pathNode: Node, where: string): string | undefined => {
    const written = textOf(pathNode, `${where}.file`);
    if (written === undefined) return undefined;
    const path = written.replace(/\\/g, "/");
    if (path.startsWith("/") || /^[a-z]:/i.test(path)) {
      at(pathNode, `${written} must be relative to the team file`);
      return undefined;
    }
    if (path.split("/").includes("..")) {
      at(pathNode, `${written} leaves the team file's folder`);
      return undefined;
    }
    if (!options.read) {
      at(pathNode, `${written} can't be read: the team file came without its folder`);
      return undefined;
    }
    const content = options.read(path.replace(/^(\.\/)+/, ""));
    if (content === null) {
      at(pathNode, `${written} isn't there`);
      return undefined;
    }
    return normalized(content);
  };
  /** Text written in place, or `{ file: PATH }` beside the team file. */
  const textOrFile = (node: Node, where: string): string | undefined => {
    if (isScalar(node) && typeof node.value === "string") return node.value;
    if (isMap(node)) {
      const pathNode = fieldsOf(node, where, FIELDS.file).get("file");
      if (pathNode) return readPath(pathNode, where);
      at(node, `${where} needs "file"`);
      return undefined;
    }
    at(node, `${where} must be text or { file: PATH }`);
    return undefined;
  };
  const listOf = (node: Node | null | undefined, where: string): Node[] => {
    if (!node) return [];
    if (isSeq(node)) return node.items as Node[];
    at(node, `${where} must be a list`);
    return [];
  };
  const mapOf = (node: Node, where: string): YAMLMap | undefined => {
    if (isMap(node)) return node;
    at(node, `${where} must be a map`);
    return undefined;
  };

  const top = fieldsOf(root, "the team file", FIELDS.root);
  const version = top.get("version");
  if (!version) at(root, '"version" is required (version: 1)');
  else if (!isScalar(version) || version.value !== 1) at(version, '"version" must be 1');
  const nameNode = top.get("name");
  const name = nameNode ? textOf(nameNode, '"name"')?.trim() : undefined;
  if (!nameNode) at(root, '"name" is required: the team\'s name');
  const idNode = top.get("id");
  const id = idNode ? textOf(idNode, '"id"') : undefined;
  if (idNode && id !== undefined && !TEAM_ID.test(id)) {
    at(idNode, `"${id}" isn't an id: up to 64 of a-z, 0-9 or -, starting with a letter or digit`);
  }
  const ref = id ?? slug(name ?? "");
  if (name !== undefined && !idNode && !ref) at(nameNode, '"name" needs a letter or digit, or give the file an "id"');

  /** Keys seen per kind, to refuse a repeat and to check what refers to them. */
  const keys = { agent: new Set<string>(), skill: new Set<string>(), channel: new Set<string>() };
  const unique = (seen: Set<string>, key: string, node: Node | null | undefined, kind: string) => {
    if (seen.has(key)) at(node, `${kind} "${key}" appears twice`);
    seen.add(key);
  };
  /** References are checked once every key is known. */
  const refs: { kind: keyof typeof keys; key: string; node: Node }[] = [];
  const refer = (kind: keyof typeof keys, node: Node, where: string) => {
    const key = textOf(node, where);
    if (key !== undefined) refs.push({ kind, key, node });
    return key ?? "";
  };
  /** A required field, else a problem at the item. */
  const need = (fields: Map<string, Node | null>, field: string, item: Node, where: string) => {
    const node = fields.get(field);
    if (!node) at(item, `${where} needs "${field}"`);
    return node ?? undefined;
  };

  const agents: MigrationBundle["agents"] = [];
  listOf(top.get("agents"), '"agents"').forEach((node, i) => {
    const where = `agents[${i}]`;
    const map = mapOf(node, where);
    if (!map) return;
    const f = fieldsOf(map, where, FIELDS.agent);
    const handleNode = need(f, "handle", map, where);
    const handle = handleNode ? textOf(handleNode, `${where}.handle`) : undefined;
    if (handleNode && handle !== undefined) {
      if (!AGENT_HANDLE.test(handle)) {
        at(handleNode, `"${handle}" isn't a handle: 2-32 of a-z, 0-9, - or _, starting with a letter or digit`);
      } else unique(keys.agent, handle, map, "agent");
    }
    const nameField = need(f, "name", map, where);
    const role = f.get("role");
    // Required: an import keeps what an earlier one brought for an agent that comes with none, so a change to its
    // name or role would never land and a check would never see it.
    const instructionsNode = need(f, "instructions", map, where);
    const instructions = instructionsNode && textOrFile(instructionsNode, `${where}.instructions`);
    if (instructionsNode && instructions !== undefined && !instructions.trim()) {
      at(instructionsNode, `${where}.instructions is empty`);
    }
    const model = f.get("model");
    const look = f.get("look");
    const appearance: MigrationBundle["agents"][number]["appearance"] = {};
    const lookMap = look ? mapOf(look, `${where}.look`) : undefined;
    if (lookMap) {
      for (const [field, value] of fieldsOf(lookMap, `${where}.look`, FIELDS.look)) {
        const text = value ? textOf(value, `${where}.look.${field}`) : undefined;
        if (text !== undefined) appearance[field as keyof typeof appearance] = text;
      }
    }
    agents.push({
      key: handle ?? "",
      name: (nameField && textOf(nameField, `${where}.name`)) ?? "",
      handle: handle ?? "",
      role: (role && textOf(role, `${where}.role`)) ?? "",
      instructions: instructions ?? "",
      model: (model && textOf(model, `${where}.model`)) || null,
      appearance,
      skills: listOf(f.get("skills"), `${where}.skills`).map((s, j) => refer("skill", s, `${where}.skills[${j}]`)),
    });
  });

  const skills: MigrationBundle["skills"] = [];
  listOf(top.get("skills"), '"skills"').forEach((node, i) => {
    const where = `skills[${i}]`;
    const map = mapOf(node, where);
    if (!map) return;
    const f = fieldsOf(map, where, FIELDS.skill);
    const file = f.get("file");
    const inline = f.get("markdown");
    if (!file === !inline) {
      at(map, `${where} needs "file" or "markdown" (one of them)`);
      return;
    }
    const keyNode = f.get("key");
    let key = keyNode ? textOf(keyNode, `${where}.key`) : undefined;
    if (!keyNode && file) {
      // `skills/research/SKILL.md` is the skill `research`.
      const path = (isScalar(file) && typeof file.value === "string" ? file.value : "").replace(/\\/g, "/");
      key = path.split("/").slice(-2, -1)[0];
      if (!key) {
        at(map, `${where} needs "key" (its file has no folder)`);
        return;
      }
    }
    if (!keyNode && inline) {
      at(map, `${where} needs "key"`);
      return;
    }
    const markdown = file ? readPath(file, where) : textOf(inline as Node, `${where}.markdown`);
    if (key === undefined) return;
    unique(keys.skill, key, keyNode ?? map, "skill");
    skills.push({ key, markdown: markdown ?? "" });
  });

  const channels: MigrationBundle["channels"] = [];
  listOf(top.get("channels"), '"channels"').forEach((node, i) => {
    const where = `channels[${i}]`;
    const map = mapOf(node, where);
    if (!map) return;
    const f = fieldsOf(map, where, FIELDS.channel);
    const nameField = need(f, "name", map, where);
    const channelName = nameField ? textOf(nameField, `${where}.name`) : undefined;
    if (nameField && channelName !== undefined) {
      if (!CHANNEL_NAME.test(channelName) || channelName.startsWith("dm-")) {
        at(
          nameField,
          `"${channelName}" isn't a channel name: up to 80 of a-z, 0-9, - or _, starting with a letter or digit`,
        );
      } else unique(keys.channel, channelName, map, "channel");
    }
    const topic = f.get("topic");
    const members = listOf(f.get("agents"), `${where}.agents`).map((m, j) => {
      const member = `${where}.agents[${j}]`;
      if (!isMap(m)) return { key: refer("agent", m, member), autoReply: true };
      const mf = fieldsOf(m, member, FIELDS.member);
      const handle = need(mf, "handle", m, member);
      const auto = mf.get("autoReply");
      if (auto && !(isScalar(auto) && typeof auto.value === "boolean"))
        at(auto, `${member}.autoReply must be true or false`);
      return {
        key: handle ? refer("agent", handle, `${member}.handle`) : "",
        autoReply: !(auto && isScalar(auto) && auto.value === false),
      };
    });
    channels.push({
      key: channelName ?? "",
      name: channelName ?? "",
      topic: (topic && textOf(topic, `${where}.topic`)) ?? "",
      agents: members,
    });
  });

  const routines: MigrationBundle["routines"] = [];
  const routineKeys = new Set<string>();
  listOf(top.get("routines"), '"routines"').forEach((node, i) => {
    const where = `routines[${i}]`;
    const map = mapOf(node, where);
    if (!map) return;
    const f = fieldsOf(map, where, FIELDS.routine);
    const nameField = need(f, "name", map, where);
    const routineName = nameField ? textOf(nameField, `${where}.name`) : undefined;
    const keyNode = f.get("key");
    const key = keyNode ? textOf(keyNode, `${where}.key`) : routineName;
    if (key !== undefined) unique(routineKeys, key, keyNode ?? map, "routine");
    const agent = need(f, "agent", map, where);
    const channel = f.get("channel");
    const cron = need(f, "cron", map, where);
    const zone = f.get("timezone");
    const prompt = need(f, "prompt", map, where);
    routines.push({
      key: key ?? "",
      name: routineName ?? "",
      agent: agent ? refer("agent", agent, `${where}.agent`) : "",
      prompt: (prompt && textOrFile(prompt, `${where}.prompt`)) ?? "",
      channel: channel ? refer("channel", channel, `${where}.channel`) : null,
      trigger: {
        cron: (cron && textOf(cron, `${where}.cron`)) ?? "",
        timezone: (zone && textOf(zone, `${where}.timezone`)) || null,
      },
    });
  });

  const notes: MigrationBundle["notes"] = [];
  const noteKeys = new Set<string>();
  listOf(top.get("notes"), '"notes"').forEach((node, i) => {
    const where = `notes[${i}]`;
    const map = mapOf(node, where);
    if (!map) return;
    const f = fieldsOf(map, where, FIELDS.note);
    const titleNode = f.get("title");
    const title = titleNode ? textOf(titleNode, `${where}.title`) : undefined;
    const keyNode = f.get("key");
    const key = keyNode ? textOf(keyNode, `${where}.key`) : title;
    if (!keyNode && !titleNode) at(map, `${where} needs "key" or "title"`);
    if (key !== undefined) unique(noteKeys, key, keyNode ?? map, "note");
    const agent = f.get("agent");
    const kindNode = f.get("kind");
    const kind = kindNode ? textOf(kindNode, `${where}.kind`) : "note";
    if (kindNode && kind !== undefined && !NOTE_KINDS.includes(kind as NoteKind)) {
      at(kindNode, `${where}.kind must be one of ${NOTE_KINDS.join(", ")}`);
    }
    const content = need(f, "content", map, where);
    notes.push({
      key: key ?? "",
      agent: agent ? refer("agent", agent, `${where}.agent`) : null,
      kind: (kind ?? "note") as NoteKind,
      ...(title !== undefined ? { title } : {}),
      content: (content && textOrFile(content, `${where}.content`)) ?? "",
    });
  });

  for (const r of refs) {
    if (!keys[r.kind].has(r.key)) at(r.node, `${r.kind} "${r.key}" isn't in the file`);
  }
  done();

  return {
    format: "agenteschat.bundle",
    version: 1,
    source: { app: TEAM_FILE_APP, ref, name: name ?? ref, files: options.name ? [options.name] : [] },
    agents,
    skills,
    channels,
    routines,
    notes,
    todo: [],
    leftOut: [],
  };
}

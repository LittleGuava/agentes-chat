import { and, count, type Database, eq, gt, lte, schema } from "@agenteschat/db";
import { type JSONValue, search } from "@jmespath-community/jmespath";
import { cutText } from "../format";
import { untrustedBlock } from "../untrusted";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./types";

/**
 * Long tool results (ADR 0015, addendum on long results): a JSON answer longer than the model reads at once is kept
 * whole for the run, the model gets its shape and an id, and reads the parts it needs with `query_result` (a JMESPath
 * expression). Anything else past the limit is still cut, as before.
 */
export const QUERY_RESULT_TOOL = "query_result";
/** How long a kept answer can be read: the turns that use it come right after it. */
export const LONG_RESULT_TTL_MS = 60 * 60_000;
/** Longer than this is kept no more than any other text: cut at the limit. */
const MAX_KEPT_CHARS = 4_000_000;
/** A run that keeps asking for huge answers past this gets them cut, like before. */
const MAX_KEPT_PER_RUN = 20;
const MAX_EXPRESSION_CHARS = 2000;
/** What the shape of an answer may take, whatever the answer. */
const SHAPE_LINES = 120;
const SHAPE_DEPTH = 6;
const SHAPE_KEYS = 40;
const SHAPE_LINE_CHARS = 200;
const SAMPLE_CHARS = 60;
/** Items of an array whose keys make its items' shape. */
const SHAPE_ITEMS = 50;
/** Room for the outside-content frame around a part, so the gateway's cut never takes its closing mark. */
const FRAME_ROOM = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GONE =
  "No kept result with that result_id in this run: it expired (they are kept for an hour) or came from another run. Call the tool again for a fresh one.";

const { toolResults } = schema;

type JsonObject = { [key: string]: JSONValue };
const isObject = (v: JSONValue): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The tool's text as JSON, when it is one object or array; anything else (prose, a log, a number) is not kept. */
function jsonOf(text: string): JSONValue | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as JSONValue;
  } catch {
    return undefined;
  }
}

const kindOf = (v: JSONValue) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** A path below `path`, written as a JMESPath expression reads it (`@` is the whole answer). */
const keyPath = (path: string, key: string) =>
  `${path === "@" ? "" : `${path}.`}${IDENTIFIER.test(key) ? key : JSON.stringify(key)}`;
const itemsPath = (path: string) => `${path === "@" ? "" : path}[*]`;

/** One object standing for an array's objects: every key any of them has, with the first value that isn't null. */
function mergedItems(items: JsonObject[]): JsonObject {
  const merged: JsonObject = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (!(key in merged) || merged[key] === null) merged[key] = value;
    }
  }
  return merged;
}

function describe(value: JSONValue, path: string, depth: number, lines: string[]): void {
  if (lines.length >= SHAPE_LINES) return;
  if (Array.isArray(value)) {
    lines.push(`${path}: array, ${value.length} items`);
    if (value.length === 0 || depth >= SHAPE_DEPTH) return;
    const items = value.slice(0, SHAPE_ITEMS);
    const objects = items.filter(isObject);
    const kinds = [...new Set(items.map(kindOf))];
    const first = items[0] ?? null;
    if (objects.length === items.length) describe(mergedItems(objects), itemsPath(path), depth + 1, lines);
    else if (kinds.length === 1) describe(first, itemsPath(path), depth + 1, lines);
    else lines.push(`${itemsPath(path)}: ${kinds.join(" or ")}, e.g. ${sample(first)}`);
    return;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    // The whole answer's own line says nothing its keys don't.
    if (path !== "@" || keys.length === 0) lines.push(`${path}: object, ${keys.length} keys`);
    if (depth >= SHAPE_DEPTH) {
      if (keys.length > 0) lines.push(`${path} keys: ${keys.slice(0, SHAPE_KEYS).join(", ")}`);
      return;
    }
    for (const key of keys.slice(0, SHAPE_KEYS)) describe(value[key] ?? null, keyPath(path, key), depth + 1, lines);
    if (keys.length > SHAPE_KEYS) {
      lines.push(
        `${path}: ${keys.length - SHAPE_KEYS} more keys (${keys.slice(SHAPE_KEYS, SHAPE_KEYS + 20).join(", ")}…)`,
      );
    }
    return;
  }
  const size = typeof value === "string" && value.length > SAMPLE_CHARS ? ` (${value.length} chars)` : "";
  lines.push(`${path}: ${kindOf(value)}${size} = ${sample(value)}`);
}

function sample(value: JSONValue): string {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (isObject(value)) return `{${Object.keys(value).length} keys}`;
  const text = typeof value === "string" && value.length > SAMPLE_CHARS ? `${cutText(value, SAMPLE_CHARS)}…` : value;
  return JSON.stringify(text);
}

/** The shape of a JSON value, one line per path (JMESPath), with a sample of each value. */
export function jsonShape(value: JSONValue): string {
  const lines: string[] = [];
  describe(value, "@", 0, lines);
  const more = lines.length >= SHAPE_LINES ? "\n… (more paths: ask for a part to see its shape)" : "";
  return lines.map((line) => cutText(line, SHAPE_LINE_CHARS)).join("\n") + more;
}

/** Text from outside the org is read inside the one envelope for outside content, wherever it is shown. */
const framed = (outside: boolean, tool: string, text: string, max: number) =>
  outside ? untrustedBlock(tool, text, max) : text;

/**
 * Keeps a tool's JSON answer too long for the model, and says what the model gets instead: how long it is, its id,
 * how to read it and its shape. Null when it isn't kept (not JSON, too long even to keep, not a run's call, or the
 * run kept enough already): the gateway cuts it as before.
 */
export async function keepLongResult(
  ctx: ToolContext,
  tool: Pick<ToolDefinition, "name" | "external" | "readsOutside">,
  text: string,
  limits: { now: Date; maxChars: number },
): Promise<string | null> {
  if (!UUID.test(ctx.runId) || text.length > MAX_KEPT_CHARS) return null;
  const value = jsonOf(text);
  if (value === undefined) return null;
  const [kept] = await ctx.db
    .select({ n: count() })
    .from(toolResults)
    .where(and(eq(toolResults.runId, ctx.runId), gt(toolResults.expiresAt, limits.now)));
  if ((kept?.n ?? 0) >= MAX_KEPT_PER_RUN) return null;
  const outside = Boolean(tool.external || tool.readsOutside);
  const [row] = await ctx.db
    .insert(toolResults)
    .values({
      orgId: ctx.orgId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      tool: tool.name,
      outside,
      content: text,
      expiresAt: new Date(limits.now.getTime() + LONG_RESULT_TTL_MS),
    })
    .returning({ id: toolResults.id });
  if (!row) return null;
  return [
    `This answer is ${text.length.toLocaleString("en-US")} characters of JSON, more than the ${limits.maxChars.toLocaleString("en-US")} you read at once, so it is kept whole for this run for the next hour as result_id "${row.id}".`,
    `Read the parts you need with ${QUERY_RESULT_TOOL}: that result_id and a JMESPath expression (\`items[0]\`, \`items[?state=='open'].{id: id, title: title}\`, \`length(items)\`, \`keys(@)\`).`,
    "Its shape, one path per line:",
    framed(outside, tool.name, jsonShape(value), limits.maxChars),
  ].join("\n");
}

/** Deletes kept answers past their time; run again, it finds nothing more to do. */
export async function sweepExpiredToolResults(db: Database, now = new Date()): Promise<number> {
  const swept = await db.delete(toolResults).where(lte(toolResults.expiresAt, now)).returning({ id: toolResults.id });
  return swept.length;
}

const refused = (content: string): ToolOutput => ({ content, isError: true });

/** `query_result`: a part of an answer this run kept, by a JMESPath expression. */
export function createQueryResultToolSource(deps: { now: () => Date; maxChars: number }): ToolSource {
  const tool: ToolDefinition = {
    name: QUERY_RESULT_TOOL,
    description:
      "Read part of a tool's answer that was too long to show you whole: give the result_id that answer named and a JMESPath expression for the part you need (a field, a filter, a slice, a projection, length()). Kept for an hour, for this run only.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        result_id: { type: "string", description: "The result_id the long answer gave you." },
        expression: {
          type: "string",
          description:
            "JMESPath over the whole answer, e.g. `items[0]`, `items[?state=='open'] | [0:20].{id: id, title: title}`, `length(items)`, `keys(@)`.",
        },
      },
      required: ["result_id", "expression"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const id = typeof input.result_id === "string" ? input.result_id.trim() : "";
      const expression = typeof input.expression === "string" ? input.expression.trim() : "";
      if (!UUID.test(id)) return refused("result_id is the id a long answer gave you, like 0193…-…: copy it exactly.");
      if (!expression || expression.length > MAX_EXPRESSION_CHARS) {
        return refused(`expression is a JMESPath expression of up to ${MAX_EXPRESSION_CHARS} characters.`);
      }
      const [row] = await ctx.db
        .select({ tool: toolResults.tool, outside: toolResults.outside, content: toolResults.content })
        .from(toolResults)
        .where(
          and(
            eq(toolResults.id, id),
            eq(toolResults.orgId, ctx.orgId),
            eq(toolResults.runId, ctx.runId),
            eq(toolResults.agentId, ctx.agentId),
            gt(toolResults.expiresAt, deps.now()),
          ),
        );
      const value = row && jsonOf(row.content);
      if (!row || value === undefined) return refused(GONE);
      let part: JSONValue;
      try {
        part = search(value, expression);
      } catch (error) {
        // The answer is valid JSON: anything the search throws is about the expression.
        return refused(`Invalid JMESPath expression: ${error instanceof Error ? error.message : String(error)}`);
      }
      const room = deps.maxChars - FRAME_ROOM;
      const json = JSON.stringify(part);
      const text =
        json.length <= room
          ? json
          : `That part is ${json.length.toLocaleString("en-US")} characters, still too long to read at once: narrow the expression (a filter, a slice like [0:20], or only the fields you need). Its shape (paths from that part):\n${jsonShape(part)}`;
      return {
        content: framed(row.outside, row.tool, text, room),
        // What is read from outside content is outside content (ADR 0117): it marks the run as its first read did.
        ...(row.outside ? { data: { outside: true } } : {}),
      };
    },
  };
  return { name: "long-results", tools: async () => [tool] };
}

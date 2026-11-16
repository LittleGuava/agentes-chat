import { parseAddressList } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, ne, schema, sql } from "@agenteschat/db";
import { type ConnectorDeps, connectionHeaders, noteRefusedSignIn } from "./connectors/connections";
import { customScope } from "./connectors/custom";
import { connectOverHttp, type McpConnect, type McpSession } from "./connectors/mcp";
import { presetForServer } from "./connectors/presets";
import { ValidationError } from "./errors";
import { composioUserId } from "./mail/accounts";
import { isEmailAddress, matchesAddressRules, normalizeAddressRule } from "./mail/text";
import { ALL_TOOLS, CONNECTOR_ALL, freshGrantedKeys, grantKey } from "./tools/scopes";

const { connectorConnections, routineHooks } = schema;

/**
 * A connector's natural events as routine triggers (ADR 0130): each one is a webhook routine (ADR 0106) whose
 * address the server registers at the provider through the connection itself, so a person picks "when an email
 * arrives" instead of copying an address. The provider's calls go down the webhook path (rate limits, dedupe,
 * the outside-content envelope); the event's filter drops what the person didn't ask for before any run.
 * A service through Composio (ADR 0196) gets a Composio trigger on the connection's account instead, whose events
 * reach the server's one signed Composio endpoint, never the routine's address.
 */
export const CONNECTOR_EVENTS = ["millionsend.email.received", "slack.message.received"] as const;
export type ConnectorEventId = (typeof CONNECTOR_EVENTS)[number];

/**
 * What a routine asks of the event: sent to this address (the inbox, "Quando chegar um e-mail em vendas@…"), from
 * these senders (addresses or `@domains`), a subject containing words.
 */
export interface ConnectorTriggerFilter {
  to?: string;
  from?: string[];
  subject?: string;
  /** A chat message (Slack): posted in this channel (its id, `C0123ABC`). */
  channel?: string;
  /** A chat message: its text contains these words. */
  text?: string;
}

/** A routine's connector event, kept in `routine_hooks.source`. */
export interface ConnectorTriggerSource {
  connectionId: string;
  event: ConnectorEventId;
  /** MillionSend: one inbox of the team (its id); absent: every inbox. */
  inboxId?: string;
  filter: ConnectorTriggerFilter;
  /** The provider's webhook for this routine, while it has one. */
  externalId?: string | null;
  /** `error`: the provider refused the webhook (`lastError` says why); the routine waits for a save. */
  status?: "active" | "error";
  lastError?: string | null;
  /**
   * Composio: who the connected account is at the service (Slack's user id), read when the trigger is made. What it
   * posts, the agent's replies through the connection among them, never starts the routine (ADR 0196 §5).
   */
  selfId?: string | null;
}

interface EventBase {
  /** The preset its connection is made from (`presetForServer`). */
  preset: string;
  /** Whether a routine may wait on one inbox of the service (`inboxId`). */
  inboxes?: true;
  /** The filter as kept: the fields this event reads, normalised; throws on an invalid one. */
  normalize(filter: ConnectorTriggerFilter | undefined): ConnectorTriggerFilter;
  /**
   * The payload as the provider sends it: whether it is this event and passes the filter, and wasn't written by the
   * connection's own account (`selfId`).
   */
  passes(payload: unknown, filter: ConnectorTriggerFilter, selfId?: string | null): boolean;
}

/** Registered at the provider through the connection's own MCP tools, posting to the routine's address. */
interface McpEventDef extends EventBase {
  way: "mcp";
  register(session: McpSession, url: string, source: ConnectorTriggerSource): Promise<string | null>;
  unregister(session: McpSession, externalId: string): Promise<void>;
}

/** A Composio trigger on the connection's account (ADR 0196), posting to the server's Composio endpoint. */
interface ComposioEventDef extends EventBase {
  way: "composio";
  /** Composio's trigger type. */
  slug: string;
  /** Composio's toolkit, which its deliveries are counted under (ADR 0103). */
  toolkit: string;
  /**
   * Its `trigger_config` for a routine's filter: what Composio can filter at its side, so an event left out is never
   * delivered (nor billed). The whole filter runs here too.
   */
  config(filter: ConnectorTriggerFilter): Record<string, unknown>;
  /** The tool that says who the connected account is at the service, and its id in the tool's answer. */
  self: { slug: string; read(data: unknown): string | null; unknown: string };
}

type EventDef = McpEventDef | ComposioEventDef;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The id in a tool's answer: JSON's `id` (or `data.id`) when it is JSON, else the first id the text names. */
export function createdId(content: string): string | null {
  try {
    const o = JSON.parse(content) as { id?: unknown; data?: { id?: unknown } };
    const id = o?.id ?? o?.data?.id;
    if (typeof id === "string" && id) return id.slice(0, 200);
  } catch {
    // Text for a model: the id it names.
  }
  return content.match(UUID)?.[0] ?? null;
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Whether a received email's recipients, sender and subject pass the filter (an empty filter passes everything). */
export function emailPasses(mail: { to?: unknown; from?: unknown; subject?: unknown }, filter: ConnectorTriggerFilter) {
  const { to, from, subject } = mail;
  if (filter.to && !parseAddressList(to).some((a) => a.address.toLowerCase() === filter.to)) return false;
  if (filter.from?.length) {
    const address = parseAddressList(from)[0]?.address;
    if (!address || !matchesAddressRules(filter.from, address)) return false;
  }
  if (filter.subject) {
    if (typeof subject !== "string" || !subject.toLowerCase().includes(filter.subject.toLowerCase())) return false;
  }
  return true;
}

/** The email filter's fields (`to`, `from`, `subject`), normalised. */
function normalizeEmailFilter(filter: ConnectorTriggerFilter | undefined): ConnectorTriggerFilter {
  const out: ConnectorTriggerFilter = {};
  const to = filter?.to?.trim().toLowerCase();
  if (to) {
    if (!isEmailAddress(to)) throw new ValidationError(`"${to}" is not an address`, "mail.invalid_rule", { value: to });
    out.to = to;
  }
  const from: string[] = [];
  for (const raw of filter?.from ?? []) {
    const rule = normalizeAddressRule(raw);
    if (!rule) throw new ValidationError(`"${raw}" is not an address or @domain`, "mail.invalid_rule", { value: raw });
    if (!from.includes(rule)) from.push(rule);
  }
  if (from.length > 50) throw new ValidationError("At most 50 senders", "mail.too_many_addresses");
  if (from.length) out.from = from;
  const subject = filter?.subject?.trim().slice(0, 200);
  if (subject) out.subject = subject;
  return out;
}

/** Slack's channel ids: public (`C…`), private (`G…`) or a direct message (`D…`). */
const SLACK_CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;

/** A chat message's filter (`channel`, `text`), normalised. */
function normalizeMessageFilter(filter: ConnectorTriggerFilter | undefined): ConnectorTriggerFilter {
  const out: ConnectorTriggerFilter = {};
  const channel = filter?.channel?.trim().toUpperCase();
  if (channel) {
    if (!SLACK_CHANNEL.test(channel)) {
      throw new ValidationError(`"${channel}" is not a channel id`, "routine.connector_channel_invalid", {
        value: channel,
      });
    }
    out.channel = channel;
  }
  const text = filter?.text?.trim().slice(0, 200);
  if (text) out.text = text;
  return out;
}

/** Slack's message subtypes that aren't someone writing: a bot's post, an edit, a delete. */
const NOT_WRITTEN = new Set(["bot_message", "message_changed", "message_deleted"]);

/**
 * Whether a Slack message passes the filter. A bot's message, or one by the connected account itself (`selfId`),
 * never does: the agent's own post through the same connection would come back as an event and start the routine
 * again.
 */
export function slackMessagePasses(payload: unknown, filter: ConnectorTriggerFilter, selfId?: string | null) {
  const o = record(payload);
  if (!o || typeof o.text !== "string" || o.bot_id) return false;
  if (selfId && o.user === selfId) return false;
  if (typeof o.subtype === "string" && NOT_WRITTEN.has(o.subtype)) return false;
  if (filter.channel && o.channel !== filter.channel) return false;
  if (filter.text && !o.text.toLowerCase().includes(filter.text.toLowerCase())) return false;
  return true;
}

const EVENTS: Record<ConnectorEventId, EventDef> = {
  "millionsend.email.received": {
    way: "mcp",
    preset: "millionsend",
    inboxes: true,
    normalize: normalizeEmailFilter,
    async register(session, url, source) {
      const res = await session.callTool("create_webhook", {
        endpoint: url,
        events: ["inbox.email.received"],
        inbox_ids: source.inboxId ? [source.inboxId] : null,
      });
      if (res.isError) throw new Error(res.content.slice(0, 300) || "MillionSend refused the webhook");
      return createdId(res.content);
    },
    async unregister(session, externalId) {
      await session.callTool("delete_webhook", { id: externalId });
    },
    passes(payload, filter) {
      const o = record(payload);
      if (o?.type !== "inbox.email.received") return false;
      // The email sits under `data.email` (MillionSend's webhook payload); the thread carries the subject too.
      const data = record(o.data);
      const email = record(data?.email) ?? {};
      return emailPasses({ ...email, subject: email.subject ?? record(data?.thread)?.subject }, filter);
    },
  },
  "slack.message.received": {
    way: "composio",
    preset: "slack",
    slug: "SLACK_CHANNEL_MESSAGE_RECEIVED",
    toolkit: "slack",
    // Only people's messages (`is_bot_message: false`), in the routine's channel when it names one (null: all).
    config: (filter) => ({ is_bot_message: false, ...(filter.channel ? { channel_id: filter.channel } : {}) }),
    normalize: normalizeMessageFilter,
    passes: slackMessagePasses,
    // Slack's `auth.test`: `user_id` is the user a token posts as (a bot token's bot user, a user token's person).
    self: {
      slug: "SLACK_TEST_AUTH",
      read: (data) => {
        // Composio's tool results sometimes nest the provider's answer under `response_data`.
        const outer = record(data);
        const id = (record(outer?.response_data) ?? outer)?.user_id;
        return typeof id === "string" && /^[UW][A-Z0-9]{2,30}$/.test(id) ? id : null;
      },
      unknown: "Slack didn't say which user the connection is",
    },
  },
};

/** Whether a routine on this event may name one inbox of the service. */
export const connectorEventHasInboxes = (event: ConnectorEventId) => EVENTS[event].inboxes === true;

/** The events a connection's service has as routine triggers (none for most). */
export const connectorEventsOf = (serverUrl: string): ConnectorEventId[] => {
  const preset = presetForServer(serverUrl)?.id;
  return CONNECTOR_EVENTS.filter((e) => EVENTS[e].preset === preset);
};

/** The calendars a meeting routine can watch (ADR 0190): Google Calendar, through Composio. */
export const MEETING_CALENDAR_PRESET = "google-calendar";
export const isMeetingCalendar = (serverUrl: string) => presetForServer(serverUrl)?.id === MEETING_CALENDAR_PRESET;

export const isConnectorEvent = (v: unknown): v is ConnectorEventId =>
  typeof v === "string" && (CONNECTOR_EVENTS as readonly string[]).includes(v);

/** The source stored for a routine's address, when it has a valid one. */
export function sourceOf(v: unknown): ConnectorTriggerSource | null {
  const o = record(v);
  if (!o || typeof o.connectionId !== "string" || !isConnectorEvent(o.event)) return null;
  return o as unknown as ConnectorTriggerSource;
}

/**
 * The event's filter normalised (an email's: lowercase sender rules, trimmed subject; a message's: the channel id,
 * trimmed words), keeping only the fields the event reads; throws on an invalid rule.
 */
export function normalizeConnectorFilter(
  event: ConnectorEventId,
  filter: ConnectorTriggerFilter | undefined,
): ConnectorTriggerFilter {
  return EVENTS[event].normalize(filter);
}

/**
 * Whether a call that reached a connector routine's address is its event and passes its filter. A Composio event
 * comes only through the server's signed Composio endpoint: whoever learned the address can't stand in for it.
 */
export function connectorCallPasses(source: ConnectorTriggerSource, body: Uint8Array) {
  const def = EVENTS[source.event];
  if (def.way === "composio") return false;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return false;
  }
  return def.passes(payload, source.filter);
}

/** Whether a Composio trigger's event is of this routine's trigger type and passes its filter (ADR 0196). */
export function composioEventPasses(source: ConnectorTriggerSource, event: { slug: string; payload: unknown }) {
  const def = EVENTS[source.event];
  return def.way === "composio" && def.slug === event.slug && def.passes(event.payload, source.filter, source.selfId);
}

/** The Composio trigger type and toolkit a routine's event was made with, else null. */
export function composioTriggerOf(source: ConnectorTriggerSource): { slug: string; toolkit: string } | null {
  const def = EVENTS[source.event];
  return def.way === "composio" ? { slug: def.slug, toolkit: def.toolkit } : null;
}

/**
 * Composio turned a trigger off (its account lost access, the project's limit): the routine waiting on it shows the
 * error until it is saved again, which makes a new one.
 */
export async function markComposioTriggerOff(db: Database, triggerId: string) {
  await db
    .update(routineHooks)
    .set({
      source: sql`${routineHooks.source} || jsonb_build_object('externalId', null, 'status', 'error', 'lastError', 'trigger_disabled')`,
      updatedAt: new Date(),
    })
    .where(sql`${routineHooks.source}->>'externalId' = ${triggerId}`);
}

/**
 * Whether an agent may read a connection's tools, as the Tool Gateway reads its grants (`toolAccess`): the read
 * scope, the whole connection (`connector:*`, what its Access switch and connecting it for everyone grant) or every
 * tool (`*`). Write alone reads nothing. Read fresh: a grant taken back counts at once.
 */
export async function agentReadsConnection(db: Database, orgId: string, agentId: string, connectionId: string) {
  const keys = await freshGrantedKeys(db, orgId, agentId);
  return [
    grantKey(connectionId, customScope(connectionId, "read")),
    grantKey(connectionId, CONNECTOR_ALL),
    grantKey(null, ALL_TOOLS),
  ].some((k) => keys.has(k));
}

/**
 * The connection a routine's agent may take this event from: active in the workspace, made from the event's
 * service, and one whose tools its owner let the agent read (ADR 0016 §2), so the agent never learns of mail it
 * couldn't read itself.
 */
export async function checkConnectorTrigger(
  db: Database,
  orgId: string,
  agentId: string,
  input: { connectionId: string; event: ConnectorEventId },
) {
  const [connection] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, input.connectionId),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!connection || presetForServer(connection.serverUrl)?.id !== EVENTS[input.event].preset) {
    throw new ValidationError("Pick a connected service", "routine.connector_not_found");
  }
  if (!(await agentReadsConnection(db, orgId, agentId, connection.id))) {
    throw new ValidationError(
      "Let the agent read this connection before a routine can wait on it",
      "routine.connector_agent_cannot_read",
    );
  }
  return connection;
}

/**
 * Whether a routine may still take its connector event when a call arrives: the owner can revoke the connection or
 * the agent's read access after the routine was saved, and the provider keeps posting either way.
 */
export async function connectorTriggerAllowed(
  db: Database,
  orgId: string,
  routineId: string,
  source: ConnectorTriggerSource,
) {
  const [routine] = await db
    .select({ agentId: schema.routines.agentId })
    .from(schema.routines)
    .where(and(eq(schema.routines.id, routineId), eq(schema.routines.orgId, orgId)));
  if (!routine?.agentId) return false;
  return checkConnectorTrigger(db, orgId, routine.agentId, source).then(
    () => true,
    () => false,
  );
}

export type ConnectorTriggerDeps = ConnectorDeps & { connect?: McpConnect };

/**
 * Makes the provider's webhook or Composio's trigger for a routine's event: its id, when the provider gives one, and
 * for Composio who the connected account is, read first: without it the agent's own posts could start the routine,
 * so no trigger is made.
 */
async function register(
  deps: ConnectorTriggerDeps,
  source: ConnectorTriggerSource,
  url: string,
): Promise<{ externalId: string | null; selfId?: string }> {
  const def = EVENTS[source.event];
  if (def.way === "mcp") {
    return { externalId: await withConnectionSession(deps, source.connectionId, (s) => def.register(s, url, source)) };
  }
  const client = deps.composio?.client;
  if (!client) throw new Error("Composio is not set up on this server");
  const [connection] = await deps.db
    .select({
      orgId: connectorConnections.orgId,
      account: connectorConnections.composioAccountId,
      serverUrl: connectorConnections.serverUrl,
    })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.id, source.connectionId), isNull(connectorConnections.revokedAt)));
  if (!connection?.account) throw new Error("The connection has no account at Composio");
  const account = { connectedAccountId: connection.account, userId: composioUserId(connection.orgId) };
  const version = presetForServer(connection.serverUrl)?.composio?.version;
  const selfId = def.self.read(
    await client.executeTool(def.self.slug, { ...account, toolkit: def.toolkit }, {}, version),
  );
  if (!selfId) throw new Error(def.self.unknown);
  const made = await client.createTrigger({ slug: def.slug, ...account, config: def.config(source.filter) });
  return { externalId: made.triggerId, selfId };
}

/**
 * Takes the provider's webhook or Composio's trigger back. Composio's upsert gives every routine on the same account,
 * trigger type and config the same trigger: it is deleted only when no other routine still waits on it.
 */
async function unregister(
  deps: ConnectorTriggerDeps,
  routineId: string,
  source: ConnectorTriggerSource,
  externalId: string,
) {
  const def = EVENTS[source.event];
  if (def.way === "mcp") return withConnectionSession(deps, source.connectionId, (s) => def.unregister(s, externalId));
  const [shared] = await deps.db
    .select({ routineId: routineHooks.routineId })
    .from(routineHooks)
    .where(and(sql`${routineHooks.source}->>'externalId' = ${externalId}`, ne(routineHooks.routineId, routineId)))
    .limit(1);
  if (!shared) await deps.composio?.client.deleteTrigger(externalId);
}

/** Whether two filters make the same webhook or trigger at the provider. */
function sameAtProvider(event: ConnectorEventId, a: ConnectorTriggerFilter, b: ConnectorTriggerFilter) {
  const def = EVENTS[event];
  return def.way === "composio"
    ? JSON.stringify(def.config(a)) === JSON.stringify(def.config(b))
    : JSON.stringify(a) === JSON.stringify(b);
}

/** Opens a connection's session (Composio's or MCP), runs `run` and closes it; a refused sign-in is noted on the connection. */
export async function withConnectionSession<T>(
  deps: ConnectorTriggerDeps,
  connectionId: string,
  run: (s: McpSession) => Promise<T>,
) {
  const [connection] = await deps.db
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.id, connectionId), isNull(connectorConnections.revokedAt)));
  if (!connection) throw new Error("connection_gone");
  try {
    const session = await (deps.connect ?? connectOverHttp)(connection, await connectionHeaders(deps, connection));
    try {
      return await run(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  } catch (error) {
    await noteRefusedSignIn(deps.db, connection, error);
    throw error;
  }
}

/**
 * Keeps a routine's connector event in step with it, as `syncMailWatch` does a mail watch: the provider keeps a
 * webhook to its address only while the routine is active and waits on that event; a changed connection, inbox
 * or filter makes a new one. `next` null: the routine no longer waits on a connector event. Without `connectors`
 * (a caller that can't reach providers) the source is kept and nothing is registered.
 */
export async function syncConnectorTrigger(
  db: Database,
  connectors: ConnectorTriggerDeps | undefined,
  routine: { id: string; active: boolean; deletedAt?: Date | null },
  url: string | null,
  next: Omit<ConnectorTriggerSource, "externalId" | "status" | "lastError" | "selfId"> | null,
) {
  const [hook] = await db
    .select({ source: routineHooks.source })
    .from(routineHooks)
    .where(eq(routineHooks.routineId, routine.id));
  if (!hook) return;
  const current = sourceOf(hook.source);
  const wanted =
    next && !routine.deletedAt ? { ...next, filter: normalizeConnectorFilter(next.event, next.filter) } : null;
  // A Composio trigger knows only what its config says (the words run here): changing only those keeps it.
  const same =
    current !== null &&
    wanted !== null &&
    current.connectionId === wanted.connectionId &&
    current.event === wanted.event &&
    (current.inboxId ?? null) === (wanted.inboxId ?? null) &&
    sameAtProvider(wanted.event, current.filter, wanted.filter);
  const keep = same && routine.active && Boolean(current?.externalId);
  if (!current && !wanted) return;
  if (connectors && current?.externalId && !keep) {
    await unregister(connectors, routine.id, current, current.externalId).catch(() => undefined);
  }
  let stored: ConnectorTriggerSource | null = null;
  if (wanted && keep && current) stored = { ...current, ...wanted };
  else if (wanted && connectors && routine.active && (url || EVENTS[wanted.event].way === "composio")) {
    try {
      const made = await register(connectors, wanted, url ?? "");
      stored = { ...wanted, ...made, status: "active", lastError: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stored = { ...wanted, externalId: null, status: "error", lastError: message.slice(0, 300) };
    }
  } else if (wanted) {
    // Without `connectors` the provider still holds what was made: its id and who the account is stay together.
    stored = connectors
      ? { ...wanted, externalId: null }
      : { ...wanted, externalId: current?.externalId ?? null, selfId: current?.selfId ?? null };
  }
  await db
    .update(routineHooks)
    .set({ source: stored, updatedAt: new Date() })
    .where(eq(routineHooks.routineId, routine.id));
}

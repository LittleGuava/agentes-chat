import { randomUUID } from "node:crypto";
import os from "node:os";
import type { AgentScope, RunnerDesktopUseInfo } from "@agenteschat/adapters/machine-protocol";
import type {
  ActivityEntry,
  ControlEvent,
  ControlScreen,
  ControlScreenRequest,
  ControlScreenSession,
} from "@agenteschat/adapters/runner-control";
import type { HelperOp, HelperStep } from "./desktop-helper";
import {
  fromUia,
  fromUiaWindows,
  type UiaSnapshot,
  type UiaWindow,
  winHelperCommand,
  winHelperSourceLine,
  winSteps,
} from "./desktop-helper-win";
import { RunnerError } from "./errors";

/**
 * Host computer use (ADR 0201 and its addendum): an agent on the person's own
 * desktop, on their own Windows computer. Two parts live here:
 *
 * - `windowsHost`: how `DesktopManager` reaches that desktop, the Windows
 *   helper instead of the agents' own Linux desktops. One screen, the
 *   person's: no desktop to start, no OS user of the agent's.
 * - `HostConsent`: the person's yes. Nothing reaches the screen without a
 *   session the person started on this computer, from the desktop app's
 *   control channel, for that agent. Only one agent holds the screen at a
 *   time, a session lasts at most `HOST_SESSION_MS`, and the person ends it
 *   with Stop, by turning the switch off, or by locking the screen. Nothing
 *   the server says can start one, and nothing is kept on disk.
 */

/** A session on the person's screen lasts this long at most (ADR 0201 §3). */
export const HOST_SESSION_MS = 30 * 60_000;
/** An ask waits this long for the person (under the hub's 120 s for `desktop.*`), then it is "not now". */
export const HOST_ASK_MS = 90_000;

const NEEDS_WINDOWS = "Using the person's own screen runs on Windows computers only, for now";
const SYSTEM_MODE = "Using the person's own screen runs only where the runner works as the person (not in system mode)";

/** What the helper's environment keeps of the runner's: Windows' own folders, never a token or a key. */
const ENV_KEPT = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ComSpec",
  "PSModulePath",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** How `DesktopManager` reaches the person's desktop instead of an agent's own. */
export interface HostDialect {
  /** `hello.hostDesktop`: whether this computer can serve it (the switch and the person's yes are checked per use). */
  info(): RunnerDesktopUseInfo;
  /** The person's home: the helper's working folder. */
  home: string;
  /** The helper reads, and sends nothing: tests and proofs (ADR 0201 §6). */
  dry: boolean;
  command(): string[];
  /** Written before the first request: the helper's source. */
  preamble(): string;
  env(): Record<string, string>;
  /** A request as this helper takes it; a `RunnerError` for what it can't send. */
  request(op: HelperOp | "forget", body: object): object;
  /** A reply as ADR 0062's helper gives it; throws on a malformed one. */
  reply(op: HelperOp | "forget", data: unknown): unknown;
}

const CANT_WATCH =
  "agentes.chat can't see when you use your mouse or keyboard on this computer (something, often an antivirus, blocked it), so no agent can use your screen";

/**
 * The Windows helper (`desktop-helper-win.cs`): key names go as virtual-key chords, UI Automation's snapshot and
 * windows come back as ADR 0062's. `dry` is the computer's own setting, never a request's: a dry helper that says
 * otherwise in its hello is refused before anything is sent to it.
 */
export function windowsHost(
  opts: { dry?: boolean; system?: boolean; platform?: NodeJS.Platform; home?: string } = {},
): HostDialect {
  const dry = opts.dry === true;
  const platform = opts.platform ?? process.platform;
  return {
    home: opts.home ?? os.homedir(),
    dry,
    info: () => {
      if (platform !== "win32") return { available: false, reason: NEEDS_WINDOWS, code: "host_desktop_windows" };
      if (opts.system) return { available: false, reason: SYSTEM_MODE, code: "host_desktop_system" };
      return { available: true };
    },
    command: () => winHelperCommand({ dry }),
    preamble: winHelperSourceLine,
    env: () => {
      const env: Record<string, string> = {};
      for (const k of ENV_KEPT) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
      }
      return env;
    },
    request: (op, body) => {
      if (op !== "input" || !isRecord(body) || !Array.isArray(body.steps)) return body;
      try {
        return { ...body, steps: winSteps(body.steps as HelperStep[]) };
      } catch (err) {
        throw new RunnerError("bad_request", err instanceof Error ? err.message : "a key Windows has no name for");
      }
    },
    reply: (op, data) => {
      if (op === "hello") {
        if (!isRecord(data)) throw new Error("hello");
        if (dry && data.dry !== true) throw new Error("a helper started dry that says it isn't");
        // The lock screen and UAC are the secure desktop: nothing there is read or touched.
        if (data.locked === true) return { ...data, a11y: false, problem: "the screen is locked" };
        // Without its hooks the person's own input can't stop the agent (ADR 0201 §3): no screen is served then.
        if (data.watching !== true) return { ...data, screen: null, a11y: false, problem: CANT_WATCH };
        return data;
      }
      if (op === "snapshot") {
        if (!isRecord(data) || !Array.isArray(data.windows) || !Array.isArray(data.apps)) throw new Error("snapshot");
        return fromUia(data as unknown as UiaSnapshot);
      }
      if (op === "extents") {
        if (!isRecord(data) || !Array.isArray(data.windows)) throw new Error("extents");
        return { ...data, windows: fromUiaWindows(data.windows as UiaWindow[]) };
      }
      return data;
    },
  };
}

export interface HostConsentOptions {
  emit(event: ControlEvent): void;
  /** Whether the desktop app listens on the control channel: without it nobody can say yes, so asks fail at once. */
  listening(): boolean;
  /** A line of the computer's own activity log (who held the screen, who stopped it). */
  record(entry: Omit<ActivityEntry, "at">): void;
  /** The helpers stop: the screen is nobody's now (all of them, or one agent's). */
  release(agentId?: string): void;
  now?: () => number;
  askMs?: number;
  sessionMs?: number;
}

interface Ask {
  request: ControlScreenRequest;
  waiters: { resolve: (fresh: boolean) => void; reject: (err: Error) => void }[];
  timer: ReturnType<typeof setTimeout>;
}

const notNow = () =>
  new RunnerError(
    "not_allowed",
    "The person didn't let you use their screen now. Don't ask again in this task unless they tell you to. Say what you needed it for.",
  );
const held = (other: string) =>
  new RunnerError(
    "not_allowed",
    `Another agent (${other}) is using the person's screen now. Try again after it is done, or do this another way.`,
  );
const nobody = () =>
  new RunnerError(
    "not_allowed",
    "Nobody can answer on this computer now: using the person's screen needs them to say yes in the agentes.chat app there, and it isn't open.",
  );

/** The person's yes for one agent's use of their screen, and their Stop. */
export class HostConsent {
  private session: ControlScreenSession | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly asks = new Map<string, Ask>();
  private readonly now: () => number;

  constructor(private readonly opts: HostConsentOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Resolves once `agent` holds the person's screen: at once in its session, else after the person's yes on this
   * computer. `true` when the yes is new (the click on Allow is the person's own input: the helper forgets it).
   */
  async require(agent: AgentScope & { name?: string }, signal?: AbortSignal): Promise<boolean> {
    this.expire();
    const s = this.session;
    if (s?.agent.id === agent.id) return false;
    if (s) throw held(s.agent.name);
    if (!this.opts.listening()) throw nobody();
    let ask = [...this.asks.values()].find((a) => a.request.agent.id === agent.id);
    if (!ask) {
      const at = this.now();
      const request: ControlScreenRequest = {
        requestId: randomUUID(),
        agent: { id: agent.id, name: agentName(agent) },
        at: new Date(at).toISOString(),
        expiresAt: new Date(at + (this.opts.askMs ?? HOST_ASK_MS)).toISOString(),
      };
      const created: Ask = {
        request,
        waiters: [],
        timer: setTimeout(() => this.settle(request.requestId, "expired"), this.opts.askMs ?? HOST_ASK_MS),
      };
      (created.timer as { unref?: () => void }).unref?.();
      this.asks.set(request.requestId, created);
      ask = created;
      this.opts.emit({ kind: "screen.requested", request });
      this.opts.record({
        agent: request.agent,
        kind: "screen",
        summary: "asked to use the screen",
        said: { key: "screenAsked" },
        result: "running",
      });
    }
    const waiting = ask;
    return new Promise<boolean>((resolve, reject) => {
      const waiter = { resolve, reject };
      waiting.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          waiting.waiters = waiting.waiters.filter((w) => w !== waiter);
          reject(new RunnerError("internal", "Canceled"));
        },
        { once: true },
      );
    });
  }

  /** The person's answer, on this computer only (the control channel). */
  answer(requestId: string, decision: "granted" | "denied"): ControlScreen {
    if (decision !== "granted" && decision !== "denied") {
      throw new RunnerError("bad_request", "decision must be granted or denied");
    }
    if (!this.asks.has(String(requestId ?? "")))
      throw new RunnerError("not_found", "That request is gone (answered or expired)");
    this.settle(requestId, decision);
    return this.screen();
  }

  /** Stop: the session ends (one agent's, or whoever's), its helper stops, and pending asks are "not now". */
  stop(by: "person" | "switch" | "locked", agentId?: string): ControlScreen {
    if (!agentId || this.session?.agent.id === agentId) this.end(by);
    for (const a of [...this.asks.values()]) {
      if (!agentId || a.request.agent.id === agentId) this.settle(a.request.requestId, "denied");
    }
    return this.screen();
  }

  /** What the app shows: who holds the screen and who asks. */
  screen(): ControlScreen {
    this.expire();
    return { session: this.session, requests: [...this.asks.values()].map((a) => a.request) };
  }

  private settle(requestId: string, decision: "granted" | "denied" | "expired") {
    const ask = this.asks.get(requestId);
    if (!ask) return;
    this.asks.delete(requestId);
    clearTimeout(ask.timer);
    const { agent } = ask.request;
    // Two asks at once: the first yes holds the screen, the other agent hears it is held.
    const taken = decision === "granted" && this.session !== null && this.session.agent.id !== agent.id;
    const final = taken ? "denied" : decision;
    this.opts.emit({ kind: "screen.resolved", requestId, decision: final });
    if (final === "granted") {
      const at = this.now();
      this.session = {
        agent,
        since: new Date(at).toISOString(),
        until: new Date(at + (this.opts.sessionMs ?? HOST_SESSION_MS)).toISOString(),
      };
      this.expiry = setTimeout(() => this.expire(), this.opts.sessionMs ?? HOST_SESSION_MS);
      (this.expiry as { unref?: () => void }).unref?.();
      this.opts.record({ agent, kind: "screen", summary: "using the screen", said: { key: "screenOn" }, result: "ok" });
      this.opts.emit({ kind: "screen.changed", screen: this.screen() });
      for (const w of ask.waiters) w.resolve(true);
      return;
    }
    this.opts.record({
      agent,
      kind: "screen",
      summary: final === "expired" ? "screen request expired" : "not now: the screen",
      said: { key: final === "expired" ? "screenExpired" : "screenNotNow" },
      result: "refused",
    });
    const err = taken && this.session ? held(this.session.agent.name) : notNow();
    for (const w of ask.waiters) w.reject(err);
  }

  private expire() {
    const s = this.session;
    if (s && Date.parse(s.until) <= this.now()) this.end("expired");
  }

  private end(by: "person" | "switch" | "locked" | "expired") {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.opts.release(s.agent.id);
    const key = {
      person: "screenStopped",
      switch: "screenSwitchedOff",
      locked: "screenLocked",
      expired: "screenEnded",
    }[by];
    this.opts.record({
      agent: s.agent,
      kind: "screen",
      summary: `stopped using the screen (${by})`,
      said: { key },
      result: "ok",
    });
    this.opts.emit({ kind: "screen.changed", screen: this.screen() });
  }
}

const agentName = (a: AgentScope & { name?: string }) => (a.name || a.handle || "An agent").slice(0, 80);

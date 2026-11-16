import type { PubSub, ScreenKind } from "@agenteschat/adapters";
import { handedBackSince, openHandoffOn } from "./browser/handoff";
import { formatBytes } from "./format";
import type { MachineCaller } from "./machine-hub";
import { screenPersonOf } from "./right-hand-seats";
import { RECORDING_LIMITS, type ScreenRecorder } from "./screen";
import type { ToolContext, ToolOutput } from "./tools/types";
import { shareSavedFile } from "./uploads";

/**
 * `record` on `browser_do` and `desktop_do` (ADR 0054 addendum 2026-11-15): the plan as an animated picture, saved
 * in the agent's folder and shown in the conversation as a shared screenshot is.
 */
export const RECORD_INPUT = {
  type: "boolean",
  description: `Record the plan: a picture of the screen after each step, as an animated PNG saved in your folder (recordings/) and shown in this conversation. For showing people how something is done or what went wrong; it adds a moment to each step. At most ${RECORDING_LIMITS.frames} pictures.`,
} as const;

/** Where a recording is saved in the agent's folder. */
export const recordingPath = (at: Date) => `recordings/${at.toISOString().replace(/[:.]/g, "-")}.png`;

/**
 * The screen is a person's now (an open handoff, or one asked for), or a person had it since `since`: from then on a
 * recording takes no pictures (only the person in control sees the screen, ADR 0040 §6).
 */
export function screenHeld(ctx: ToolContext, screen: ScreenKind, since: Date) {
  return async () =>
    Boolean(await openHandoffOn(ctx.db, ctx.orgId, ctx.agentId, screen, await screenPersonOf(ctx.db, ctx))) ||
    (await handedBackSince(ctx.db, ctx, since, screen));
}

const STOPPED = {
  person: " It stopped where a person had the screen: nothing they did is in it.",
  secret: " It stopped where a secret was typed: nothing after it is in it.",
  full: ` It stopped at its limit (${RECORDING_LIMITS.frames} pictures or ${formatBytes(RECORDING_LIMITS.bytes)}).`,
} as const;

/**
 * The plan's answer (`out`) with its recording: written to the agent's folder (`write`), then shown in the
 * conversation (`shareSavedFile`). The plan's answer stands whatever happens to its recording.
 */
export async function keepRecording(
  deps: { machines?: { hub: MachineCaller } | null; pubsub?: PubSub; publicUrl?: string },
  ctx: ToolContext,
  input: {
    machineId: string;
    recorder: ScreenRecorder;
    write: (path: string, bytes: Uint8Array) => Promise<void>;
    out: ToolOutput;
    at?: Date;
  },
): Promise<ToolOutput> {
  const { out, recorder } = input;
  const withLine = (line: string): ToolOutput => ({ ...out, content: `${out.content}\n${line}` });
  try {
    const recording = await recorder.finish();
    if (!recording) return withLine("Nothing was recorded: no picture of the screen could be taken.");
    const path = recordingPath(input.at ?? new Date());
    await input.write(path, recording.bytes);
    const line = `Recorded ${recording.frames} ${recording.frames === 1 ? "picture" : "pictures"} of the screen in ${path} (${recording.width}×${recording.height}, ${formatBytes(recording.bytes.length)}), an animated PNG.${recorder.stopped ? STOPPED[recorder.stopped] : ""}`;
    const { isError: _shareFailed, ...shared } = await shareSavedFile(deps, ctx, input.machineId, path, {
      ...withLine(line),
      data: { ...out.data, recording: path },
    });
    return out.isError ? { ...shared, isError: true } : shared;
  } catch (error) {
    return withLine(`The recording couldn't be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

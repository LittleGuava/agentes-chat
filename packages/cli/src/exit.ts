/** The exit codes scripts act on (ADR 0188 §7). Changing one breaks every script that reads it. */
export const EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  needsPerson: 3,
  timedOut: 4,
  unreachable: 5,
  limited: 6,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure with the exit code it ends the command with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A task's status, as the MCP tools name it, to the exit code of a command that waited on it. */
export function exitForStatus(status: string): ExitCode {
  switch (status) {
    case "done":
      return EXIT.done;
    case "waiting_approval":
    case "waiting_input":
      return EXIT.needsPerson;
    case "still_running":
      return EXIT.timedOut;
    default:
      // failed, canceled, no_run, and any status this version doesn't know: never a reason to keep waiting.
      return EXIT.failed;
  }
}

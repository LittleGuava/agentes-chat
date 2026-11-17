/**
 * Where a stdio program registered on a connected computer lives (ADR 0215, addendum 2026-11-17): a connection's
 * `server_url` of `computer://<machineId>/<id>`, never fetched. The machine ties it to the computer; the id gives each
 * program its own address, so two programs on one computer are two connections.
 */
const SCHEME = "computer://";

/** Its connection's `auth_type`: no sign-in, the program's own variables in the sealed secret. */
export const PROGRAM_AUTH = "computer";

export const programServerUrl = (machineId: string, id: string = crypto.randomUUID()) => `${SCHEME}${machineId}/${id}`;

/** What a computer's programs' addresses start with. */
export const programUrlPrefix = (machineId: string) => `${SCHEME}${machineId}/`;

/** The computer a program's address names; null for any other address. */
export function programMachineOf(serverUrl: string): string | null {
  if (!serverUrl.startsWith(SCHEME)) return null;
  const [machineId] = serverUrl.slice(SCHEME.length).split("/");
  return machineId || null;
}

export const isComputerProgram = (c: { serverUrl: string }) => programMachineOf(c.serverUrl) !== null;

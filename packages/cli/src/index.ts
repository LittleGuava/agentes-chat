import { main } from "./cli";

// Ctrl-C stops waiting, never the task: the command says how to pick it up again and exits 130.
const interrupt = new AbortController();
process.once("SIGINT", () => interrupt.abort());

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

// exitCode, not process.exit(): a piped stdout gets flushed before the process ends.
main(process.argv.slice(2), {
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  signal: interrupt.signal,
}).then((code) => {
  process.exitCode = code;
  // An interrupted request can leave a socket open; nothing is left to flush but what was written.
  if (interrupt.signal.aborted) process.stdout.write("", () => process.exit(code));
});

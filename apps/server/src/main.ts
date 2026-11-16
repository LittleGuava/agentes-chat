/**
 * The image's entrypoint. `main.ts migrate` (`docker compose run --rm agentes migrate`)
 * only prepares the database the way boot does, then exits: an upgrade can
 * migrate while the previous version still serves. `main.ts setup` is the
 * self-host setup (`npx @agenteschat/setup`) for servers without Node, run in
 * the directory mounted as the working directory. `main.ts telemetry`
 * (`docker compose run --rm agentes telemetry`) prints the next usage report
 * and sends nothing. `main.ts team plan|check|apply FILE --as EMAIL` (`docker compose run --rm -T agentes team check -
 * --as ana@example.com < team.yaml`) plans, checks or applies a team file kept in git (ADR 0055, addendum
 * 2026-11-15).
 */
import { createMemoryPubSub, createPostgresPubSub, type PubSub, postgresJsNotifier } from "@agenteschat/adapters";
import { loadConfig } from "@agenteschat/config";
import { createDatabase } from "@agenteschat/db";
import {
  createBlobStoreResolver,
  createLocalKeyWrapper,
  passwordLinkByEmail,
  shareCacheInvalidations,
} from "@agenteschat/engine";
import { createLogger } from "./logger";
import { platformBlobStore, prepareDatabase, startServer } from "./start";
import { processIO, runTeamCommand } from "./team-file";
import { printTelemetry } from "./telemetry";

if (process.argv[2] === "setup") {
  const { main } = await import("@agenteschat/setup/src/cli");
  const code = await main(process.argv.slice(3), { image: true });
  // Once stdout has drained: a piped `--json` result arrives whole.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

if (process.argv[2] === "migrate") {
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
  await prepareDatabase(database, createLogger(config.LOG_LEVEL));
  await database.close();
  process.exit(0);
}

// `main.ts password-link <email>` (`docker compose run --rm agentes password-link ana@example.com`, ADR 0158): a
// new-password link for that account, for a server that sends no email.
if (process.argv[2] === "password-link") {
  const email = process.argv[3] ?? "";
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
  const link = await passwordLinkByEmail(database.db, config.PUBLIC_URL, email);
  await database.close();
  if (!link) {
    process.stderr.write(`No account here uses ${email}.\n`);
    process.exit(1);
  }
  process.stdout.write(`${link.url}\n`);
  process.stderr.write(`Works once, until ${link.expiresAt.toLocaleString()}.\n`);
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

if (process.argv[2] === "telemetry") {
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
  await printTelemetry(database.db, config);
  await database.close();
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

if (process.argv[2] === "team") {
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 2 });
  const shared = database.client
    ? await createPostgresPubSub(postgresJsNotifier(database.client))
    : createMemoryPubSub();
  // The running server hears what this changes through Postgres: its events and its caches' invalidations, each
  // waited for before the connection closes.
  const sent = new Set<Promise<void>>();
  const pubsub: PubSub = {
    subscribe: (topic, handler) => shared.subscribe(topic, handler),
    publish(topic, event) {
      const p = shared.publish(topic, event);
      sent.add(p);
      void p.finally(() => sent.delete(p)).catch(() => undefined);
      return p;
    },
  };
  const stopSharing = shareCacheInvalidations(pubsub);
  const keyWrappers = [createLocalKeyWrapper(config.AGENTES_SECRET)];
  const blobs = createBlobStoreResolver({
    db: database.db,
    keyWrappers,
    platform: platformBlobStore(config, database.db),
  });
  const code = await runTeamCommand({ db: database.db, blobs, pubsub }, process.argv.slice(3), processIO);
  await Promise.allSettled([...sent]);
  stopSharing();
  await shared.close?.();
  await database.close();
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

await startServer({ edition: "selfhost" });

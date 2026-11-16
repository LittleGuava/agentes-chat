import { expect, test } from "bun:test";
import { frontDoor } from "../src/http/front-door";

const PAGES = "http://127.0.0.1:4000";
const PUBLIC = new URL("http://localhost:4000");

/** The door with fakes behind it: what each request reached. */
function door(options: { ownHostsOnly?: boolean; pages?: string | null } = {}) {
  const reached: string[] = [];
  const fetch = frontDoor<null>(
    {
      ownHosts: options.ownHostsOnly ? new Set(["127.0.0.1:4000", "localhost:4000", PUBLIC.host]) : null,
      publicUrl: PUBLIC,
      pagesUrl: options.pages === undefined ? PAGES : (options.pages ?? undefined),
    },
    (req, _srv, next) => {
      if (new URL(req.url).pathname === "/api/ws") {
        reached.push("sockets");
        return undefined;
      }
      return next(req);
    },
    (req) => {
      reached.push(`app ${new URL(req.url).host}`);
      return new Response("app", { status: 200 });
    },
  );
  const call = async (url: string, init: RequestInit = {}) => {
    const answer = await fetch(new Request(url, init), null);
    return { status: answer?.status ?? "upgraded", location: answer?.headers.get("location") ?? null };
  };
  return { call, reached };
}

test("the pages host never reaches a socket upgrade: every request there goes to the HTTP app (ADR 0211 §1)", async () => {
  const { call, reached } = door();
  expect(await call(`${PAGES}/api/ws?orgId=x`, { headers: { upgrade: "websocket" } })).toEqual({
    status: 200,
    location: null,
  });
  expect(reached).toEqual(["app 127.0.0.1:4000"]);
  // The app's host still upgrades.
  expect(await call("http://localhost:4000/api/ws?orgId=x", { headers: { upgrade: "websocket" } })).toEqual({
    status: "upgraded",
    location: null,
  });
  expect(reached).toEqual(["app 127.0.0.1:4000", "sockets"]);
});

test("without a pages host, the same name upgrades as before", async () => {
  const { call, reached } = door({ pages: null });
  expect((await call(`${PAGES}/api/ws`, { headers: { upgrade: "websocket" } })).status).toBe("upgraded");
  expect(reached).toEqual(["sockets"]);
});

test("answering only its own names (native mode), the pages host is one of them and is never sent to PUBLIC_URL", async () => {
  const { call, reached } = door({ ownHostsOnly: true, pages: "http://pages.test:4000" });
  const page = await call("http://pages.test:4000/p/x/", { headers: { host: "pages.test:4000", accept: "text/html" } });
  expect(page).toEqual({ status: 200, location: null });
  expect(reached).toEqual(["app pages.test:4000"]);
  // Another of its own names still goes to PUBLIC_URL, and a stranger's name still gets a 421.
  const other = await call("http://127.0.0.1:4000/x", { headers: { host: "127.0.0.1:4000", accept: "text/html" } });
  expect(other).toEqual({ status: 302, location: "http://localhost:4000/x" });
  expect((await call("http://evil.test/x", { headers: { host: "evil.test" } })).status).toBe(421);
});

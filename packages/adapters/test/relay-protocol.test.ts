import { expect, test } from "bun:test";
import {
  MACHINE_PROTOCOL_VERSION,
  parseAccess,
  parseRunnerFrame,
  parseServerFrame,
  RELAY_PROTOCOL,
  readConnectHead,
  relayCovers,
  relayPac,
  relaySite,
  relaySitesFor,
} from "../src/machine-protocol";

/** ADR 0203: the rules both runners and the server read the same way. */

test("a runner on this protocol speaks it", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(RELAY_PROTOCOL);
});

test("a site is a public name as the person typed it, never an address or a local name", () => {
  expect(relaySite("https://www.LinkedIn.com/jobs?x=1")).toBe("www.linkedin.com");
  expect(relaySite("*.example.com")).toBe("example.com");
  expect(relaySite("example.com.:443")).toBe("example.com");
  for (const bad of ["localhost", "printer.local", "router.lan", "10.0.0.1", "[::1]", "com", "user@example.com", ""]) {
    expect(relaySite(bad)).toBeNull();
  }
});

test("a site covers itself and the names under it at a dot", () => {
  expect(relayCovers("jobs.example.com", ["example.com"])).toBe(true);
  expect(relayCovers("example.com", ["example.com"])).toBe(true);
  expect(relayCovers("badexample.com", ["example.com"])).toBe(false);
  expect(relayCovers("example.com.evil.org", ["example.com"])).toBe(false);
  expect(relayCovers("93.184.216.34", ["example.com"])).toBe(false);
});

test("the grant reaches the server as stored, and lends each site to its agents only", () => {
  const access = parseAccess({
    folders: [],
    tools: { claude: false, codex: false, commands: false },
    relay: [
      { site: "Example.com", agents: ["a1"] },
      { site: "localhost", agents: ["a1"] },
      { site: "jobs.org", agents: ["*"] },
      { site: "example.com", agents: ["a2"] },
    ],
  });
  expect(access?.relay).toEqual([
    { site: "example.com", agents: ["a1"] },
    { site: "jobs.org", agents: ["*"] },
  ]);
  expect(relaySitesFor(access, "a1")).toEqual(["example.com", "jobs.org"]);
  expect(relaySitesFor(access, "a2")).toEqual(["jobs.org"]);
  // An older runner says nothing about it.
  expect(parseAccess({ folders: [], tools: { claude: true, codex: false, commands: true } })?.relay).toBeUndefined();
});

test("relay.want and relay.ready cross the wire checked", () => {
  expect(
    parseRunnerFrame(JSON.stringify({ type: "relay.want", callId: "c1", agentId: "a1", host: "WWW.Example.com" })),
  ).toEqual({ type: "relay.want", callId: "c1", agentId: "a1", host: "www.example.com" });
  expect(
    parseRunnerFrame(JSON.stringify({ type: "relay.want", callId: "c1", agentId: "a1", host: "127.0.0.1" })),
  ).toBeNull();
  const streamId = "A".repeat(43);
  expect(parseServerFrame(JSON.stringify({ type: "relay.ready", callId: "c1", ok: true, streamId }))).toEqual({
    type: "relay.ready",
    callId: "c1",
    ok: true,
    streamId,
  });
  expect(parseServerFrame(JSON.stringify({ type: "relay.ready", callId: "c1", ok: true, streamId: "x" }))).toBeNull();
});

test("the head of a tunnel: only a CONNECT to a name", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const head = "CONNECT www.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n";
  expect(readConnectHead(enc(`${head}rest`))).toEqual({
    status: "ok",
    host: "www.example.com",
    port: 443,
    length: head.length,
  });
  expect(readConnectHead(enc("CONNECT www.example.com:443 HTTP/1.1\r\n"))).toEqual({ status: "partial" });
  expect(readConnectHead(enc("GET / HTTP/1.1\r\n\r\n")).status).toBe("bad");
  expect(readConnectHead(enc("CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n")).status).toBe("bad");
  expect(readConnectHead(enc(`CONNECT a.com:443 HTTP/1.1\r\nX: ${"y".repeat(9000)}`)).status).toBe("bad");
});

test("the proxy script sends only https pages of the sites to the entrance", () => {
  const url = relayPac(["example.com", "not a site"], 41234);
  const script = atob(url.slice(url.indexOf(",") + 1));
  const FindProxyForURL = new Function("dnsDomainIs", `${script}; return FindProxyForURL;`)(
    (host: string, domain: string) => host.endsWith(domain),
  ) as (url: string, host: string) => string;
  expect(FindProxyForURL("https://jobs.example.com/", "jobs.example.com")).toBe("PROXY 127.0.0.1:41234");
  expect(FindProxyForURL("http://jobs.example.com/", "jobs.example.com")).toBe("DIRECT");
  expect(FindProxyForURL("https://badexample.com/", "badexample.com")).toBe("DIRECT");
  expect(script).not.toContain("not a site");
});

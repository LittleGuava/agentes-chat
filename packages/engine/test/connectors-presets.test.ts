import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@agenteschat/db";
import {
  authServerMetadata,
  CONNECTOR_BRANDS,
  type ConnectorDeps,
  completeOAuth,
  connectCustomServer,
  connectorListing,
  createApiKeyConnection,
  MCP_PRESETS,
  mcpPreset,
  presetForServer,
  probeMcpServer,
  revokeAtProvider,
  startOAuth,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("one-click MCP connectors", () => {
  test("presets are official https servers with unique ids; matched by canonical URL", () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A preset's label is a new connection's name: two presets never share one.
    expect(new Set(MCP_PRESETS.map((p) => p.label.toLowerCase())).size).toBe(ids.length);
    for (const p of MCP_PRESETS) expect(p.serverUrl.startsWith("https://")).toBe(true);
    // HubSpot has no server that registers us: it is a service through Composio (ADR 0107).
    expect(mcpPreset("hubspot")?.serverUrl).toBe("https://backend.composio.dev/api/v3.1/toolkits/hubspot");
    expect(mcpPreset("linear")?.serverUrl).toBe("https://mcp.linear.app/mcp");
    expect(presetForServer("https://mcp.linear.app/mcp/")?.id).toBe("linear");
    expect(presetForServer("https://example.com/mcp")).toBeNull();
  });

  test("a service goes through Composio only on Composio's own OAuth app: no key to paste, no app of ours", () => {
    const ways = MCP_PRESETS.flatMap((p) => (p.composio ? [[p.id, p.composio.auth]] : []));
    expect(ways.length).toBeGreaterThan(0);
    for (const [id, auth] of ways) expect([id, auth]).toEqual([id, "managed"]);
  });

  test("vendors that refuse agentes.chat until they approve it stay listed as `soon`: greyed out, not connectable", () => {
    expect(
      MCP_PRESETS.filter((p) => p.soon)
        .map((p) => p.id)
        .sort(),
    ).toEqual([
      "asana",
      "dropbox",
      "figma",
      "gamma",
      "intercom",
      "intercom-eu",
      "mercadopago",
      "meta-ads",
      "revenuecat",
      "semrush",
      "square",
      "vercel",
    ]);
    expect(mcpPreset("vercel")).toMatchObject({ serverUrl: "https://mcp.vercel.com", category: "dev", soon: true });
    expect(mcpPreset("figma")).toMatchObject({ serverUrl: "https://mcp.figma.com/mcp", soon: true });
    const listed = connectorListing({ oauthApps: {} });
    const entry = (id: string) => listed.find((e) => e.id === id);
    expect(entry("asana")).toMatchObject({ kind: "remote_mcp", available: false, soon: true });
    expect(entry("figma")).toMatchObject({ available: false, soon: true, iconUrl: "/connectors/figma.svg" });
    // Calendly refused only our name: it connects.
    expect(entry("calendly")).toMatchObject({ available: true, soon: false });
    expect(entry("github")).toMatchObject({ kind: "catalog", soon: false });
  });

  test("Intercom: its US and EU servers; the Cloud offers no API key for them (Intercom's terms forbid asking for one), self-hosted they take one like the other one-click servers", () => {
    expect(["intercom", "intercom-eu"].map((id) => mcpPreset(id)?.serverUrl)).toEqual([
      "https://mcp.intercom.com/mcp",
      "https://mcp.eu.intercom.com/mcp",
    ]);
    expect(mcpPreset("intercom")?.description).not.toContain("US");
    const auth = (cloud: boolean) =>
      Object.fromEntries(
        connectorListing({ oauthApps: {}, cloud })
          .filter((e) => ["intercom", "intercom-eu", "linear", "github"].includes(e.id))
          .map((e) => [e.id, e.auth]),
      );
    expect(auth(true)).toEqual({
      github: ["oauth", "api_key"],
      linear: ["oauth", "api_key"],
      intercom: ["oauth"],
      "intercom-eu": ["oauth"],
    });
    expect(auth(false)).toMatchObject({ intercom: ["oauth", "api_key"], "intercom-eu": ["oauth", "api_key"] });
  });

  test("every connector in the catalog has a logo the web app serves", () => {
    const web = resolve(import.meta.dir, "../../../apps/web/public");
    for (const b of Object.values(CONNECTOR_BRANDS)) {
      expect(existsSync(`${web}/${b.own ? "brands" : "connectors"}/${b.file}.svg`)).toBe(true);
    }
    const missing = connectorListing({ oauthApps: {} })
      .filter((e) => !e.iconUrl)
      .map((e) => e.id);
    expect(missing).toEqual([]);
  });

  test("a server without protected-resource metadata: OAuth at its own origin when it registers clients", async () => {
    const http = (async (url: string) => {
      if (url === "https://mcp.atlassian.com/v1/mcp") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="OAuth"' } });
      }
      if (url === "https://mcp.atlassian.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://mcp.atlassian.com",
          authorization_endpoint: "https://mcp.atlassian.com/v1/authorize",
          token_endpoint: "https://mcp.atlassian.com/v1/token",
          registration_endpoint: "https://mcp.atlassian.com/v1/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    f = await setup();
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      http,
      resolveHost: async () => ["93.184.216.34"],
    };
    expect(await probeMcpServer(deps, "https://mcp.atlassian.com/v1/mcp")).toEqual({
      kind: "oauth",
      resource: "https://mcp.atlassian.com/v1/mcp",
      issuer: "https://mcp.atlassian.com",
      scopes: [],
    });
  });

  test("Square: no scopes in the metadata at its path, so the root's are asked for (it refuses an authorization without one)", async () => {
    const pathMetadata = "https://mcp.squareup.com/.well-known/oauth-protected-resource/mcp";
    const rootMetadata = "https://mcp.squareup.com/.well-known/oauth-protected-resource";
    // As Square answered on 2026-10-31.
    const docs: Record<string, unknown> = {
      [pathMetadata]: {
        resource: "https://mcp.squareup.com/mcp",
        authorization_servers: ["https://mcp.squareup.com"],
        bearer_methods_supported: ["header"],
      },
      [rootMetadata]: {
        resource: "https://mcp.squareup.com/mcp",
        authorization_servers: ["https://mcp.squareup.com"],
        scopes_supported: ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "ORDERS_READ"],
      },
    };
    const http = (async (url: string) => {
      if (url === "https://mcp.squareup.com/mcp") {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${pathMetadata}"` },
        });
      }
      return docs[url] ? Response.json(docs[url]) : new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    f = await setup();
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      http,
      resolveHost: async () => ["93.184.216.34"],
    };
    expect(await probeMcpServer(deps, "https://mcp.squareup.com/mcp")).toEqual({
      kind: "oauth",
      resource: "https://mcp.squareup.com/mcp",
      issuer: "https://mcp.squareup.com",
      scopes: ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "ORDERS_READ"],
    });
    // A root naming another authorization server says nothing about this one's scopes.
    docs[rootMetadata] = { ...(docs[rootMetadata] as object), authorization_servers: ["https://other.example.com"] };
    expect(await probeMcpServer(deps, "https://mcp.squareup.com/mcp")).toMatchObject({ scopes: [] });
  });
});

describe("agents' email, phone and calls, Whop and You.com", () => {
  test("their vendors' own servers, each in its category", () => {
    const of = (id: string) => {
      const p = mcpPreset(id);
      return p && [p.label, p.category, p.serverUrl];
    };
    expect(["agentmail", "agentphone", "vapi", "whop", "youcom"].map(of)).toEqual([
      ["AgentMail", "dev", "https://mcp.agentmail.to/mcp"],
      ["AgentPhone", "dev", "https://mcp.agentphone.ai/mcp"],
      ["Vapi", "dev", "https://mcp.vapi.ai/mcp"],
      ["Whop", "payments", "https://mcp.whop.com/mcp"],
      ["You.com", "data", "https://api.you.com/mcp"],
    ]);
    expect(presetForServer("https://mcp.vapi.ai/mcp/")?.id).toBe("vapi");
    // Telnyx and Agentcard answer without credentials, which would connect them with none: left out.
    expect(presetForServer("https://api.telnyx.com/v2/mcp")).toBeNull();
    expect(presetForServer("https://mcp.agentcard.sh/mcp")).toBeNull();
  });

  test("a server that takes no key offers only the sign-in, on the Cloud and self-hosted", () => {
    const auth = (cloud: boolean) =>
      Object.fromEntries(
        connectorListing({ oauthApps: {}, cloud })
          .filter((e) => ["agentmail", "agentphone", "vapi", "whop", "youcom"].includes(e.id))
          .map((e) => [e.id, e.auth]),
      );
    const expected: Record<string, ("oauth" | "api_key")[]> = {
      agentmail: ["oauth"],
      agentphone: ["oauth", "api_key"],
      vapi: ["oauth"],
      whop: ["oauth"],
      youcom: ["oauth", "api_key"],
    };
    expect(auth(true)).toEqual(expected);
    expect(auth(false)).toEqual(expected);
  });

  test("a key sent for one of them is refused before anything is stored, self-hosted too", async () => {
    f = await setup();
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
    };
    for (const serverUrl of ["https://mcp.vapi.ai/mcp", "https://mcp.agentmail.to/mcp", "https://mcp.whop.com/mcp"]) {
      const refused = await connectCustomServer(deps, f.owner.id, f.org.id, {
        serverUrl,
        apiKey: "vendor_secret_12345",
      }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ValidationError);
      expect((refused as ValidationError).code).toBe("connector.oauth_only");
    }
    expect(await f.db.select().from(schema.connectorConnections)).toEqual([]);
  });

  test("their OAuth is found as they answered on 2026-11-15: AgentMail's unquoted metadata address, You.com's issuer with a path", async () => {
    const youApp = "P2jInttRMuXpyYZMbVcsc4C9Z0RT/MS3BitzWFxlSigWFUNJHHNsIYt5qp";
    const youIssuer = `https://auth.you.com/v1/apps/agentic/${youApp}`;
    const docs: Record<string, unknown> = {
      "https://mcp.agentmail.to/.well-known/oauth-protected-resource/mcp": {
        resource: "https://mcp.agentmail.to/mcp",
        authorization_servers: ["https://clerk.console.agentmail.to"],
      },
      "https://clerk.console.agentmail.to/.well-known/oauth-authorization-server": {
        issuer: "https://clerk.console.agentmail.to",
        authorization_endpoint: "https://clerk.console.agentmail.to/oauth/authorize",
        token_endpoint: "https://clerk.console.agentmail.to/oauth/token",
        registration_endpoint: "https://clerk.console.agentmail.to/oauth/register",
        code_challenge_methods_supported: ["S256"],
      },
      "https://api.you.com/mcp/.well-known/oauth-protected-resource": {
        resource: "https://api.you.com/mcp",
        authorization_servers: [youIssuer],
        scopes_supported: ["Tools", "offline_access"],
      },
      [`https://auth.you.com/.well-known/oauth-authorization-server/v1/apps/agentic/${youApp}`]: {
        issuer: youIssuer,
        authorization_endpoint: `https://auth.you.com/oauth2/v1/apps/agentic/${youApp}/authorize`,
        token_endpoint: `https://auth.you.com/oauth2/v1/apps/agentic/${youApp}/token`,
        registration_endpoint: `https://auth.you.com/v1/mgmt/mcp/client/${youApp}/register`,
        code_challenge_methods_supported: ["S256"],
      },
    };
    const challenges: Record<string, string> = {
      "https://mcp.agentmail.to/mcp":
        "Bearer resource_metadata=https://mcp.agentmail.to/.well-known/oauth-protected-resource/mcp",
      "https://api.you.com/mcp":
        'Bearer resource_metadata="https://api.you.com/mcp/.well-known/oauth-protected-resource" scope="Tools offline_access"',
    };
    const http = (async (url: string) => {
      const challenge = challenges[url];
      if (challenge) return new Response("", { status: 401, headers: { "www-authenticate": challenge } });
      return docs[url] ? Response.json(docs[url]) : new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    f = await setup();
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      http,
      resolveHost: async () => ["93.184.216.34"],
    };
    expect(await probeMcpServer(deps, "https://mcp.agentmail.to/mcp")).toEqual({
      kind: "oauth",
      resource: "https://mcp.agentmail.to/mcp",
      issuer: "https://clerk.console.agentmail.to",
      scopes: [],
    });
    expect(await probeMcpServer(deps, "https://api.you.com/mcp")).toEqual({
      kind: "oauth",
      resource: "https://api.you.com/mcp",
      issuer: youIssuer,
      scopes: ["Tools", "offline_access"],
    });
    expect((await authServerMetadata(deps, youIssuer))?.registration_endpoint).toBe(
      `https://auth.you.com/v1/mgmt/mcp/client/${youApp}/register`,
    );
  });
});

describe("GitHub with our OAuth app", () => {
  test("disconnecting also revokes the grant at GitHub (basic auth with the app); API keys are left alone", async () => {
    f = await setup();
    const calls: { url: string; method: string; auth: string | null; body: string }[] = [];
    const http = (async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("authorization"),
        body: String(init.body ?? ""),
      });
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return Response.json({ access_token: "gho_token_1", token_type: "bearer", scope: "repo,read:org,workflow" });
      }
      if (url.includes("/applications/gh-client/token")) return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const deps: ConnectorDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://app.example.com",
      oauthApps: { github: { clientId: "gh-client", clientSecret: "gh-secret" } },
      http,
    };
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/app/connectors/oauth/callback",
    );
    const { connection } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    expect(await revokeAtProvider(deps, f.org.id, connection.id)).toBe(true);
    const revoke = calls.find((c) => c.method === "DELETE");
    expect(revoke?.url).toBe("https://api.github.com/applications/gh-client/token");
    expect(revoke?.auth).toBe(`Basic ${Buffer.from("gh-client:gh-secret").toString("base64")}`);
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: "gho_token_1" });

    const keyed = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "sentry",
      apiKey: "sntrys_secret_123456",
    });
    expect(await revokeAtProvider(deps, f.org.id, keyed.id)).toBe(false);
  });
});

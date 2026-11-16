/**
 * Test fake — an agent's API keys (ADR 0210), same shapes as the server's `…/agents/{agentId}/api-keys` and
 * `…/agent-key-rooms/{channelId}` routes. Tests add keys, give one a room and make the next call fail.
 */
import type { AgentApiKey, AgentKeyRoom, ApiClient } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";

export const AGENT_API_ORIGIN = "https://agentes.example";

export interface FakeAgentApiKeys {
  client: ApiClient["agentApiKeys"];
  /** Live keys by agent, newest first. */
  keys: Map<string, AgentApiKey[]>;
  /** Keys' rooms by channel id, as their maker reads them. */
  rooms: Map<string, AgentKeyRoom>;
  /** The next call fails with this (once). */
  nextError: ApiError | null;
  add(agentId: string, key: Partial<AgentApiKey> & { name: string }): AgentApiKey;
}

let n = 0;

export function createFakeAgentApiKeys(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  me: () => { id: string; name: string },
): FakeAgentApiKeys {
  const fake: FakeAgentApiKeys = {
    keys: new Map(),
    rooms: new Map(),
    nextError: null,
    client: undefined as never,
    add: (agentId, key) => {
      const full: AgentApiKey = {
        id: `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`,
        lastFour: "Wx9z",
        createdAt: now().toISOString(),
        expiresAt: null,
        lastUsedAt: null,
        createdBy: me(),
        roomId: null,
        ...key,
      };
      fake.keys.set(agentId, [full, ...(fake.keys.get(agentId) ?? [])]);
      return full;
    },
  };
  const failOnce = () => {
    const error = fake.nextError;
    if (!error) return;
    fake.nextError = null;
    throw error;
  };
  fake.client = {
    list: async (orgId, agentId) => {
      log("agentApiKeys.list", orgId, agentId);
      failOnce();
      return structuredClone({
        keys: fake.keys.get(agentId) ?? [],
        endpoint: `${AGENT_API_ORIGIN}/api/agents/v1/${agentId}/messages`,
      });
    },
    create: async (orgId, agentId, input) => {
      log("agentApiKeys.create", orgId, agentId, input);
      failOnce();
      const secret = `agk_${"A1b2C3d4".repeat(5)}Wx9`;
      const key = fake.add(agentId, {
        name: input.name,
        lastFour: secret.slice(-4),
        expiresAt: input.expiresInDays
          ? new Date(now().getTime() + input.expiresInDays * 86_400_000).toISOString()
          : null,
      });
      return structuredClone({ key, secret });
    },
    revoke: async (orgId, agentId, keyId) => {
      log("agentApiKeys.revoke", orgId, agentId, keyId);
      failOnce();
      fake.keys.set(
        agentId,
        (fake.keys.get(agentId) ?? []).filter((k) => k.id !== keyId),
      );
    },
    room: async (orgId, channelId) => {
      log("agentApiKeys.room", orgId, channelId);
      const room = fake.rooms.get(channelId);
      if (!room) throw new ApiError(404, "not_found", "Conversation not found");
      return structuredClone(room);
    },
  };
  return fake;
}

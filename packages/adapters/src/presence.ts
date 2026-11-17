/**
 * Who is online in an organization, and who has which conversation open. Ephemeral and write-heavy, so it never
 * goes to Postgres in the default build. Core: in-memory (accurate for a single instance: each replica knows only
 * its own sockets). Cloud: Redis with TTL.
 */
export interface Presence {
  connect(orgId: string, userId: string, connectionId: string): Promise<void>;
  disconnect(orgId: string, userId: string, connectionId: string): Promise<void>;
  /** User ids with at least one open connection. */
  online(orgId: string): Promise<string[]>;
  /**
   * A connection has a conversation open (ADR 0084 addendum 2026-11-15). True when the person had it open on no
   * other connection: who views it changed.
   */
  view(orgId: string, channelId: string, userId: string, connectionId: string): Promise<boolean>;
  /** The connection closed the conversation. True when the person has it open on no other connection now. */
  unview(orgId: string, channelId: string, userId: string, connectionId: string): Promise<boolean>;
  /** User ids with the conversation open on at least one connection, in the order they opened it. */
  viewers(orgId: string, channelId: string): Promise<string[]>;
}

/** Connection ids per key: the first added and the last removed are what changes. */
function connectionSets() {
  const sets = new Map<string, Map<string, Set<string>>>();
  return {
    add(key: string, userId: string, connectionId: string): boolean {
      const users = sets.get(key) ?? new Map<string, Set<string>>();
      sets.set(key, users);
      const conns = users.get(userId) ?? new Set<string>();
      users.set(userId, conns);
      if (conns.has(connectionId)) return false;
      conns.add(connectionId);
      return conns.size === 1;
    },
    remove(key: string, userId: string, connectionId: string): boolean {
      const users = sets.get(key);
      const conns = users?.get(userId);
      if (!users || !conns?.delete(connectionId) || conns.size > 0) return false;
      users.delete(userId);
      if (users.size === 0) sets.delete(key);
      return true;
    },
    users: (key: string) => [...(sets.get(key)?.keys() ?? [])],
  };
}

export function createMemoryPresence(): Presence {
  const orgs = connectionSets();
  const channels = connectionSets();
  const channelKey = (orgId: string, channelId: string) => `${orgId}:${channelId}`;
  return {
    async connect(orgId, userId, connectionId) {
      orgs.add(orgId, userId, connectionId);
    },
    async disconnect(orgId, userId, connectionId) {
      orgs.remove(orgId, userId, connectionId);
    },
    async online(orgId) {
      return orgs.users(orgId).sort();
    },
    async view(orgId, channelId, userId, connectionId) {
      return channels.add(channelKey(orgId, channelId), userId, connectionId);
    },
    async unview(orgId, channelId, userId, connectionId) {
      return channels.remove(channelKey(orgId, channelId), userId, connectionId);
    },
    async viewers(orgId, channelId) {
      return channels.users(channelKey(orgId, channelId));
    },
  };
}

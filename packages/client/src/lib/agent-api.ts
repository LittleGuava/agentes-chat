import type { TFunction } from "i18next";
import type { AgentApiKey } from "../api/types";
import { formatShortDate, relativeTime } from "./format";

/** Where the secret goes in an example nobody can run as it is: the list never holds a key's secret. */
export const AGENT_KEY_PLACEHOLDER = "agk_…";

/** A shell's single quotes around any text: a quote inside closes, escapes and reopens them. */
const shellQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The call a key's card shows (ADR 0210): this server's address for the agent, the key as a bearer and one message,
 * waiting up to 30 s for the answer. Pasted into a shell as it is, with the real secret, it sends.
 */
export function agentApiCurl(endpoint: string, secret: string, message: string) {
  return [
    `curl -X POST ${endpoint} \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d ${shellQuoted(JSON.stringify({ message, wait_seconds: 30 }))}`,
  ].join("\n");
}

/** A key's line under its name: when and by whom it was made, until when it works, and its last use. */
export function agentKeyFacts(t: TFunction, locale: string, key: AgentApiKey, meId: string, now = new Date()) {
  const date = formatShortDate(locale, key.createdAt);
  return [
    key.createdBy.id === meId
      ? t("agentApi.createdByYou", { date })
      : t("agentApi.created", { date, name: key.createdBy.name }),
    key.expiresAt
      ? t("apps.tokens.expires", { date: formatShortDate(locale, key.expiresAt) })
      : t("apps.tokens.noExpiry"),
    key.lastUsedAt
      ? t("agentApi.usedAt", { when: relativeTime(t, locale, key.lastUsedAt, now) })
      : t("agentApi.neverUsed"),
  ].join(" · ");
}

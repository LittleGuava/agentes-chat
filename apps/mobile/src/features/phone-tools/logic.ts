import type { PhoneContact, PhoneJobAnswer, PhoneTools } from "@agenteschat/client";
import type { ContactsPermission, DeviceContact } from "./contacts-access";

/**
 * What the phone sends back for an agent's search of its contacts (ADR 0205), as plain functions: the matches only,
 * each its name, phone numbers and email addresses, within what the server takes (`apps/server/src/routes/app/phone.ts`).
 */

export const PHONE_CONTACTS_MAX = 5;
export const PHONE_CONTACT_VALUES_MAX = 5;
const NAME_MAX = 200;
const PHONE_MAX = 40;
const EMAIL_MAX = 254;
const ERROR_MAX = 300;
const DEVICE_NAME_MAX = 100;

/** Lower case without accents, spaces collapsed: how a name and a search are compared. */
const folded = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

const nameOf = (c: DeviceContact) =>
  (c.fullName?.trim() || [c.givenName, c.familyName].filter((p) => p?.trim()).join(" ")).replace(/\s+/g, " ").trim();

/** Each value trimmed, blanks and duplicates dropped, one too long for the server left out whole (never cut). */
function valuesOf(values: (string | null | undefined)[], max: number): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const v = raw?.trim() ?? "";
    if (!v || v.length > max || out.includes(v)) continue;
    out.push(v);
    if (out.length === PHONE_CONTACT_VALUES_MAX) break;
  }
  return out;
}

/** Whether every word of the search is in the name. */
function matches(name: string, query: string) {
  const words = folded(query).split(" ").filter(Boolean);
  const haystack = folded(name);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

/** The answer to one search: the first `PHONE_CONTACTS_MAX` contacts the search matches, with a name. */
export function contactsAnswer(found: DeviceContact[], query: string): PhoneJobAnswer {
  const contacts: PhoneContact[] = [];
  for (const c of found) {
    const name = nameOf(c);
    if (!name || !matches(name, query)) continue;
    contacts.push({
      name: name.slice(0, NAME_MAX),
      phones: valuesOf(
        (c.phones ?? []).map((p) => p.number),
        PHONE_MAX,
      ),
      emails: valuesOf(
        (c.emails ?? []).map((e) => e.address),
        EMAIL_MAX,
      ),
    });
    if (contacts.length === PHONE_CONTACTS_MAX) break;
  }
  return { outcome: "done", contacts };
}

/** A job the phone couldn't run, with why (as the server takes it). */
export const failedAnswer = (error: unknown): PhoneJobAnswer => {
  const text = (error instanceof Error ? error.message : String(error)).trim() || "Unknown error";
  return { outcome: "failed", error: text.slice(0, ERROR_MAX) };
};

/** Turning contacts on: save at once, show the system's prompt, or send the person to the phone's Settings. */
export function consentStep(permission: ContactsPermission): "save" | "ask" | "settings" {
  if (permission.status === "granted") return "save";
  return permission.canAskAgain ? "ask" : "settings";
}

/** The phone's name the server shows back: its own, its model, or "Phone". */
export function deviceNameOf(name: string | null | undefined, model: string | null | undefined): string {
  const picked = name?.trim() || model?.trim() || "Phone";
  return picked.slice(0, DEVICE_NAME_MAX);
}

/** A job was added or closed for this person: the app lists its jobs again. */
export const isPhoneJobEvent = (event: { type: string }) => event.type === "phone.job";

/** Whether this person turned contacts on here. */
export const contactsOn = (tools: PhoneTools | undefined) => tools?.tools.includes("contacts") ?? false;

/**
 * Whether Você's switch shows on: the server has the person's yes and this phone the system's permission. Reinstalled,
 * another phone, or the permission taken back in Settings: off, so turning it on asks the system again.
 */
export const switchOn = (tools: PhoneTools | undefined, permission: ContactsPermission | null) =>
  contactsOn(tools) && permission?.status === "granted";

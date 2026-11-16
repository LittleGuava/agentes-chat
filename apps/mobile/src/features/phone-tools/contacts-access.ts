/**
 * The phone's address book as the phone tools reach it (ADR 0205): the system's permission and the book itself, read
 * on the phone and matched here (`contactsAnswer`). The real one is `deviceContacts` (expo-contacts); tests hand in a
 * fake. Nothing here imports a native module.
 */

/** The system's answer about contacts: `canAskAgain` false means only the phone's Settings can change it. */
export interface ContactsPermission {
  status: "granted" | "denied" | "undetermined";
  canAskAgain: boolean;
}

/** One contact as the phone's address book gives it, before anything is picked to leave the phone. */
export interface DeviceContact {
  fullName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  phones?: { number?: string | null }[] | null;
  emails?: { address?: string | null }[] | null;
}

export interface ContactsAccess {
  permission(): Promise<ContactsPermission>;
  /** Shows the system's prompt (only when the person turns contacts on). */
  request(): Promise<ContactsPermission>;
  /**
   * Every contact, with only its names, numbers and addresses. Not the system's name filter: Android's is one
   * `LIKE '%…%'` on the display name (accents count, words in order) and iOS's another rule, so one search would
   * find different people on each.
   */
  all(): Promise<DeviceContact[]>;
}

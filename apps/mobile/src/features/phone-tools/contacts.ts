import { requireOptionalNativeModule } from "expo";
import type { ContactsAccess, ContactsPermission } from "./contacts-access";

type ExpoContacts = typeof import("expo-contacts");

const permissionOf = (r: { status: string; canAskAgain: boolean }): ContactsPermission => ({
  status: r.status === "granted" || r.status === "denied" ? r.status : "undetermined",
  canAskAgain: r.canAskAgain,
});

function accessOf(contacts: ExpoContacts): ContactsAccess {
  const { Contact, ContactField } = contacts;
  const fields = [
    ContactField.FULL_NAME,
    ContactField.GIVEN_NAME,
    ContactField.FAMILY_NAME,
    ContactField.PHONES,
    ContactField.EMAILS,
  ] as const;
  return {
    permission: async () => permissionOf(await contacts.getPermissionsAsync()),
    request: async () => permissionOf(await contacts.requestPermissionsAsync()),
    all: () => Contact.getAllDetails(fields),
  };
}

/**
 * The phone's address book through expo-contacts (ADR 0205). A build from before the module carries no native side,
 * and loading expo-contacts there would throw: null, so Você hides the row and no job is answered. Only the fields
 * above are read, on the phone; what leaves it is `contactsAnswer`'s.
 */
export const deviceContacts: ContactsAccess | null = requireOptionalNativeModule("ExpoContactsNext")
  ? accessOf(require("expo-contacts") as ExpoContacts)
  : null;

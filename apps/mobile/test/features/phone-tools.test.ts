import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type PhoneJob, type PhoneJobAnswer } from "@agenteschat/client";
import { answerPhoneJobs, type PhoneJobsApi } from "../../src/features/phone-tools/answer";
import type { ContactsAccess, DeviceContact } from "../../src/features/phone-tools/contacts-access";
import {
  consentStep,
  contactsAnswer,
  deviceNameOf,
  isPhoneJobEvent,
  PHONE_CONTACT_VALUES_MAX,
  PHONE_CONTACTS_MAX,
  switchOn,
} from "../../src/features/phone-tools/logic";

/**
 * ADR 0205, the phone's side: the person turns contacts on from Você (the system's permission asked only then), the
 * app hears of each job on its realtime topic, searches the phone's own address book and answers with the matches
 * alone: at most 5 contacts, each its name, phone numbers and email addresses.
 */

const MOBILE = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(MOBILE, path), "utf8");

const maria: DeviceContact = {
  fullName: "Maria Souza",
  phones: [{ number: "+55 11 91234-5678" }, { number: " +55 11 91234-5678 " }, { number: "" }],
  emails: [{ address: "maria@example.com" }],
};

describe("what leaves the phone", () => {
  test("the matches only, each its name, numbers and addresses, duplicates and blanks dropped", () => {
    const answer = contactsAnswer([maria, { fullName: "João Lima", phones: [{ number: "11 5555-0000" }] }], "maria");
    expect(answer).toEqual({
      outcome: "done",
      contacts: [{ name: "Maria Souza", phones: ["+55 11 91234-5678"], emails: ["maria@example.com"] }],
    });
  });

  test("a search matches without accents or case, word by word, and a contact without a name is left out", () => {
    const found: DeviceContact[] = [
      { fullName: "José Antônio Pereira", phones: [{ number: "1" }] },
      { givenName: "Antonio", familyName: "Silva" },
      { fullName: "", phones: [{ number: "2" }] },
    ];
    const answer = contactsAnswer(found, "  ANTONIO  jose ");
    expect(answer).toEqual({
      outcome: "done",
      contacts: [{ name: "José Antônio Pereira", phones: ["1"], emails: [] }],
    });
    expect(contactsAnswer(found, "antonio")).toMatchObject({
      contacts: [{ name: "José Antônio Pereira" }, { name: "Antonio Silva" }],
    });
  });

  test(`at most ${PHONE_CONTACTS_MAX} contacts and ${PHONE_CONTACT_VALUES_MAX} numbers or addresses each, what the server takes`, () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      fullName: `Ana ${i}`,
      phones: Array.from({ length: 7 }, (_, j) => ({ number: `${i}${j}` })),
      emails: [{ address: `${"a".repeat(260)}@example.com` }, { address: `ana${i}@example.com` }],
    }));
    const answer = contactsAnswer(many, "ana");
    if (answer.outcome !== "done") throw new Error("not done");
    expect(answer.contacts).toHaveLength(PHONE_CONTACTS_MAX);
    for (const c of answer.contacts) {
      expect(c.phones).toHaveLength(PHONE_CONTACT_VALUES_MAX);
      // Too long for the server: left out whole, never cut into a wrong address.
      expect(c.emails).toEqual([`ana${c.name.slice(4)}@example.com`]);
    }
  });

  test("nothing matching is an empty answer, not a failure", () => {
    expect(contactsAnswer([maria], "zé")).toEqual({ outcome: "done", contacts: [] });
  });
});

describe("turning contacts on", () => {
  test("the system's permission is asked only when the person turns it on; refused for good, Settings", () => {
    expect(consentStep({ status: "granted", canAskAgain: true })).toBe("save");
    expect(consentStep({ status: "undetermined", canAskAgain: true })).toBe("ask");
    expect(consentStep({ status: "denied", canAskAgain: true })).toBe("ask");
    expect(consentStep({ status: "denied", canAskAgain: false })).toBe("settings");
  });

  test("the switch is on only while the server has the yes and this phone the permission", () => {
    const yes = { tools: ["contacts" as const], deviceName: "Ana's iPhone", updatedAt: "2026-11-16T10:00:00.000Z" };
    const granted = { status: "granted" as const, canAskAgain: true };
    expect(switchOn(yes, granted)).toBe(true);
    // Reinstalled, another phone, or taken back in Settings: off here, so turning it on asks the system again.
    expect(switchOn(yes, { status: "undetermined", canAskAgain: true })).toBe(false);
    expect(switchOn(yes, { status: "denied", canAskAgain: false })).toBe(false);
    expect(switchOn(yes, null)).toBe(false);
    expect(switchOn({ ...yes, tools: [] }, granted)).toBe(false);
    expect(switchOn(undefined, granted)).toBe(false);
  });

  test("the phone's name the server shows back: its own, or a plain fallback", () => {
    expect(deviceNameOf(" Ana's iPhone ", "iPhone 17")).toBe("Ana's iPhone");
    expect(deviceNameOf(null, "Pixel 10")).toBe("Pixel 10");
    expect(deviceNameOf("", undefined)).toBe("Phone");
    expect(deviceNameOf("x".repeat(150), null)).toHaveLength(100);
  });

  test("the realtime event the app re-lists on", () => {
    expect(isPhoneJobEvent({ type: "phone.job", jobId: "j1" })).toBe(true);
    expect(isPhoneJobEvent({ type: "phone.jobs" })).toBe(false);
  });
});

/**
 * A server's phone API: the jobs it lists, the answers it got. A closed job refuses its answer, as the server does; a
 * dropped one loses its first answer on the way (no connection), as a phone on a train would.
 */
function fakeApi(jobs: PhoneJob[], closed: string[] = [], dropped: string[] = []) {
  const answers: [string, PhoneJobAnswer][] = [];
  const tries: string[] = [];
  const api: PhoneJobsApi = {
    jobs: async () => ({ jobs: jobs.filter((j) => !answers.some(([id]) => id === j.id)) }),
    answer: async (_orgId, jobId, answer) => {
      tries.push(jobId);
      if (closed.includes(jobId)) throw new ApiError(409, "phone.job_closed", "This job already ended");
      if (dropped.includes(jobId) && tries.filter((id) => id === jobId).length === 1)
        throw new TypeError("Network request failed");
      answers.push([jobId, answer]);
    },
  };
  return { api, answers, tries };
}

/** The phone's address book, with the permission it has; `broken` makes reading it throw. */
function fakeContacts(book: DeviceContact[], status: "granted" | "denied" = "granted", broken = false) {
  let reads = 0;
  const access: ContactsAccess = {
    permission: async () => ({ status, canAskAgain: true }),
    request: async () => ({ status, canAskAgain: true }),
    all: async () => {
      reads++;
      if (broken) throw new Error("Contacts store unavailable");
      return book;
    },
  };
  return { access, reads: () => reads };
}

const job = (id: string, query: string): PhoneJob => ({
  id,
  kind: "find_contact",
  input: { query },
  agent: { id: "a1", name: "dev" },
  createdAt: "2026-11-16T10:00:00.000Z",
  expiresAt: "2026-11-16T10:01:00.000Z",
});

describe("answering the jobs", () => {
  test("each pending job is searched on the phone and answered once", async () => {
    const server = fakeApi([job("j1", "maria"), job("j2", "zé")]);
    const phone = fakeContacts([maria]);
    const handled = new Set<string>();

    await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled });
    await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled });

    expect(phone.reads()).toBe(2);
    expect(server.answers).toEqual([
      [
        "j1",
        {
          outcome: "done",
          contacts: [{ name: "Maria Souza", phones: ["+55 11 91234-5678"], emails: ["maria@example.com"] }],
        },
      ],
      ["j2", { outcome: "done", contacts: [] }],
    ]);
  });

  test("the system's permission taken back: the job fails with why, and the address book isn't read", async () => {
    const server = fakeApi([job("j1", "maria")]);
    const phone = fakeContacts([maria], "denied");
    await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled: new Set() });
    expect(phone.reads()).toBe(0);
    expect(server.answers).toEqual([
      ["j1", { outcome: "failed", error: "Contacts access is off for the agentes.chat app on this phone." }],
    ]);
  });

  test("an address book that can't be read fails the job with why", async () => {
    const server = fakeApi([job("j1", "maria")]);
    const phone = fakeContacts([maria], "granted", true);
    await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled: new Set() });
    expect(server.answers).toEqual([["j1", { outcome: "failed", error: "Contacts store unavailable" }]]);
  });

  test("a job the server already closed doesn't stop the next", async () => {
    const server = fakeApi([job("j0", "maria"), job("j1", "maria")], ["j0"]);
    const phone = fakeContacts([maria]);
    await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled: new Set() });
    expect(server.answers.map(([id, a]) => [id, a.outcome])).toEqual([["j1", "done"]]);
  });

  test("the match is ours, not the system's: words in any order, accents aside, across the whole book", async () => {
    // Android's own name filter is one LIKE '%…%' on the display name (accents count, words in order): reading the
    // book and matching here is what makes "jose silva" find José da Silva on every phone.
    const jose = { fullName: "José da Silva", phones: [{ number: "+55 21 98888-7777" }] };
    const server = fakeApi([job("j1", "silva jose")]);
    const phone = fakeContacts([maria, jose]);
    await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled: new Set() });
    expect(server.answers).toEqual([
      ["j1", { outcome: "done", contacts: [{ name: "José da Silva", phones: ["+55 21 98888-7777"], emails: [] }] }],
    ]);
  });

  test("an answer lost on the way goes again on the next pass; one the server refused doesn't", async () => {
    const server = fakeApi([job("j0", "maria"), job("j1", "maria")], ["j0"], ["j1"]);
    const phone = fakeContacts([maria]);
    const handled = new Set<string>();

    expect(await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled })).toBe(true);
    expect(server.answers).toEqual([]);
    expect(await answerPhoneJobs({ api: server.api, orgId: "o1", contacts: phone.access, handled })).toBe(false);

    expect(server.answers.map(([id, a]) => [id, a.outcome])).toEqual([["j1", "done"]]);
    expect(server.tries).toEqual(["j0", "j1", "j1"]);
  });
});

describe("the app's wiring", () => {
  test("the jobs are answered wherever the app is, and Você has the switch", () => {
    expect(read("app/(app)/_layout.tsx")).toContain("usePhoneJobs()");
    expect(read("app/(app)/me/phone-tools.tsx")).toContain("PhoneToolsPage");
    expect(read("src/features/me/MeScreen.tsx")).toContain('open("/me/phone-tools")');
  });

  test("the build asks iOS with our words, and Android only reads contacts", () => {
    const config = read("app.config.ts");
    expect(config).toContain('"expo-contacts"');
    expect(config).toContain("contactsPermission:");
    expect(config).toContain('"android.permission.WRITE_CONTACTS"');
  });
});

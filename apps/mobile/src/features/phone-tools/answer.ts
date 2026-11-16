import { type ApiClient, ApiError } from "@agenteschat/client";
import type { ContactsAccess } from "./contacts-access";
import { contactsAnswer, failedAnswer } from "./logic";

/** The part of the API the phone answers its jobs with. */
export type PhoneJobsApi = Pick<ApiClient["phone"], "jobs" | "answer">;

/** What the agent reads when the system's permission was taken back after the person turned contacts on. */
const PERMISSION_OFF = "Contacts access is off for the agentes.chat app on this phone.";

/** The server's word that a job takes no answer any more: it ended, or another of the person's phones answered it. */
const REFUSED = new Set(["phone.job_closed", "phone.job_not_found"]);

/**
 * Answers this person's pending jobs here once each (ADR 0205): every job is matched against the phone's own address
 * book and answered with the matches (`contactsAnswer`), or failed with why. `handled` keeps the ids the server got an
 * answer for or refused, so such a job isn't tried again while it still lists; an answer lost on the way (no
 * connection, the server down) leaves its job to the next pass. True when one was lost, for the caller to try again.
 */
export async function answerPhoneJobs(deps: {
  api: PhoneJobsApi;
  orgId: string;
  contacts: ContactsAccess;
  handled: Set<string>;
}): Promise<boolean> {
  const { api, orgId, contacts, handled } = deps;
  const { jobs } = await api.jobs(orgId);
  let lost = false;
  for (const job of jobs) {
    if (handled.has(job.id)) continue;
    let answer: Parameters<PhoneJobsApi["answer"]>[2];
    try {
      const permission = await contacts.permission();
      answer =
        permission.status === "granted"
          ? contactsAnswer(await contacts.all(), job.input.query)
          : { outcome: "failed", error: PERMISSION_OFF };
    } catch (error) {
      answer = failedAnswer(error);
    }
    try {
      await api.answer(orgId, job.id, answer);
      handled.add(job.id);
    } catch (error) {
      if (error instanceof ApiError && REFUSED.has(error.code)) handled.add(job.id);
      else lost = true;
    }
  }
  return lost;
}

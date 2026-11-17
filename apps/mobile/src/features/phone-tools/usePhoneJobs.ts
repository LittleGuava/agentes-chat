import { useApi, usePhoneTools } from "@agenteschat/client";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useConnection, useOrgId } from "../shared/hooks";
import { answerPhoneJobs } from "./answer";
import { deviceContacts } from "./contacts";
import { contactsOn, isPhoneJobEvent } from "./logic";

/** How long after an answer lost on the way the jobs are read again (a job lasts a minute). */
const RETRY_MS = 5_000;

/**
 * Answers the jobs this person's agents send to this phone (ADR 0205), whatever screen is open: when contacts are on
 * here, the jobs are read on mounting, each time the app comes back to the front, on every `phone.job` event and
 * shortly after an answer was lost on the way; one pass at a time, another queued behind it. Mounted once with the
 * app's stack.
 */
export function usePhoneJobs() {
  const api = useApi();
  const connection = useConnection();
  const orgId = useOrgId();
  const tools = usePhoneTools(orgId, deviceContacts !== null);
  const on = contactsOn(tools.data);
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const contacts = deviceContacts;
    if (!on || !contacts) return;
    let running = false;
    let again = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      clearTimeout(retry);
      void answerPhoneJobs({ api: api.phone, orgId, contacts, handled: handled.current })
        .then((lost) => {
          if (lost) retry = setTimeout(run, RETRY_MS);
        })
        // The list didn't come (no connection): the next event or the app's return reads it again.
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (again) {
            again = false;
            run();
          }
        });
    };
    run();
    const offEvent = connection?.onUserEvent((event) => {
      if (isPhoneJobEvent(event)) run();
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    return () => {
      clearTimeout(retry);
      offEvent?.();
      appState.remove();
    };
  }, [on, api, connection, orgId]);
}

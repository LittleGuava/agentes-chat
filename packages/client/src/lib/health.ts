import type { TFunction } from "i18next";
import type { HealthIssue } from "../api/types";
import { runErrorText } from "./errors";

/**
 * The words of Settings › Health (ADR 0214), shared by the apps: what an issue says on its first line. A run's failure
 * is worded as the conversation words it (`runErrorText`), the rest by their kind; the normalized text (`<n>`,
 * `<path>`…) stands when nothing else says more.
 */
export function healthHeadline(t: TFunction, issue: HealthIssue): string {
  switch (issue.kind) {
    case "timeout":
    case "run_failed": {
      // The scan keeps one name and one text of the run's error (`health.ts`): each goes where its code's words want it.
      const name = issue.subject ?? "";
      const params = {
        provider: name,
        brain: name,
        model: name,
        modelProvider: name,
        keyProvider: issue.title,
        detail: issue.title,
      };
      return runErrorText(t, issue.source, params) || issue.title || t("health.runFailed");
    }
    case "queue_stalled":
      return t("health.stalled");
    case "job_failed":
      return issue.title || t("health.jobFailed");
    case "cost_spike": {
      const agent = issue.examples.find((e) => e.agent?.name)?.agent?.name;
      return agent ? t("health.costSpike", { agent }) : t("health.costSpikeNoName");
    }
    default:
      return issue.title || t("health.runFailed");
  }
}

/** What failed, shown as code beside the kind: the tool or the job's kind; none for a run (its words say it). */
export const healthSource = (issue: HealthIssue): string | null =>
  issue.kind === "tool_error" || issue.kind === "queue_stalled" || issue.kind === "job_failed" ? issue.source : null;

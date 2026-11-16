import { type HealthIssue, useHealthIssues } from "@agenteschat/client";
import { clockAt, whenAt } from "@agenteschat/client/lib/format";
import { healthHeadline, healthSource } from "@agenteschat/client/lib/health";
import { Card, Chip, EmptyState } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import "./health.css";

/**
 * Configurações › Saúde (ADR 0214): what keeps failing in the workspace, one row per cause, the latest first. Each row
 * says what failed, how many times and since when, and its latest occurrences: when and which agent, never what
 * anyone wrote.
 */
export function HealthSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useRightHandLook();
  const health = useHealthIssues(org.id);
  const issues = health.data?.issues ?? [];
  return (
    <section className="health" aria-label={t("settings.section.health")}>
      {health.isPending ? (
        <LoadingList count={4} trailing />
      ) : health.isError ? (
        <ErrorState error={health.error} onRetry={() => void health.refetch()} />
      ) : issues.length === 0 ? (
        <EmptyState size="page" agent={look} mood="deal" title={t("health.emptyTitle")}>
          {t("health.empty")}
        </EmptyState>
      ) : (
        <ul className="health__list">
          {issues.map((issue) => (
            <li key={issue.id}>
              <Issue issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Issue({ issue }: { issue: HealthIssue }) {
  const { t, i18n } = useTranslation();
  const source = healthSource(issue);
  const locale = i18n.language;
  return (
    <Card as="article" className="health-issue">
      <div className="health-issue__head">
        <Chip icon="alert" className={`health-chip--${issue.kind}`}>
          {t(`health.kind.${issue.kind}`)}
        </Chip>
        {source && <code className="ac-inlinecode">{source}</code>}
        <span className="health-issue__count">{t("health.count", { count: issue.count })}</span>
      </div>
      <p className="health-issue__title">{healthHeadline(t, issue)}</p>
      <p className="health-issue__sub">
        {t("health.since", { first: whenAt(t, locale, issue.firstAt), last: whenAt(t, locale, issue.lastAt) })}
      </p>
      {issue.examples.length > 0 && (
        <p className="health-issue__sub">
          {t("health.latest")}{" "}
          {issue.examples
            .map((e) => (e.agent?.name ? `${e.agent.name} ${clockAt(locale, e.at)}` : clockAt(locale, e.at)))
            .join(" · ")}
        </p>
      )}
    </Card>
  );
}

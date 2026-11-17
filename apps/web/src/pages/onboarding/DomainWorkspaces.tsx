import { useDomainWorkspaces, useJoinByDomain } from "@agenteschat/client";
import { errorText, invitedErrorText } from "@agenteschat/client/lib/errors";
import { Button, Card, CardHeader, List } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { OrgMark } from "@/components/ProfilePhoto";
import { useToast } from "@/lib/toast";

/**
 * The onboarding's first step: workspaces the person's confirmed email domain lets them join without an invitation
 * (ADR 0068, addendum 2026-11-15). Nothing while there are none, or the address isn't confirmed yet.
 */
export function DomainWorkspaces() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const workspaces = useDomainWorkspaces().data ?? [];
  const join = useJoinByDomain();
  if (workspaces.length === 0) return null;
  return (
    <Card aria-labelledby="domain-workspaces-title">
      <CardHeader
        id="domain-workspaces-title"
        icon="person"
        title={t("onboarding.domainJoin.title")}
        subtitle={t("onboarding.domainJoin.lead")}
      />
      <List>
        {workspaces.map((w) => (
          <div key={w.id} className="ac-list__row ac-mediarow">
            <span className="ac-mediarow__face">
              <OrgMark logo={w.logo} size={32} />
            </span>
            <span className="ac-mediarow__head">
              <b>{w.name}</b>
            </span>
            <span className="ac-mediarow__end ac-acts">
              <Button
                variant="primary"
                size="sm"
                aria-label={t("onboarding.domainJoin.joinName", { name: w.name })}
                loading={join.isPending && join.variables === w.id}
                disabled={join.isPending}
                onClick={() =>
                  join.mutate(w.id, {
                    onSuccess: ({ orgId }) => void navigate({ to: "/org/$orgId", params: { orgId } }),
                    // A full workspace says whom to tell, never its numbers (they are for its admins).
                    onError: (e) =>
                      toast.show(invitedErrorText(t, e, i18n.language) ?? errorText(t, e, i18n.language), "error"),
                  })
                }
              >
                {t("onboarding.domainJoin.join")}
              </Button>
            </span>
          </div>
        ))}
      </List>
    </Card>
  );
}

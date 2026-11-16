import { useAddJoinDomain, useJoinDomains, useRemoveJoinDomain, useRoles } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { Avatar, Button, Card, CardHeader, Field, Input, List, Select } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Who } from "@/components/invite/InviteRows";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** "Membro": no cargo, only what Todos has. */
const MEMBER = "member";

/**
 * Members › "Join by email domain" (ADR 0068, addendum 2026-11-15), for whoever manages members: the domains whose
 * confirmed addresses find the workspace and join without an invitation, each with the cargo they start on.
 */
export function JoinDomains() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const domains = useJoinDomains(org.id);
  const roles = useRoles(org.id).data?.roles ?? [];
  const add = useAddJoinDomain(org.id);
  const remove = useRemoveJoinDomain(org.id);
  const [domain, setDomain] = useState("");
  const [role, setRole] = useState(MEMBER);
  const [error, setError] = useState<string | null>(null);
  const givable = sortRoles(roles.filter((r) => !isEveryone(r) && r.givable));
  const options = [
    { value: MEMBER, label: t("roles.member") },
    ...givable.map((r) => ({ value: r.id, label: r.name })),
  ];
  const nameOf = (id: string) => roles.find((r) => r.id === id)?.name;
  const submit = () =>
    add.mutate(
      { domain, roleIds: role === MEMBER ? [] : [role] },
      {
        onSuccess: (d) => {
          setDomain("");
          setError(null);
          toast.show(t("members.domains.added", { domain: d.domain }));
        },
        onError: (e) => setError(errorText(t, e)),
      },
    );
  const list = domains.data ?? [];
  return (
    <Card aria-labelledby="join-domains-title">
      <CardHeader
        id="join-domains-title"
        icon="globe"
        title={t("members.domains.title")}
        subtitle={t("members.domains.lead", { org: org.name })}
      />
      {list.length > 0 && (
        <List>
          {list.map((d) => {
            const names = d.roleIds.map(nameOf).filter((n): n is string => Boolean(n));
            return (
              <div key={d.id} className="ac-list__row members-row ac-mediarow">
                <Who
                  face={<Avatar size="md" name={d.domain} initials={d.domain.slice(0, 2).toUpperCase()} />}
                  name={d.domain}
                  sub={t("members.domains.rolesOf", {
                    roles: names.length ? joinNames(names, t) : t("roles.member"),
                  })}
                />
                <span className="ac-mediarow__end members-row__acts ac-acts">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("members.domains.remove", { domain: d.domain })}
                    loading={remove.isPending && remove.variables === d.id}
                    onClick={() =>
                      remove.mutate(d.id, {
                        onSuccess: () => toast.show(t("members.domains.removed", { domain: d.domain })),
                        onError: (e) => toast.show(errorText(t, e), "error"),
                      })
                    }
                  >
                    {t("members.domains.removeShort")}
                  </Button>
                </span>
              </div>
            );
          })}
        </List>
      )}
      <form
        className="ac-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim()) submit();
        }}
      >
        <Field
          label={t("members.domains.domain")}
          id="join-domain"
          error={error}
          hint={{ name: t("common.about", { label: t("members.domains.domain") }), text: t("members.domains.hint") }}
        >
          <Input
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
              setError(null);
            }}
            placeholder={t("members.domains.placeholder")}
            spellCheck={false}
            autoCapitalize="none"
            inputMode="url"
          />
        </Field>
        <Field label={t("members.domains.role")} id="join-domain-role">
          <Select value={role} options={options} onValueChange={setRole} />
        </Field>
        <div className="ac-acts">
          <Button type="submit" variant="primary" icon="plus" loading={add.isPending} disabled={!domain.trim()}>
            {t("members.domains.add")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

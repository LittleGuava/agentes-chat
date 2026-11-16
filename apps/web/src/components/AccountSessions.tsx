import { ApiError, useAccountSessions, useSignOutOtherSessions, useSignOutSession } from "@agenteschat/client";
import { sessionDeviceName, sessionIcon, sessionLine } from "@agenteschat/client/lib/sessions";
import { Button, Card, CardHeader, Chip } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PrefRow } from "@/components/NoticePrefs";
import { useToast } from "@/lib/toast";

/**
 * Configurações › Sua conta › Sessões ativas (ADR 0006, addendum 2026-11-15): every place the account is signed in,
 * this one first and marked "Esta sessão" where the others have "Sair", and "Sair de todas as outras" on the card. Nothing on a server from
 * before the list.
 */
export function AccountSessions() {
  const { t, i18n } = useTranslation();
  const sessions = useAccountSessions();
  const signOut = useSignOutSession();
  const signOutOthers = useSignOutOtherSessions();
  const toast = useToast();
  const list = sessions.data;
  if (!list) return null;
  // One that ended meanwhile is gone already: the list read again says so.
  const failed = (error: unknown) => {
    if (!(error instanceof ApiError && error.status === 404)) toast.show(t("settings.account.sessions.failed"));
  };
  const title = t("settings.account.sessions.title");
  return (
    <Card aria-labelledby="account-sessions">
      <CardHeader
        id="account-sessions"
        icon="shield"
        title={title}
        hint={{ name: t("common.about", { label: title }), text: t("settings.account.sessions.help") }}
        action={
          list.some((s) => !s.current) && (
            <Button
              size="sm"
              loading={signOutOthers.isPending}
              onClick={() =>
                signOutOthers.mutate(undefined, {
                  onSuccess: () => toast.show(t("settings.account.sessions.signedOutOthers")),
                  onError: failed,
                })
              }
            >
              {t("settings.account.sessions.signOutOthers")}
            </Button>
          )
        }
      />
      <div className="settings-rows">
        {list.map((s) => {
          const name = sessionDeviceName(t, s.device);
          return (
            <PrefRow
              key={s.id}
              id={`account-session-${s.id}`}
              icon={sessionIcon(s.device)}
              label={name}
              status={sessionLine(t, i18n.language, s)}
              control={
                s.current ? (
                  <Chip tone="info">{t("settings.account.sessions.current")}</Chip>
                ) : (
                  <Button
                    size="sm"
                    aria-label={`${t("settings.account.sessions.signOut")}: ${name}`}
                    loading={signOut.isPending && signOut.variables === s.id}
                    onClick={() => signOut.mutate(s.id, { onError: failed })}
                  >
                    {t("settings.account.sessions.signOut")}
                  </Button>
                )
              }
            />
          );
        })}
      </div>
    </Card>
  );
}

import { useServerUpdate } from "@agenteschat/client";
import { Card, CardHeader } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { CommandBlock } from "@/components/machine-bits";

/**
 * A newer server release, for the installation's owner (ADR 0060, addendum 2026-11-15): its version, its notes on
 * GitHub and the command that installs it on this server. Nothing at all while the server is up to date, for
 * everyone else, on agentes.chat itself and with `UPDATE_CHECK=off` (the API answers `null`).
 */
export function ServerUpdateCard() {
  const { t } = useTranslation();
  const data = useServerUpdate().data;
  if (!data?.updateAvailable || !data.latest) return null;
  return (
    <Card aria-labelledby="sec-server-update">
      <CardHeader
        id="sec-server-update"
        icon="download"
        title={t("settings.serverUpdate.title", { version: data.latest.version })}
        subtitle={t("settings.serverUpdate.current", { version: data.version })}
        action={
          <a className="ac-link" href={data.latest.notesUrl} target="_blank" rel="noopener noreferrer">
            {t("settings.serverUpdate.notes")}
          </a>
        }
      />
      {data.command && (
        <div className="list-col">
          <span className="small muted">
            {t(data.install === "native" ? "settings.serverUpdate.native" : "settings.serverUpdate.docker")}
          </span>
          <CommandBlock command={data.command} />
        </div>
      )}
    </Card>
  );
}

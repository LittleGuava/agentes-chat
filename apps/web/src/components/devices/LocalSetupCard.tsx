import type { LocalSetup, Machine } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { localSetupWay } from "@agenteschat/client/lib/machines";
import { addsConnectors, makesAgents } from "@agenteschat/client/lib/permissions";
import { Alert, Button, Card, CardHeader, Chip, List, ProviderLogo } from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ImportFailureNote } from "@/components/ImportFailure";
import { ImportReport, Preview, useImportFlow } from "@/components/ImportFlow";
import { useOrg } from "@/components/org-context";

type Server = LocalSetup["servers"][number];

/** Under a server's address: what can be done with it, when it can't simply be connected. */
function stateLine(t: TFunction, s: Server, connected: boolean): string | null {
  if (connected) return null;
  if (s.state === "connect") {
    const names = [...s.headers, ...s.query, ...s.env];
    return names.length > 0 ? t("machines.local.needs", { names: joinNames(names, t) }) : null;
  }
  if (s.state === "stdio") return t("machines.local.state.stdio", { command: s.command ?? "" });
  if (s.state === "connected") return null;
  return t(`machines.local.state.${s.state}`);
}

/** Each reason's words (`too_many` and the like would read as plural forms to i18next). */
const WHY = {
  too_big: "big",
  unreadable: "unreadable",
  link: "link",
  too_many: "capped",
  no_skill: "noSkill",
} as const;

/** The files and skill folders it didn't read, with why ("~/.codex/config.toml (grande demais)"); a missing one is no news. */
function notRead(t: TFunction, setup: LocalSetup) {
  return [
    ...setup.files.flatMap((f) => (f.state === "read" || f.state === "missing" ? [] : [[f.path, f.state] as const])),
    ...setup.skipped.map((s) => [s.path, s.reason] as const),
  ].map(([path, why]) => `${path} (${t(`machines.local.why.${WHY[why]}`)})`);
}

/**
 * The MCP servers and skills the person who connected this computer set up for Claude Code, Cursor and Codex there
 * (ADR 0055, addendum 2026-11-15), read only when they press Procurar. A server is connected through the usual
 * custom-server flow, the skills come through the usual import (its plan, picks and report).
 */
export function LocalSetupCard({ machine: m }: { machine: Machine }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const way = localSetupWay(m, me.user.id);
  const flow = useImportFlow(org.id);
  const imports = makesAgents(org);
  const [connect, setConnect] = useState<{ server: string; flow: FlowState } | null>(null);
  // Servers connected from here since the last read: their rows say so without reading the computer again.
  const [joined, setJoined] = useState<ReadonlySet<string>>(new Set());
  const read = useMutation({
    mutationFn: () => api.machines.localConfig(org.id, m.id),
    meta: { silent: true },
    onSuccess: (setup) => {
      setJoined(new Set());
      if (imports && setup.bundle.skills.length > 0) void flow.read({ bundle: setup.bundle });
      else flow.reset();
    },
  });
  if (!way) return null;
  const setup = read.data;
  const title = t("machines.local.title");
  const skipped = setup ? notRead(t, setup) : [];

  return (
    <Card aria-labelledby="sec-machine-local">
      <CardHeader
        id="sec-machine-local"
        icon="plug"
        title={title}
        action={
          way === "read" ? (
            <Button size="sm" icon="search" loading={read.isPending} onClick={() => read.mutate()}>
              {setup ? t("machines.local.lookAgain") : t("machines.local.look")}
            </Button>
          ) : undefined
        }
      />
      <p className="small muted local-setup__lead">
        {way === "outdated"
          ? t("machines.local.outdated")
          : way === "offline"
            ? t("machines.local.offline")
            : t("machines.local.intro")}
      </p>
      {read.isError && <Alert>{errorText(t, read.error, i18n.language)}</Alert>}
      {setup && setup.servers.length === 0 && setup.bundle.skills.length === 0 && (
        <p className="small muted local-setup__lead">{t("machines.local.nothing")}</p>
      )}
      {setup && setup.servers.length > 0 && (
        <section aria-labelledby="sec-machine-local-servers" className="local-setup__part">
          <h3 id="sec-machine-local-servers" className="local-setup__heading">
            {t("machines.local.servers")}
          </h3>
          <List aria-label={t("machines.local.servers")}>
            {setup.servers.map((s) => {
              // Two tools may name a server alike: the row is the tool's and the name's.
              const key = `${s.app}:${s.name}`;
              const connected = s.state === "connected" || joined.has(key);
              const line = stateLine(t, s, connected);
              const connectable = !connected && (s.state === "connect" || s.state === "key_in_address");
              return (
                <div key={key} className="ac-list__row machine-folder" data-server={s.name}>
                  <span className="machine-row__icon">
                    <ProviderLogo id={s.app} size="sm" />
                  </span>
                  <span className="list-col local-setup__main">
                    <span className="machine-folder__name">{s.name}</span>
                    {s.url && <code className="machine-folder__path">{s.url}</code>}
                    {line && <span className="small muted">{line}</span>}
                  </span>
                  <span className="machine-folder__tail ac-captail">
                    {connected && <Chip icon="check">{t("machines.local.connected")}</Chip>}
                    {connectable && !addsConnectors(org) && (
                      <span className="small muted">{t("actionCard.connect_app.adminOnly")}</span>
                    )}
                    {connectable && addsConnectors(org) && (
                      <Button
                        size="sm"
                        aria-label={t("machines.local.connectLabel", { name: s.name })}
                        onClick={() =>
                          setConnect({
                            server: key,
                            // A masked address is left for the person to paste whole.
                            flow: { step: 0, def: null, url: s.state === "connect" ? s.url : undefined },
                          })
                        }
                      >
                        {t("machines.local.connect")}
                      </Button>
                    )}
                  </span>
                </div>
              );
            })}
          </List>
        </section>
      )}
      {setup && setup.bundle.skills.length > 0 && (
        <section aria-label={t("machines.local.skills")} className="local-setup__part">
          {/* The import's own preview names its kinds (Skills) under its header: no heading of ours above it. */}
          {!imports && <h3 className="local-setup__heading">{t("machines.local.skills")}</h3>}
          {setup.masked.length > 0 && (
            <p className="small muted local-setup__lead">
              {t("machines.local.masked", { names: joinNames(setup.masked, t) })}
            </p>
          )}
          {!imports ? (
            <>
              <p className="small muted local-setup__lead">{setup.bundle.skills.map((s) => s.key).join(", ")}</p>
              <p className="small muted local-setup__lead">{t("machines.local.noImport")}</p>
            </>
          ) : flow.failure ? (
            <ImportFailureNote failure={flow.failure} retry={flow.retry} />
          ) : flow.planned && flow.report ? (
            <ImportReport flow={flow} orgId={org.id} level={3} />
          ) : flow.planned ? (
            <Preview flow={flow} orgId={org.id} standalone level={3} fixed />
          ) : null}
        </section>
      )}
      {skipped.length > 0 && (
        <p className="small muted local-setup__lead">{t("machines.local.notRead", { list: skipped.join(", ") })}</p>
      )}
      <ConnectFlow
        flow={connect?.flow ?? null}
        // No returnTo: back from signing in elsewhere, Conectores finishes the flow (tools, agents), this page can't.
        onChange={(next) => {
          // Past the address step, the server is connected.
          if (connect && next.step !== 0) setJoined((j) => new Set([...j, connect.server]));
          setConnect((c) => c && { ...c, flow: next });
        }}
        onClose={() => setConnect(null)}
      />
    </Card>
  );
}

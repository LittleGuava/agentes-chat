/**
 * Preferences › Agents' files (ADR 0204): whether this computer downloads the agents' files, of which workspace and
 * conversations, where they go and how the last pass went. The popover does the downloading (`startFolderSync`); this
 * tab only writes the choice, which the popover hears at once.
 */
import { Button, Checkbox, Icon, PixelSpinner, Select, Switch } from "@agenteschat/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../../app";
import {
  type Conversation,
  conversationsOf,
  FOLDER_SYNC_PREF,
  FOLDER_SYNC_STATUS_PREF,
  type FolderSyncChoice,
  type FolderSyncStatus,
} from "../../control/folder-sync";
import { type ServerWorkspaces, serverName } from "../../control/server";
import { useLivePref, usePref } from "../../hooks";
import { OrgTile } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { clock } from "../../ui/time";

type Listing = { state: "loading" } | { state: "failed" } | { state: "ready"; conversations: Conversation[] };

const targetKey = (server: string, orgId: string) => `${server} ${orgId}`;

export function FolderSync() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [choice, setChoice] = usePref<FolderSyncChoice | null>(FOLDER_SYNC_PREF, null);
  const status = useLivePref<FolderSyncStatus | null>(FOLDER_SYNC_STATUS_PREF, null);
  const [spaces, setSpaces] = useState<ServerWorkspaces[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const on = choice?.on === true;

  useEffect(() => {
    let live = true;
    const read = () =>
      void host
        .workspaces()
        .then((l) => live && setSpaces(l))
        .catch(() => live && setSpaces([]));
    read();
    void host
      .servers()
      .then((l) => live && setCurrent(l.current))
      .catch(() => {});
    const off = host.onWorkspaces(read);
    return () => {
      live = false;
      off();
    };
  }, [host]);

  const signedIn = (spaces ?? []).filter((s) => s.signedIn);
  const options = signedIn.flatMap((s) =>
    s.orgs.map((org) => ({
      value: targetKey(s.server, org.id),
      label: org.name,
      leading: <OrgTile logo={org.logo} size="sm" />,
      ...(signedIn.length > 1 ? { group: serverName(s.server) } : {}),
    })),
  );
  // The workspace taken when none was chosen: the open server's first, else any.
  const first = [...signedIn].sort((a, b) => Number(b.server === current) - Number(a.server === current))[0];
  const fallback = first?.orgs[0] ? { server: first.server, orgId: first.orgs[0].id } : null;
  const chosen = choice?.orgId ? { server: choice.server, orgId: choice.orgId } : null;
  const chosenKey = chosen ? targetKey(chosen.server, chosen.orgId) : "";
  // A workspace no longer signed in to keeps its choice (a session out for a moment drops nothing); the picker shows
  // so another can be taken.
  const picker = options.length > 1 || !options.some((o) => o.value === chosenKey);

  // Turned on before the workspaces were read: the first one, once they are.
  useEffect(() => {
    if (choice?.on && !choice.orgId && fallback) setChoice({ ...choice, ...fallback, channelIds: [] });
  }, [choice, fallback, setChoice]);

  useEffect(() => {
    if (!on) return;
    let live = true;
    host
      .folderSyncRoot()
      .then((path) => live && setRoot(path))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host, on]);

  const server = on ? chosen?.server : undefined;
  const orgId = on ? chosen?.orgId : undefined;
  // One reading at a time: a newer one (another workspace, Try again) makes the older's answer moot.
  const asked = useRef(0);
  const load = useCallback(async () => {
    if (!server || !orgId) return;
    const ask = ++asked.current;
    setListing({ state: "loading" });
    const read = async (path: string) => {
      const answer = await host.siteFetch(server, "GET", `/api/app/organizations/${orgId}/${path}`);
      if (answer.status !== 200) throw new Error(`status ${answer.status}`);
      return JSON.parse(answer.body) as unknown;
    };
    try {
      const channels = await read("channels");
      const dms = await read("dms");
      if (asked.current === ask) setListing({ state: "ready", conversations: conversationsOf(channels, dms) });
    } catch {
      if (asked.current === ask) setListing({ state: "failed" });
    }
  }, [host, server, orgId]);
  useEffect(() => {
    void load();
    return () => {
      asked.current++;
    };
  }, [load]);

  const turn = (next: boolean) =>
    setChoice(
      choice
        ? { ...choice, on: next }
        : { on: next, server: fallback?.server ?? "", orgId: fallback?.orgId ?? "", channelIds: [] },
    );
  const pick = (value: string) => {
    const [s = "", o = ""] = value.split(" ");
    if (choice && (s !== choice.server || o !== choice.orgId))
      setChoice({ on: choice.on, server: s, orgId: o, channelIds: [] });
  };
  const toggle = (id: string, checked: boolean) => {
    if (!choice) return;
    const rest = choice.channelIds.filter((c) => c !== id);
    setChoice({ ...choice, channelIds: checked ? [...rest, id] : rest });
  };
  const reveal = () => {
    if (root) host.revealFolder(root).catch(() => toast(t("desktop.common.error"), "alert"));
  };

  const mine = status && chosen && status.server === chosen.server && status.orgId === chosen.orgId ? status : null;
  const trouble = mine?.unreachable
    ? t("desktop.folderSync.unreachable")
    : mine && mine.failed > 0
      ? t("desktop.folderSync.someFailed")
      : null;
  const onTitle = t("desktop.folderSync.on");

  return (
    <>
      <PrefHead title={t("desktop.folderSync.title")} lead={t("desktop.folderSync.lead")} />
      <PrefCard>
        <PrefRow
          title={onTitle}
          hint={hintFor(t, onTitle, t("desktop.folderSync.onHint"))}
          htmlFor="folder-sync"
          end={<Switch id="folder-sync" aria-describedby="folder-sync-hint" checked={on} onCheckedChange={turn} />}
        />
        {on && spaces && options.length === 0 && <PrefRow desc={t("desktop.folderSync.noWorkspace")} />}
        {on && chosen && options.length > 0 && picker && (
          <PrefRow
            title={t("desktop.prefs.folders.org")}
            htmlFor="folder-sync-workspace"
            end={
              <Select
                id="folder-sync-workspace"
                size="sm"
                align="end"
                value={chosenKey}
                onValueChange={pick}
                options={options}
              />
            }
          />
        )}
        {on && root && (
          <PrefRow
            title={t("desktop.folderSync.folder")}
            desc={root}
            end={
              <Button size="sm" variant="ghost" onClick={reveal}>
                {host.platform === "mac" ? t("desktop.server.reveal") : t("desktop.server.revealFiles")}
              </Button>
            }
          />
        )}
        {on && chosen && (
          <PrefRow
            title={t("desktop.folderSync.last")}
            desc={mine ? clock(mine.at, i18n.language) : t("desktop.folderSync.notYet")}
            under={
              trouble && (
                <span className="dk-honest ac-iconline" role="status">
                  <Icon name="alert" size={16} />
                  <span>{trouble}</span>
                </span>
              )
            }
          />
        )}
      </PrefCard>

      {on && chosen && (
        <>
          <CardTitle>{t("desktop.folderSync.conversations")}</CardTitle>
          <PrefCard>
            {listing.state === "loading" && (
              <PrefRow
                lead={<PixelSpinner size={14} color="sky" />}
                desc={<span className="dk-shimmer">{t("desktop.folderSync.loading")}</span>}
              />
            )}
            {listing.state === "failed" && (
              <PrefRow
                desc={t("desktop.folderSync.loadFailed")}
                end={
                  <Button size="sm" variant="ghost" onClick={() => void load()}>
                    {t("desktop.common.retry")}
                  </Button>
                }
              />
            )}
            {listing.state === "ready" && listing.conversations.length === 0 && (
              <PrefRow desc={t("desktop.folderSync.none")} />
            )}
            {listing.state === "ready" &&
              listing.conversations.map((c) => (
                <PrefRow
                  key={c.id}
                  lead={
                    <Checkbox
                      id={`conversation-${c.id}`}
                      checked={choice?.channelIds.includes(c.id) ?? false}
                      onCheckedChange={(checked) => toggle(c.id, checked)}
                    />
                  }
                  htmlFor={`conversation-${c.id}`}
                  title={c.dm ? c.name : `#${c.name}`}
                  desc={c.dm ? t("desktop.folderSync.dmFolder") : undefined}
                />
              ))}
          </PrefCard>
        </>
      )}
    </>
  );
}

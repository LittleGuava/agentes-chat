import { useChannels, useDms, useMarkChannelRead, useMarkChannelUnread } from "@agenteschat/client";
import { readToggleOf } from "@agenteschat/client/lib/unread";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";
import type { ConversationRow } from "../chats/logic";
import { usePins } from "../chats/pins";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { arrangesCategories, categoryHrefs, movesChannel } from "./logic";

const NO_CHANNELS: never[] = [];

/** One of a row's long press actions: the app's sheet shows `icon`, iOS's own menu the SF Symbol `symbol`. */
export interface RowAction {
  key: "pin" | "pin-up" | "pin-down" | "move" | "read";
  icon: "pin" | "up" | "down" | "list" | "check" | "mail";
  symbol: "pin" | "pin.slash" | "arrow.up" | "arrow.down" | "folder" | "envelope.open" | "envelope.badge";
  label: string;
  run: () => void;
}

/**
 * The home's long presses (ADR 0080), as short sheets: a row's "Fixar no topo" (a channel, an agent's or a person's
 * DM), "Marcar como lida" or "Marcar como não lida" (`readToggleOf`), a pinned row's Mover para cima and Mover para
 * baixo among the pinned ones (ADR 0083, addendum of 2026-11-15) and a channel's "Mover para…" (only where
 * `movesChannel`), and a category header's Renomear, Categorias and Nova categoria (admins; undefined otherwise, so
 * the header has no long press at all).
 */
export function useCategoryMenus() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const sheet = useSheet();
  const channels = useChannels(orgId).data ?? NO_CHANNELS;
  const dms = useDms(orgId).data;
  const markRead = useMarkChannelRead(orgId).mutate;
  const markUnread = useMarkChannelUnread(orgId).mutate;
  const admin = arrangesCategories(org);
  const dir = useDirectory();
  const pins = usePins();
  const go = useCallback(
    (href: Parameters<typeof router.push>[0]) => {
      sheet.close();
      router.push(href);
    },
    [sheet],
  );
  // What a row's long press offers: pin it on top (a channel, an agent's or a person's DM) or take it off, and move
  // a channel (only where `movesChannel`). The same list fills the app's sheet and iOS's own menu.
  const rowActions = (r: ConversationRow): RowAction[] => {
    const channel = r.kind === "channel" ? channels.find((c) => c.id === r.channelId) : undefined;
    const pin =
      r.kind === "channel"
        ? { kind: "channels" as const, id: r.channelId }
        : r.kind === "dm"
          ? { kind: r.with.type === "agent" ? ("agents" as const) : ("people" as const), id: r.with.id }
          : null;
    if (!pin || (r.kind === "channel" && !channel)) return [];
    const pinned = pins.isPinned(pin.kind, pin.id);
    const toggle = channel
      ? readToggleOf({ channel })
      : r.kind === "dm"
        ? readToggleOf({ dm: dms?.find((d) => d.channelId === r.channelId) })
        : null;
    return [
      {
        key: "pin",
        icon: "pin",
        symbol: pinned ? "pin.slash" : "pin",
        label: pinned ? t("sidebarPins.unpin") : t("sidebarPins.pin"),
        run: () => pins.toggle(pin.kind, pin.id),
      },
      ...(pins.canStep(pin.kind, pin.id, -1)
        ? [
            {
              key: "pin-up" as const,
              icon: "up" as const,
              symbol: "arrow.up" as const,
              label: t("sidebarPins.moveUp"),
              run: () => pins.step(pin.kind, pin.id, -1),
            },
          ]
        : []),
      ...(pins.canStep(pin.kind, pin.id, 1)
        ? [
            {
              key: "pin-down" as const,
              icon: "down" as const,
              symbol: "arrow.down" as const,
              label: t("sidebarPins.moveDown"),
              run: () => pins.step(pin.kind, pin.id, 1),
            },
          ]
        : []),
      ...(toggle === "read"
        ? [
            {
              key: "read" as const,
              icon: "check" as const,
              symbol: "envelope.open" as const,
              label: t("contextMenu.markRead"),
              run: () => markRead(r.channelId),
            },
          ]
        : toggle === "unread"
          ? [
              {
                key: "read" as const,
                icon: "mail" as const,
                symbol: "envelope.badge" as const,
                label: t("contextMenu.markUnread"),
                run: () => markUnread(r.channelId),
              },
            ]
          : []),
      ...(channel && movesChannel(channel, meId, org)
        ? [
            {
              key: "move" as const,
              icon: "list" as const,
              symbol: "folder" as const,
              label: t("channelCategories.move"),
              run: () => router.push(categoryHrefs.pick(channel.id)),
            },
          ]
        : []),
    ];
  };
  const rowMenu = (r: ConversationRow) => {
    const actions = rowActions(r);
    if (actions.length === 0) return;
    const channel = r.kind === "channel" ? channels.find((c) => c.id === r.channelId) : undefined;
    sheet.open(
      <>
        <SheetTitle
          {...(channel ? { leading: <Tile icon="hash" size={40} /> } : {})}
          title={channel ? `#${channel.name}` : r.kind === "dm" ? dir.nameOf(r.with) : ""}
        />
        <ActionList
          items={actions.map((a) => ({
            key: a.key,
            icon: a.icon,
            label: a.label,
            onPress: () => {
              sheet.close();
              a.run();
            },
          }))}
        />
      </>,
    );
  };
  const categoryMenu = (categoryId: string, name: string) => {
    if (!admin) return undefined;
    return () =>
      sheet.open(
        <>
          <SheetTitle title={name} />
          <ActionList
            items={[
              {
                key: "rename",
                icon: "pen",
                label: t("channelCategories.rename"),
                onPress: () => go(categoryHrefs.edit(categoryId)),
              },
              {
                key: "manage",
                icon: "list",
                label: t("mobile.categories.title"),
                hint: t("mobile.categories.manageHint"),
                onPress: () => go(categoryHrefs.manage),
              },
              {
                key: "new",
                icon: "plus",
                label: t("channelCategories.newCategory"),
                onPress: () => go(categoryHrefs.create()),
              },
            ]}
          />
        </>,
      );
  };
  // One function for every render (the rows are memoized), always running the latest menu.
  const latest = useRef({ rowMenu, rowActions });
  latest.current = { rowMenu, rowActions };
  const openRowMenu = useCallback((r: ConversationRow) => latest.current.rowMenu(r), []);
  const rowActionsOf = useCallback((r: ConversationRow) => latest.current.rowActions(r), []);
  return { openRowMenu, rowActionsOf, categoryMenu };
}

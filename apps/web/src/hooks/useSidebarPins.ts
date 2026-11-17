import {
  type SidebarPins,
  useAgentGroups,
  useChannels,
  useDms,
  useSetSidebarView,
  useSidebarView,
} from "@agenteschat/client";
import { groupOf } from "@agenteschat/client/lib/agent-groups";
import { hiddenAgentIds } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { dayOnePins, type PinKind, pinsOf, placePin, stepPin, togglePin } from "@agenteschat/client/lib/sidebar-view";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { useDirectory } from "./useDirectory";

/**
 * "Fixar no topo" (pins inside each sidebar section): what is pinned (on day one the person's own agents), the menu
 * items that pin or unpin a row and move a pinned one among the others, and `place` for a dragged pinned row. Saved
 * per person (`…/me/sidebar/view`): the order of the pinned rows is the person's own, never the workspace's (ADR 0083,
 * addendum of 2026-11-15).
 */
export function useSidebarPins() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const view = useSidebarView(org.id);
  const setView = useSetSidebarView(org.id);
  const dir = useDirectory(org.id);
  const dms = useDms(org.id).data;
  const groups = useAgentGroups(org.id).data;
  const channels = useChannels(org.id).data;
  const hidden = hiddenAgentIds(org, dir.agents);
  const listed = dir.agents.filter((a) => !hidden.has(a.id));
  const lastActive = new Map<string, string>();
  for (const d of dms ?? [])
    if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
  const dayOne = dayOnePins(
    listed.filter((a) => !isRightHand(a)),
    me.user.id,
    lastActive,
    groups,
  );
  // A pin of something no longer in these lists holds no place.
  const known = {
    agents: listed.map((a) => a.id),
    channels: channels?.filter((c) => c.isMember).map((c) => c.id),
    people: dir.members.map((m) => m.userId),
  };
  const pins = pinsOf(view, dayOne, known);
  // Every change starts from the saved pins as they are now (day one's included).
  const save = (change: (from: SidebarPins) => SidebarPins | null) =>
    setView((now) => {
      const from = pinsOf(now, dayOne, known);
      return { ...now, pins: change(from) ?? from };
    });
  const toggle = (kind: PinKind, id: string) => {
    if (!togglePin(pins, kind, id)) {
      toast.show(t(`sidebarPins.full.${kind}`), "info");
      return;
    }
    save((from) => togglePin(from, kind, id));
  };
  // The pinned rows shown with this one: an agent's setor's (`splitPinned` puts a pin on top of its own setor).
  const shownWith = (kind: PinKind, id: string) => {
    if (kind !== "agents") return pins[kind];
    const group = groupOf(groups, id)?.id;
    return pins.agents.filter((x) => groupOf(groups, x)?.id === group);
  };
  const step = (kind: PinKind, id: string, by: -1 | 1): MenuEntry[] =>
    stepPin(pins, kind, id, by, shownWith(kind, id))
      ? [
          {
            kind: "item",
            id: by < 0 ? "pin-up" : "pin-down",
            label: t(by < 0 ? "sidebarPins.moveUp" : "sidebarPins.moveDown"),
            icon: by < 0 ? "arrowUp" : "arrowDown",
            run: () => save((from) => stepPin(from, kind, id, by, shownWith(kind, id))),
          },
        ]
      : [];
  return {
    view,
    setView,
    pins,
    isPinned: (kind: PinKind, id: string) => pins[kind].includes(id),
    toggle,
    /** A dragged pinned row dropped before another pinned one (`before`), or last (null). */
    place: (kind: PinKind, id: string, before: string | null) => {
      if (placePin(pins, kind, id, before)) save((from) => placePin(from, kind, id, before));
    },
    /**
     * "Fixar no topo" / "Tirar do topo" for a row's menus, and on a pinned row "Mover para cima" / "Mover para baixo"
     * among the pinned rows shown with it: the keyboard's way to what dragging does.
     */
    entries: (kind: PinKind, id: string): MenuEntry[] => [
      {
        kind: "item",
        id: "pin",
        label: pins[kind].includes(id) ? t("sidebarPins.unpin") : t("sidebarPins.pin"),
        icon: "pin",
        run: () => toggle(kind, id),
      },
      ...step(kind, id, -1),
      ...step(kind, id, 1),
    ],
  };
}

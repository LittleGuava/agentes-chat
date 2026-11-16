import {
  type SidebarPins,
  useAgentGroups,
  useChannels,
  useDms,
  useSetSidebarView,
  useSidebarView,
} from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { dayOnePins, type PinKind, pinsOf, stepPin, togglePin } from "@agenteschat/client/lib/sidebar-view";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";

/**
 * "Fixar no topo", the web sidebar's pins on the phone: the same per-person pins (`…/me/sidebar/view`), on top of
 * Conversas' Agentes, Canais and Pessoas and of Agentes' Livres. Day one, the person's own agents. A pinned row moves
 * one place at a time among its section's pins (`step`): the person's own order, on every device (ADR 0083, addendum
 * of 2026-11-15).
 */
export function usePins(): {
  pins: SidebarPins;
  /** The person chose these pins (false: day one's default, the agents they made, nothing they did). */
  chosen: boolean;
  isPinned: (kind: PinKind, id: string) => boolean;
  toggle: (kind: PinKind, id: string) => void;
  /** Whether a pinned row can move one place up (-1) or down (1) among its section's pins. */
  canStep: (kind: PinKind, id: string, by: -1 | 1) => boolean;
  step: (kind: PinKind, id: string, by: -1 | 1) => void;
} {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const toast = useToast();
  const dir = useDirectory();
  const dms = useDms(orgId).data;
  const groups = useAgentGroups(orgId).data;
  const channels = useChannels(orgId).data;
  const view = useSidebarView(orgId);
  const setView = useSetSidebarView(orgId);
  const lastActive = new Map<string, string>();
  for (const d of dms ?? [])
    if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
  const listed = dir.agents.filter((a) => listsAgent(org, a));
  const dayOne = meId
    ? dayOnePins(
        listed.filter((a) => !isRightHand(a)),
        meId,
        lastActive,
        groups,
      )
    : [];
  // A pin of something no longer in these lists holds no place.
  const known = {
    agents: listed.map((a) => a.id),
    channels: channels?.filter((c) => c.isMember).map((c) => c.id),
    people: [...dir.memberById.keys()],
  };
  const pins = pinsOf(view, dayOne, known);
  // Every change starts from the saved pins as they are now (day one's included).
  const save = (change: (from: SidebarPins) => SidebarPins | null) =>
    setView((now) => {
      const from = pinsOf(now, dayOne, known);
      return { ...now, pins: change(from) ?? from };
    });
  return {
    pins,
    chosen: view.pins != null,
    isPinned: (kind, id) => pins[kind].includes(id),
    toggle: (kind, id) => {
      if (!togglePin(pins, kind, id)) {
        toast({ title: t(`sidebarPins.full.${kind}`), icon: "pin" });
        return;
      }
      save((from) => togglePin(from, kind, id));
    },
    canStep: (kind, id, by) => stepPin(pins, kind, id, by) !== null,
    step: (kind, id, by) => save((from) => stepPin(from, kind, id, by)),
  };
}

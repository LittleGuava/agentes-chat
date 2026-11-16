import { useOwnOrder, useSetOwnOrder } from "@agenteschat/client";
import { inOwnOrder, type OwnOrderKind, placeInOwnOrder, stepInOwnOrder } from "@agenteschat/client/lib/own-order";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";

/**
 * "Usar a minha ordem" (ADR 0080, addendum of 2026-11-16): off, every section reads as everyone's (`arrange` gives the
 * base back as is) and nothing here offers a move. On, each section's rows that aren't pinned show in the person's
 * order, they drag among themselves (`place`) and their menus move them (`entries`); `shown` is always the section's
 * ids as the person sees them now. Saved per person (`…/me/sidebar/own-order`): no one else's sidebar changes.
 */
export function useSidebarOwnOrder() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const own = useOwnOrder(org.id);
  const setOwn = useSetOwnOrder(org.id);
  const save = (kind: OwnOrderKind, change: (order: string[]) => string[] | null) =>
    setOwn((now) => ({ ...now, [kind]: change(now[kind]) ?? now[kind] }));
  const step = (kind: OwnOrderKind, shown: readonly string[], id: string, by: -1 | 1): MenuEntry[] =>
    stepInOwnOrder(own[kind], shown, id, by)
      ? [
          {
            kind: "item",
            id: by < 0 ? "own-up" : "own-down",
            label: t(by < 0 ? "sidebarPins.moveUp" : "sidebarPins.moveDown"),
            icon: by < 0 ? "arrowUp" : "arrowDown",
            run: () => save(kind, (order) => stepInOwnOrder(order, shown, id, by)),
          },
        ]
      : [];
  return {
    on: own.on,
    setOn: (on: boolean) => setOwn((now) => ({ ...now, on })),
    arrange: <T>(kind: OwnOrderKind, base: readonly T[], idOf: (item: T) => string): T[] =>
      own.on ? inOwnOrder(base, own[kind], idOf) : [...base],
    place: (kind: OwnOrderKind, shown: readonly string[], id: string, before: string | null) => {
      if (own.on && placeInOwnOrder(own[kind], shown, id, before))
        save(kind, (order) => placeInOwnOrder(order, shown, id, before));
    },
    entries: (kind: OwnOrderKind, shown: readonly string[] | undefined, id: string): MenuEntry[] =>
      own.on && shown ? [...step(kind, shown, id, -1), ...step(kind, shown, id, 1)] : [],
  };
}

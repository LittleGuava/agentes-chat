import type { TFunction } from "i18next";
import { namesText } from "./format";

/**
 * Who else has a conversation open (ADR 0084 addendum 2026-11-15), as its header shows them: a few faces, a count of
 * the rest, and every name (up to `NAMES_IN_TIP`) in the tip.
 */

/** Faces in the header before "+N". */
export const VIEWER_FACES = 3;
/** Names the tip says before "and N more". */
export const NAMES_IN_TIP = 8;

export interface ViewersShown {
  faces: { id: string; name: string }[];
  /** Viewers past the faces. */
  more: number;
  /** "Here now: Ana, Bruno and 2 more"; empty with nobody. */
  label: string;
}

/**
 * `ids` in the order they opened it (`GET …/viewers`). Someone the app doesn't know yet (the people still loading, a
 * person who just joined) is left out until the people list has them.
 */
export function viewersShown(
  ids: readonly string[],
  nameOf: (id: string) => string | undefined,
  t: TFunction,
  max = VIEWER_FACES,
): ViewersShown {
  const known = ids.flatMap((id) => {
    const name = nameOf(id);
    return name ? [{ id, name }] : [];
  });
  if (known.length === 0) return { faces: [], more: 0, label: "" };
  const names = namesText(
    t,
    known.map((p) => p.name),
    NAMES_IN_TIP,
  );
  return {
    faces: known.slice(0, max),
    more: Math.max(0, known.length - max),
    label: t("channel.viewers", { names }),
  };
}

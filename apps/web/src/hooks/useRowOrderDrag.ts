import { type DragEvent, useState } from "react";

const ROW_DRAG = "application/x-agentes-row-order";

/**
 * Dragging a row among the rows shown with it (`shownWith(id)`: its section's ids, in order) into the person's own
 * order, saved by `place` (before another of those rows, or last with null): the pinned rows (ADR 0083, addendum of
 * 2026-11-15), and with "Usar a minha ordem" every section's rows (ADR 0080, addendum of 2026-11-16). Never the
 * workspace's order: a row drops only on a row of its own section, and the workspace's drags (a channel, a category,
 * an agent) pass over these rows to their section as before.
 */
export function useRowOrderDrag(
  shownWith: (id: string) => readonly string[],
  place: (id: string, before: string | null, shown: readonly string[]) => void,
) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [mark, setMark] = useState<{ id: string; where: "before" | "after" } | null>(null);
  const end = () => {
    setDragging(null);
    setMark(null);
  };
  // Over a row of another section, or no drag of ours: not ours to take.
  const takes = (id: string) => dragging !== null && shownWith(id).includes(dragging);
  return (id: string) => ({
    draggable: shownWith(id).length > 1,
    "data-drop": mark?.id === id ? mark.where : undefined,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = "move";
      // Firefox starts a drag only with some data set. Not text, or a text field it's dropped on types the id.
      e.dataTransfer.setData(ROW_DRAG, id);
      setDragging(id);
    },
    onDragEnd: end,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!takes(id)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (id === dragging) return mark && setMark(null);
      const r = e.currentTarget.getBoundingClientRect();
      const where = e.clientY > r.top + r.height / 2 ? "after" : "before";
      if (mark?.id !== id || mark.where !== where) setMark({ id, where });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!takes(id) || dragging === null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = dragging;
      const m = mark;
      const shown = shownWith(id);
      end();
      if (m) place(from, m.where === "before" ? m.id : (shown[shown.indexOf(m.id) + 1] ?? null), shown);
    },
  });
}

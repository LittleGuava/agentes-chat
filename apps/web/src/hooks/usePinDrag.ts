import { type DragEvent, useState } from "react";

const PIN_DRAG = "application/x-agentes-pin";

/**
 * Dragging a pinned row among its section's pinned rows (`ids`, in order): the person's own order, saved with their
 * pins by `place` (before another pinned row, or last with null), never the workspace's (ADR 0083, addendum of
 * 2026-11-15). A drag of its own: a pinned row drops only on the pinned rows beside it, and the workspace's drags (a
 * channel, an agent) pass over the pinned rows to their section as before.
 */
export function usePinDrag(ids: readonly string[], place: (id: string, before: string | null) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [mark, setMark] = useState<{ id: string; where: "before" | "after" } | null>(null);
  const end = () => {
    setDragging(null);
    setMark(null);
  };
  return (id: string) => ({
    draggable: ids.length > 1,
    "data-drop": mark?.id === id ? mark.where : undefined,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = "move";
      // Firefox starts a drag only with some data set. Not text, or a text field it's dropped on types the id.
      e.dataTransfer.setData(PIN_DRAG, id);
      setDragging(id);
    },
    onDragEnd: end,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (id === dragging) return mark && setMark(null);
      const r = e.currentTarget.getBoundingClientRect();
      const where = e.clientY > r.top + r.height / 2 ? "after" : "before";
      if (mark?.id !== id || mark.where !== where) setMark({ id, where });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const from = dragging;
      const m = mark;
      end();
      if (m) place(from, m.where === "before" ? m.id : (ids[ids.indexOf(m.id) + 1] ?? null));
    },
  });
}

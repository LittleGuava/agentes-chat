import { useSearch } from "@agenteschat/client";
import {
  type FindStep,
  findFilters,
  findIdsIn,
  findPosition,
  stepFind,
} from "@agenteschat/client/lib/conversation-find";
import { Button, SearchField } from "@agenteschat/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import "./search.css";

/**
 * Find in the conversation (Ctrl/⌘F, ADR 0123 addendum 2026-11-15): a bar on top of the conversation that searches
 * this channel (or thread) on the server as one types, goes to the newest message found, and steps through the rest:
 * Enter or ↑ to older ones, Shift+Enter or ↓ back to newer, wrapping at either end. The conversation goes to each one
 * as a message link does (`onJump`, paging older history in when it isn't loaded). Esc or × closes it. Ctrl/⌘F again
 * from its field is the browser's own find.
 */
export function FindBar({
  channelId,
  threadId,
  focus,
  jumping,
  onJump,
  onClose,
}: {
  channelId: string;
  /** A thread view: its root message's id. */
  threadId?: string | undefined;
  /** Bumped by each Ctrl/⌘F: the field takes the focus, its words selected. */
  focus: number;
  /** The message the conversation is still paging back to: no other step until it lands. */
  jumping?: string | undefined;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  // Search as one types, a beat after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const search = useSearch(org.id, q, ["message"], findFilters(channelId, q));
  // The last search's hits stay while the next one runs: they are not this one's.
  const settled = Boolean(q) && q === text.trim() && search.isSuccess && !search.isPlaceholderData;
  const served = settled ? (search.data?.length ?? 0) : 0;
  const ids = useMemo(
    () => (settled ? findIdsIn(search.data ?? [], threadId ? { channelId, threadId } : { channelId }) : []),
    [settled, search.data, channelId, threadId],
  );
  // Held by id: the list can change under it (a refetch, a new message found).
  const [current, setCurrent] = useState<string | null>(null);
  const go = (id: string | null) => {
    setCurrent(id);
    if (id) onJump(id);
  };
  // New words found something: to the newest of it, once per search.
  const landedFor = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: lands once when a search's hits arrive
  useEffect(() => {
    if (!settled || landedFor.current === q) return;
    landedFor.current = q;
    go(ids[0] ?? null);
  }, [settled, q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each Ctrl/⌘F, the bar already open or not
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);
  const step = (to: FindStep) => {
    if (jumping || !ids.length) return;
    go(stepFind(ids, current, to));
  };
  const at = findPosition(ids, current, served);
  const status = !q
    ? ""
    : search.isError
      ? t("channel.find.failed")
      : !settled
        ? t("channel.find.searching")
        : !at.total
          ? t("channel.find.none")
          : t(at.more ? "channel.find.positionMore" : "channel.find.position", { at: at.at, total: at.total });
  const label = t("channel.find.label");
  return (
    // Its Esc is its own, from the field or a button: no panel beside it closes, no agent stops.
    <search
      className="find-bar"
      aria-label={label}
      data-esc-own=""
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <SearchField
        ref={input}
        size="sm"
        className="find-bar__field"
        aria-label={label}
        placeholder={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? "newer" : "older");
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            step(e.key === "ArrowUp" ? "older" : "newer");
          }
        }}
      />
      <div className="find-bar__acts">
        <output className="find-bar__status" aria-live="polite">
          {status}
        </output>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="chevronUp"
          aria-label={t("channel.find.older")}
          disabled={!ids.length || Boolean(jumping)}
          onClick={() => step("older")}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="chevronDown"
          aria-label={t("channel.find.newer")}
          disabled={!ids.length || Boolean(jumping)}
          onClick={() => step("newer")}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          aria-label={t("channel.find.close")}
          onClick={onClose}
        />
      </div>
    </search>
  );
}

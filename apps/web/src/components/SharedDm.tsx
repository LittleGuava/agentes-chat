import type { SharedDm, SharedDmLine } from "@agenteschat/client";
import { useChannels } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { dayLabel, formatTime, sentAtLine } from "@agenteschat/client/lib/format";
import { type SharePlace, shareReaders, shareTargetOf } from "@agenteschat/client/lib/shared-dm";
import {
  Avatar,
  Button,
  Card,
  DayDivider,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Locked,
  Message,
  MessageText,
  SearchSelect,
  type SelectOption,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { Fragment, type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./shared-dm.css";

/**
 * "Compartilhar conversa" in the header of a DM with an agent (ADR 0151, addendum 2026-11-15): a read-only copy of the
 * talk as it is now, posted with a note in a channel the person is in or in their DM with a colleague. The dialog
 * says who will read it there and that it can't be taken back; the DM itself stays theirs.
 */
export function ShareDmButton({ channelId, agentName }: { channelId: string; agentName: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="personAdd"
        className="channel__icon"
        aria-label={t("dmShare.action")}
        title={t("dmShare.action")}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={(o) => !o && setOpen(false)}
        title={t("dmShare.title", { name: agentName })}
        description={t("dmShare.description")}
        closeLabel={t("common.close")}
        width={440}
      >
        {open && <ShareDmForm channelId={channelId} agentName={agentName} onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function ShareDmForm({ channelId, agentName, onClose }: { channelId: string; agentName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const id = useId();
  const [place, setPlace] = useState<SharePlace | undefined>();
  const [note, setNote] = useState(() => t("dmShare.noteDefault", { name: agentName }));
  // Where the person talks: channels they joined (not those an administrator only reads), and their colleagues.
  const mine = useMemo(() => (channels.data ?? []).filter((c) => c.isMember && !c.seenAsAdmin), [channels.data]);
  const people = useMemo(() => dir.members.filter((m) => m.userId !== me.user.id), [dir.members, me.user.id]);
  const options = useMemo<SelectOption<SharePlace>[]>(
    () => [
      ...mine.map((c) => ({
        value: `c:${c.id}` as const,
        label: `#${c.name}`,
        group: t("dmShare.channels"),
        leading: <Icon name={c.visibility === "private" ? "lock" : "channel"} size={16} />,
      })),
      ...people.map((p) => ({
        value: `u:${p.userId}` as const,
        label: p.name,
        group: t("dmShare.people"),
        leading: <Avatar size="xs" name={p.name} imageUrl={p.image} />,
      })),
    ],
    [mine, people, t],
  );
  const chosenChannel = place?.startsWith("c:") ? mine.find((c) => c.id === place.slice(2)) : undefined;
  const chosenPerson = place?.startsWith("u:") ? people.find((p) => p.userId === place.slice(2)) : undefined;
  const readers = chosenChannel
    ? shareReaders({ channel: chosenChannel })
    : chosenPerson
      ? shareReaders({ person: chosenPerson })
      : null;
  const share = useMutation({
    mutationFn: (to: SharePlace) => api.dms.share(org.id, channelId, { to: shareTargetOf(to), note: note.trim() }),
    onSuccess: () => {
      toast.show(
        chosenChannel
          ? t("dmShare.sharedIn", { name: chosenChannel.name })
          : t("dmShare.sharedWith", { name: chosenPerson?.name ?? "" }),
        "success",
      );
      onClose();
    },
    onError: (error) => toast.show(errorText(t, error), "error"),
  });
  const ready = Boolean(place) && note.trim().length > 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && place) share.mutate(place);
      }}
    >
      <Locked when={share.isPending}>
        <DialogBody className="shared-dm-form">
          <Field
            label={t("dmShare.where")}
            id={`${id}-where`}
            example={readers ? t(readers.key, readers.params) : null}
          >
            <SearchSelect<SharePlace>
              value={place}
              onValueChange={setPlace}
              options={options}
              placeholder={t("dmShare.wherePlaceholder")}
              labels={{
                search: t("dmShare.search"),
                searchPlaceholder: t("dmShare.search"),
                noResults: t("dmShare.noResults"),
                list: t("dmShare.where"),
              }}
            />
          </Field>
          <Field label={t("dmShare.note")} id={`${id}-note`}>
            <Textarea value={note} rows={2} maxLength={2000} autoGrow onChange={(e) => setNote(e.target.value)} />
          </Field>
        </DialogBody>
      </Locked>
      <DialogFooter note={t("common.cantUndo")}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={share.isPending}>
          {t("dmShare.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The copy on its message: who the talk was with and how long, and Ler, which opens it read only. */
export function SharedDmCard({ shared, sharedAt }: { shared: SharedDm; sharedAt: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t("dmShare.card", { name: shared.agent.name });
  return (
    <Card padded className="shared-dm-card" aria-label={title}>
      <div className="ac-mediarow ac-mediarow--row">
        <span className="ac-mediarow__face">
          <AgentAvatar agentId={shared.agent.id || undefined} size="sm" name={shared.agent.name} state="idle" />
        </span>
        <span className="ac-mediarow__head">
          <b>{title}</b>
        </span>
        <span className="ac-mediarow__body small muted">
          {t("dmShare.lines", { count: shared.count })} · {t("dmShare.copyNote")}
        </span>
        <span className="ac-mediarow__end">
          <Button size="sm" icon="lock" onClick={() => setOpen(true)}>
            {t("dmShare.open")}
          </Button>
        </span>
      </div>
      {open && <SharedDmDialog shared={shared} sharedAt={sharedAt} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function SharedDmDialog({ shared, sharedAt, onClose }: { shared: SharedDm; sharedAt: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const rows: ReactNode[] = [];
  let previous: SharedDmLine | undefined;
  for (const [i, line] of shared.lines.entries()) {
    const day = line.at.slice(0, 10);
    const newDay = previous?.at.slice(0, 10) !== day;
    if (newDay) rows.push(<DayDivider key={`d${i}`}>{dayLabel(t, i18n.language, line.at)}</DayDivider>);
    const agent = line.author.type === "agent";
    const person = agent ? undefined : dir.memberById.get(line.author.id);
    const grouped = !newDay && previous?.author.type === line.author.type && previous.author.id === line.author.id;
    const when = sentAtLine(t, i18n.language, line.at);
    rows.push(
      <Fragment key={`m${i}`}>
        <Message
          agent={agent}
          grouped={grouped}
          avatar={
            agent ? (
              <AgentAvatar agentId={line.author.id || undefined} name={line.author.name} state="idle" />
            ) : (
              <Avatar name={line.author.name} imageUrl={person?.image} />
            )
          }
          author={line.author.name}
          time={formatTime(i18n.language, line.at)}
          meta={line.inThread ? `${when} · ${t("dmShare.inThread")}` : when}
        >
          <MessageText>
            <MessageBody
              body={line.cut ? `${line.body}…` : line.body}
              resolveMention={dir.mentionName}
              mentionTone={dir.mentionTone}
            />
          </MessageText>
        </Message>
      </Fragment>,
    );
    previous = line;
  }
  const readOnly = (
    <span className="ac-iconline">
      <Icon name="lock" size={16} />
      <span>{t("dmShare.copyNote")}</span>
    </span>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("dmShare.card", { name: shared.agent.name })}
      subtitle={`${t("dmShare.lines", { count: shared.count })} · ${sentAtLine(t, i18n.language, sharedAt)}`}
      leading={<AgentAvatar agentId={shared.agent.id || undefined} size="sm" name={shared.agent.name} state="idle" />}
      closeLabel={t("common.close")}
      width={620}
      className="consult-dialog"
    >
      <section
        className="channel__messages consult-dialog__list"
        aria-label={t("dmShare.card", { name: shared.agent.name })}
      >
        {shared.omitted > 0 && <p className="thread-origin">{t("dmShare.omitted", { count: shared.omitted })}</p>}
        {rows}
      </section>
      <DialogFooter bar note={readOnly} />
    </Dialog>
  );
}

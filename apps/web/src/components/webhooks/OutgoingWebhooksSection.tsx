import {
  ApiError,
  type Channel,
  OUTGOING_WEBHOOK_EVENTS,
  type OutgoingWebhook,
  type OutgoingWebhookDelivery,
  type OutgoingWebhookEvent,
  type OutgoingWebhookInput,
  useChannels,
  useCreateOutgoingWebhook,
  useDeleteOutgoingWebhook,
  useOutgoingWebhookDeliveries,
  useOutgoingWebhooks,
  useRotateOutgoingWebhookSecret,
  useTestOutgoingWebhook,
  useUpdateOutgoingWebhook,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { whenAt } from "@agenteschat/client/lib/format";
import { deliveryResult, eventWordKey, webhookState } from "@agenteschat/client/lib/outgoing-webhooks";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  CheckboxPill,
  ChipField,
  type ChipFieldOption,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FormStack,
  Icon,
  Input,
} from "@agenteschat/ui";
import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import "@/pages/routines.css";
import "./webhooks.css";

/*
 * Configurações › Conectores › Webhooks (ADR 0188), administrators only: the workspace's outgoing webhooks, each with
 * its state, Testar, its latest deliveries, a new secret (shown once, like the first), turning it back on after its
 * failures turned it off, and deleting it.
 */

/** The most a workspace keeps (the server's `MAX_OUTGOING_WEBHOOKS`). */
const MAX_WEBHOOKS = 20;

export function OutgoingWebhooksSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useOutgoingWebhooks(org.id);
  const [form, setForm] = useState<OutgoingWebhook | "new" | null>(null);
  /** A secret just made, shown once on its webhook's card. */
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const hooks = list.data;
  const full = (hooks?.length ?? 0) >= MAX_WEBHOOKS;
  const add = (
    <Button variant="primary" icon="plus" disabled={full} onClick={() => setForm("new")}>
      {t("webhooks.new")}
    </Button>
  );

  return (
    <div className="owh">
      {!hooks ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <LoadingList count={2} avatar={false} />
        )
      ) : hooks.length === 0 ? (
        <EmptyState size="panel" icon="send" title={t("webhooks.emptyTitle")} actions={add}>
          {t("webhooks.emptyText")}
        </EmptyState>
      ) : (
        <>
          <div className="ac-acts owh__top">{add}</div>
          {full && <p className="small muted">{t("webhooks.full", { max: MAX_WEBHOOKS })}</p>}
          <div className="owh__list">
            {hooks.map((w) => (
              <WebhookCard
                key={w.id}
                webhook={w}
                secret={secret?.id === w.id ? secret.value : null}
                onSecret={(value) => setSecret({ id: w.id, value })}
                onEdit={() => setForm(w)}
              />
            ))}
          </div>
        </>
      )}
      {form && (
        <WebhookDialog
          webhook={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onCreated={(id, value) => setSecret({ id, value })}
        />
      )}
    </div>
  );
}

type Asking = "secret" | "delete" | null;

function WebhookCard({
  webhook: w,
  secret,
  onSecret,
  onEdit,
}: {
  webhook: OutgoingWebhook;
  secret: string | null;
  onSecret: (value: string) => void;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const channels = useChannels(org.id).data ?? [];
  const update = useUpdateOutgoingWebhook(org.id);
  const remove = useDeleteOutgoingWebhook(org.id);
  const rotate = useRotateOutgoingWebhookSecret(org.id);
  const test = useTestOutgoingWebhook(org.id);
  const [asking, setAsking] = useState<Asking>(null);
  const [open, setOpen] = useState(false);
  const state = webhookState(w);
  const failed = (error: unknown) => toast.show(errorText(t, error, i18n.language));
  const turn = (enabled: boolean) =>
    update.mutate(
      { id: w.id, enabled },
      { onSuccess: () => toast.show(t(enabled ? "webhooks.turnedOn" : "webhooks.turnedOff")), onError: failed },
    );
  const names = w.channelIds.map((id) => `#${channels.find((c) => c.id === id)?.name ?? "?"}`);
  const events = w.events.map((e) => t(eventWordKey(e) ?? "webhooks.event.ping")).join(", ");
  const where = names.length > 0 ? t("webhooks.inChannels", { channels: names.join(", ") }) : null;
  const titleId = useId();

  return (
    <Card className="owh-card" aria-labelledby={titleId}>
      <CardHeader id={titleId} icon="send" title={w.name} subtitle={<span className="owh-card__url">{w.url}</span>} />
      <p className="owh-card__facts small">
        <span className={`owh-state owh-state--${state}`}>{t(`webhooks.state.${state}`)}</span>
        <span>{where ? `${events} ${where}` : events}</span>
        {w.lastSuccessAt && (
          <span className="muted">
            {t("webhooks.lastSuccess", { when: whenAt(t, i18n.language, w.lastSuccessAt) })}
          </span>
        )}
      </p>
      {state === "failures" && (
        <div className="ac-actline">
          <Alert>{t("webhooks.offByFailures", { count: w.consecutiveFailures })}</Alert>
          <Button size="sm" icon="power" loading={update.isPending} onClick={() => turn(true)}>
            {t("webhooks.turnOn")}
          </Button>
        </div>
      )}
      {secret && (
        <div className="owh-card__secret">
          <p className="routine-note small ac-iconline" role="status">
            <Icon name="key" size={14} />
            <span>{t("webhooks.secretOnce")}</span>
          </p>
          <CommandBlock command={secret} copied={t("webhooks.secretCopied")} />
        </div>
      )}
      {asking ? (
        <div className="routine-hook__confirm" role="alert">
          <p className="small">
            {asking === "secret" ? t("webhooks.newSecretBody") : t("webhooks.deleteBody", { name: w.name })}
          </p>
          <div className="routine-hook__actions">
            <Button size="sm" onClick={() => setAsking(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={asking === "secret" ? rotate.isPending : remove.isPending}
              onClick={() =>
                asking === "secret"
                  ? rotate.mutate(w.id, {
                      onSuccess: (done) => {
                        setAsking(null);
                        onSecret(done.secret);
                      },
                      onError: failed,
                    })
                  : remove.mutate(w.id, { onSuccess: () => toast.show(t("webhooks.deleted")), onError: failed })
              }
            >
              {asking === "secret" ? t("webhooks.newSecret") : t("webhooks.delete")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ac-acts owh-card__acts">
          <Button
            size="sm"
            icon="send"
            disabled={!w.enabled}
            loading={test.isPending}
            onClick={() =>
              test.mutate(w.id, {
                onSuccess: () => {
                  setOpen(true);
                  toast.show(t("webhooks.tested"));
                },
                onError: failed,
              })
            }
          >
            {t("webhooks.test")}
          </Button>
          <Button size="sm" icon="edit" onClick={onEdit}>
            {t("webhooks.edit")}
          </Button>
          <Button size="sm" icon="key" onClick={() => setAsking("secret")}>
            {t("webhooks.newSecret")}
          </Button>
          {state === "on" ? (
            <Button size="sm" icon="power" loading={update.isPending} onClick={() => turn(false)}>
              {t("webhooks.turnOff")}
            </Button>
          ) : (
            state === "off" && (
              <Button size="sm" icon="power" loading={update.isPending} onClick={() => turn(true)}>
                {t("webhooks.turnOnAgain")}
              </Button>
            )
          )}
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setAsking("delete")}>
            {t("webhooks.delete")}
          </Button>
        </div>
      )}
      <div className="owh-card__log">
        <Button
          size="sm"
          variant="ghost"
          icon={open ? "chevronUp" : "chevronDown"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {t("webhooks.deliveries")}
        </Button>
        {open && <Deliveries webhookId={w.id} />}
      </div>
    </Card>
  );
}

const NODE_ICON = { ok: "check", pending: "clock", failed: "close", skipped: "dash" } as const;
const NODE_CLASS = { ok: "ok", pending: "running", failed: "failed", skipped: "skipped" } as const;

/** The latest deliveries, newest first: what each was about, how it ended and when. */
function Deliveries({ webhookId }: { webhookId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const log = useOutgoingWebhookDeliveries(org.id, webhookId);
  if (!log.data)
    return log.isError ? (
      <ErrorState error={log.error} onRetry={() => void log.refetch()} />
    ) : (
      <LoadingList count={2} avatar={false} />
    );
  if (log.data.length === 0) return <p className="small muted">{t("webhooks.noDeliveries")}</p>;
  return (
    <ol className="routine-runs" aria-label={t("webhooks.deliveries")}>
      {log.data.map((d) => (
        <DeliveryItem key={d.id} delivery={d} at={(iso) => whenAt(t, i18n.language, iso)} />
      ))}
    </ol>
  );
}

function DeliveryItem({ delivery: d, at }: { delivery: OutgoingWebhookDelivery; at: (iso: string) => string }) {
  const { t } = useTranslation();
  const result = deliveryResult(d);
  const event = eventWordKey(d.event);
  return (
    <li className="routine-runs__item">
      <span className={`routine-runs__node routine-runs__node--${NODE_CLASS[result.tone]}`}>
        <Icon name={NODE_ICON[result.tone]} size={14} />
      </span>
      <span>
        <b>{t(result.key, result.values)}</b>
        <span className="routine-runs__words">
          {[
            event ? t(event) : d.event,
            ...(d.attempts > 1 ? [t("webhooks.attempts", { count: d.attempts })] : []),
          ].join(" · ")}
        </span>
      </span>
      <time dateTime={d.createdAt}>{at(d.createdAt)}</time>
    </li>
  );
}

type FieldName = "name" | "url" | "events" | "channels";

/** Which field a server refusal belongs to, and its words there; null: the form's own line. */
function refusalField(code: string): FieldName | null {
  if (code.startsWith("url.")) return "url";
  if (code === "outgoing_webhook.name") return "name";
  if (code === "outgoing_webhook.no_events" || code === "outgoing_webhook.event") return "events";
  if (code.startsWith("outgoing_webhook.") && code.includes("channel")) return "channels";
  return null;
}

/** An address the server takes: https, with a host. */
function httpsUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/** New webhook, or Edit: its name, its https address, its events and, for messages, its channels. */
function WebhookDialog({
  webhook,
  onClose,
  onCreated,
}: {
  webhook: OutgoingWebhook | null;
  onClose: () => void;
  onCreated: (id: string, secret: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const create = useCreateOutgoingWebhook(org.id);
  const update = useUpdateOutgoingWebhook(org.id);
  const channels = useChannels(org.id).data ?? [];
  const [draft, setDraft] = useState<OutgoingWebhookInput>(() => ({
    name: webhook?.name ?? "",
    url: webhook?.url ?? "",
    events: webhook?.events ?? ["message.posted"],
    channelIds: webhook?.channelIds ?? [],
  }));
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<{ field: FieldName | null; text: string } | null>(null);
  const formId = useId();
  const saving = create.isPending || update.isPending;
  const messages = draft.events.includes("message.posted");

  const local: Partial<Record<FieldName, string>> = {};
  if (!draft.name.trim()) local.name = t("webhooks.form.nameRequired");
  if (!httpsUrl(draft.url)) local.url = t("webhooks.form.urlHttps");
  if (draft.events.length === 0) local.events = t("errors.outgoingWebhook.noEvents");
  if (messages && draft.channelIds.length === 0) local.channels = t("errors.outgoingWebhook.noChannels");
  const errorOf = (f: FieldName) => (tried ? local[f] : undefined) ?? (refusal?.field === f ? refusal.text : undefined);

  const change = (patch: Partial<OutgoingWebhookInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setRefusal(null);
  };
  const toggleEvent = (e: OutgoingWebhookEvent, on: boolean) =>
    change({ events: OUTGOING_WEBHOOK_EVENTS.filter((x) => (x === e ? on : draft.events.includes(x))) });
  const refused = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "";
    const field = refusalField(code);
    const text =
      code === "url.internal"
        ? t("webhooks.form.urlInternal")
        : code === "url.https_required"
          ? t("webhooks.form.urlHttps")
          : errorText(t, error, i18n.language);
    setRefusal({ field, text });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(local).length > 0) return;
    const input = { ...draft, name: draft.name.trim(), url: draft.url.trim() };
    if (webhook)
      update.mutate(
        { id: webhook.id, ...input },
        {
          onSuccess: () => {
            toast.show(t("webhooks.form.saved"));
            onClose();
          },
          onError: refused,
        },
      );
    else
      create.mutate(input, {
        onSuccess: (made) => {
          onCreated(made.webhook.id, made.secret);
          toast.show(t("webhooks.form.created"));
          onClose();
        },
        onError: refused,
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t(webhook ? "webhooks.form.editTitle" : "webhooks.form.newTitle")}
      description={t("webhooks.form.text")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <form id={formId} onSubmit={submit} noValidate>
          <FormStack>
            <Field label={t("webhooks.form.name")} error={errorOf("name")}>
              <Input
                value={draft.name}
                maxLength={100}
                placeholder={t("webhooks.form.namePlaceholder")}
                onChange={(e) => change({ name: e.target.value })}
              />
            </Field>
            <Field
              label={t("webhooks.form.url")}
              error={errorOf("url")}
              example={t("webhooks.form.urlExample")}
              hint={{ name: t("common.about", { label: t("webhooks.form.url") }), text: t("webhooks.form.urlHint") }}
            >
              <Input
                type="url"
                inputMode="url"
                value={draft.url}
                maxLength={2000}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => change({ url: e.target.value })}
              />
            </Field>
            <Field
              group
              label={t("webhooks.form.events")}
              error={errorOf("events")}
              hint={{
                name: t("common.about", { label: t("webhooks.form.events") }),
                text: t("webhooks.form.eventsHint"),
              }}
            >
              <div className="owh-form__events">
                {OUTGOING_WEBHOOK_EVENTS.map((e) => (
                  <CheckboxPill
                    key={e}
                    id={`${formId}-${e}`}
                    checked={draft.events.includes(e)}
                    onCheckedChange={(on) => toggleEvent(e, on)}
                  >
                    {t(eventWordKey(e) ?? "webhooks.event.ping")}
                  </CheckboxPill>
                ))}
              </div>
            </Field>
            <ChannelsField
              channels={channels}
              picked={draft.channelIds}
              required={messages}
              error={errorOf("channels")}
              onChange={(channelIds) => change({ channelIds })}
            />
            {refusal && refusal.field === null && <Alert>{refusal.text}</Alert>}
          </FormStack>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" form={formId} variant="primary" loading={saving} disabled={saving}>
          {t(webhook ? "common.save" : "webhooks.form.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The channels it listens to: required for messages, otherwise they narrow the other events (none: every channel). */
function ChannelsField({
  channels,
  picked,
  required,
  error,
  onChange,
}: {
  channels: Channel[];
  picked: string[];
  required: boolean;
  error: string | undefined;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const icon = (c: Channel) => (c.visibility === "private" ? "lock" : "channel");
  const byId = new Map(channels.map((c) => [c.id, c]));
  const options: ChipFieldOption[] = [...channels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      value: c.id,
      label: `#${c.name}`,
      leading: <Icon name={icon(c)} size={16} />,
      picked: picked.includes(c.id),
    }));
  const label = t("webhooks.form.channels");
  return (
    <Field
      label={label}
      error={error}
      hint={{
        name: t("common.about", { label }),
        text: t(required ? "webhooks.form.channelsHint" : "webhooks.form.channelsOptionalHint"),
      }}
    >
      <ChipField
        tokens={picked.map((id) => {
          const c = byId.get(id);
          const name = c?.name ?? "?";
          return {
            key: id,
            label: name,
            leading: <Icon name={c ? icon(c) : "channel"} size={14} />,
            removeLabel: t("common.removeName", { name: `#${name}` }),
          };
        })}
        onRemove={(id) => onChange(picked.filter((x) => x !== id))}
        placeholder={t(required ? "webhooks.form.addChannel" : "webhooks.form.everyChannel")}
        morePlaceholder={t("webhooks.form.addChannel")}
        options={options}
        onPick={(o) => onChange(o.picked ? picked.filter((x) => x !== o.value) : [...picked, o.value])}
        listLabel={label}
        empty={(query) => (query ? t("webhooks.form.noChannel", { query }) : t("webhooks.form.noChannels"))}
        aria-invalid={error ? true : undefined}
      />
    </Field>
  );
}

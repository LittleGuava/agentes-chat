import type { AgentApiKey, AgentApiKeyInput, Me } from "@agenteschat/client";
import { keys, useAgentApiKeyActions, useAgentApiKeys } from "@agenteschat/client";
import { AGENT_KEY_PLACEHOLDER, agentApiCurl, agentKeyFacts } from "@agenteschat/client/lib/agent-api";
import { errorCode, errorText, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import {
  Alert,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  Select,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { useSignInAgain } from "@/hooks/useSignInAgain";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";
import "@/components/ai-apps.css";

type Validity = "30" | "90" | "365" | "none";
const VALIDITIES: Validity[] = ["30", "90", "365", "none"];
const daysOf = (v: Validity): AgentApiKeyInput["expiresInDays"] => (v === "none" ? null : (Number(v) as 30 | 90 | 365));

/**
 * Configurações → API do agente (ADR 0187): its keys (never a secret), "Criar chave" with the secret once, Revogar,
 * the way into a key's own conversation for whoever made it, and a call to copy with this server's address. Only
 * for who manages the agent (its owner or `manage_agents`), as the server allows.
 */
export function AgentApiCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, viewer } = useAgentEdit();
  const manages = viewer !== "member";
  const list = useAgentApiKeys(org.id, agent.id, manages);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AgentApiKey | null>(null);
  if (!manages) return null;
  const data = list.data;
  return (
    <Card as="section" className="agp-card" aria-labelledby="agp-api">
      <CardHead
        id="agp-api"
        icon="code"
        title={t("agentApi.title")}
        subtitle={t("agentApi.subtitle", { name: agent.name })}
        hint={{
          name: t("common.about", { label: t("agentApi.title") }),
          text: t("agentApi.help", { name: agent.name }),
        }}
        action={
          data && (
            <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
              {t("agentApi.create")}
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <LoadingList count={2} />
      ) : list.isError || !data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {data.keys.length ? (
            <List aria-label={t("agentApi.title")}>
              {data.keys.map((key) => (
                <KeyRow key={key.id} apiKey={key} onRevoke={() => setRevoking(key)} />
              ))}
            </List>
          ) : (
            <span className="small muted">{t("agentApi.empty")}</span>
          )}
          <span className="newag__label">{t("agentApi.example")}</span>
          <CommandBlock
            command={agentApiCurl(data.endpoint, AGENT_KEY_PLACEHOLDER, t("agentApi.sampleMessage"))}
            copied={t("agentApi.exampleCopied")}
            copyLabel={t("agentApi.copyExample")}
          />
        </>
      )}
      {creating && data && <CreateKeyDialog endpoint={data.endpoint} onClose={() => setCreating(false)} />}
      <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}

function KeyRow({ apiKey, onRevoke }: { apiKey: AgentApiKey; onRevoke: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const menu = t("apps.actions", { name: apiKey.name });
  const room = apiKey.roomId;
  return (
    <div className="ac-list__row app-row ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
          <Icon name="key" />
        </span>
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span className="app-row__name">{apiKey.name}</span>
          <code className="small muted">…{apiKey.lastFour}</code>
        </span>
      </span>
      <span className="ac-mediarow__end">
        {/* On the name's line, risen with it, as the apps' rows have it. */}
        <span className="ac-captail ac-captop">
          <Menu
            align="end"
            label={menu}
            trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={menu} />}
          >
            {room && (
              <MenuItem
                icon="message"
                onSelect={() =>
                  void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: room } })
                }
              >
                {t("agentApi.openRoom")}
              </MenuItem>
            )}
            <MenuItem icon="block" danger onSelect={onRevoke}>
              {t("apps.tokens.revoke")}
            </MenuItem>
          </Menu>
        </span>
      </span>
      <span className="ac-mediarow__body small muted">{agentKeyFacts(t, i18n.language, apiKey, me.user.id)}</span>
    </div>
  );
}

/** "Criar chave": a name and how long it lasts; then the secret once, closed only after copying it. */
function CreateKeyDialog({ endpoint, onClose }: { endpoint: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const { create } = useAgentApiKeyActions(org.id, agent.id);
  const [name, setName] = useState("");
  const [validity, setValidity] = useState<Validity>("90");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const qc = useQueryClient();
  const signInAgain = useSignInAgain(qc.getQueryData<Me | null>(keys.me)?.user.email ?? "");
  if (secret) {
    return (
      <Dialog
        open
        // ×, Esc or a press outside before copying would lose the key for good: they ask first.
        onOpenChange={(o) => {
          if (o) return;
          if (copied) onClose();
          else setLeaving(true);
        }}
        title={t("agentApi.createdTitle")}
        closeLabel={t("common.close")}
        width={560}
      >
        <DialogBody className="apps-token">
          <Alert tone="neutral">{t("agentApi.once")}</Alert>
          <CommandBlock
            command={secret}
            copied={t("agentApi.copied")}
            copyLabel={t("agentApi.copy")}
            onCopied={() => setCopied(true)}
          />
          <span className="newag__label">{t("agentApi.example")}</span>
          <CommandBlock
            command={agentApiCurl(endpoint, secret, t("agentApi.sampleMessage"))}
            copied={t("agentApi.exampleCopied")}
            copyLabel={t("agentApi.copyExample")}
            onCopied={() => setCopied(true)}
          />
          {leaving && !copied && <Alert>{t("agentApi.leaveText")}</Alert>}
        </DialogBody>
        <DialogFooter>
          {leaving && !copied && (
            <Button variant="danger" onClick={onClose}>
              {t("apps.tokens.leave")}
            </Button>
          )}
          <Button variant="primary" disabled={!copied} onClick={onClose}>
            {t("apps.tokens.done")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }
  const clean = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentApi.create")}
      description={t("agentApi.help", { name: agent.name })}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean || create.isPending) return;
          setError(null);
          setReauth(false);
          create.mutate(
            { name: clean, expiresInDays: daysOf(validity) },
            {
              onSuccess: (created) => setSecret(created.secret),
              onError: (err) => {
                const stale = errorCode(err) === REAUTH_SIGN_IN;
                setReauth(stale);
                setError(stale ? t("agentApi.reauth") : errorText(t, err));
              },
            },
          );
        }}
      >
        <Locked when={create.isPending}>
          <DialogBody className="apps-token">
            <Field label={t("apps.tokens.name")} id="agp-api-name">
              <Input
                value={name}
                maxLength={60}
                placeholder={t("agentApi.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t("apps.tokens.validity")} id="agp-api-validity">
              <Select
                value={validity}
                onValueChange={(v) => {
                  setValidity(v as Validity);
                  setReauth(false);
                  setError(null);
                }}
                options={VALIDITIES.map((v) => ({ value: v, label: t(`apps.tokens.days.${v}`) }))}
              />
            </Field>
            {error && <Alert>{error}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {reauth ? (
            <Button type="button" variant="primary" onClick={() => void signInAgain()}>
              {t("proof.signInButton")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!clean}>
              {t("agentApi.create")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Revogar: the key stops working at once. */
function RevokeDialog({ apiKey, onClose }: { apiKey: AgentApiKey | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const { revoke } = useAgentApiKeyActions(org.id, agent.id);
  const name = apiKey?.name ?? "";
  return (
    <Dialog
      open={apiKey !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("apps.tokens.revokeTitle", { name })}
      description={t("agentApi.revokeText")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          loading={revoke.isPending}
          disabled={revoke.isPending}
          onClick={() =>
            apiKey &&
            revoke.mutate(apiKey.id, {
              onSuccess: () => {
                toast.show(t("agentApi.revoked"));
                onClose();
              },
            })
          }
        >
          {t("apps.tokens.revoke")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Sites through this computer (ADR 0203): the sites that block servers, which agents of the workspace open through
 * this computer's connection. The person decides here, for each site, which agents (named, even those of other
 * computers, or every agent); the server only reads it.
 */
import {
  ALL_AGENTS,
  RELAY_PROTOCOL,
  type RelayAgent,
  type RunnerRelayGrant,
  relaySite,
} from "@agenteschat/adapters/machine-protocol";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Popover,
  Segmented,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSnapshot, useStore } from "../../app";
import { ControlError } from "../../control/client";
import { type Home, orgName, pairedHomes } from "../../control/store";
import { usePending } from "../../hooks";
import { AgentFace, OrgTile } from "../../ui/bits";
import { PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { listNames } from "../../ui/time";

export function Sites() {
  const { t } = useTranslation();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const [picked, setPicked] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RunnerRelayGrant | null>(null);
  const [pending, run] = usePending<"add" | "remove">();
  const home = homes.find((h) => h.homeId === picked) ?? homes[0];

  if (!home) return <PrefHead title={t("desktop.prefs.sites.title")} lead={t("desktop.prefs.sites.lead")} />;

  const org = orgName(home);
  const sites = home.access?.relay ?? [];
  // A runner from before sites could be lent answers nothing it understands: it asks for an update instead.
  const outdated = (home.status?.protocol ?? 0) < RELAY_PROTOCOL;

  const close = () => {
    if (pending === "add") return;
    setAdding(false);
    setTyped("");
    setError(null);
  };

  const add = async () => {
    const site = relaySite(typed);
    if (!site) return setError(t("desktop.prefs.sites.invalid"));
    try {
      await store.request(home.homeId, { type: "relay.add", site, agents: [] });
      toast(t("desktop.prefs.sites.added", { site }), "globe");
      setAdding(false);
      setTyped("");
      setError(null);
      setOpenFor(site);
    } catch (err) {
      if (err instanceof ControlError && err.code === "invalid_site") setError(t("desktop.prefs.sites.invalid"));
      else toast(t("desktop.common.error"), "alert");
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await store.request(home.homeId, { type: "relay.remove", site: removing.site });
      toast(t("desktop.prefs.sites.removed"));
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
    setRemoving(null);
  };

  return (
    <>
      <PrefHead
        title={t("desktop.prefs.sites.title")}
        lead={t("desktop.prefs.sites.lead")}
        action={
          !outdated && (
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              {t("desktop.prefs.sites.add")}
            </Button>
          )
        }
      />
      {homes.length > 1 && (
        <div className="dk-orgpick">
          <Segmented
            label={t("desktop.prefs.folders.org")}
            value={home.homeId}
            onValueChange={(id) => {
              setPicked(id);
              setOpenFor(null);
            }}
            options={homes.map((h) => ({
              value: h.homeId,
              label: orgName(h),
              mark: <OrgTile logo={h.logo} size="sm" />,
            }))}
          />
        </div>
      )}
      <PrefCard>
        {outdated ? (
          <PrefRow title={t("desktop.prefs.sites.outdatedTitle")} desc={t("desktop.prefs.sites.outdatedBody")} />
        ) : sites.length === 0 ? (
          <PrefRow title={t("desktop.prefs.sites.noneTitle", { org })} desc={t("desktop.prefs.sites.noneBody")} />
        ) : (
          sites.map((g) => (
            <SiteRow
              key={g.site}
              home={home}
              grant={g}
              open={openFor === g.site}
              onOpenChange={(o) => setOpenFor(o ? g.site : null)}
              onRemove={() => setRemoving(g)}
            />
          ))
        )}
      </PrefCard>
      <p className="dk-help dk-under-card">{t("desktop.prefs.sites.how")}</p>

      <Dialog
        open={adding}
        onOpenChange={(o) => !o && close()}
        title={t("desktop.prefs.sites.addTitle")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("add", add);
          }}
        >
          <DialogBody>
            <Field label={t("desktop.prefs.sites.site")} example="example.com" error={error}>
              <Input
                value={typed}
                autoFocus
                maxLength={300}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
              />
            </Field>
          </DialogBody>
          <DialogFooter bar>
            <Button type="button" variant="ghost" disabled={pending === "add"} onClick={close}>
              {t("desktop.common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending === "add"} disabled={!typed.trim()}>
              {t("desktop.prefs.sites.addConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && pending !== "remove" && setRemoving(null)}
        title={t("desktop.prefs.sites.removeTitle", { site: removing?.site ?? "" })}
        description={t("desktop.prefs.sites.removeBody")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" disabled={pending === "remove"} onClick={() => setRemoving(null)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={pending === "remove"} onClick={() => void run("remove", remove)}>
            {t("desktop.common.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function SiteRow({
  home,
  grant,
  open,
  onOpenChange,
  onRemove,
}: {
  home: Home;
  grant: RunnerRelayGrant;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const store = useStore();
  const toast = useToast();
  // Whom the server says this computer may lend to; absent while it hasn't heard (offline since the app started).
  const lendable = home.status?.lendable;
  const every = grant.agents.includes(ALL_AGENTS);
  const named = grant.agents.filter((id) => id !== ALL_AGENTS);
  const known = (id: string): RelayAgent | null => lendable?.find((a) => a.id === id) ?? null;
  // Each change sends the whole list: the next waits for the one before it.
  const [pending, run] = usePending<"agents">();

  const set = async (agents: string[]) => {
    try {
      await store.request(home.homeId, { type: "relay.setAgents", site: grant.site, agents });
    } catch {
      toast(t("desktop.prefs.sites.agentsFailed"), "alert");
    }
  };
  const toggle = (agentId: string, on: boolean) =>
    set(on ? [...new Set([...named, agentId])] : named.filter((id) => id !== agentId));

  const users = named.map((id) => known(id));
  const line = every ? (
    t("desktop.prefs.sites.everyAgent", { org: orgName(home) })
  ) : named.length > 0 ? (
    <>
      <span className="dk-avs">
        {users.map((a, i) =>
          a ? <AgentFace key={a.id} agent={a} size="xs" /> : <Icon key={named[i]} name="agent" size={14} />,
        )}
      </span>
      {listNames(
        users.map((a) => a?.name ?? t("desktop.prefs.sites.unknownAgent")),
        i18n.language,
      )}
    </>
  ) : (
    <span className="dk-faint">{t("desktop.prefs.sites.noAgents")}</span>
  );
  const rowId = (id: string) => `rs-${home.homeId}-${id}-${grant.site}`.replace(/[^\w-]/g, "");

  return (
    <PrefRow
      top
      lead={
        <span className="dk-logo dk-logo--soft">
          <Icon name="globe" size={16} />
        </span>
      }
      title={grant.site}
      desc={<span className="dk-crow__line">{line}</span>}
      end={
        <>
          <Popover
            label={t("desktop.prefs.sites.whoUses", { site: grant.site })}
            side="bottom"
            align="end"
            open={open}
            onOpenChange={onOpenChange}
            trigger={
              <Button size="sm" icon="members">
                {t("desktop.prefs.sites.agents")}
              </Button>
            }
          >
            <div className="dk-drop">
              <div className="dk-drop__cap">{t("desktop.prefs.sites.whoUses", { site: grant.site })}</div>
              <label htmlFor={rowId("every")} className="dk-drop__row">
                <Checkbox
                  id={rowId("every")}
                  checked={every}
                  disabled={pending !== null}
                  onCheckedChange={(on) => void run("agents", () => set(on ? [ALL_AGENTS] : []))}
                />
                <b>{t("desktop.prefs.sites.every")}</b>
              </label>
              <div className="dk-drop__list">
                {!lendable && <p className="dk-help dk-drop__empty">{t("desktop.prefs.sites.offline")}</p>}
                {lendable?.length === 0 && (
                  <p className="dk-help dk-drop__empty">
                    {t("desktop.prefs.sites.noLendable", { org: orgName(home) })}
                  </p>
                )}
                {lendable?.map((a) => (
                  <label key={a.id} htmlFor={rowId(a.id)} className="dk-drop__row">
                    <Checkbox
                      id={rowId(a.id)}
                      checked={every || named.includes(a.id)}
                      disabled={every || pending !== null}
                      onCheckedChange={(on) => void run("agents", () => toggle(a.id, on))}
                    />
                    <AgentFace agent={a} size="xs" />
                    <span className="dk-drop__who">
                      <b>{a.name}</b>
                      {a.machine && <small>{a.machine}</small>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </Popover>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="close"
            aria-label={t("desktop.prefs.sites.removeLabel", { site: grant.site })}
            onClick={onRemove}
          />
        </>
      }
    />
  );
}

import { useAddSidebarLink, useRemoveSidebarLink, useSidebarLinks } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  SIDEBAR_LINK_LIMIT,
  SIDEBAR_LINK_TITLE_MAX,
  sidebarLinkInput,
  sidebarLinkShown,
  sidebarLinkUrl,
} from "@agenteschat/client/lib/sidebar-links";
import { Button, Field, Icon, Input } from "@agenteschat/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

/**
 * The person's own links under the tools on top of the sidebar (ADR 0083, amendment of 2026-11-15). Each opens in a
 * new tab, never inside the app: most sites refuse to be framed, and the desktop app sends a new window to the
 * system's browser. `display: contents` keeps them rows of the tools' group without counting as its tools.
 */
export function SidebarLinkRows({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const links = useSidebarLinks(orgId).data ?? [];
  if (links.length === 0) return null;
  return (
    <div className="sidebar__links">
      {links.map((link) => (
        <a
          key={link.id}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="sidebar__item"
          title={`${link.title}\n${sidebarLinkShown(link.url)}`}
        >
          <Icon name="link" />
          <span className="sidebar__item-label">{link.title}</span>
          <span className="ac-visually-hidden"> ({t("shell.opensInNewTab")})</span>
          <Icon name="external" size={14} className="sidebar__link-out" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

/** Whether the person has a link in this workspace: a personal workspace shows the tools' block for one. */
export const useHasSidebarLinks = (orgId: string) => (useSidebarLinks(orgId).data?.length ?? 0) > 0;

/**
 * "Links" in "Personalizar a barra lateral": the person's links, each with its remove button, then a name and an
 * address to add one (an address typed without `https://` gets it). Up to `SIDEBAR_LINK_LIMIT`; the form gives way to
 * a line saying so at the limit.
 */
export function SidebarLinksSetup({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const links = useSidebarLinks(orgId).data ?? [];
  const add = useAddSidebarLink(orgId);
  const remove = useRemoveSidebarLink(orgId);
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const full = links.length >= SIDEBAR_LINK_LIMIT;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const url = sidebarLinkUrl(sidebarLinkInput(address));
    if (!url) {
      setAddressError(t("errors.sidebarLink.url"));
      return;
    }
    add.mutate(
      { title: title.trim(), url },
      {
        onSuccess: () => {
          setTitle("");
          setAddress("");
        },
        onError: (error) => setFormError(errorText(t, error)),
      },
    );
  };
  return (
    <>
      <h3 className="sidebar-setup__heading">{t("shell.sidebarSetup.links")}</h3>
      <p className="small muted sidebar-setup__hint">{t("shell.sidebarSetup.linksHint")}</p>
      {links.length > 0 && (
        <ul className="sidebar-setup sidebar-setup--links">
          {links.map((link) => (
            <li key={link.id} className="sidebar-setup__row">
              <span className="settings-row__icon" aria-hidden="true">
                <Icon name="link" size={16} />
              </span>
              <span className="sidebar-setup__link">
                <span className="sidebar-setup__name">{link.title}</span>
                <span className="small muted sidebar-setup__address">{sidebarLinkShown(link.url)}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="trash"
                aria-label={t("shell.sidebarSetup.removeLink", { name: link.title })}
                onClick={() => remove.mutate(link.id, { onError: (error) => toast.show(errorText(t, error), "error") })}
              />
            </li>
          ))}
        </ul>
      )}
      {full ? (
        <p className="small muted">{t("errors.sidebarLink.full", { max: SIDEBAR_LINK_LIMIT })}</p>
      ) : (
        <form className="sidebar-links-form" onSubmit={submit} noValidate>
          <Field label={t("shell.sidebarSetup.linkTitle")}>
            <Input
              value={title}
              maxLength={SIDEBAR_LINK_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label={t("shell.sidebarSetup.linkUrl")}
            example={t("shell.sidebarSetup.linkUrlExample")}
            error={addressError ?? formError}
          >
            <Input
              type="url"
              inputMode="url"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressError(null);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Button type="submit" icon="plus" disabled={!title.trim() || !address.trim()} loading={add.isPending}>
            {t("shell.sidebarSetup.addLink")}
          </Button>
        </form>
      )}
    </>
  );
}

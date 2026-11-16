import { useAnnouncements, useDismissAnnouncement } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/**
 * What the people who run this server tell me (ADR 0056, addendum on announcements): one card each on top of the work
 * area, the operator's words as plain text, its link opened outside the app, and an × that closes it for good.
 */
export function Announcements() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useAnnouncements(org.id).data?.announcements ?? [];
  const dismiss = useDismissAnnouncement(org.id);
  if (list.length === 0) return null;
  return (
    <section className="outages" aria-label={t("announcement.region")}>
      {list.map((a) => (
        // The hold's strip: its words wrap whole, the link on the title's line, the × beside it.
        <div key={a.id} className="outage hold-banner" role="status">
          <span className="outage__text">
            <b>{a.title}</b>
            {a.body && <span className="announcement__body">{a.body}</span>}
          </span>
          {a.link && (
            <span className="outage__acts">
              <Button asChild variant="ghost" size="sm">
                <a href={a.link.url} target="_blank" rel="noopener noreferrer">
                  {a.link.label ?? t("announcement.open")}
                </a>
              </Button>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="close"
            className="outage__close"
            aria-label={t("announcement.dismiss")}
            onClick={() => dismiss.mutate(a.id)}
          />
        </div>
      ))}
    </section>
  );
}

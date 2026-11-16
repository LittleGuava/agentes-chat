import { usePublishedPages, useUnpublishPage } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { copyText } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";

/**
 * A file's public page in Compartilhar (ADR 0211 §6): its address, the version it shows, Copiar link and
 * Despublicar. Nothing while the file has none, or the server publishes no pages.
 */
export function PublishedPageSection({ artifactId }: { artifactId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const pages = usePublishedPages(org.id, artifactId);
  const unpublish = useUnpublishPage(org.id);
  const page = pages.data?.[0];
  if (!page) return null;
  return (
    <section className="share__section" aria-label={t("share.publicPage")}>
      <h3 className="ac-eyebrow">{t("share.publicPage")}</h3>
      <div className="share__row">
        <span className="share__lead">
          <Icon name="audienceEveryone" size={16} />
        </span>
        <span className="share__name">
          {page.url}
          <span className="muted"> · {t("share.publicVersion", { version: page.version })}</span>
        </span>
      </div>
      <p className="small muted share__note">{t("share.publicNote")}</p>
      <div className="ac-acts">
        <Button
          size="sm"
          icon="link"
          disabled={unpublish.isPending}
          onClick={() => void copyText(page.url, () => toast.show(t("share.copied")))}
        >
          {t("share.copyPublicLink")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={unpublish.isPending}
          onClick={() =>
            unpublish.mutate(page.id, {
              onSuccess: () => toast.show(t("share.unpublished"), "success"),
              onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
            })
          }
        >
          {t("share.unpublish")}
        </Button>
      </div>
    </section>
  );
}

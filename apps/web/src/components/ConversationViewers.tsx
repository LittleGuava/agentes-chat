import { useChannelViewers } from "@agenteschat/client";
import { viewersShown } from "@agenteschat/client/lib/viewers";
import { AvatarStack } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useViewersLive } from "@/realtime/context";

/**
 * The people who have this conversation open too (ADR 0084 addendum 2026-11-15): a few faces in its header and every
 * name in the tip. Only for who reads it (`enabled`): anyone else could not subscribe, nor ask.
 */
export function ConversationViewers({ channelId, enabled }: { channelId: string; enabled: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  useViewersLive(org.id, channelId, enabled);
  const ids = useChannelViewers(org.id, channelId, enabled).data ?? [];
  const shown = viewersShown(ids, (id) => dir.memberById.get(id)?.name, t);
  if (!enabled || shown.faces.length === 0) return null;
  return (
    <span className="channel__viewers" role="img" aria-label={shown.label} title={shown.label}>
      <AvatarStack>
        {shown.faces.map((p) => (
          <PersonAvatar key={p.id} id={p.id} name={p.name} size="sm" />
        ))}
      </AvatarStack>
      {shown.more > 0 && <span className="channel__viewers-more">+{shown.more}</span>}
    </span>
  );
}

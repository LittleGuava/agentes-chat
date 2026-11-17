import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./context";
import { keys } from "./keys";
import type { ConversationPlace } from "./types";

/** The model an agent thinks with in one conversation alone (ADR 0032, addendum 2026-11-15). */
export function useConversationModel(orgId: string, agentId: string, place: ConversationPlace, enabled = true) {
  const api = useApi();
  const threadId = place.threadId ?? null;
  return useQuery({
    queryKey: keys.conversationModel(orgId, agentId, place.channelId, threadId),
    queryFn: () => api.agents.conversationModel(orgId, agentId, { channelId: place.channelId, threadId }),
    enabled,
    retry: false,
  });
}

/** Several agents' models in one conversation (the phone's "Modelos nesta conversa"), in the order asked. */
export function useConversationModels(orgId: string, agentIds: readonly string[], place: ConversationPlace) {
  const api = useApi();
  const threadId = place.threadId ?? null;
  return useQueries({
    queries: agentIds.map((agentId) => ({
      queryKey: keys.conversationModel(orgId, agentId, place.channelId, threadId),
      queryFn: () => api.agents.conversationModel(orgId, agentId, { channelId: place.channelId, threadId }),
      retry: false,
    })),
  });
}

/** Another of its models in this conversation, or `null` back to the agent's own. */
export function useSetConversationModel(orgId: string, agentId: string, place: ConversationPlace) {
  const api = useApi();
  const qc = useQueryClient();
  const threadId = place.threadId ?? null;
  return useMutation({
    meta: { silent: true },
    mutationFn: (model: string | null) =>
      api.agents.setConversationModel(orgId, agentId, { channelId: place.channelId, threadId, model }),
    onSuccess: (view) => qc.setQueryData(keys.conversationModel(orgId, agentId, place.channelId, threadId), view),
  });
}

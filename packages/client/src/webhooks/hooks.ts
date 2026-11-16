import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { OutgoingWebhook, OutgoingWebhookDelivery, OutgoingWebhookInput, OutgoingWebhookPatch } from "./types";

/*
 * Outgoing webhooks in the apps (ADR 0188), administrators only. A signing secret comes back once, from creating a
 * webhook or asking for another secret: it lives in the mutation's result only, never in the query cache, and is
 * forgotten as soon as nothing watches it (`gcTime: 0`).
 */

function webhooksOf(api: ApiClient): NonNullable<ApiClient["outgoingWebhooks"]> {
  if (!api.outgoingWebhooks) throw new Error("This server has no outgoing webhooks");
  return api.outgoingWebhooks;
}

export function useOutgoingWebhooks(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.outgoingWebhookList(orgId),
    queryFn: () => webhooksOf(api).list(orgId),
    enabled: enabled && Boolean(orgId) && Boolean(api.outgoingWebhooks),
  });
}

const outcomes = (list: OutgoingWebhookDelivery[]) => list.map((d) => `${d.id}:${d.status}:${d.attempts}`).join();

/**
 * The webhook's latest deliveries, newest first; asked again every few seconds while one is still pending. When the
 * log changed since it was last read (a log not read yet counts as empty), the webhooks are asked again too: the
 * delivery that just ended may be the one that turned its webhook off (ADR 0188 §7), or set its failures back to zero.
 */
export function useOutgoingWebhookDeliveries(orgId: string, webhookId: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  const key = keys.outgoingWebhookDeliveries(orgId, webhookId ?? "");
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const before = qc.getQueryData<OutgoingWebhookDelivery[]>(key);
      const list = await webhooksOf(api).deliveries(orgId, webhookId ?? "");
      if (outcomes(before ?? []) !== outcomes(list))
        void qc.invalidateQueries({ queryKey: keys.outgoingWebhookList(orgId) });
      return list;
    },
    enabled: Boolean(orgId) && Boolean(webhookId) && Boolean(api.outgoingWebhooks),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "pending") ? 3000 : false),
  });
}

function useRefresh(orgId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.outgoingWebhooks(orgId) });
}

export function useCreateOutgoingWebhook(orgId: string) {
  const api = useApi();
  const refresh = useRefresh(orgId);
  return useMutation({
    mutationFn: (input: OutgoingWebhookInput) => webhooksOf(api).create(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

export function useUpdateOutgoingWebhook(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useRefresh(orgId);
  return useMutation({
    mutationFn: ({ id, ...patch }: OutgoingWebhookPatch & { id: string }) => webhooksOf(api).update(orgId, id, patch),
    meta: { silent: true },
    onSuccess: (hook) => {
      qc.setQueryData<OutgoingWebhook[]>(keys.outgoingWebhookList(orgId), (list) =>
        list?.map((w) => (w.id === hook.id ? hook : w)),
      );
      void refresh();
    },
  });
}

export function useDeleteOutgoingWebhook(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useRefresh(orgId);
  return useMutation({
    mutationFn: (id: string) => webhooksOf(api).remove(orgId, id),
    meta: { silent: true },
    onSuccess: (_done, id) => {
      qc.setQueryData<OutgoingWebhook[]>(keys.outgoingWebhookList(orgId), (list) => list?.filter((w) => w.id !== id));
      qc.removeQueries({ queryKey: keys.outgoingWebhookDeliveries(orgId, id) });
      void refresh();
    },
  });
}

/** A new signing secret, shown once: the old one stops signing at once. */
export function useRotateOutgoingWebhookSecret(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (id: string) => webhooksOf(api).rotateSecret(orgId, id),
    meta: { silent: true },
    gcTime: 0,
  });
}

/** Testar: a `ping` down the same path as an event's; the log shows it at once and follows it. */
export function useTestOutgoingWebhook(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => webhooksOf(api).test(orgId, id),
    meta: { silent: true },
    onSuccess: (_queued, id) => void qc.invalidateQueries({ queryKey: keys.outgoingWebhookDeliveries(orgId, id) }),
  });
}

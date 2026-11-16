import { type Message, useEditMessage } from "@agenteschat/client";
import { Button, Dialog, DialogBody, DialogFooter, Field, Locked, Textarea } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";

/**
 * "Editar mensagem" on a message you sent (ADR 0207): its text in a field. `redo` once an agent took it: saving is
 * "Editar e refazer a resposta", the agents that answered answer the new text (the server's only way then).
 */
export function EditMessageDialog({
  message,
  redo,
  onClose,
}: {
  message: Pick<Message, "id" | "body">;
  redo: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const edit = useEditMessage(org.id);
  const [text, setText] = useState(message.body);
  const changed = text.trim() !== "" && text.trim() !== message.body.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("channel.editMessage")}
      closeLabel={t("common.close")}
      unsaved={changed}
      width={480}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!changed) return;
          edit.mutate({ messageId: message.id, body: text.trim(), redo }, { onSuccess: onClose });
        }}
      >
        <Locked when={edit.isPending}>
          <DialogBody>
            <Field
              label={t("channel.editLabel")}
              id={`edit-${message.id}`}
              hint={
                redo
                  ? { name: t("common.about", { label: t("channel.editRedo") }), text: t("channel.editRedoHint") }
                  : undefined
              }
            >
              <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!changed || edit.isPending} loading={edit.isPending}>
            {t(redo ? "channel.editRedo" : "channel.editSave")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

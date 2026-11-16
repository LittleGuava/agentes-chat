import { Button, Dialog, DialogBody, DialogFooter, Field, InfoHint, Segmented, Switch } from "@agenteschat/ui";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { useOrg } from "@/components/org-context";

/** What "Exportar conversa" exports: a channel or DM, or one of its threads. */
export interface ExportTarget {
  channelId: string;
  threadId?: string;
}

type Format = "markdown" | "json";

/**
 * "Exportar conversa" (ADR 0055 addendum 2026-11-15): Markdown or JSON, with its files in a zip when asked. The server
 * checks who reads it and names the file; the browser only saves what comes back.
 */
export function ConversationExportDialog({ target, onClose }: { target: ExportTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const [format, setFormat] = useState<Format>("markdown");
  const [files, setFiles] = useState(false);
  const url = api.transcripts?.url;
  const download = () => {
    if (!target || !url) return;
    fileSaver.save(url(org.id, target.channelId, { format, threadId: target.threadId, files }), "");
    onClose();
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t(target?.threadId ? "transcript.titleThread" : "transcript.title")}
      closeLabel={t("common.close")}
      width={420}
    >
      <DialogBody>
        <Field label={t("transcript.format")} id="transcript-format">
          <Segmented
            block
            label={t("transcript.format")}
            value={format}
            onValueChange={setFormat}
            options={[
              { value: "markdown", label: "Markdown" },
              { value: "json", label: "JSON" },
            ]}
          />
        </Field>
        <div className="settings-row ac-actrow">
          <span className="settings-row__text ac-actrow__text">
            <span className="ac-hintline">
              <label className="settings-row__label" htmlFor="transcript-files">
                {t("transcript.files")}
              </label>
              <InfoHint id="transcript-files-help" name={t("common.about", { label: t("transcript.files") })}>
                {t("transcript.filesHelp")}
              </InfoHint>
            </span>
          </span>
          <Switch
            id="transcript-files"
            checked={files}
            onCheckedChange={setFiles}
            aria-describedby="transcript-files-help"
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" icon="download" disabled={!url} onClick={download}>
          {t("transcript.download")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const ExportContext = createContext<((target: ExportTarget) => void) | null>(null);

/** Opens "Exportar conversa" for a channel, DM or thread; null outside the workspace shell. */
export const useExportConversation = () => useContext(ExportContext);

/** One export dialog for the workspace: a channel's menu, a DM's person or agent and a thread's "…" open it. */
export function ConversationExportProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const open = useMemo(() => (next: ExportTarget) => setTarget(next), []);
  return (
    <ExportContext.Provider value={open}>
      {children}
      <ConversationExportDialog target={target} onClose={() => setTarget(null)} />
    </ExportContext.Provider>
  );
}

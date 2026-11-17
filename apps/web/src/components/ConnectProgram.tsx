import type { ProgramComputer } from "@agenteschat/client";
import { useCatalog, useCustomServerAction } from "@agenteschat/client";
import { type ConnectedItem, fromServer } from "@agenteschat/client/lib/connected";
import { errorText } from "@agenteschat/client/lib/errors";
import { commandLine, commandWords, type PastedProgram } from "@agenteschat/client/lib/mcp-paste";
import { Alert, Button, DialogBody, DialogFooter, Field, Input, Locked, OptionList } from "@agenteschat/ui";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/** A program's command, as people are given it. Code, so the same in every language. */
const COMMAND_EXAMPLE = "npx -y @acme/notes-mcp";
const VARIABLE_EXAMPLE = "NOTES_TOKEN";

interface VariableRow {
  id: number;
  name: string;
  value: string;
}

/**
 * "Programa neste computador" (ADR 0215): a stdio MCP server started on a computer the person connected, under its
 * Commands switch and command rules. The command line, then the variables by name, their values typed as secrets and
 * never shown again. Connected, it is a server whose tools wait for a level and that no agent uses until given.
 */
export function ConnectProgram({
  computers,
  pasted,
  choice,
  onConnected,
  onClose,
}: {
  /** The person's computers that can run a program now (at least one). */
  computers: ProgramComputer[];
  /** What a pasted `mcpServers` block or command said, to start from. */
  pasted: PastedProgram | null;
  /** How the server is reached (address or program), above the form. */
  choice: ReactNode;
  onConnected: (item: ConnectedItem) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  const { connectProgram } = useCustomServerAction(org.id);
  const [machineId, setMachineId] = useState(computers[0]?.id ?? "");
  const [line, setLine] = useState(pasted ? commandLine([pasted.command, ...pasted.args]) : "");
  const [label, setLabel] = useState(pasted?.name ?? "");
  const nextId = useRef(1);
  const [rows, setRows] = useState<VariableRow[]>(() =>
    (pasted?.env ?? []).map((v) => ({ id: nextId.current++, name: v.name, value: v.value })),
  );
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const computer = computers.find((c) => c.id === machineId) ?? computers[0];
  const words = commandWords(line);
  const commandError = !touched
    ? undefined
    : words === null
      ? t("connectFlow.program.commandQuote")
      : words.length === 0
        ? t("connectFlow.program.commandMissing")
        : undefined;
  const busy = connectProgram.isPending;

  const submit = () => {
    setTouched(true);
    setFailure(null);
    if (!computer || !words || words.length === 0) return;
    const [command = "", ...args] = words;
    connectProgram.mutate(
      {
        machineId: computer.id,
        command,
        args,
        env: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), value: r.value })),
        ...(label.trim() ? { label: label.trim() } : {}),
      },
      {
        onSuccess: (server) => onConnected(fromServer(server, catalog.data?.connectors ?? [])),
        onError: (error) => setFailure(errorText(t, error, i18n.language)),
      },
    );
  };
  const set = (id: number, patch: Partial<VariableRow>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <>
      <Locked when={busy}>
        <DialogBody className="cflow__body">
          {choice}
          <p className="muted cflow__text">{t("connectFlow.program.text")}</p>
          {computers.length > 1 ? (
            <OptionList
              aria-label={t("connectFlow.program.computer")}
              value={machineId}
              onValueChange={setMachineId}
              options={computers.map((c) => ({ value: c.id, title: c.name }))}
            />
          ) : (
            computer && <p className="cflow__text">{t("connectFlow.program.runsOn", { computer: computer.name })}</p>
          )}
          <form
            className="cflow__key"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field
              label={t("connectFlow.program.command")}
              id="cflow-program"
              example={COMMAND_EXAMPLE}
              error={commandError}
            >
              <Input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field label={t("connectFlow.name")} id="cflow-program-name">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("connectFlow.namePlaceholder")}
              />
            </Field>
          </form>
          <div className="cflow__headers">
            <p className="small muted">{t("connectFlow.program.variablesHelp")}</p>
            {rows.length > 0 && (
              <div className="cflow__hgroup">
                <div className="cflow__hrow" aria-hidden="true">
                  <span className="ac-field__label">{t("connectFlow.program.variable")}</span>
                  <span className="ac-field__label">{t("connectFlow.headers.value")}</span>
                </div>
                <ul className="cflow__hrows">
                  {rows.map((row, i) => (
                    <li key={row.id} className="cflow__hrow">
                      <Input
                        value={row.name}
                        placeholder={VARIABLE_EXAMPLE}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-label={t("connectFlow.program.variableOf", { n: i + 1 })}
                        onChange={(e) => set(row.id, { name: e.target.value })}
                      />
                      <Input
                        type="password"
                        value={row.value}
                        autoComplete="off"
                        aria-label={t("connectFlow.program.valueOf", { n: i + 1 })}
                        onChange={(e) => set(row.id, { value: e.target.value })}
                      />
                      <Button
                        variant="ghost"
                        iconOnly
                        icon="close"
                        aria-label={t("connectFlow.program.removeVariable", { n: i + 1 })}
                        onClick={() => setRows(rows.filter((other) => other.id !== row.id))}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="cflow__hadd">
              <Button
                size="sm"
                icon="plus"
                onClick={() => setRows([...rows, { id: nextId.current++, name: "", value: "" }])}
              >
                {t("connectFlow.program.addVariable")}
              </Button>
            </div>
          </div>
          {failure && <Alert>{failure}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter
        bar
        note={
          busy && computer
            ? t("connectFlow.program.starting", { computer: computer.name })
            : t("connectFlow.program.note")
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={busy} loading={busy} onClick={submit}>
          {t("connectFlow.program.add")}
        </Button>
      </DialogFooter>
    </>
  );
}

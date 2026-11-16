import { MY_CHROME_MAX_MINUTES, type MyChromeSession } from "@agenteschat/adapters/machine-protocol";
import { formatTime } from "@agenteschat/client/lib/format";
import { AffixInput, Button, Icon, Select } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../../app";
import { isUnsupported } from "../../control/accounts";
import { ControlError } from "../../control/client";
import { lendBlockers, lendInput } from "../../control/my-chrome";
import type { DesktopStore, Home } from "../../control/store";
import { usePending } from "../../hooks";
import { AgentFace } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";

/** How often the open pane asks who holds the Chrome: a lending ends by itself when its time is up. */
const LIST_MS = 30_000;

/** Each organization's runner that can lend it: its sessions now; a runner too old to lend one is left out. */
type Lendings = Map<string, MyChromeSession[]>;

/**
 * "Your Chrome" (ADR 0202): the person lends one agent the Chrome they started with remote debugging, for a while,
 * and ends it. Never while Commands or a coding program is on in any organization here: such an agent could reach
 * that Chrome itself. Each runner checks it too, and gives the Chrome back once one goes on.
 */
export function LendChrome({ homes }: { homes: readonly Home[] }) {
  const { t, i18n } = useTranslation();
  const store = useStore();
  const toast = useToast();
  const [lendings, setLendings] = useState<Lendings>(new Map());
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [port, setPort] = useState("9222");
  const [minutes, setMinutes] = useState("60");
  const [wrong, setWrong] = useState<"port" | "minutes" | null>(null);
  const [pending, run] = usePending<string>();
  const blockers = lendBlockers(homes);
  // Asked again when who is here or what they allow changes (a switch on gives a lending back), and every LIST_MS.
  const asked = JSON.stringify(homes.map((h) => [h.homeId, h.access?.tools ?? null, h.status?.agents.length ?? 0]));
  const [listed, setListed] = useState(0);
  const load = () => setListed((n) => n + 1);
  useEffect(() => {
    const id = setInterval(() => setListed((n) => n + 1), LIST_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let live = true;
    const homeIds = (JSON.parse(asked) as [string][]).map(([homeId]) => homeId);
    void listLendings(store, homeIds, listed).then((next) => live && setLendings(next));
    return () => {
      live = false;
    };
  }, [asked, listed, store]);

  const agents = homes.flatMap((h) =>
    lendings.has(h.homeId) ? (h.status?.agents ?? []).map((a) => ({ home: h, agent: a })) : [],
  );
  if (agents.length === 0) return null;
  const key = (homeId: string, agentId: string) => `${homeId}:${agentId}`;
  const picked = agents.find((a) => key(a.home.homeId, a.agent.id) === chosen) ?? agents[0];
  const held = agents.flatMap(({ home, agent }) =>
    (lendings.get(home.homeId) ?? [])
      .filter((s) => s.agentId === agent.id)
      .map((session) => ({ home, agent, session })),
  );
  const at = (iso: string) => formatTime(i18n.language, iso);

  const lend = () =>
    run("lend", async () => {
      if (!picked) return;
      const input = lendInput(port, minutes);
      if ("error" in input) return setWrong(input.error);
      setWrong(null);
      try {
        const { session } = await store.request(picked.home.homeId, {
          type: "mychrome.connect",
          agentId: picked.agent.id,
          port: input.port,
          minutes: input.minutes,
        });
        toast(t("desktop.myChrome.lent", { agent: picked.agent.name, time: at(session.expiresAt) }), "globe");
      } catch (err) {
        const code = err instanceof ControlError ? err.code : null;
        toast(
          code === "not_allowed"
            ? t("desktop.myChrome.blocked")
            : code === "internal"
              ? t("desktop.myChrome.noAnswer", { port: input.port })
              : t("desktop.common.error"),
          "alert",
        );
      }
      load();
    });
  const end = (home: Home, agentId: string) =>
    run(`end:${agentId}`, async () => {
      try {
        await store.request(home.homeId, { type: "mychrome.disconnect", agentId });
      } catch {
        toast(t("desktop.common.error"), "alert");
      }
      load();
    });

  const lendName = t("desktop.myChrome.lendName");
  return (
    <>
      <CardTitle>{t("desktop.myChrome.title")}</CardTitle>
      <PrefCard>
        <PrefRow
          lead={
            <span className="dk-logo">
              <Icon name="globe" size={16} />
            </span>
          }
          title={lendName}
          hint={hintFor(t, lendName, t("desktop.myChrome.lendAbout"))}
          under={
            blockers.length > 0 ? (
              <p className="dk-help" role="status">
                {t("desktop.myChrome.blocked")}
              </p>
            ) : (
              <form
                className="dk-inline-form dk-lend"
                onSubmit={(e) => {
                  e.preventDefault();
                  void lend();
                }}
              >
                <Select
                  aria-label={t("desktop.myChrome.agent")}
                  value={picked ? key(picked.home.homeId, picked.agent.id) : undefined}
                  onValueChange={setChosen}
                  options={agents.map(({ home, agent }) => ({
                    value: key(home.homeId, agent.id),
                    label: agent.name,
                    leading: <AgentFace agent={agent} size="xs" />,
                  }))}
                />
                <AffixInput
                  className="dk-lend__port"
                  prefix={t("desktop.myChrome.port")}
                  inputMode="numeric"
                  aria-label={t("desktop.myChrome.port")}
                  invalid={wrong === "port"}
                  value={port}
                  maxLength={5}
                  onChange={(e) => setPort(e.target.value)}
                />
                <AffixInput
                  className="dk-lend__minutes"
                  prefix={t("desktop.myChrome.minutes")}
                  inputMode="numeric"
                  aria-label={t("desktop.myChrome.minutes")}
                  invalid={wrong === "minutes"}
                  value={minutes}
                  maxLength={3}
                  onChange={(e) => setMinutes(e.target.value)}
                />
                <Button type="submit" variant="primary" loading={pending === "lend"} disabled={pending !== null}>
                  {t("desktop.myChrome.lend")}
                </Button>
                {wrong && (
                  <p className="dk-help" role="alert">
                    {wrong === "port"
                      ? t("desktop.myChrome.badPort")
                      : t("desktop.myChrome.badMinutes", { max: MY_CHROME_MAX_MINUTES })}
                  </p>
                )}
              </form>
            )
          }
        />
        {held.map(({ home, agent, session }) => (
          <PrefRow
            key={key(home.homeId, agent.id)}
            lead={<AgentFace agent={agent} size="sm" />}
            title={agent.name}
            desc={t("desktop.myChrome.until", { time: at(session.expiresAt), port: session.port })}
            end={
              <Button
                size="sm"
                aria-label={t("desktop.myChrome.disconnectOf", { agent: agent.name })}
                loading={pending === `end:${agent.id}`}
                disabled={pending !== null}
                onClick={() => void end(home, agent.id)}
              >
                {t("desktop.myChrome.disconnect")}
              </Button>
            }
          />
        ))}
      </PrefCard>
    </>
  );
}

/**
 * Who holds the Chrome, per organization's runner that can lend one. An older runner (`bad_request`) and one in system
 * mode (`not_allowed`) can't: their agents aren't offered. `_round` only says which asking this is.
 */
async function listLendings(store: DesktopStore, homeIds: readonly string[], _round: number): Promise<Lendings> {
  const next: Lendings = new Map();
  await Promise.all(
    homeIds.map(async (homeId) => {
      try {
        next.set(homeId, (await store.request(homeId, { type: "mychrome.list" })).sessions);
      } catch (err) {
        if (!isUnsupported(err) && !(err instanceof ControlError && err.code === "not_allowed")) next.set(homeId, []);
      }
    }),
  );
  return next;
}

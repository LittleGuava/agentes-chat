import { usePhoneTools, useSetPhoneTools } from "@agenteschat/client";
import * as Device from "expo-device";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Linking, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedList, GroupedRow, useToast } from "@/ui";
import { Page } from "../me/parts";
import { deviceContacts } from "./contacts";
import type { ContactsPermission } from "./contacts-access";
import { consentStep, deviceNameOf, switchOn } from "./logic";

/**
 * Contatos do celular (ADR 0205): this person's consent, for this workspace and this phone, to let the agents they talk
 * to search the phone's contacts. The system's prompt shows only when they turn it on; refused for good, the toast
 * opens the phone's Settings.
 */
export function PhoneToolsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const tools = usePhoneTools(orgId, deviceContacts !== null);
  const save = useSetPhoneTools(orgId);
  const [asking, setAsking] = useState(false);
  // The system's permission here, read on opening and again when the app comes back (from Settings, say).
  const [permission, setPermission] = useState<ContactsPermission | null>(null);
  useEffect(() => {
    const contacts = deviceContacts;
    if (!contacts) return;
    const read = () => void contacts.permission().then(setPermission, () => setPermission(null));
    read();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => appState.remove();
  }, []);
  const on = switchOn(tools.data, permission);
  const failed = () => toast({ title: t("mobile.phoneTools.failed"), icon: "x" });
  const denied = (settings: boolean) =>
    toast({
      title: t("mobile.phoneTools.deniedTitle"),
      subtitle: t("mobile.phoneTools.deniedSub"),
      icon: "phone",
      action: settings
        ? { label: t("mobile.common.openSettings"), onPress: () => void Linking.openSettings() }
        : undefined,
    });
  const turnOn = async () => {
    const contacts = deviceContacts;
    if (!contacts) return;
    let now = await contacts.permission();
    const step = consentStep(now);
    if (step === "settings") return denied(true);
    if (step === "ask") now = await contacts.request();
    setPermission(now);
    if (now.status !== "granted") return denied(!now.canAskAgain);
    save.mutate(
      { tools: ["contacts"], deviceName: deviceNameOf(Device.deviceName, Device.modelName) },
      { onError: failed },
    );
  };
  const toggle = () => {
    if (asking || save.isPending) return;
    if (on) {
      save.mutate({ tools: [], deviceName: deviceNameOf(Device.deviceName, Device.modelName) }, { onError: failed });
      return;
    }
    setAsking(true);
    void turnOn()
      .catch(failed)
      .finally(() => setAsking(false));
  };
  return (
    <Page title={t("mobile.phoneTools.title")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("mobile.phoneTools.contacts")}
          labelLines={2}
          toggle={on}
          disabled={!tools.data || asking || save.isPending}
          onPress={toggle}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.phoneTools.help")}</GroupedFooter>
    </Page>
  );
}

const styles = StyleSheet.create({ gap: { height: 14 } });

import type { TFunction } from "i18next";
import type { AccountSession } from "../api/types";
import { dayLabel } from "./format";

/**
 * How a session of the account reads in the apps (ADR 0006, addendum 2026-11-15): its device's name, its icon, and the
 * line under it (this one, the address it came from, when it was last used).
 */

type Device = AccountSession["device"];

const HANDHELD = new Set(["iPhone", "iPad", "Android", "iOS"]);

/** The kit icon a session shows: a phone or tablet, a computer, or a globe for a device nobody can tell. */
export function sessionIcon(device: Device): "phone" | "computer" | "globe" {
  if (device.kind === "phone_app" || (device.os !== null && HANDHELD.has(device.os))) return "phone";
  return device.kind === "unknown" ? "globe" : "computer";
}

/** "Chrome no Windows", "App do celular no iOS", "macOS", "Dispositivo desconhecido". */
export function sessionDeviceName(t: TFunction, device: Device): string {
  if (device.kind === "phone_app") {
    return device.os
      ? t("settings.account.sessions.phoneAppOn", { os: device.os })
      : t("settings.account.sessions.phoneApp");
  }
  if (device.browser && device.os) {
    return t("settings.account.sessions.browserOn", { browser: device.browser, os: device.os });
  }
  return device.browser ?? device.os ?? t("settings.account.sessions.unknown");
}

/**
 * The line under a session's name: "203.0.113.7 · Último uso: Ontem". This one's says only its address (null without
 * one): its mark ("Esta sessão") stands at the line's end, where the others' Sair is.
 */
export function sessionLine(t: TFunction, locale: string, session: AccountSession, now = new Date()): string | null {
  if (session.current) return session.ip;
  const when = t("settings.account.sessions.lastUsed", { day: dayLabel(t, locale, session.lastActiveAt, now) });
  return [session.ip, when].filter(Boolean).join(" · ");
}

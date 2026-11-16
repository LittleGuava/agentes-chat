import { and, type Database, desc, eq, gt, ne, schema } from "@agenteschat/db";

/**
 * Where an account is signed in (ADR 0006, addendum 2026-11-15): its live sessions, named by the device each one's
 * sign-in came from, and signing one out, or every one but the asking session's. Sessions are named by their id,
 * never by their token. A browser's pushes go with its session (`push_devices.session_id`, ADR 0071).
 */

/** What a session's sign-in says about its device: a browser, the phone app, or nothing we can tell. */
export interface SessionDevice {
  kind: "browser" | "phone_app" | "unknown";
  /** A browser's own name ("Chrome", "Safari"…), when its user agent says. */
  browser: string | null;
  /** The system's own name ("Windows", "iPhone"…), when its user agent says. */
  os: string | null;
}

export interface AccountSession {
  id: string;
  /** The session this request came with. */
  current: boolean;
  device: SessionDevice;
  /** The address it signed in from, as the server saw it (behind `TRUSTED_PROXIES`); null when none was kept. */
  ip: string | null;
  signedInAt: Date;
  /** When it was last renewed: Better Auth moves it at most once a day, so it is a day, not a moment. */
  lastActiveAt: Date;
}

/**
 * The device a user agent names. The phone app's requests carry its HTTP stack's own: CFNetwork on iOS, OkHttp on
 * Android. The desktop app's window sends its system's web view's (WebKit on macOS, Edge on Windows), the same as a
 * browser's, so it shows as one.
 */
export function sessionDevice(userAgent: string | null): SessionDevice {
  const ua = userAgent?.trim() ?? "";
  if (/\bokhttp\//i.test(ua)) return { kind: "phone_app", browser: null, os: "Android" };
  if (/\bCFNetwork\/.*\bDarwin\//.test(ua)) return { kind: "phone_app", browser: null, os: "iOS" };
  const os = osOf(ua);
  const browser = browserOf(ua);
  if (!os && !browser) return { kind: "unknown", browser: null, os: null };
  return { kind: "browser", browser, os };
}

function osOf(ua: string) {
  if (/\biPad\b/.test(ua)) return "iPad";
  if (/\b(iPhone|iPod)\b/.test(ua)) return "iPhone";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\b(Macintosh|Mac OS X)\b/.test(ua)) return "macOS";
  if (/\b(Linux|X11)\b/.test(ua)) return "Linux";
  return null;
}

/** Checked in this order: Edge, Opera and Samsung's browser also say Chrome, and Chrome also says Safari. */
function browserOf(ua: string) {
  if (/\bEdg(A|iOS)?\//.test(ua)) return "Edge";
  if (/\b(OPR|Opera)\//.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\b(Firefox|FxiOS)\//.test(ua)) return "Firefox";
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return "Chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return "Safari";
  return null;
}

/** `userId`'s sessions that still work, `currentId`'s first, then the last used first. */
export async function listAccountSessions(db: Database, userId: string, currentId: string): Promise<AccountSession[]> {
  const rows = await db
    .select({
      id: schema.sessions.id,
      ipAddress: schema.sessions.ipAddress,
      userAgent: schema.sessions.userAgent,
      createdAt: schema.sessions.createdAt,
      updatedAt: schema.sessions.updatedAt,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(desc(schema.sessions.updatedAt), desc(schema.sessions.createdAt));
  const sessions = rows.map((r) => ({
    id: r.id,
    current: r.id === currentId,
    device: sessionDevice(r.userAgent),
    ip: r.ipAddress?.trim() || null,
    signedInAt: r.createdAt,
    lastActiveAt: r.updatedAt,
  }));
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
}

/** Signs `userId`'s session `sessionId` out; false when they have no such session. */
export async function signOutAccountSession(db: Database, userId: string, sessionId: string) {
  const ended = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
    .returning({ id: schema.sessions.id });
  return ended.length > 0;
}

/** Signs out every session of `userId` but `keepId`; how many ended. */
export async function signOutOtherAccountSessions(db: Database, userId: string, keepId: string) {
  const ended = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepId)))
    .returning({ id: schema.sessions.id });
  return ended.length;
}

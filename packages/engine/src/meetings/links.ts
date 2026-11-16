import type { ScreenObservation, ScreenStep } from "../screen";

/**
 * Which meeting links an agent may be sent to, the address it opens, the name it joins with and the steps it takes
 * on the meeting's page (ADR 0199 §3). Pure: the tool and its tests share it.
 */

export const MEETING_PLATFORMS = ["google_meet", "jitsi"] as const;
export type MeetingPlatform = (typeof MEETING_PLATFORMS)[number];

export const MEETING_PLATFORM_NAMES: Record<MeetingPlatform, string> = {
  google_meet: "Google Meet",
  jitsi: "Jitsi Meet",
};

/** How much of a transcript the agent is handed (ADR 0199 §7); past it the start is kept and the cut is said. */
export const MEETING_TRANSCRIPT_MAX_CHARS = 60_000;

export interface MeetingLink {
  platform: MeetingPlatform;
  /** Rebuilt from the parsed parts: never the text the model gave. */
  url: string;
  room: string;
}

export type MeetingLinkResult =
  | { ok: true; link: MeetingLink }
  | { ok: false; reason: "not_a_link" | "not_https" | "not_a_meeting" }
  | { ok: false; reason: "unsupported"; platform: string };

const MEET_HOST = "meet.google.com";
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const JITSI_HOST = "meet.jit.si";
const JITSI_ROOM = /^[A-Za-z0-9_-]{3,128}$/;

/** Meeting services a link may name that the agent can't join yet. */
const UNSUPPORTED: { platform: string; host: (host: string) => boolean }[] = [
  { platform: "Zoom", host: (h) => h === "zoom.us" || h.endsWith(".zoom.us") },
  {
    platform: "Microsoft Teams",
    host: (h) => h === "teams.microsoft.com" || h === "teams.live.com" || h.endsWith(".teams.microsoft.com"),
  },
];

export function parseMeetingLink(raw: string): MeetingLinkResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not_a_link" };
  }
  const host = url.hostname.toLowerCase();
  const unsupported = UNSUPPORTED.find((u) => u.host(host));
  if (unsupported) return { ok: false, reason: "unsupported", platform: unsupported.platform };
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password || url.port) return { ok: false, reason: "not_a_meeting" };
  const segments = url.pathname.split("/").slice(1);
  if (segments.length !== 1) return { ok: false, reason: "not_a_meeting" };
  const [segment = ""] = segments;
  if (host === MEET_HOST) {
    const code = segment.toLowerCase();
    if (!MEET_CODE.test(code)) return { ok: false, reason: "not_a_meeting" };
    return { ok: true, link: { platform: "google_meet", url: `https://${MEET_HOST}/${code}`, room: code } };
  }
  if (host === JITSI_HOST) {
    if (!JITSI_ROOM.test(segment)) return { ok: false, reason: "not_a_meeting" };
    return { ok: true, link: { platform: "jitsi", url: `https://${JITSI_HOST}/${segment}`, room: segment } };
  }
  return { ok: false, reason: "not_a_meeting" };
}

/** What the agent is told when a link is refused. */
export function meetingLinkRefusal(result: Exclude<MeetingLinkResult, { ok: true }>): string {
  switch (result.reason) {
    case "unsupported":
      return `${result.platform} meetings aren't supported yet: only Google Meet and Jitsi Meet (meet.jit.si) links. Tell them so.`;
    case "not_https":
      return "That link isn't https: only https Google Meet and Jitsi Meet links can be joined.";
    case "not_a_link":
      return "That isn't a link. Ask for the meeting's link (https://meet.google.com/abc-defg-hij or https://meet.jit.si/<room>).";
    case "not_a_meeting":
      return "That isn't a meeting's link: only a Google Meet meeting (https://meet.google.com/abc-defg-hij) or a Jitsi Meet room (https://meet.jit.si/<room>) can be joined.";
  }
}

const SUFFIX = " (notes)";
const MAX_NAME = 60;

/** The name it shows in the call: its own, then "(notes)", so everyone sees what the bot is for. */
export function meetingDisplayName(agentName: string): string {
  // Control characters and quotes out: the name goes into a page's field and a URL option.
  const clean = agentName
    .replace(/[\p{Cc}\p{Cf}"'`]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = (clean || "Agent").slice(0, MAX_NAME - SUFFIX.length).trim();
  return `${name}${SUFFIX}`;
}

/** The address opened: Jitsi's room with its options muting microphone and camera and naming the bot. */
export function meetingJoinUrl(link: MeetingLink, displayName: string): string {
  if (link.platform !== "jitsi") return link.url;
  // Jitsi reads each option's value as JSON: the name is a JSON string, then URL-encoded, so it can't add options.
  const options = [
    "config.startWithAudioMuted=true",
    "config.startWithVideoMuted=true",
    `userInfo.displayName=${encodeURIComponent(JSON.stringify(displayName))}`,
  ];
  return `${link.url}#${options.join("&")}`;
}

/**
 * The steps on the meeting's page, stopping at the first that fails. Google Meet: the name box first (a browser
 * signed in to an account has none, so it never joins as a person), microphone and camera off, then ask to join.
 * Jitsi: the room's options already muted them, and a toggle clicked there would turn them on.
 */
export function meetingJoinSteps(link: MeetingLink, displayName: string): ScreenStep[] {
  const open: ScreenStep = { do: "open", url: meetingJoinUrl(link, displayName) };
  switch (link.platform) {
    case "google_meet":
      return [
        open,
        { do: "fill", target: "Your name", text: displayName },
        { do: "click", target: "Turn off microphone" },
        { do: "click", target: "Turn off camera" },
        { do: "click", target: "Ask to join" },
      ];
    case "jitsi":
      return [
        open,
        { do: "fill", target: "Enter your name", text: displayName },
        { do: "click", target: "Join meeting" },
      ];
  }
}

export type MeetingPageState = "waiting" | "in_call" | "refused";

const REFUSED = [/you can.t join this video call/i, /não é possível participar desta videochamada/i];
const IN_CALL = [/\bleave call\b/i, /\bleave meeting\b/i, /sair da chamada/i, /sair da reunião/i];

/** Where the page after the steps says the agent is; anything it doesn't recognize is waiting for the host. */
export function meetingStateOf(page: ScreenObservation | null): MeetingPageState {
  const text = page?.lines.join("\n") ?? "";
  if (REFUSED.some((r) => r.test(text))) return "refused";
  if (IN_CALL.some((r) => r.test(text))) return "in_call";
  return "waiting";
}

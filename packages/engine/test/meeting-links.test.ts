import { describe, expect, test } from "bun:test";
import {
  meetingDisplayName,
  meetingJoinSteps,
  meetingJoinUrl,
  meetingStateOf,
  observeSnapshot,
  parseMeetingLink,
} from "../src";

/** ADR 0199 §3: which links an agent may be sent to, what it opens, and the steps it takes there. */

describe("meeting links", () => {
  test("a Google Meet link opens as its rebuilt address, without what followed the code", () => {
    expect(parseMeetingLink("https://meet.google.com/abc-defg-hij?authuser=1&hs=122#x")).toEqual({
      ok: true,
      link: { platform: "google_meet", url: "https://meet.google.com/abc-defg-hij", room: "abc-defg-hij" },
    });
    expect(parseMeetingLink("  https://MEET.google.com/ABC-DEFG-HIJ  ")).toMatchObject({
      ok: true,
      link: { url: "https://meet.google.com/abc-defg-hij" },
    });
  });

  test("a Jitsi Meet room on meet.jit.si", () => {
    expect(parseMeetingLink("https://meet.jit.si/Weekly_Sync-42")).toEqual({
      ok: true,
      link: { platform: "jitsi", url: "https://meet.jit.si/Weekly_Sync-42", room: "Weekly_Sync-42" },
    });
  });

  test("Zoom and Teams are named as not supported yet", () => {
    expect(parseMeetingLink("https://us02web.zoom.us/j/123456789?pwd=x")).toEqual({
      ok: false,
      reason: "unsupported",
      platform: "Zoom",
    });
    expect(parseMeetingLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting")).toEqual({
      ok: false,
      reason: "unsupported",
      platform: "Microsoft Teams",
    });
  });

  test("anything else is refused: not https, a look-alike host, a credential, a port, a page that isn't a meeting", () => {
    const reason = (raw: string) => {
      const r = parseMeetingLink(raw);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason("http://meet.google.com/abc-defg-hij")).toBe("not_https");
    expect(reason("not a link")).toBe("not_a_link");
    expect(reason("https://meet.google.com.evil.example/abc-defg-hij")).toBe("not_a_meeting");
    expect(reason("https://evilmeet.google.com/abc-defg-hij")).toBe("not_a_meeting");
    expect(reason("https://user:pass@meet.google.com/abc-defg-hij")).toBe("not_a_meeting");
    expect(reason("https://meet.google.com:8443/abc-defg-hij")).toBe("not_a_meeting");
    expect(reason("https://meet.google.com/new")).toBe("not_a_meeting");
    expect(reason("https://meet.google.com/lookup/team-standup")).toBe("not_a_meeting");
    expect(reason("https://meet.google.com/abc-defg-hij/extra")).toBe("not_a_meeting");
    expect(reason("https://meet.jit.si/")).toBe("not_a_meeting");
    expect(reason("https://meet.jit.si/a/b")).toBe("not_a_meeting");
    expect(reason("https://meet.jit.si/room%22name")).toBe("not_a_meeting");
    expect(reason("https://example.com/abc-defg-hij")).toBe("not_a_meeting");
  });
});

describe("the name it joins with", () => {
  test("the agent's name with (notes), cleaned of quotes and control characters, never longer than 60", () => {
    expect(meetingDisplayName("Ada")).toBe("Ada (notes)");
    expect(meetingDisplayName('Ada "the" \u0007Bot')).toBe("Ada the Bot (notes)");
    const long = meetingDisplayName("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(" (notes)")).toBe(true);
    expect(meetingDisplayName("   ")).toBe("Agent (notes)");
  });

  test("Jitsi gets its muted options and the name in the fragment, encoded so a name can't add options", () => {
    const link = { platform: "jitsi" as const, url: "https://meet.jit.si/Room1", room: "Room1" };
    const url = meetingJoinUrl(link, "Ada & co=1 (notes)");
    const [base, fragment = ""] = url.split("#");
    expect(base).toBe("https://meet.jit.si/Room1");
    const options = fragment.split("&");
    expect(options).toEqual([
      "config.startWithAudioMuted=true",
      "config.startWithVideoMuted=true",
      `userInfo.displayName=${encodeURIComponent(JSON.stringify("Ada & co=1 (notes)"))}`,
    ]);
    const meet = {
      platform: "google_meet" as const,
      url: "https://meet.google.com/abc-defg-hij",
      room: "abc-defg-hij",
    };
    expect(meetingJoinUrl(meet, "Ada (notes)")).toBe("https://meet.google.com/abc-defg-hij");
  });
});

describe("the join steps", () => {
  test("Google Meet: the name first, microphone and camera off, then ask to join", () => {
    const link = {
      platform: "google_meet" as const,
      url: "https://meet.google.com/abc-defg-hij",
      room: "abc-defg-hij",
    };
    expect(meetingJoinSteps(link, "Ada (notes)")).toEqual([
      { do: "open", url: "https://meet.google.com/abc-defg-hij" },
      { do: "fill", target: "Your name", text: "Ada (notes)" },
      { do: "click", target: "Turn off microphone" },
      { do: "click", target: "Turn off camera" },
      { do: "click", target: "Ask to join" },
    ]);
  });

  test("Jitsi: muted by the room's options, never by a toggle that would turn them on", () => {
    const link = { platform: "jitsi" as const, url: "https://meet.jit.si/Room1", room: "Room1" };
    const steps = meetingJoinSteps(link, "Ada (notes)");
    expect(steps[0]).toEqual({ do: "open", url: meetingJoinUrl(link, "Ada (notes)") });
    expect(steps.slice(1)).toEqual([
      { do: "fill", target: "Enter your name", text: "Ada (notes)" },
      { do: "click", target: "Join meeting" },
    ]);
    expect(steps.some((s) => /microphone|camera/i.test(s.target ?? ""))).toBe(false);
  });

  test("the page after joining says where the agent is", () => {
    const page = (text: string) => observeSnapshot({ text, url: "https://meet.google.com/abc-defg-hij" });
    expect(meetingStateOf(page('- heading "Asking to be let in…"'))).toBe("waiting");
    expect(meetingStateOf(page('- button "Leave call" [ref=e9]'))).toBe("in_call");
    expect(meetingStateOf(page('- heading "You can\'t join this video call"'))).toBe("refused");
    expect(meetingStateOf(page('- heading "Ready to join?"'))).toBe("waiting");
    expect(meetingStateOf(null)).toBe("waiting");
  });
});

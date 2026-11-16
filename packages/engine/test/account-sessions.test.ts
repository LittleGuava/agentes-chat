import { describe, expect, test } from "bun:test";
import { sessionDevice } from "../src/account-sessions";

/** The device a session's sign-in came from, read from its user agent (ADR 0006, addendum 2026-11-15). */
describe("sessionDevice", () => {
  const cases: [string, string | null, ReturnType<typeof sessionDevice>][] = [
    [
      "Chrome on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      { kind: "browser", browser: "Chrome", os: "Windows" },
    ],
    [
      "Edge on Windows, which also says Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      { kind: "browser", browser: "Edge", os: "Windows" },
    ],
    [
      "Safari on a Mac",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      { kind: "browser", browser: "Safari", os: "macOS" },
    ],
    [
      "a Mac's web view, which names no browser",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      { kind: "browser", browser: null, os: "macOS" },
    ],
    [
      "Safari on an iPhone, which also says Mac OS X",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      { kind: "browser", browser: "Safari", os: "iPhone" },
    ],
    [
      "Chrome on an iPad",
      "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
      { kind: "browser", browser: "Chrome", os: "iPad" },
    ],
    [
      "Firefox on Linux",
      "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      { kind: "browser", browser: "Firefox", os: "Linux" },
    ],
    [
      "Samsung's browser on Android, which also says Chrome and Linux",
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      { kind: "browser", browser: "Samsung Internet", os: "Android" },
    ],
    [
      "Opera on ChromeOS",
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0",
      { kind: "browser", browser: "Opera", os: "ChromeOS" },
    ],
    [
      "the phone app on an iPhone",
      "agenteschat/42 CFNetwork/1568.200.51 Darwin/24.1.0",
      { kind: "phone_app", browser: null, os: "iOS" },
    ],
    ["the phone app on Android", "okhttp/4.12.0", { kind: "phone_app", browser: null, os: "Android" }],
    ["a script", "curl/8.7.1", { kind: "unknown", browser: null, os: null }],
    ["nothing kept", "", { kind: "unknown", browser: null, os: null }],
    ["no user agent", null, { kind: "unknown", browser: null, os: null }],
  ];
  for (const [name, ua, device] of cases) {
    test(name, () => expect(sessionDevice(ua)).toEqual(device));
  }
});

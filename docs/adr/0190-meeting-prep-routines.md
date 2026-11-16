# 0190. A routine that prepares each meeting on a connected calendar

- Status: Accepted
- Date: 2026-11-15
- Builds on: 0053 (routines and unattended work), 0107 (services through Composio), 0117 (outside content), 0130 (connector events as routine triggers)
- Code: `packages/engine/src/meeting-prep.ts` (`MEETING_EVENT`, `meetingOf`, `pollMeetingWatches`, `syncMeetingWatch`, `checkMeetingConnection`, `meetingEventText`), `packages/engine/src/routines.ts` (the `meeting` trigger), `packages/engine/src/context.ts` (the meeting's lines in a routine run), `packages/db/src/schema/work.ts` (`meeting_watches`, migration `0299_meeting_watches`), `apps/server/src/routes/app/routines.ts`, `apps/server/src/workers.ts` (the `meetings` tick), `packages/client/src/api/types.ts` (`RoutineMeetingTrigger`), web `RoutinesPage.tsx` and phone `routines/hooks.tsx`, `logic.ts` (its words; the editor keeps it)

## Context

People who live in their calendar want the agent to get them ready for each meeting: who is coming, what it is about, what the team already knows about them, and the open work that touches it, a few minutes before it starts. Today they can only ask for it each time, or set a daily routine that reads the whole day at once and is stale by the afternoon.

ADR 0130 lists Google Calendar's "event starting" as a Composio trigger. A meeting is not an event that happens and is then delivered: its start is known ahead, and the moment to act is a chosen time before it. A webhook would tell us that an event changed, never that one starts in fifteen minutes.

## Decision

1. **A `meeting` trigger.** A routine can fire `lead` minutes (5 to 240, 15 by default) before each meeting on a Google Calendar connection (the `google-calendar` preset, through Composio). It is stored as the event `meeting.upcoming` plus a `meeting_watches` row (one per routine): the connection, the lead, when to look next (`next_check_at`), and the watch's state (`active`, or `error` with the last reason). Its runs are ordinary event runs (ADR 0053 §6.3): a background run in the routine's room, speaking only through `hand_off`.
2. **Code looks, the model works.** A worker tick (every minute) claims the watches due (`next_check_at <= now`, `SKIP LOCKED`) of active routines in an open workspace (not on hold, suspended or being deleted: a look is a billed call) and lists the connection's events from now to `lead + 30` minutes ahead with `GOOGLECALENDAR_EVENTS_LIST`, through the connection's own session (no model, no prompt). A meeting whose moment (`start - lead`) came fires a routine run; none came, nothing runs and no model is called. The watch then looks again at the earliest of the next moment it saw and 15 minutes later, so a run starts within a minute of its moment while a quiet calendar costs one call every 15 minutes (96 a day per routine, counted in the workspace's Composio calls like any other).
3. **What counts as a meeting.** An event with a time (not all day), not cancelled, that the calendar's owner didn't decline, with at least one other attendee, and that hasn't started yet. Focus blocks and reminders to oneself have no one else and fire nothing.
4. **Each meeting once.** A run's dedupe key is the event's id and start (`meeting:<id>:<start>`): a meeting seen by two looks fires once; one moved to another time is a new meeting and fires again. Two meetings at the same moment join one run (`mergeEvents`).
5. **The brief.** The run's event carries the meeting as data (title, start and end, organizer, attendees with their answers, location, call link, description), cut to fit: the description to 1,500 characters, at most 30 attendees. The run reads it as lines, the description last so a cut takes the end of the longest part, inside the outside-content envelope (ADR 0117), after one line saying a meeting is about to start and that the notes go out through `hand_off` before it does. The routine's own instructions say what to prepare.
6. **It always speaks.** A meeting routine reports every run (`report: "always"`) unless its creator chose otherwise: a prep nobody receives is no prep.
7. **Consent stays with the connection** (as in ADR 0130 §4). The routine's agent must be able to read the connection: its read or write scope, the whole connection (`connector:*`), or every tool (`*`). This is wider than ADR 0130 §4, which takes only the read scope: a calendar connected through Composio is usually granted whole. It is checked when the routine is saved and when its agent changes, and again before each look: a connection revoked or a grant taken back stops the looks, leaves the watch in `error` with the reason, and fires nothing.
8. **This changes ADR 0130's table** for Google Calendar's "event starting": through a look ahead by code, not a Composio trigger. ADR 0130 turned polling down for mail because of text answers, idle calls and latency: a Composio session answers structured `data`, the look ahead removes the latency, and the idle cost is the one call in 15 minutes above.

## The data that crosses the boundary

```ts
// The trigger, as the API takes it and the apps read it.
type MeetingTriggerInput = { type: "meeting"; connectionId: string; leadMinutes?: number };
type MeetingTrigger = {
  type: "meeting";
  connectionId: string;
  leadMinutes: number;
  status: "active" | "error";
  lastError: string | null;
};

// A routine run's event (`routine_runs.event`), one per meeting (several merge as `events`).
type MeetingEvent = {
  type: "meeting.upcoming";
  summary: string; // "«Weekly sync» starts at 2026-11-16T13:00:00.000Z (in 15 min) with 3 others"
  meeting: {
    id: string;
    title: string;
    start: string; // ISO
    end: string | null;
    organizer: string | null;
    attendees: { email: string; name: string | null; response: string | null }[];
    location: string | null;
    link: string | null;
    description: string | null;
  };
};
```

## Consequences

- A person sets "15 minutes before each meeting, prepare me" once and gets a note before every meeting with someone, and nothing for an empty day.
- A meeting added inside the lead time (or moments before) still fires when the next look finds it, as long as it hasn't started.
- Every routine looks for itself: two routines on one calendar make two looks.
- "Run now" on a meeting routine starts a run with no meeting in it: the agent has only the routine's instructions (it can read the calendar itself).
- Composio's own answer for the event list was read from its documented shape (`items` of Google's API); a real calendar hasn't been read yet.

## Later

- The routine editor on the web and the phone ("Antes de cada reunião"), and the agents' own routine tools; this first slice is the API and the apps' reading of the trigger.
- Outlook and other calendars, one entry each in the list of calendar sources.
- One look per connection for every routine on it.
- A filter by calendar, by organizer or by words in the title.

## Alternatives considered

- **Composio's "event starting soon" trigger:** a webhook per routine through Composio, with its own polling and window we don't control; it needs the public address and the webhook secret, and still fires for blocks with no one else.
- **A daily routine that reads the day:** one run for every meeting, hours before the later ones.
- **A schedule computed from the calendar:** one routine slot per meeting kept in step with every change; the look ahead does the same with no copy of the calendar to keep right.

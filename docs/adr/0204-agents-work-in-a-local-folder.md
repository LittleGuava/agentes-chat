# 0204. The agents' work in a folder on the person's computer

- Status: Accepted (built: the server's list, the desktop app's planner, its native writes, its timer and the choice
  in Preferences)
- Date: 2026-11-15
- Builds on: ADR 0019 (files and who sees them), ADR 0036 and 0066 (the desktop app), ADR 0151 and 0157 (who sees what)
- Code: engine `drive-sync.ts` (`driveSyncList`), route `GET /api/app/organizations/{orgId}/drive-sync`
  (`routes/app/artifacts.ts`); desktop `control/folder-sync.ts` (`planFolderSync`, `applyWritten`, `runFolderSync`,
  `safeName`, `startFolderSync`, `conversationsOf`, `statusOf`), Preferences' tab `windows/prefs/FolderSync.tsx`,
  `src-tauri/src/folder_sync.rs` (`folder_sync_list`, `folder_sync_scan`, `folder_sync_fetch`, `folder_sync_root`);
  tests `packages/engine/test/drive-sync.test.ts`, `apps/server/test/drive-sync-route.test.ts`,
  `apps/desktop/test/folder-sync.test.ts`, `apps/desktop/test/folder-sync-prefs.test.tsx`, `folder_sync.rs`'s own

## Context

What agents make lands in the Drive: documents, tables, diffs, pages, diagrams and uploaded files (ADR 0019). People
who work in files on their own computer (an editor, a spreadsheet, a folder a backup or another sync tool already
watches) download them one by one. The ask is the agents' work in a folder of their own computer, kept current without
anyone clicking, for the conversations they choose.

Two places on the person's computer could do it. The runner (ADR 0025) is the agents' computer: it may run as root in
system mode, on a server or a VM of the workspace, and its job is the agents' work, never a person's folders. The
desktop app (ADR 0036) runs as the person, on their own computer, and already makes requests with the main window's
session for its own windows (`with_session` in `workspaces.rs`). The session is what decides what a person sees, so
the server's own checks stay the only checks.

Syncing both ways is a different product: a person's edit going back to the Drive is a new version by that person, with
its conflicts against agents writing at the same time. This decision is the one-way part, and it is written so a later
two-way part can build on it.

## Decision

1. **The desktop app downloads; nothing goes up, nothing is deleted.** For each conversation the person chose, the
   files made by agents (`createdBy` an agent), in the Drive (`inDrive`), that the person can read now go to
   `<Documents>/agentes.chat/<agent>/<conversation>/<file>`. `<Documents>` is the system's own documents folder (the
   one Windows shows as "Documentos" in Portuguese), read by Tauri's `document_dir`. The app never deletes a file: a
   file deleted in the Drive, moved out of reach or in a conversation no longer chosen stays where it is. One workspace
   per computer in this first part.

2. **The server says what to download, in one list.** `GET /api/app/organizations/{orgId}/drive-sync?channelIds=a,b`
   (at most 50 conversations) returns, with the caller's session and through `listArtifacts`, so through the same
   visibility as the Drive (ADR 0019, 0151, 0157):

   ```ts
   interface DriveSyncFile {
     id: string;            // the artifact
     kind: "document" | "table" | "diff" | "html" | "diagram" | "file";
     version: number;       // its current version
     name: string;          // a name that doesn't change from one version to the next: an upload's own name, else title + extension
     format: "csv" | "patch" | null; // the download's export, for tables and diffs; null: the bytes as stored
     agent: { id: string; name: string };
     conversation: { id: string; name: string; dm: boolean };
     updatedAt: string;
   }
   // { files: DriveSyncFile[]; truncated: boolean }
   ```

   Blocks, polls and choices (`inDrive` false) are left out, so are files without a conversation and those a person
   made. A table goes down as CSV and a diff as a `.patch`, the formats a person opens; the rest as the Drive keeps
   them (`.md`, `.html`, `.mmd`, an upload's bytes). The name carries no version: the download's own name
   (`<slug>-v<n>.<ext>`) would make each version a new file. At most 1,000 files per call, the most recently updated
   first, with `truncated` set past that.

3. **Signals.** A new version in the Drive is a `version` greater than the one written; an edit on the computer is a
   file whose SHA-256 differs from the one of the bytes the app wrote. The app keeps, per file, where it wrote it, the
   version and that hash (the manifest, in the app's own storage, never in the folder).

4. **The plan is a pure function** (`planFolderSync`): remote list, manifest and what the folder holds in, actions out.

   - A file not in the manifest is written to a new path; the write happens only while nothing is at that path.
   - A new version over an untouched local copy replaces it; the write happens only while the copy still has the hash
     the manifest says.
   - A new version over a copy the person changed is written next to it as `<name> (v<n>).<ext>`; the person's copy is
     never touched. The manifest remembers the version copied, so running again doesn't copy it twice.
   - A copy the person deleted stays deleted: a new version doesn't bring it back.
   - A path is chosen once, at the first download, and kept by the artifact's id: an agent, a conversation or a file
     renamed later doesn't move or duplicate anything.
   - Names become safe on every system (`safeName`): no `<>:"/\|?*` or control characters, no trailing dot or space, no
     `.` or `..`, no reserved Windows name (`CON`, `NUL`, `COM1`…), at most 80 characters with the extension kept. Two
     names that differ only by case are the same file on Windows and macOS, so a path taken by any other file, in any
     case, gets ` (2)`, ` (3)`… before the extension.

5. **The native side writes only under its own folder, only what it was asked, only with its checks.** Three app
   commands, answered for the popover alone, and a fourth for Preferences:

   - `folder_sync_list(server, orgId, channelIds)`: the list above, with the session, the URL built in Rust from ids it
     checked.
   - `folder_sync_scan(hash)`: every file under `<Documents>/agentes.chat` as a relative path (at most 20,000, four
     levels), and the SHA-256 of the paths asked.
   - `folder_sync_fetch({ server, orgId, artifactId, version, format, path, expect })`: downloads
     `/api/app/organizations/{orgId}/artifacts/{artifactId}/file?version=<n>[&format=csv|patch]` with the session,
     streamed into a part file in the destination's folder (at most 1 GiB), hashed on the way, then put in place: with
     `expect` null only where nothing is (create-new), else only while the file there still has the hash `expect`
     (checked just before the rename). Answers the hash written, or `changed` when the folder moved on, which the next
     pass plans again. Any answer but 200 fails the call: a redirect (a proxy's, a sign-in page's) is never written
     as the file.

   - `folder_sync_root()`, Preferences' only: makes `<Documents>/agentes.chat` if it isn't there and answers its full
     path, to show it and open it ("Show in Finder", through the existing `reveal_folder`, which opens folders only).

   The web view never passes a full path: `path` is relative, each part checked again in Rust like `safeName` does,
   and joined to the folder Rust chose. The `Host` the windows see gains these four calls; until now it promised no
   file system beyond its existing calls.

6. **When it runs.** The popover runs a pass at start and every five minutes while the choice is on and names at
   least one conversation, one pass at a time, at most 50 writes per pass, and keeps the manifest after each write, so a
   pass cut in the middle loses nothing. Only the copies a new version may replace are hashed; the rest of the folder is
   only listed. A choice changed in Preferences starts a pass at once (a pass already running runs once more when it
   ends).

7. **The choice lives in Preferences, as the app's own storage.** A tab of the app's own ("Agents' files", next to
   Servers, since it is the person's and not the agents' computer's) holds:

   - one switch, off at first: turning it on takes the open server's first workspace, turning it off keeps the choice
     for when it comes back on;
   - the workspace, picked among the signed-in servers' workspaces when there is more than one, or when the one chosen
     is gone (a workspace left or a server signed out keeps its choice, so a session out for a moment loses nothing);
     another workspace starts with no conversation;
   - the folder, with "Show in Finder" (or "Show in Files");
   - the last download (its time, and whether the server couldn't be reached or some files didn't come down);
   - the workspace's conversations the person reads, to check: its channels by name (`GET …/channels`), then its direct
     conversations with an agent (`GET …/dms`; one between people holds no agent's files). Both go through `site_fetch`,
     whose list of paths gains these two `GET`s, with the main window's session, so the server's own checks decide.

   ```ts
   // localStorage "agentes.desktop.folderSync", written by Preferences, read by the popover at every pass
   interface FolderSyncChoice { on: boolean; server: string; orgId: string; channelIds: string[] }
   // "agentes.desktop.folderSync.status", written by the popover after every pass, read by Preferences
   interface FolderSyncStatus { server: string; orgId: string; at: string; written: number; failed: number; unreachable: boolean }
   ```

   The two windows share the web view's storage; each hears the other's writes through the `storage` event, as the
   popover already does for the menu bar setting. The manifest keeps its own key per server and workspace, so going
   back to a workspace finds what was written there.

## Consequences

- What reaches the folder is what the person could download by hand: the server checks the session on each request.
- Every window allowed `site_fetch` may now also read a workspace's channel list and direct conversations with the
  session; both are what the site itself shows the person, and nothing else about them is reachable.
- A person can edit, move and delete what is in the folder; the app works around them and never undoes them.
- The manifest lives with the app: if it is lost, every file in the folder counts as the person's, so new versions come
  down as new files next to them, never over them.
- The time between the hash check and the rename is short but not zero: an edit saved in that instant can be replaced.
  The editor's own backup and the Drive's versions (the agent's version is still there) are the way back.
- Files land in a folder other sync tools may watch (OneDrive moves Documents on many Windows computers): they get the
  agents' work too, which is the point, and their own conflicts are theirs.

## Later

- "Download to this computer" in a conversation's menu on the site, through `this_mac`.
- More than one workspace (a `<workspace>` level above the agents), and a person's own files.
- A file event (`artifact.updated` on the site's socket) starting a pass at once, instead of the five-minute timer.
- Two-way: a local edit going up as a new version by that person, with the Drive's `baseVersion` conflict (ADR 0019).
- The phone and the runner: neither downloads to a person's folder.

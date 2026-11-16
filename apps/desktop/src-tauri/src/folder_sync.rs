//! The agents' work in a folder of this computer (ADR 0204): `<Documents>/agentes.chat/<agent>/<conversation>/<file>`.
//! The popover plans what to download (`control/folder-sync.ts`); this side lists with the main window's session,
//! looks at the folder, and writes only what it was asked, only under its own folder, and only while the folder is
//! still as the plan saw it: where nothing is, or over a file that still has the hash the app wrote. Nothing is deleted.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::workspaces::{good_id, session_cookie};

/// The folder inside the system's documents folder.
const FOLDER: &str = "agentes.chat";
/// What a scan lists at most, and how deep (agent, conversation, file, one more for the person's own folders).
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 4;
/// The largest file written (the Drive's own uploads are smaller).
const MAX_BYTES: u64 = 1 << 30;
/// The server's list, as text, at most.
const LIST_MAX: u64 = 8 * 1024 * 1024;
/// A download in progress, next to where it goes; a scan skips it.
const PART: &str = ".agentes-part";
const CHANGED: &str = "changed";

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().document_dir().map(|dir| dir.join(FOLDER)).map_err(|e| e.to_string())
}

/// A Windows reserved name, with or without an extension (`CON`, `aux.md`, `COM1`).
fn reserved(part: &str) -> bool {
    let stem: Vec<char> = part.split('.').next().unwrap_or("").to_lowercase().chars().collect();
    let word: String = stem.iter().take(3).collect();
    match stem.len() {
        3 => matches!(word.as_str(), "con" | "prn" | "aux" | "nul"),
        4 => matches!(word.as_str(), "com" | "lpt") && (stem[3].is_ascii_digit() || "¹²³".contains(stem[3])),
        _ => false,
    }
}

/// One part of a path, as `safeName` in folder-sync.ts makes them.
fn part_ok(part: &str) -> bool {
    !part.is_empty()
        && part.chars().count() <= 120
        && part != "."
        && part != ".."
        && !part.starts_with(' ')
        && !part.ends_with(['.', ' '])
        && !part.ends_with(PART)
        && !part.chars().any(|c| "<>:\"/\\|?*".contains(c) || c.is_control())
        && !reserved(part)
}

/// `<agent>/<conversation>/<file>` under `root`, each part checked; None for anything else.
fn target(root: &Path, relative: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = relative.split('/').collect();
    (parts.len() == 3 && parts.iter().all(|p| part_ok(p))).then(|| parts.iter().fold(root.to_path_buf(), |p, s| p.join(s)))
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(hex(&hasher.finalize()));
        }
        hasher.update(&buf[..n]);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Scan {
    /// Every file under the folder, relative, with `/`.
    pub files: Vec<String>,
    /// The SHA-256 of the paths asked that are files there.
    pub hashes: HashMap<String, String>,
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(name) = entry.file_name().into_string() else { continue };
        // Not followed: a link is neither a file nor a folder here.
        let Ok(kind) = entry.file_type() else { continue };
        let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if kind.is_dir() {
            walk(&entry.path(), &relative, depth + 1, out);
        } else if kind.is_file() && !name.ends_with(PART) {
            out.push(relative);
        }
    }
}

pub fn scan(root: &Path, hash: &[String]) -> Scan {
    let mut files = Vec::new();
    walk(root, "", 0, &mut files);
    let hashes = hash
        .iter()
        .filter_map(|relative| {
            let path = target(root, relative)?;
            let meta = fs::symlink_metadata(&path).ok()?;
            meta.is_file().then(|| hash_file(&path).ok()).flatten().map(|h| (relative.clone(), h))
        })
        .collect();
    Scan { files, hashes }
}

/// Whether the file at `path` is as the plan saw it: absent for `None`, else with the hash `expect`.
fn as_planned(path: &Path, expect: Option<&str>) -> Result<(), String> {
    let there = match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.to_string()),
    };
    match (expect, there) {
        (None, false) => Ok(()),
        (Some(expect), true) if hash_file(path).map_err(|e| e.to_string())? == expect => Ok(()),
        _ => Err(CHANGED.into()),
    }
}

/// Writes `body` to `relative` under `root`: streamed into a part file next to it, hashed on the way, then put in
/// place only while the folder is still as planned. Answers the SHA-256 written, or `changed`.
pub fn place(root: &Path, relative: &str, body: &mut dyn Read, expect: Option<&str>) -> Result<String, String> {
    let path = target(root, relative).ok_or("not a path of the folder")?;
    let dir = path.parent().ok_or("not a path of the folder")?;
    as_planned(&path, expect)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("not a path of the folder")?;
    let part = dir.join(format!(".{name}{PART}"));
    let written = (|| -> io::Result<String> {
        let mut out = File::create(&part)?;
        let mut hasher = Sha256::new();
        let mut limited = body.take(MAX_BYTES + 1);
        let mut buf = vec![0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let n = limited.read(&mut buf)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_BYTES {
                return Err(io::Error::other("larger than the folder takes"));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        out.sync_all()?;
        Ok(hex(&hasher.finalize()))
    })();
    let result = written.map_err(|e| e.to_string()).and_then(|sha| {
        as_planned(&path, expect)?;
        match expect {
            // Only where nothing is: a hard link refuses an existing name; where links don't work, a new file does.
            None => match fs::hard_link(&part, &path) {
                Ok(()) => Ok(sha),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(CHANGED.into()),
                Err(_) => {
                    let mut out = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| {
                        if e.kind() == io::ErrorKind::AlreadyExists { CHANGED.to_string() } else { e.to_string() }
                    })?;
                    io::copy(&mut File::open(&part).map_err(|e| e.to_string())?, &mut out).map_err(|e| e.to_string())?;
                    Ok(sha)
                }
            },
            Some(_) => fs::rename(&part, &path).map(|()| sha).map_err(|e| e.to_string()),
        }
    });
    let _ = fs::remove_file(&part);
    result
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Patch,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Named {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub dm: bool,
}

/// One file of `GET …/drive-sync`, as the popover plans with it.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DriveSyncFile {
    pub id: String,
    pub version: u32,
    pub name: String,
    pub format: Option<Format>,
    pub agent: Named,
    pub conversation: Conversation,
}

#[derive(Deserialize)]
struct DriveSyncList {
    files: Vec<DriveSyncFile>,
}

fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(read).redirects(0).build()
}

fn get(app: &AppHandle, server: &str, path: &str, read: Duration) -> Result<ureq::Response, String> {
    let (url, cookie) = session_cookie(app, server, path)?;
    let response = agent(read)
        .get(url.as_str())
        .set("Cookie", &cookie)
        .set("X-Agentes-Client", "mobile")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(status, _) => format!("status {status}"),
            e => e.to_string(),
        })?;
    // Not followed, and never written as the file: a redirect (a proxy's or a sign-in page's) is a failed download.
    if response.status() != 200 {
        return Err(format!("status {}", response.status()));
    }
    Ok(response)
}

/// The agents' files of the chosen conversations (`GET …/drive-sync`).
#[tauri::command]
pub async fn folder_sync_list(
    app: AppHandle,
    window: tauri::Window,
    server: String,
    org_id: String,
    channel_ids: Vec<String>,
) -> Result<Vec<DriveSyncFile>, String> {
    if window.label() != "popover" {
        return Err("only the popover asks this".into());
    }
    if !good_id(&org_id) || channel_ids.is_empty() || channel_ids.len() > 50 || !channel_ids.iter().all(|c| good_id(c)) {
        return Err("bad ids".into());
    }
    let path = format!("/api/app/organizations/{org_id}/drive-sync?channelIds={}", channel_ids.join(","));
    tauri::async_runtime::spawn_blocking(move || {
        let mut text = String::new();
        get(&app, &server, &path, Duration::from_secs(30))?
            .into_reader()
            .take(LIST_MAX)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        serde_json::from_str::<DriveSyncList>(&text).map(|l| l.files).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where the files go, for Preferences to show (and open: the folder is made here, so it can be).
#[tauri::command]
pub fn folder_sync_root(app: AppHandle, window: tauri::Window) -> Result<String, String> {
    if window.label() != "prefs" {
        return Err("only Preferences asks this".into());
    }
    let root = root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

/// What the folder holds, and the hashes of `hash`'s paths.
#[tauri::command]
pub async fn folder_sync_scan(app: AppHandle, window: tauri::Window, hash: Vec<String>) -> Result<Scan, String> {
    if window.label() != "popover" {
        return Err("only the popover asks this".into());
    }
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || scan(&root, &hash)).await.map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    server: String,
    org_id: String,
    artifact_id: String,
    version: u32,
    format: Option<Format>,
    path: String,
    expect: Option<String>,
}

/// Downloads one file of the plan with the session and puts it in the folder (`place`).
#[tauri::command]
pub async fn folder_sync_fetch(app: AppHandle, window: tauri::Window, request: FetchRequest) -> Result<String, String> {
    if window.label() != "popover" {
        return Err("only the popover asks this".into());
    }
    let r = request;
    if !good_id(&r.org_id) || !good_id(&r.artifact_id) {
        return Err("bad ids".into());
    }
    if r.expect.as_deref().is_some_and(|h| h.len() != 64 || !h.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err("bad hash".into());
    }
    let root = root(&app)?;
    if target(&root, &r.path).is_none() {
        return Err("not a path of the folder".into());
    }
    let format = match r.format {
        None => "",
        Some(Format::Csv) => "&format=csv",
        Some(Format::Patch) => "&format=patch",
    };
    let path = format!("/api/app/organizations/{}/artifacts/{}/file?version={}{format}", r.org_id, r.artifact_id, r.version);
    tauri::async_runtime::spawn_blocking(move || {
        let response = get(&app, &r.server, &path, Duration::from_secs(60))?;
        place(&root, &r.path, &mut response.into_reader(), r.expect.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder in the system's temporary folder, never the person's documents.
    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentes-folder-sync-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha(text: &str) -> String {
        hex(&Sha256::digest(text.as_bytes()))
    }

    #[test]
    fn only_three_safe_parts_under_the_folder() {
        let root = Path::new("/x");
        assert!(target(root, "Dev/general/Relatório.md").is_some());
        for bad in [
            "Dev/general",
            "Dev/general/a/b",
            "../general/a.md",
            "Dev/../a.md",
            "Dev/general/a.md.",
            "Dev/general/ a.md",
            "Dev/gen:eral/a.md",
            "Dev/general/a\\b.md",
            "CON/general/a.md",
            "Dev/general/aux.md",
            "Dev/general/COM1",
            "Dev/general/a.md.agentes-part",
            "/Dev/general/a.md",
            "C:/general/a.md",
        ] {
            assert!(target(root, bad).is_none(), "{bad}");
        }
        assert!(target(root, "Dev/general/console.md").is_some());
    }

    #[test]
    fn a_new_file_only_where_nothing_is() {
        let root = temp_root("new");
        let sha1 = place(&root, "Dev/general/a.md", &mut "one".as_bytes(), None).unwrap();
        assert_eq!(sha1, sha("one"));
        assert_eq!(fs::read_to_string(root.join("Dev/general/a.md")).unwrap(), "one");
        // Something is there now: refused, untouched, no part file left.
        assert_eq!(place(&root, "Dev/general/a.md", &mut "two".as_bytes(), None), Err(CHANGED.into()));
        assert_eq!(fs::read_to_string(root.join("Dev/general/a.md")).unwrap(), "one");
        assert_eq!(scan(&root, &[]).files, vec!["Dev/general/a.md".to_string()]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_replace_only_over_the_hash_the_app_wrote() {
        let root = temp_root("replace");
        let sha1 = place(&root, "Dev/general/a.md", &mut "one".as_bytes(), None).unwrap();
        let sha2 = place(&root, "Dev/general/a.md", &mut "two".as_bytes(), Some(&sha1)).unwrap();
        assert_eq!(fs::read_to_string(root.join("Dev/general/a.md")).unwrap(), "two");
        // The person edits it: an expected hash that no longer matches leaves their copy alone.
        fs::write(root.join("Dev/general/a.md"), "mine").unwrap();
        assert_eq!(place(&root, "Dev/general/a.md", &mut "three".as_bytes(), Some(&sha2)), Err(CHANGED.into()));
        assert_eq!(fs::read_to_string(root.join("Dev/general/a.md")).unwrap(), "mine");
        // Deleted by the person: a replace doesn't bring it back.
        fs::remove_file(root.join("Dev/general/a.md")).unwrap();
        assert_eq!(place(&root, "Dev/general/a.md", &mut "three".as_bytes(), Some(&sha2)), Err(CHANGED.into()));
        assert!(!root.join("Dev/general/a.md").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_scan_lists_files_and_hashes_the_paths_asked() {
        let root = temp_root("scan");
        place(&root, "Dev/general/a.md", &mut "one".as_bytes(), None).unwrap();
        fs::write(root.join("Dev/general/.b.md.agentes-part"), "half").unwrap();
        fs::write(root.join("notes.txt"), "mine").unwrap();
        let got = scan(&root, &["Dev/general/a.md".into(), "Dev/general/gone.md".into(), "../x".into()]);
        let mut files = got.files.clone();
        files.sort();
        assert_eq!(files, vec!["Dev/general/a.md".to_string(), "notes.txt".to_string()]);
        assert_eq!(got.hashes, HashMap::from([("Dev/general/a.md".to_string(), sha("one"))]));
        // No folder yet: nothing, no error.
        assert_eq!(scan(&root.join("missing"), &[]), Scan::default());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_servers_list() {
        let text = r#"{"files":[{"id":"a1","kind":"table","version":2,"name":"Vendas.csv","format":"csv",
            "agent":{"id":"g1","name":"Dev"},"conversation":{"id":"c1","name":"general","dm":false},
            "updatedAt":"2026-11-15T00:00:00Z"}],"truncated":false}"#;
        let list: DriveSyncList = serde_json::from_str(text).unwrap();
        assert_eq!(list.files[0].format, Some(Format::Csv));
        assert_eq!(list.files[0].version, 2);
        assert!(serde_json::from_str::<DriveSyncList>(&text.replace("\"csv\"", "\"exe\"")).is_err());
    }
}
